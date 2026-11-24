/**
 * IM 远程指令网关。
 *
 * 入口：
 *   POST /feishu/event   飞书事件订阅（url_verification 挑战 + 消息事件，明文/加密双模式）
 *   POST /api/command    通用 HTTP 指令入口（任何 IM 桥、脚本、curl 都能用，现在即可联调）
 *
 * 出口（控制台「远程指令」模块调用，adminSecret 鉴权）：
 *   GET  /api/commands?secret&since&status   拉取指令队列
 *   POST /api/commands/update                回写状态（done / dismissed）
 *   GET  /health                             健康检查
 *
 * 设计约束：网关**不执行任务**。执行必须回到控制台登录态，
 * 由用户确认后用本人身份跑——服务端没有账号 session，越权执行会破坏多租户隔离。
 */
import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { timingSafeEqual } from "node:crypto";
import { parseEventBody, larkSignature } from "./crypto.mjs";
import { createCommandStore, extractFeishuText } from "./commands.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export function loadConfig(configPath = join(ROOT, "config.json")) {
  const raw = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : {};
  return {
    port: Number(process.env.PORT ?? raw.port ?? 8788),
    adminSecret: process.env.ADMIN_SECRET ?? raw.adminSecret ?? "",
    // 飞书自建应用：事件订阅的 Verification Token 与 Encrypt Key（后续接入时填写）
    feishuVerificationToken: process.env.FEISHU_VERIFICATION_TOKEN ?? raw.feishuVerificationToken ?? "",
    feishuEncryptKey: process.env.FEISHU_ENCRYPT_KEY ?? raw.feishuEncryptKey ?? "",
    dataDir: raw.dataDir ?? join(ROOT, "data"),
  };
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a ?? ""));
  const bufB = Buffer.from(String(b ?? ""));
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

function adminAuthorized(req, url) {
  if (!req._gatewayConfig.adminSecret) return false;
  const header = req.headers["x-admin-secret"];
  const fromHeader = Array.isArray(header) ? header[0] : header;
  return safeEqual(fromHeader, req._gatewayConfig.adminSecret) || safeEqual(url.searchParams.get("secret"), req._gatewayConfig.adminSecret);
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

function sendJson(res, status, payload, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...headers });
  res.end(JSON.stringify(payload));
}

export function createService({ config, logger = console }) {
  const store = createCommandStore(config.dataDir);

  async function handleFeishuEvent(req, res, rawBody) {
    // 签名校验：飞书开启加密/签名时会带 X-Lark-Signature；缺失时只放行明文挑战
    const timestamp = req.headers["x-lark-request-timestamp"] ?? "";
    const nonce = req.headers["x-lark-request-nonce"] ?? "";
    const signature = req.headers["x-lark-signature"] ?? "";
    if (signature) {
      const expected = larkSignature({ timestamp, nonce, encryptKey: config.feishuEncryptKey, body: rawBody });
      if (!safeEqual(signature, expected)) {
        sendJson(res, 401, { ok: false, error: "invalid signature" });
        logger.warn("飞书回调签名校验失败");
        return;
      }
    }

    const { payload, error } = parseEventBody(rawBody, {
      encryptKey: config.feishuEncryptKey,
      verificationToken: config.feishuVerificationToken,
    });
    if (error || !payload) {
      sendJson(res, 401, { ok: false, error: error ?? "bad payload" });
      logger.warn(`飞书回调解析失败：${error ?? "未知错误"}`);
      return;
    }

    // URL 验证：把 challenge 原样回给飞书
    if (payload.type === "url_verification") {
      sendJson(res, 200, { challenge: payload.challenge });
      logger.info("飞书 URL 验证通过");
      return;
    }

    const { text, from, eventId } = extractFeishuText(payload);
    if (text) {
      const { command, created } = store.enqueue({ text, source: "feishu", from, eventId });
      logger.info(created ? `收到飞书指令 #${command.id}：${text.slice(0, 40)}` : "飞书事件重复，已忽略");
    }
    // 风格要求：快速返回 200 空对象，避免飞书侧重推
    sendJson(res, 200, {});
  }

  const server = http.createServer(async (req, res) => {
    req._gatewayConfig = config;
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (url.pathname === "/health") {
      sendJson(res, 200, { ok: true, pending: store.listSince(0, "pending").commands.length });
      return;
    }

    // 通用 HTTP 指令入口：现在就能用（curl / 其他 IM 桥）
    if (url.pathname === "/api/command" && req.method === "POST") {
      if (!adminAuthorized(req, url)) {
        sendJson(res, 403, { ok: false, error: "forbidden" });
        return;
      }
      try {
        const raw = await readBody(req);
        const body = raw ? JSON.parse(raw) : {};
        const { command, created } = store.enqueue({
          text: body.text,
          source: body.source ?? "http",
          from: body.from ?? "",
          eventId: body.eventId ?? "",
        });
        if (!command) {
          sendJson(res, 400, { ok: false, error: "text 不能为空" });
          return;
        }
        sendJson(res, 200, { ok: true, created, command });
      } catch (error) {
        sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : "bad request" });
      }
      return;
    }

    // 队列拉取
    if (url.pathname === "/api/commands" && req.method === "GET") {
      if (!adminAuthorized(req, url)) {
        sendJson(res, 403, { ok: false, error: "forbidden" });
        return;
      }
      const since = Number(url.searchParams.get("since") ?? 0);
      const status = url.searchParams.get("status") ?? "";
      const payload = store.listSince(Number.isFinite(since) ? since : 0, status);
      sendJson(res, 200, { ok: true, ...payload }, { "Cache-Control": "no-store" });
      return;
    }

    // 状态回写
    if (url.pathname === "/api/commands/update" && req.method === "POST") {
      if (!adminAuthorized(req, url)) {
        sendJson(res, 403, { ok: false, error: "forbidden" });
        return;
      }
      try {
        const body = JSON.parse((await readBody(req)) || "{}");
        const command = store.setStatus(body.id, body.status);
        if (!command) {
          sendJson(res, 404, { ok: false, error: "指令不存在或状态非法" });
          return;
        }
        sendJson(res, 200, { ok: true, command });
      } catch (error) {
        sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : "bad request" });
      }
      return;
    }

    // 飞书事件订阅
    if (url.pathname === "/feishu/event" && req.method === "POST") {
      try {
        const rawBody = await readBody(req);
        await handleFeishuEvent(req, res, rawBody);
      } catch (error) {
        sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : "bad request" });
      }
      return;
    }

    sendJson(res, 404, { ok: false, error: "not found" });
  });

  return { server, store };
}

/* 直接运行：node src/server.mjs */
const isMain = process.argv[1] && process.argv[1].endsWith("server.mjs");
if (isMain) {
  const config = loadConfig();
  if (!config.adminSecret) {
    console.error("缺少 adminSecret：请复制 config.example.json 为 config.json 并填写，或设置环境变量 ADMIN_SECRET");
    process.exit(1);
  }
  const { server } = createService({ config });
  server.listen(config.port, () => {
    console.log(`IM 远程指令网关已启动：http://127.0.0.1:${config.port}`);
    console.log(`飞书事件地址：https://你的域名/feishu/event${config.feishuEncryptKey ? "（加密模式）" : "（明文模式）"}`);
    console.log(`控制台「远程指令」填写：服务地址 http://127.0.0.1:${config.port} · 密钥 adminSecret`);
    if (!config.feishuVerificationToken) console.log("提示：尚未配置飞书 Token，HTTP 入口 /api/command 可先用");
  });
}
