/**
 * 本地自测：不连企业微信，用真实加解密算法构造回调包，验证服务端全链路。
 *
 * 覆盖：URL 验证回显 → 事件解密 → 消息同步 → 规则命中（名片/文本/兜底）
 *       → 重复消息去重 → 错误签名拒绝。
 * MOCK 模式不真正调用企微接口，发送报文记录在 client.sent 里供断言。
 */
import os from "node:os";
import http from "node:http";
import crypto from "node:crypto";
import { readFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { createService } from "../src/server.mjs";
import { encrypt, signature } from "../src/crypto.mjs";
import { renderTemplate, guessStage } from "../src/customers.mjs";

const rules = JSON.parse(readFileSync(new URL("../rules.json", import.meta.url), "utf8"));
const aesKey = crypto.randomBytes(32).toString("base64").slice(0, 43);
const token = "test-callback-token";
const corpId = "wwtest1234567890";
const silent = { info() {}, warn() {}, error() {} };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failed = 0;

function baseConfig(overrides = {}) {
  return {
    port: 0,
    corpId,
    kfSecret: "test-secret",
    token,
    encodingAesKey: aesKey,
    miniAppId: "wxappid123456",
    miniTitle: "AI 名片",
    miniPagePath: "pages/card/index",
    deepseekKey: "",
    aiFallback: false,
    mock: true,
    adminSecret: "test-admin-secret",
    dataDir: mkdtempSync(join(os.tmpdir(), "kf-test-")),
    mockMessages: [],
    ...overrides,
  };
}

async function start(config) {
  const { server, client } = createService({ config, rules, logger: silent });
  await new Promise((resolve) => server.listen(0, resolve));
  return { server, client, port: server.address().port };
}

function check(name, ok, detail = "") {
  if (!ok) failed += 1;
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` ｜ ${detail}` : ""}`);
}

/** URL 验证：企微 GET 带加密 echostr，服务端应解密后原样返回明文。 */
async function testVerify(port) {
  const echo = "echo-plaintext-123";
  const ts = String(Math.floor(Date.now() / 1000));
  const nonce = "n1";
  const enc = encrypt(echo, aesKey, corpId);
  const sig = signature(token, ts, nonce, enc);
  const res = await fetch(
    `http://127.0.0.1:${port}/wecom/callback?msg_signature=${sig}&timestamp=${ts}&nonce=${nonce}&echostr=${encodeURIComponent(enc)}`,
  );
  const body = await res.text();
  check("URL 验证回显明文", res.status === 200 && body === echo, `status=${res.status} body=${body}`);
}

function buildEvent(overrides = {}) {
  const inner = [
    "<xml>",
    "<ToUserName><![CDATA[wwtest1234567890]]></ToUserName>",
    "<CreateTime>1700000000</CreateTime>",
    "<MsgType><![CDATA[event]]></MsgType>",
    `<Event><![CDATA[${overrides.event ?? "kf_msg_or_event"}]]></Event>`,
    "<Token><![CDATA[kf-token-abc]]></Token>",
    "<OpenKfId><![CDATA[wkTEST123]]></OpenKfId>",
    "</xml>",
  ].join("");
  const enc = encrypt(inner, aesKey, corpId);
  const ts = String(Math.floor(Date.now() / 1000));
  const nonce = "n2";
  return {
    body: `<xml><Encrypt><![CDATA[${enc}]]></Encrypt></xml>`,
    ts,
    nonce,
    sig: signature(token, ts, nonce, enc),
  };
}

async function postEvent(port, payload) {
  const res = await fetch(
    `http://127.0.0.1:${port}/wecom/callback?msg_signature=${payload.sig}&timestamp=${payload.ts}&nonce=${payload.nonce}`,
    { method: "POST", headers: { "Content-Type": "text/xml" }, body: payload.body },
  );
  return res.status;
}

async function testMessage(name, content, msgid, assertFn, configOverrides = {}) {
  const config = baseConfig({
    mockMessages: [
      { msgid, open_kfid: "wkTEST123", external_userid: "wmCUSTOMER1", origin: 3, msgtype: "text", text: { content } },
    ],
    ...configOverrides,
  });
  const { server, client, port } = await start(config);
  const status = await postEvent(port, buildEvent());
  await sleep(300);
  const ok = status === 200 && assertFn(client.sent);
  check(name, ok, `回调 ${status}，实际发送 ${client.sent.length} 条`);
  server.close();
  return { client, sent: client.sent };
}

