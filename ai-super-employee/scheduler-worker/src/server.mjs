/**
 * 常驻调度 worker（骨架）。
 *
 * 接口（adminSecret 鉴权，优先 x-admin-secret 头，?secret= 兼容）：
 *   GET  /health          心跳（版本 + 计数，无需鉴权）
 *   POST /api/schedules   整表同步计划 { schedules: [...] }
 *   GET  /api/schedules   读回已同步计划
 *   GET  /api/due         当前到期计划（?now= 可注入时间戳便于联调）
 *   POST /api/runs        前端执行后回写运行记录 { scheduleId, at, status, durationMs, steps }
 *   GET  /api/runs        运行历史（?limit=，上限 200）
 *
 * 安全边界（与 im-bot-gateway 一致）：worker 只做「存计划 + 算到期 + 记历史 + 心跳」，
 * **不代跑需登录态的 LLM 任务**。关页面期间到期计划会积压，页面重开时前端拉 due
 * 补跑并回写。真 7×24 代跑需要云端执行身份，后置——本骨架不冒充已实现。
 */
import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { timingSafeEqual } from "node:crypto";
import { createScheduleStore } from "./schedule.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const WORKER_VERSION = "1.0.0";

export function loadConfig(configPath = join(ROOT, "config.json")) {
  const raw = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : {};
  return {
    port: Number(process.env.PORT ?? raw.port ?? 8789),
    adminSecret: process.env.ADMIN_SECRET ?? raw.adminSecret ?? "",
    dataDir: raw.dataDir ?? join(ROOT, "data"),
  };
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a ?? ""));
  const bufB = Buffer.from(String(b ?? ""));
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

function adminAuthorized(req, url, config) {
  if (!config.adminSecret) return false;
  const header = req.headers["x-admin-secret"];
  const fromHeader = Array.isArray(header) ? header[0] : header;
  return safeEqual(fromHeader, config.adminSecret) || safeEqual(url.searchParams.get("secret"), config.adminSecret);
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
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, x-admin-secret",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    ...headers,
  });
  res.end(JSON.stringify(payload));
}

export function createService({ config, logger = console }) {
  const store = createScheduleStore(config.dataDir);
  const startedAt = Date.now();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (req.method === "OPTIONS") {
      sendJson(res, 204, {});
      return;
    }

    if (url.pathname === "/health" && req.method === "GET") {
      sendJson(res, 200, {
        ok: true,
        service: "scheduler-worker",
        version: WORKER_VERSION,
        uptimeMs: Date.now() - startedAt,
        ...store.counts(),
      });
      return;
    }

    if (!url.pathname.startsWith("/api/")) {
      sendJson(res, 404, { ok: false, error: "not found" });
      return;
    }

    if (!adminAuthorized(req, url, config)) {
      sendJson(res, 403, { ok: false, error: "forbidden" });
      return;
    }

    try {
      if (url.pathname === "/api/schedules" && req.method === "POST") {
        const body = JSON.parse((await readBody(req)) || "{}");
        if (!Array.isArray(body.schedules)) {
          sendJson(res, 400, { ok: false, error: "schedules 必须是数组" });
          return;
        }
        const count = store.replaceSchedules(body.schedules);
        logger.info(`计划同步：${count} 条`);
        sendJson(res, 200, { ok: true, count });
        return;
      }

      if (url.pathname === "/api/schedules" && req.method === "GET") {
        sendJson(res, 200, { ok: true, schedules: store.listSchedules() }, { "Cache-Control": "no-store" });
        return;
      }

      if (url.pathname === "/api/due" && req.method === "GET") {
        const nowParam = Number(url.searchParams.get("now") ?? 0);
        const now = Number.isFinite(nowParam) && nowParam > 0 ? nowParam : Date.now();
        const due = store.listDue(now);
        sendJson(res, 200, { ok: true, now, due }, { "Cache-Control": "no-store" });
        return;
      }

      if (url.pathname === "/api/runs" && req.method === "POST") {
        const body = JSON.parse((await readBody(req)) || "{}");
        const run = store.appendRun(body);
        if (!run) {
          sendJson(res, 400, { ok: false, error: "scheduleId 不能为空" });
          return;
        }
        sendJson(res, 200, { ok: true, run });
        return;
      }

      if (url.pathname === "/api/runs" && req.method === "GET") {
        sendJson(res, 200, { ok: true, runs: store.listRuns(url.searchParams.get("limit") ?? 50) }, { "Cache-Control": "no-store" });
        return;
      }

      sendJson(res, 404, { ok: false, error: "not found" });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : "bad request" });
    }
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
    console.log(`常驻调度 worker 已启动：http://127.0.0.1:${config.port}（v${WORKER_VERSION}）`);
    console.log("控制台「定时任务」→「常驻调度」卡填写：服务地址 + adminSecret 后点「同步计划」");
    console.log("边界：本服务只存计划/算到期/记历史，不代跑需登录态的任务");
  });
}
