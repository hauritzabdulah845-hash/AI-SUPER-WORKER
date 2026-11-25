/**
 * 常驻调度 worker 前端对接（骨架）。
 *
 * worker（scheduler-worker/）只做「存计划 + 算到期 + 记历史 + 心跳」，
 * **不代跑需登录态的 LLM 任务**：关页面期间到期计划会积压，页面重开时
 * 前端拉 due 补跑并回写。真 7×24 代跑需要云端执行身份，后置。
 *
 * 配置（地址 + 密钥）只存本机 localStorage，与 CommandInbox 同一套架构。
 * 所有函数失败如实抛错/返回状态，不静默吞掉。
 */
import type { Pipeline, PipelineRun } from "./pipeline";

export interface SchedulerConfig {
  baseUrl: string;
  secret: string;
}

export interface SchedulerHealth {
  ok: boolean;
  version?: string;
  uptimeMs?: number;
  schedules?: number;
  enabled?: number;
  runs?: number;
}

const STORAGE_KEY = "ai-employee:scheduler";

export function loadSchedulerConfig(): SchedulerConfig {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) return { baseUrl: "", secret: "", ...(JSON.parse(raw) as Partial<SchedulerConfig>) };
  } catch {
    // 配置损坏按未配置处理
  }
  return { baseUrl: "", secret: "" };
}

export function saveSchedulerConfig(config: SchedulerConfig): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch {
    // 隐私模式写失败不影响本次会话
  }
}

function baseOf(config: SchedulerConfig): string {
  return config.baseUrl.trim().replace(/\/+$/, "");
}

export function schedulerConfigured(config: SchedulerConfig): boolean {
  return Boolean(config.baseUrl.trim() && config.secret.trim());
}

async function call<T>(config: SchedulerConfig, path: string, init?: RequestInit): Promise<T> {
  const base = baseOf(config);
  if (!base) throw new Error("尚未填写调度服务地址");
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", "x-admin-secret": config.secret, ...(init?.headers ?? {}) },
  });
  if (res.status === 403) throw new Error("密钥不对，请核对 scheduler-worker config.json 的 adminSecret");
  if (!res.ok) throw new Error(`调度服务返回 ${res.status}，检查地址与服务是否在运行`);
  const payload = (await res.json()) as { ok?: boolean; error?: string } & T;
  if (payload.ok === false) throw new Error(payload.error || "调度服务返回异常");
  return payload;
}

/** 心跳检查（无需密钥语义，但统一走同一通道便于报错一致）。 */
export async function checkHealth(config: SchedulerConfig): Promise<SchedulerHealth> {
  const base = baseOf(config);
  if (!base) throw new Error("尚未填写调度服务地址");
  const res = await fetch(`${base}/health`, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`调度服务返回 ${res.status}，检查地址与服务是否在运行`);
  return (await res.json()) as SchedulerHealth;
}

/** 把本机流水线整表同步到 worker（只同步调度字段，历史不上传）。 */
export async function syncSchedules(config: SchedulerConfig, pipelines: Pipeline[]): Promise<number> {
  const schedules = pipelines.map((row) => ({
    id: row.id,
    name: row.name,
    enabled: row.enabled,
    mode: row.mode,
    time: row.time,
    hours: row.hours,
    createdAt: row.createdAt,
    lastRunAt: row.lastRunAt,
    steps: row.steps,
  }));
  const payload = await call<{ count?: number }>(config, "/api/schedules", {
    method: "POST",
    body: JSON.stringify({ schedules }),
  });
  return payload.count ?? schedules.length;
}

/** 拉取当前到期计划 id 列表（页面重开补跑用）。 */
export async function pullDue(config: SchedulerConfig): Promise<string[]> {
  const payload = await call<{ due?: { id: string }[] }>(config, "/api/due");
  return (payload.due ?? []).map((row) => row.id);
}

/** 到期计划条目（带周期标识，补跑去重用）。 */
export interface DueItem {
  id: string;
  name?: string;
  mode?: "daily" | "interval";
  /** 周期标识：同计划同周期只执行一次（worker 计算，老版本可能缺失，前端本地兜底） */
  periodKey?: string;
  nextRunLabel?: string;
}

/** 拉取到期计划详情（含 periodKey），供补跑编排（catchup.ts）使用。 */
export async function pullDueDetailed(config: SchedulerConfig): Promise<DueItem[]> {
  const payload = await call<{ due?: DueItem[] }>(config, "/api/due");
  return (payload.due ?? []).filter((row) => row && typeof row.id === "string");
}

/** 前端执行后回写运行记录；带 periodKey 时 worker 侧同周期去重。 */
export async function reportRun(
  config: SchedulerConfig,
  pipelineId: string,
  run: PipelineRun,
  periodKey?: string,
): Promise<void> {
  await call(config, "/api/runs", {
    method: "POST",
    body: JSON.stringify({
      scheduleId: pipelineId,
      at: run.at,
      status: run.status,
      durationMs: run.durationMs,
      steps: run.steps,
      ...(periodKey ? { periodKey } : {}),
    }),
  });
}