async function main() {
  console.log("—— 微信客服自动回复服务 · 本地自测 ——\n");

  const verifier = await start(baseConfig());
  await testVerify(verifier.port);
  verifier.server.close();

  await testMessage("「了解」触发 AI 名片", "你好，想了解一下你们是做什么的", "msg-card-1", (sent) => {
    const first = sent[0];
    return (
      sent.length === 1 &&
      first.msgtype === "miniprogram" &&
      first.miniprogram.appid === "wxappid123456" &&
      first.miniprogram.pagepath === "pages/card/index" &&
      first.miniprogram.title === "AI 名片"
    );
  });

  await testMessage("「收费」触发文本回复", "你们怎么收费", "msg-price-1", (sent) => {
    const first = sent[0];
    return sent.length === 1 && first.msgtype === "text" && first.text.content.includes("2999");
  });

  await testMessage("未命中走兜底回复", "在吗", "msg-fallback-1", (sent) => {
    const first = sent[0];
    return sent.length === 1 && first.msgtype === "text" && first.text.content.includes("稍后详细回复");
  });

  // 去重：同一 msgid 到达两次，只应回复一次
  const dedupeConfig = baseConfig({
    mockMessages: [
      { msgid: "msg-dup-1", open_kfid: "wkTEST123", external_userid: "wmCUSTOMER1", origin: 3, msgtype: "text", text: { content: "想了解下" } },
    ],
  });
  const dedupe = await start(dedupeConfig);
  await postEvent(dedupe.port, buildEvent());
  await sleep(250);
  await postEvent(dedupe.port, buildEvent());
  await sleep(250);
  check("同一消息不重复回复", dedupe.client.sent.length === 1, `实际发送 ${dedupe.client.sent.length} 条`);
  dedupe.server.close();

  // 错误签名必须拒绝
  const reject = await start(baseConfig());
  const payload = buildEvent();
  const badRes = await fetch(
    `http://127.0.0.1:${reject.port}/wecom/callback?msg_signature=deadbeef&timestamp=${payload.ts}&nonce=${payload.nonce}`,
    { method: "POST", headers: { "Content-Type": "text/xml" }, body: payload.body },
  );
  check("错误签名被拒绝", badRes.status === 401, `status=${badRes.status}`);
  reject.server.close();

  // 非客服事件不触发同步
  const ignored = await start(baseConfig());
  await postEvent(ignored.port, buildEvent({ event: "other_event" }));
  await sleep(150);
  check("非客服事件不处理", ignored.client.sent.length === 0);
  ignored.server.close();

  // 客户身份打通：消息进来即建档，对话进事件流，控制台按 seq 增量拉取
  const syncConfig = baseConfig({
    mockMessages: [
      { msgid: "msg-sync-1", open_kfid: "wkTEST123", external_userid: "wmCUSTOMER9", origin: 3, msgtype: "text", text: { content: "你们怎么收费", send_time: 1700000000 } },
    ],
  });
  const sync = await start(syncConfig);
  await postEvent(sync.port, buildEvent());
  await sleep(300);
  const syncUrl = (since, secret = "test-admin-secret") =>
    `http://127.0.0.1:${sync.port}/api/sync?secret=${encodeURIComponent(secret)}&since=${since}`;
  const first = await (await fetch(syncUrl(0))).json();
  const customer = first.customers?.[0];
  const inEvent = first.events?.find((event) => event.direction === "in");
  const outEvent = first.events?.find((event) => event.direction === "out");
  check(
    "客户自动建档（来源/阶段/计数）",
    Boolean(customer) && customer.externalUserId === "wmCUSTOMER9" && customer.msgCount === 1 && customer.stage === "报价",
    customer ? `${customer.name} stage=${customer.stage} msgCount=${customer.msgCount}` : "无档案",
  );
  check(
    "对话进事件流（收 + 回）",
    Boolean(inEvent) && Boolean(outEvent) && inEvent.text.includes("收费") && outEvent.ruleId === "price",
    `events=${first.events?.length ?? 0} nextSeq=${first.nextSeq}`,
  );

  const inc = await (await fetch(syncUrl(first.nextSeq))).json();
  check("增量拉取不重复", (inc.events?.length ?? -1) === 0 && (inc.customers?.length ?? 0) === 1, `increment=${inc.events?.length ?? 0} 条`);
  const denied = await fetch(syncUrl(0, "wrong-secret"));
  check("同步接口鉴权", denied.status === 403, `status=${denied.status}`);
  sync.server.close();

  // AI 兜底必须排在默认规则之前：关键词未命中且开启 aiFallback 时，
  // AI 先在规则里挑一个；只有 AI 也给不出才落默认话术。
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("api.deepseek.com")) {
      return new Response(JSON.stringify({ choices: [{ message: { content: "demo" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return realFetch(url, init);
  };
  try {
    await testMessage(
      "AI 兜底先于默认规则",
      "最近忙不忙",
      "msg-ai-fallback-1",
      (sent) => {
        const first = sent[0];
        return sent.length === 1 && first.msgtype === "text" && first.text.content.includes("体验入口");
      },
      { aiFallback: true, deepseekKey: "test-key" },
    );
  } finally {
    globalThis.fetch = realFetch;
  }

  // 同步接口支持 x-admin-secret 请求头鉴权（密钥不再必须出现在 URL 里）
  const headerAuth = await start(baseConfig());
  const headerOk = await fetch(`http://127.0.0.1:${headerAuth.port}/api/sync?since=0`, {
    headers: { "x-admin-secret": "test-admin-secret" },
  });
  const headerBad = await fetch(`http://127.0.0.1:${headerAuth.port}/api/sync?since=0`, {
    headers: { "x-admin-secret": "wrong" },
  });
  const queryOk = await fetch(`http://127.0.0.1:${headerAuth.port}/api/sync?secret=test-admin-secret&since=0`);
  check(
    "同步接口请求头鉴权（兼容 query）",
    headerOk.status === 200 && headerBad.status === 403 && queryOk.status === 200,
    `header=${headerOk.status} bad=${headerBad.status} query=${queryOk.status}`,
  );
  headerAuth.server.close();

  // 高意向实时提醒：客户阶段跃迁进「报价」时，应向企微群机器人 webhook 推一条
  const alertBodies = [];
  const alertServer = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => { alertBodies.push(body); res.writeHead(204); res.end(); });
  });
  await new Promise((resolve) => alertServer.listen(0, resolve));
  const alertPort = alertServer.address().port;
  const alertCfg = baseConfig({
    alertWebhook: `http://127.0.0.1:${alertPort}/hook`,
    mockMessages: [
      { msgid: "msg-alert-1", open_kfid: "wkTEST123", external_userid: "wmHOT1", origin: 3, msgtype: "text", text: { content: "你们专业版多少钱？" } },
      { msgid: "msg-alert-2", open_kfid: "wkTEST123", external_userid: "wmHOT2", origin: 3, msgtype: "text", text: { content: "在吗" } },
    ],
  });
  const alert = await start(alertCfg);
  await postEvent(alert.port, buildEvent());
  await sleep(400);
  const hotAlerts = alertBodies.filter((body) => body.includes("高意向客户提醒"));
  const coldAlerts = alertBodies.filter((body) => body.includes("wmHOT2"));
  check(
    "高意向跃迁推送提醒、普通消息不推",
    hotAlerts.length === 1 && hotAlerts[0].includes("报价") && coldAlerts.length === 0,
    `推送 ${alertBodies.length} 条，其中高意向 ${hotAlerts.length} 条`,
  );
  alert.server.close();
  alertServer.close();

  // 规则话术模板变量：未知客户称呼用「你」，已知用名字
  check("模板变量 {{name}} 替换", renderTemplate("你好{{name}}，我们按项目报价", null) === "你好你，我们按项目报价" && renderTemplate("{{name}}你好", { named: true, name: "王总" }) === "王总你好");
  check("阶段粗判", guessStage("可以先试用吗") === "试用" && guessStage("多少钱") === "报价" && guessStage("嗯嗯") === "新建", `${guessStage("可以先试用吗")}/${guessStage("多少钱")}/${guessStage("嗯嗯")}`);

  console.log(`\n${failed === 0 ? "全部通过" : `${failed} 项失败`}`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
