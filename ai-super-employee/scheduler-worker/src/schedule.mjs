/**
 * 常驻调度骨架 · 纯逻辑（到期判定 + 本地持久化）。
 *
 * ⚠ 双份维护点：这里的 todayAt / isDue / nextRunAt / nextRunLabel 是前端
 * src/cloud/pipeline.ts 同名函数的服务端重写（不能直接 import 前端 TS）。
 * 改判定语义时两边必须同步改，并跑两边测试（test:pipeline 与本 worker 自测）。
 *
 * 安全边界：worker 只做「存计划 + 算到期 + 记历史 + 心跳」，**不代跑需登录态的
 * LLM 任务**。关页面期间到期计划会积压，页面重开时前端拉 due 补跑并回写运行记录。
 * 真 7×24 代跑需要云端执行身份（账号 session），后置，见接入清单。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const MAX_SCHEDULES = 50;
export const MAX_RUNS = 200;
const DAY_MS = 86_400_000;

/** 当天的 "HH:MM" 对应本地时间戳（与 pipeline.ts todayAt 一致）。 */
export function todayAt(time, now) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(time ?? "").trim());
  const date = new Date(now);
  date.setSeconds(0, 0);
  if (!match) {
    date.setHours(9, 0, 0, 0);
    return date.getTime();
  }
  date.setHours(Math.min(23, Number(match[1])), Math.min(59, Number(match[2])), 0, 0);
  return date.getTime();
}

/** 下一次展示用触发时刻（与 pipeline.ts nextRunAt 一致）。 */
export function nextRunAt(schedule, now) {
  if (schedule.mode === "interval") {
    const hours = Math.max(1, schedule.hours || 24);
    const base = schedule.lastRunAt ?? schedule.createdAt;
    const next = base + hours * 3_600_000;
    return next > now ? next : now + 60_000;
  }
  const today = todayAt(schedule.time, now);
  if (now < today) return today;
  return today + DAY_MS;
}

/**
 * 是否到点（与 pipeline.ts isDue 一致）：
 * - 每日：今天触发时刻已到且今天还没跑过（错过补跑一次）；
 * - 间隔：距上次运行（首次为创建时间）已满 hours 小时；
 * - 停用或空步骤永不到期。
 */
export function isDue(schedule, now) {
  if (!schedule.enabled || !Array.isArray(schedule.steps) || !schedule.steps.length) return false;
  if (schedule.mode === "interval") {
    const hours = Math.max(1, schedule.hours || 24);
    const base = schedule.lastRunAt ?? schedule.createdAt;
    return now >= base + hours * 3_600_000;
  }
  const today = todayAt(schedule.time, now);
  return now >= today && (schedule.lastRunAt ?? 0) < today;
}

/** 下次触发展示文案（与 pipeline.ts nextRunLabel 一致）。 */
export function nextRunLabel(schedule, now) {
  if (!schedule.enabled) return "已停用";
  if (schedule.mode === "interval") {
    const hours = Math.max(1, schedule.hours || 24);
    const base = schedule.lastRunAt ?? schedule.createdAt;
    const remain = base + hours * 3_600_000 - now;
    if (remain <= 0) return "待补跑";
    if (remain < 3_600_000) return `${Math.max(1, Math.round(remain / 60_000))} 分钟后`;
    return `${Math.round(remain / 3_600_000)} 小时后`;
  }
  const today = todayAt(schedule.time, now);
  if (now < today) return `今天 ${schedule.time}`;
  if ((schedule.lastRunAt ?? 0) < today) return "待补跑";
  return `明天 ${schedule.time}`;
}

export function dueSchedules(list, now) {
  return (Array.isArray(list) ? list : []).filter((row) => isDue(row, now));
}

/** 归一化一条计划（前端同步过来的形状与 pipeline.ts Pipeline 对齐，历史不收，只收调度字段）。 */
export function normalizeSchedule(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = String(raw.id ?? "").trim().slice(0, 80);
  if (!id) return null;
  const mode = raw.mode === "interval" ? "interval" : "daily";
  const timeMatch = /^(\d{1,2}):(\d{2})$/.exec(String(raw.time ?? ""));
  const time = timeMatch
    ? `${String(Math.min(23, Number(timeMatch[1]))).padStart(2, "0")}:${String(Math.min(59, Number(timeMatch[2]))).padStart(2, "0")}`
    : "09:00";
  const hours = Math.min(168, Math.max(1, Math.round(Number(raw.hours) || 24)));
  const createdAt = Number.isFinite(Number(raw.createdAt)) ? Number(raw.createdAt) : Date.now();
  const lastRunAt = raw.lastRunAt == null || !Number.isFinite(Number(raw.lastRunAt)) ? null : Number(raw.lastRunAt);
  const steps = Array.isArray(raw.steps)
    ? raw.steps
        .filter((step) => step && typeof step === "object" && typeof step.kind === "string")
        .slice(0, 20)
        .map((step) => ({
          id: String(step.id ?? "").slice(0, 80),
          kind: String(step.kind).slice(0, 40),
          params: step.params && typeof step.params === "object" ? step.params : {},
        }))
    : [];
  return {
    id,
    name: String(raw.name ?? "未命名流水线").trim().slice(0, 60) || "未命名流水线",
    enabled: raw.enabled === true,
    mode,
    time,
    hours,
    createdAt,
    lastRunAt,
    steps,
  };
}

