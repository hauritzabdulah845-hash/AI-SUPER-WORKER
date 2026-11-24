/**
 * 本地自测：不连飞书，用真实加解密构造回调包，验证网关全链路。
 * 覆盖：HTTP 指令入口（鉴权/入队/幂等）→ 队列拉取 → 状态回写
 *       → 飞书 URL 验证（明文/加密）→ 加密事件入队 → 签名拒绝 → 非文本消息。
 */
import os from "node:os";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { createService } from "../src/server.mjs";
import { encryptLark, larkSignature } from "../src/crypto.mjs";
import { extractFeishuText } from "../src/commands.mjs";

const SECRET = "test-admin-secret";
const TOKEN = "test-verification-token";
const ENCRYPT_KEY = "test-encrypt-key-0123456789";
let failed = 0;

function baseConfig(overrides = {}) {
  return {
    port: 0,
    adminSecret: SECRET,
    feishuVerificationToken: TOKEN,
    feishuEncryptKey: ENCRYPT_KEY,
    dataDir: mkdtempSync(join(os.tmpdir(), "im-gw-test-")),
    ...overrides,
  };
}

async function start(config) {
  const { server, store } = createService({ config, logger: { info() {}, warn() {}, error() {} } });
  await new Promise((resolve) => server.listen(0, resolve));
  return { server, store, port: server.address().port };
}

