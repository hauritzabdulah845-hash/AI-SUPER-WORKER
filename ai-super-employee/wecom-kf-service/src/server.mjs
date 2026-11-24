/**
 * 微信客服自动回复服务。
 *
 * 职责：接住企微回调 → 拉消息 → 规则匹配 → 回内容或 AI 名片。
 * 关键约束：回调必须 5 秒内响应，所以先回 success 再异步处理。
 */
import http from "node:http";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { decrypt, signature, parseXml, escapeXml } from "./crypto.mjs";
import { WecomClient } from "./wecom.mjs";
import { matchRule, pickRuleByAI, buildReply } from "./rules.mjs";
import { createCustomerStore, renderTemplate } from "./customers.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export function loadConfig(configPath = join(ROOT, "config.json")) {
  const raw = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : {};
  const config = {
    port: Number(process.env.PORT ?? raw.port ?? 8787),
    corpId: process.env.CORP_ID ?? raw.corpId ?? "",
    kfSecret: process.env.KF_SECRET ?? raw.kfSecret ?? "",
    token: process.env.CALLBACK_TOKEN ?? raw.token ?? "",
    encodingAesKey: process.env.ENCODING_AES_KEY ?? raw.encodingAesKey ?? "",
    miniAppId: process.env.MINI_APP_ID ?? raw.miniAppId ?? "",
    miniTitle: raw.miniTitle ?? "AI 名片",
    miniPagePath: raw.miniPagePath ?? "pages/card/index",
    miniThumbMediaId: raw.miniThumbMediaId ?? "",
    deepseekKey: process.env.DEEPSEEK_KEY ?? raw.deepseekKey ?? "",
    aiFallback: raw.aiFallback === true,
    mock: raw.mock === true,
    adminSecret: process.env.ADMIN_SECRET ?? raw.adminSecret ?? "",
    dataDir: raw.dataDir ?? join(ROOT, "data"),
  };
  return config;
}

export function loadRules(rulesPath = join(ROOT, "rules.json")) {
  if (!existsSync(rulesPath)) return [];
  return JSON.parse(readFileSync(rulesPath, "utf8"));
}

/** cursor / 去重集合的简易持久化：重启不丢，避免重复回复。 */
function createStore(dataDir) {
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, "state.json");
  let state = { cursors: {}, seenMsgIds: [] };
  if (existsSync(file)) {
    try {
      state = { cursors: {}, seenMsgIds: [], ...JSON.parse(readFileSync(file, "utf8")) };
    } catch {
      // 状态文件损坏就重置，宁可多发一条也不阻塞服务
    }
  }
  const save = () => writeFileSync(file, JSON.stringify(state), "utf8");
  return {
    getCursor: (openKfid) => state.cursors[openKfid] ?? "",
    setCursor: (openKfid, cursor) => {
      state.cursors[openKfid] = cursor;
      save();
    },
    isSeen: (msgId) => state.seenMsgIds.includes(msgId),
    markSeen: (msgId) => {
      state.seenMsgIds.push(msgId);
      if (state.seenMsgIds.length > 500) state.seenMsgIds = state.seenMsgIds.slice(-500);
      save();
    },
  };
}