/** 归一化一条运行回写记录。 */
export function normalizeRun(raw) {
  if (!raw || typeof raw !== "object") return null;
  const scheduleId = String(raw.scheduleId ?? raw.pipelineId ?? "").trim().slice(0, 80);
  if (!scheduleId) return null;
  const status = ["done", "partial", "failed"].includes(raw.status) ? raw.status : "failed";
  const at = Number.isFinite(Number(raw.at)) ? Number(raw.at) : Date.now();
  const durationMs = Math.max(0, Math.round(Number(raw.durationMs) || 0));
  const steps = Array.isArray(raw.steps)
    ? raw.steps.slice(0, 20).map((step) => ({
        stepId: String(step?.stepId ?? "").slice(0, 80),
        kind: String(step?.kind ?? "").slice(0, 40),
        label: String(step?.label ?? "").slice(0, 120),
        status: step?.status === "done" ? "done" : "failed",
        detail: String(step?.detail ?? "").slice(0, 300),
      }))
    : [];
  return { scheduleId, at, status, durationMs, steps };
}

function readJson(file, fallback) {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

/**
 * 本地持久化：data/schedules.json + data/runs.json。
 * 计划由前端整表同步覆盖；运行记录只追加、封顶 MAX_RUNS，并回填计划 lastRunAt。
 */
export function createScheduleStore(dataDir) {
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  const schedulesFile = join(dataDir, "schedules.json");
  const runsFile = join(dataDir, "runs.json");

  let schedules = readJson(schedulesFile, []);
  if (!Array.isArray(schedules)) schedules = [];
  schedules = schedules.map(normalizeSchedule).filter(Boolean).slice(0, MAX_SCHEDULES);

  let runs = readJson(runsFile, []);
  if (!Array.isArray(runs)) runs = [];
  runs = runs.map(normalizeRun).filter(Boolean).slice(0, MAX_RUNS);

  const saveSchedules = () => writeFileSync(schedulesFile, JSON.stringify(schedules, null, 1), "utf8");
  const saveRuns = () => writeFileSync(runsFile, JSON.stringify(runs, null, 1), "utf8");

  /** 整表覆盖同步（前端是真源，worker 只镜像调度字段）。返回实际存入条数。 */
  function replaceSchedules(list) {
    const next = (Array.isArray(list) ? list : []).map(normalizeSchedule).filter(Boolean).slice(0, MAX_SCHEDULES);
    // 保留 worker 侧已回填的 lastRunAt（前端可能还没同步到最新运行）
    const prevById = new Map(schedules.map((row) => [row.id, row]));
    schedules = next.map((row) => {
      const prev = prevById.get(row.id);
      const lastRunAt = Math.max(row.lastRunAt ?? 0, prev?.lastRunAt ?? 0) || null;
      return { ...row, lastRunAt };
    });
    saveSchedules();
    return schedules.length;
  }

  function listSchedules() {
    return schedules.map((row) => ({ ...row }));
  }

  function listDue(now) {
    return dueSchedules(schedules, now).map((row) => ({ ...row, nextRunLabel: nextRunLabel(row, now) }));
  }

  /** 前端执行后回写：追加运行记录并更新对应计划 lastRunAt。 */
  function appendRun(raw) {
    const run = normalizeRun(raw);
    if (!run) return null;
    runs = [run, ...runs].slice(0, MAX_RUNS);
    saveRuns();
    const target = schedules.find((row) => row.id === run.scheduleId);
    if (target) {
      target.lastRunAt = Math.max(target.lastRunAt ?? 0, run.at);
      saveSchedules();
    }
    return run;
  }

  function listRuns(limit = 50) {
    const n = Math.min(MAX_RUNS, Math.max(1, Math.round(Number(limit) || 50)));
    return runs.slice(0, n);
  }

  function counts() {
    return { schedules: schedules.length, enabled: schedules.filter((row) => row.enabled).length, runs: runs.length };
  }

  return { replaceSchedules, listSchedules, listDue, appendRun, listRuns, counts };
}