function check(name, ok, detail = "") {
  if (!ok) failed += 1;
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` ｜ ${detail}` : ""}`);
}

async function postJson(port, path, payload, headers = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function main() {
  console.log("—— IM 远程指令网关 · 本地自测 ——\n");

  const gw = await start(baseConfig());

  // 1. 健康检查
  const health = await (await fetch(`http://127.0.0.1:${gw.port}/health`)).json();
  check("健康检查", health.ok === true, `pending=${health.pending}`);

  // 2. HTTP 指令入口：鉴权 + 入队
  const denied = await postJson(gw.port, "/api/command?secret=wrong", { text: "不该进来" });
  check("指令入口鉴权", denied.status === 403, `status=${denied.status}`);

  const inserted = await postJson(gw.port, `/api/command?secret=${encodeURIComponent(SECRET)}`, {
    text: "帮我生成本周内容排期",
    source: "http",
    from: "测试脚本",
    eventId: "evt-1",
  });
  check(
    "HTTP 指令入队",
    inserted.status === 200 && inserted.body.created === true && inserted.body.command.status === "pending",
    `id=${inserted.body.command?.id}`,
  );

  // 3. 幂等：同 eventId 重推不重复
  const dup = await postJson(gw.port, `/api/command?secret=${encodeURIComponent(SECRET)}`, {
    text: "帮我生成本周内容排期",
    eventId: "evt-1",
  });
  check("同 eventId 不重复入队", dup.body.created === false && dup.body.command.id === inserted.body.command.id, `id=${dup.body.command?.id}`);

  // 4. 空文本拒绝
  const empty = await postJson(gw.port, `/api/command?secret=${encodeURIComponent(SECRET)}`, { text: "   " });
  check("空指令被拒绝", empty.status === 400, `status=${empty.status}`);

  // 5. 队列拉取 + 增量
  const all = await (await fetch(`http://127.0.0.1:${gw.port}/api/commands?secret=${encodeURIComponent(SECRET)}&since=0`)).json();
  check("队列拉取", all.ok === true && all.commands.length === 1 && all.nextSeq === 1, `n=${all.commands?.length}`);
  const inc = await (await fetch(`http://127.0.0.1:${gw.port}/api/commands?secret=${encodeURIComponent(SECRET)}&since=${all.nextSeq}`)).json();
  check("增量拉取为空", inc.commands.length === 0, `n=${inc.commands.length}`);

  // 6. 状态回写
  const updated = await postJson(gw.port, `/api/commands/update?secret=${encodeURIComponent(SECRET)}`, {
    id: inserted.body.command.id,
    status: "done",
  });
  check("状态回写 done", updated.status === 200 && updated.body.command.status === "done");
  const badStatus = await postJson(gw.port, `/api/commands/update?secret=${encodeURIComponent(SECRET)}`, {
    id: inserted.body.command.id,
    status: "running",
  });
  check("非法状态被拒", badStatus.status === 404, `status=${badStatus.status}`);

  // 7. 飞书 URL 验证（明文模式）
  const challenge = await postJson(gw.port, "/feishu/event", {
    type: "url_verification",
    challenge: "challenge-abc",
    token: TOKEN,
  });
  check("飞书明文 URL 验证", challenge.status === 200 && challenge.body.challenge === "challenge-abc");

  const badToken = await postJson(gw.port, "/feishu/event", {
    type: "url_verification",
    challenge: "x",
    token: "wrong",
  });
  check("错误 token 拒绝", badToken.status === 401, `status=${badToken.status}`);

  // 8. 加密事件：构造飞书事件包 → 解密入队
  const feishuEvent = {
    schema: "2.0",
    header: { event_id: "evt-feishu-1", event_type: "im.message.receive_v1" },
    event: {
      sender: { sender_id: { open_id: "ou_test_1" } },
      message: {
        message_id: "om_1",
        message_type: "text",
        content: JSON.stringify({ text: "@_user_1 帮我分析上周线索转化" }),
      },
    },
  };
  const encrypted = encryptLark(feishuEvent, ENCRYPT_KEY);
  const ts = String(Math.floor(Date.now() / 1000));
  const nonce = "n-1";
  const rawBody = JSON.stringify({ encrypt: encrypted });
  const sig = larkSignature({ timestamp: ts, nonce, encryptKey: ENCRYPT_KEY, body: rawBody });
  const encRes = await fetch(`http://127.0.0.1:${gw.port}/feishu/event`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Lark-Request-Timestamp": ts,
      "X-Lark-Request-Nonce": nonce,
      "X-Lark-Signature": sig,
    },
    body: rawBody,
  });
  check("加密事件解密入队", encRes.status === 200, `status=${encRes.status}`);

  const queue = await (await fetch(`http://127.0.0.1:${gw.port}/api/commands?secret=${encodeURIComponent(SECRET)}&since=0`)).json();
  const feishuCmd = queue.commands.find((item) => item.source === "feishu");
  check(
    "飞书指令内容与来源",
    Boolean(feishuCmd) && feishuCmd.text === "帮我分析上周线索转化" && feishuCmd.from === "ou_test_1",
    feishuCmd ? `#${feishuCmd.id} ${feishuCmd.text}` : "未找到",
  );

  // 9. 签名错误拒绝
  const badSigRes = await fetch(`http://127.0.0.1:${gw.port}/feishu/event`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Lark-Request-Timestamp": ts,
      "X-Lark-Request-Nonce": nonce,
      "X-Lark-Signature": "deadbeef",
    },
    body: rawBody,
  });
  check("错误签名拒绝", badSigRes.status === 401, `status=${badSigRes.status}`);

  // 10. 非文本消息给出占位说明（不猜内容）
  const cardEvent = {
    header: { event_id: "evt-card-1" },
    event: {
      sender: { sender_id: { open_id: "ou_test_2" } },
      message: { message_id: "om_2", message_type: "interactive", content: "{}" },
    },
  };
  await postJson(gw.port, "/feishu/event", cardEvent);
  const afterCard = await (await fetch(`http://127.0.0.1:${gw.port}/api/commands?secret=${encodeURIComponent(SECRET)}&since=0`)).json();
  const cardCmd = afterCard.commands.find((item) => item.eventId === "evt-card-1");
  check(
    "非文本消息记录为占位指令",
    Boolean(cardCmd) && cardCmd.text.includes("暂不支持"),
    cardCmd ? cardCmd.text : "未找到",
  );

  // 11. extractFeishuText 纯函数
  const extracted = extractFeishuText({
    header: { event_id: "e" },
    event: { message: { message_type: "text", content: JSON.stringify({ text: "@_user_1  生成海报 " }) } },
  });
  check("文本抽取去 @ 占位", extracted.text === "生成海报", `text=${extracted.text}`);

  gw.server.close();
  console.log(`\n${failed === 0 ? "全部通过" : `${failed} 项失败`}`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
