/**
 * 常驻调度补跑编排（第二十五批接线，兑现第二十九章 29.5 后置项）。
 *
 * 流程：控制台打开 → pullDueDetailed 拉积压到期计划 → 与本地 pipeline.ts
 * 语义对齐判定 → 逐个用既有 runPipelineById 执行 → reportRun 回写 worker。
 *
 * 防双跑（三层，缺一不可）：
 * 1. 本地语义闸：补跑前用 pipeline.ts 的 isDue 复核本地计划——本地 30 秒轮询
 *    或手动运行已跑过本周期时 lastRunAt 已更新，isDue=false，直接跳过。
 * 2. 补跑标记（claim）：执行前把 {periodKey, at} 写进 localStorage，
 *    同周期已有未过期标记（30 分钟内）视为正在补跑/刚补跑过，跳过；
 *    标记过期后允许重试（防页面中途关闭把周期永久吞掉）。
 * 3. worker 去重：回写带 periodKey，worker 同计划同周期只入账一次；
 *    且 runPipelineById 自带进程内并发闸，同一计划不会并发双跑。
 *
 * 上限：单轮最多补跑 CATCHUP_MAX_PER_ROUND 条，超出留待下次打开/手动补跑。
 * 未配置或拉取失败时静默跳过并把状态记进本机，供常驻调度卡展示，不打扰主流程。
 */
import { isDue, loadPipelines, runPipelineById, todayAt, type Pipeline } from "./pipeline";
import {
  pullDueDetailed,
  reportRun,
  schedulerConfigured,
  type DueItem,
  type SchedulerConfig,
} from "./scheduler";

/** 单轮补跑上限：积压再多也分批跑，避免打开页面就长时间占用。 */
export const CATCHUP_MAX_PER_ROUND = 5;
/** 补跑标记有效期：超过后视为上次补跑中断，允许同周期重试。 */
export const CLAIM_TTL_MS = 30 * 60_000;

const CLAIMS_KEY = "ai-employee:catchup-claims";
const STATUS_KEY = "ai-employee:catchup-last";

export interface CatchupClaim {
  periodKey: string;
  at: number;
}

export type CatchupClaims = Record<string, CatchupClaim>;

/**
 * 周期标识（与 scheduler-worker/src/schedule.mjs 的 periodKey 保持一致，
 * 改语义两边同步）：每日 `daily:YYYY-MM-DD@HH:MM`，间隔 `interval:<到期时间戳>`。
 * worker 老版本不带 periodKey 时用它本地兜底。
 */
export function periodKeyOf(pipeline: Pipeline, now: number): string {
  if (pipeline.mode === "interval") {
    const hours = Math.max(1, pipeline.hours || 24);
    const base = pipeline.lastRunAt ?? pipeline.createdAt;
    return `interval:${base + hours * 3_600_000}`;
  }
  const trigger = new Date(todayAt(pipeline.time, now));
  const ymd = `${trigger.getFullYear()}-${String(trigger.getMonth() + 1).padStart(2, "0")}-${String(trigger.getDate()).padStart(2, "0")}`;
  return `daily:${ymd}@${pipeline.time}`;
}

export interface CatchupPlanItem {
  pipeline: Pipeline;
  periodKey: string;
}

export interface CatchupSkip {
  id: string;
  reason: string;
}

export interface CatchupPlan {
  toRun: CatchupPlanItem[];
  skipped: CatchupSkip[];
  /** 因单轮上限留待下次的条数 */
  remaining: number;
}

/**
 * 补跑计划（纯函数）：把 worker 到期列表与本地计划对齐，决定跑谁、跳谁。
 * 判定顺序：本地不存在 → 已停用/空步骤 → 本地已跑过本周期（isDue=false）
 * → 已有未过期补跑标记 → 入选（受单轮上限截断，余数计 remaining）。
 */
export function planCatchup(
  due: DueItem[],
  pipelines: Pipeline[],
  claims: CatchupClaims,
  now: number,
  maxPerRound: number = CATCHUP_MAX_PER_ROUND,
): CatchupPlan {
  const byId = new Map(pipelines.map((row) => [row.id, row]));
  const toRun: CatchupPlanItem[] = [];
  const skipped: CatchupSkip[] = [];
  let remaining = 0;

  for (const item of due) {
    const pipeline = byId.get(item.id);
    if (!pipeline) {
      skipped.push({ id: item.id, reason: "本地计划不存在（可能已删除）" });
      continue;
    }
    if (!pipeline.enabled || !pipeline.steps.length) {
      skipped.push({ id: item.id, reason: "本地已停用或无步骤" });
      continue;
    }
    if (!isDue(pipeline, now)) {
      skipped.push({ id: item.id, reason: "本地已跑过本周期" });
      continue;
    }
    const periodKey = item.periodKey?.trim() || periodKeyOf(pipeline, now);
    const claim = claims[pipeline.id];
    if (claim && claim.periodKey === periodKey && now - claim.at < CLAIM_TTL_MS) {
      skipped.push({ id: item.id, reason: "已标记补跑（防重复）" });
      continue;
    }
    if (toRun.length >= Math.max(1, maxPerRound)) {
      remaining += 1;
      continue;
    }
    toRun.push({ pipeline, periodKey });
  }

  return { toRun, skipped, remaining };
}