export function createService({ config, rules, logger = console }) {
  const client = new WecomClient(config);
  const store = createStore(config.dataDir);
  const customers = createCustomerStore(config.dataDir);

  /** 异步处理一条客服事件：拉消息 → 逐条匹配 → 回复。 */
  async function handleKfEvent({ kfToken, openKfid }) {
    try {
      const cursor = store.getCursor(openKfid);
      const data = await client.syncMsg({ kfToken, openKfid, cursor });

      for (const msg of data.msg_list ?? []) {
        // origin=3 是微信客户发送的消息，其余是接待人员或系统事件
        if (msg.origin !== 3) continue;
        if (store.isSeen(msg.msgid)) continue;
        store.markSeen(msg.msgid);
        if (msg.msgtype !== "text") {
          // 非文本消息目前不回复，但仍记一笔，保证控制台能看到客户发过什么
          customers.touch({ externalUserId: msg.external_userid, openKfid, text: `[${msg.msgtype}]`, at: msg.send_time ? new Date(msg.send_time * 1000).toISOString() : undefined });
          customers.record({ externalUserId: msg.external_userid, direction: "in", type: msg.msgtype, text: `[${msg.msgtype}]` });
          logger.info(`收到非文本消息（${msg.msgtype}），已记录未回复`);
          continue;
        }

        const text = msg.text?.content ?? "";
        const at = msg.send_time ? new Date(msg.send_time * 1000).toISOString() : new Date().toISOString();
        const customer = customers.touch({ externalUserId: msg.external_userid, openKfid, text, at });
        customers.record({ externalUserId: msg.external_userid, direction: "in", text, at });

        let rule = matchRule(rules, text);
        if (!rule && config.aiFallback && config.deepseekKey) {
          rule = await pickRuleByAI({ rules, text, apiKey: config.deepseekKey });
        }
        const reply = buildReply(rule, config);
        if (!reply) {
          logger.warn(`未命中任何规则，客户消息：${text}`);
          continue;
        }

        if (reply.type === "miniprogram") {
          await client.sendMiniProgram({
            externalUserId: msg.external_userid,
            openKfid,
            appid: reply.appid,
            title: reply.title,
            pagepath: reply.pagepath,
            thumbMediaId: reply.thumbMediaId,
          });
          customers.record({ externalUserId: msg.external_userid, direction: "out", type: "miniprogram", text: `[AI 名片] ${reply.title}`, ruleId: rule?.id ?? "" });
          logger.info(`已向 ${msg.external_userid}（${customer?.name}）发送小程序名片：${reply.pagepath}`);
        } else {
          const content = renderTemplate(reply.content, customer);
          await client.sendText({
            externalUserId: msg.external_userid,
            openKfid,
            content,
          });
          customers.record({ externalUserId: msg.external_userid, direction: "out", text: content, ruleId: rule?.id ?? "" });
          logger.info(`已向 ${msg.external_userid}（${customer?.name}）发送文本回复（${content.length} 字）`);
        }
      }

      if (data.next_cursor) store.setCursor(openKfid, data.next_cursor);
    } catch (error) {
      logger.error(`处理客服事件失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
        if (body.length > 1_000_000) {
          reject(new Error("请求体过大"));
          req.destroy();
        }
      });
      req.on("end", () => resolve(body));
      req.on("error", reject);
    });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, mock: config.mock, rules: rules.length }));
      return;
    }

    // 规则只读查看：方便客户排查「为什么没回复」，用 config.adminSecret 保护
    if (url.pathname === "/admin/rules") {
      const secret = url.searchParams.get("secret") ?? "";
      if (!config.adminSecret || secret !== config.adminSecret) {
        res.writeHead(403);
        res.end("forbidden");
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ rules, sent: client.sent.slice(-20) }, null, 2));
      return;
    }

    // 控制台同步接口：把企微侧的客户档案与对话记录交给登录态的前端落库
    if (url.pathname === "/api/sync") {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Headers", "content-type");
      res.setHeader("Cache-Control", "no-store");
      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }
      const secret = url.searchParams.get("secret") ?? "";
      if (!config.adminSecret || secret !== config.adminSecret) {
        res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: "forbidden" }));
        return;
      }
      const since = Number(url.searchParams.get("since") ?? 0);
      const payload = customers.since(Number.isFinite(since) ? since : 0);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, ...payload }));
      return;
    }

    if (url.pathname !== "/wecom/callback") {
      res.writeHead(404);
      res.end("not found");
      return;
    }

    const msgSignature = url.searchParams.get("msg_signature") ?? "";
    const timestamp = url.searchParams.get("timestamp") ?? "";
    const nonce = url.searchParams.get("nonce") ?? "";

    // URL 验证：企微用 GET 发 echostr，需解密后原样返回明文
    if (req.method === "GET") {
      const echostr = url.searchParams.get("echostr") ?? "";
      if (!echostr || signature(config.token, timestamp, nonce, echostr) !== msgSignature) {
        res.writeHead(401);
        res.end("invalid signature");
        logger.warn("回调校验失败：签名不匹配，请核对 Token");
        return;
      }
      try {
        const { message } = decrypt(echostr, config.encodingAesKey);
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(message);
        logger.info("回调 URL 验证通过");
      } catch (error) {
        res.writeHead(500);
        res.end("decrypt failed");
        logger.error(`echostr 解密失败：${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }

    if (req.method === "POST") {
      try {
        const body = await readBody(req);
        const outer = parseXml(body);
        const encrypt = outer.Encrypt ?? "";
        if (!encrypt || signature(config.token, timestamp, nonce, encrypt) !== msgSignature) {
          res.writeHead(401);
          res.end("invalid signature");
          logger.warn("消息回调签名校验失败");
          return;
        }
        const { message, receiveId } = decrypt(encrypt, config.encodingAesKey);
        if (receiveId && config.corpId && receiveId !== config.corpId) {
          logger.warn(`receiveid 与企业号不一致：${receiveId}，请核对 corpid`);
        }
        const inner = parseXml(message);

        // 先响应，后处理：企微要求 5 秒内拿到响应，超时会重试
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("success");

        if (inner.Event === "kf_msg_or_event" && inner.Token && inner.OpenKfId) {
          void handleKfEvent({ kfToken: inner.Token, openKfid: inner.OpenKfId });
        }
        return;
      } catch (error) {
        res.writeHead(500);
        res.end("bad request");
        logger.error(`回调处理失败：${error instanceof Error ? error.message : String(error)}`);
        return;
      }
    }

    res.writeHead(405);
    res.end("method not allowed");
  });

  return { server, client, store };
}

/* 直接运行：node src/server.mjs */
const isMain = process.argv[1] && process.argv[1].endsWith("server.mjs");
if (isMain) {
  const config = loadConfig();
  const rules = loadRules();
  const missing = ["corpId", "kfSecret", "token", "encodingAesKey", "miniAppId"].filter((key) => !config[key]);
  if (missing.length && !config.mock) {
    console.error(`缺少配置项：${missing.join(", ")}，请在 config.json 或环境变量中补齐`);
    process.exit(1);
  }
  const { server } = createService({ config, rules });
  server.listen(config.port, () => {
    console.log(`微信客服自动回复服务已启动：http://127.0.0.1:${config.port}${config.mock ? "（MOCK 模式）" : ""}`);
    console.log(`回调地址请填写：https://你的域名/wecom/callback`);
    console.log(`已加载规则 ${rules.length} 条`);
  });
}