/* ------------------------------------------------------------------ */
/* 补跑标记与状态（本机 localStorage）                                  */
/* ------------------------------------------------------------------ */

export function loadClaims(): CatchupClaims {
  try {
    const raw = localStorage.getItem(CLAIMS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const out: CatchupClaims = {};
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      const row = value as Partial<CatchupClaim> | null;
      if (row && typeof row.periodKey === "string" && Number.isFinite(row.at)) {
        out[id] = { periodKey: row.periodKey, at: Number(row.at) };
      }
    }
    return out;
  } catch {
    return {};
  }
}

function saveClaims(claims: CatchupClaims): void {
  try {
    localStorage.setItem(CLAIMS_KEY, JSON.stringify(claims));
  } catch {
    /* 节点测试环境无 localStorage / 隐私模式写失败不影响主流程 */
  }
}

/** 执行前标记：同周期先占位，防补跑与本地轮询/重复打开双跑。 */
export function claimPipeline(id: string, periodKey: string, now: number): CatchupClaims {
  const claims = loadClaims();
  claims[id] = { periodKey, at: now };
  saveClaims(claims);
  return claims;
}

export interface CatchupReport {
  /** 本轮补跑开始时间 */
  at: number;
  configured: boolean;
  /** worker 返回的到期条数 */
  dueCount: number;
  /** 实际补跑执行的计划 id */
  ranIds: string[];
  skippedCount: number;
  /** 因单轮上限留待下次的条数 */
  remaining: number;
  /** 回写 worker 失败的条数（执行本身已完成，靠下次同步对齐） */
  reportFailures: number;
  error?: string;
}

export function loadCatchupStatus(): CatchupReport | null {
  try {
    const raw = localStorage.getItem(STATUS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CatchupReport;
    return parsed && Number.isFinite(parsed.at) ? parsed : null;
  } catch {
    return null;
  }
}

function saveCatchupStatus(report: CatchupReport): void {
  try {
    localStorage.setItem(STATUS_KEY, JSON.stringify(report));
  } catch {
    /* 同上 */
  }
}

/* ------------------------------------------------------------------ */
/* 编排执行                                                            */
/* ------------------------------------------------------------------ */

let catchupInFlight = false;

export function isCatchupRunning(): boolean {
  return catchupInFlight;
}

/**
 * 执行一轮补跑：拉 due → 规划 → 逐个标记+执行+回写。
 * 未配置直接返回 configured=false 的报告；拉取失败记 error 不抛错，
 * 调用方（PipelineCenter）静默展示状态即可。重入直接返回上次状态。
 */
export async function runCatchup(
  config: SchedulerConfig,
  options: { now?: number; maxPerRound?: number } = {},
): Promise<CatchupReport> {
  const now = options.now ?? Date.now();
  const base: CatchupReport = {
    at: now,
    configured: schedulerConfigured(config),
    dueCount: 0,
    ranIds: [],
    skippedCount: 0,
    remaining: 0,
    reportFailures: 0,
  };
  if (!base.configured) return base;
  if (catchupInFlight) {
    return loadCatchupStatus() ?? { ...base, error: "补跑正在进行中" };
  }

  catchupInFlight = true;
  try {
    const due = await pullDueDetailed(config);
    base.dueCount = due.length;
    const plan = planCatchup(due, loadPipelines(), loadClaims(), now, options.maxPerRound ?? CATCHUP_MAX_PER_ROUND);
    base.skippedCount = plan.skipped.length;
    base.remaining = plan.remaining;

    for (const item of plan.toRun) {
      claimPipeline(item.pipeline.id, item.periodKey, Date.now());
      const run = await runPipelineById(item.pipeline.id);
      if (!run) {
        // 已在运行（本地轮询/手动撞车）或计划被删：本周期由对方负责，不重复执行
        base.skippedCount += 1;
        continue;
      }
      base.ranIds.push(item.pipeline.id);
      try {
        await reportRun(config, item.pipeline.id, run, item.periodKey);
      } catch {
        // 执行已落本地历史（recordRun 已更新 lastRunAt），回写失败靠下次同步对齐
        base.reportFailures += 1;
      }
    }
  } catch (error) {
    base.error = error instanceof Error ? error.message : "补跑拉取失败";
  } finally {
    catchupInFlight = false;
  }

  saveCatchupStatus(base);
  return base;
}
