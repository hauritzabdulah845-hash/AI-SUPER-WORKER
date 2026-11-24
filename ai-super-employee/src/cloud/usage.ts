/**
 * 模型调用配额与消耗统计（纯函数 + 本机留档）。
 *
 * 解决的问题：平台 429 只能靠「用着用着断了」发现。
 * 做法：每次模型调用记一条（通道 / 模型 / 成败 / tokens / 耗时），
 * 提供近 24h & 今日汇总、失败率、按模型分布，并在接近阈值时预警。
 * 只存本机 localStorage，不上传。
 */

export interface UsageRecord {
  /** 毫秒时间戳 */
  at: number;
  /** 通道：platform = 平台通道，custom = 自带 Key，demo = 演示降级 */
  channel: "platform" | "custom" | "demo";
  model: string;
  ok: boolean;
  /** 粗略 tokens（入参估算 + 出参实测，见 estimateTokens） */
  tokens: number;
  /** 毫秒耗时 */
  ms: number;
  /** 失败原因（ok=false 时） */
  error?: string;
}

export interface UsageSummary {
  calls: number;
  ok: number;
  failed: number;
  tokens: number;
  /** 失败率 0~1 */
  failRate: number;
  /** 平均耗时（毫秒） */
  avgMs: number;
  /** 按通道 */
  byChannel: Record<string, { calls: number; tokens: number; failed: number }>;
  /** 按模型，按 tokens 降序 */
  byModel: { model: string; calls: number; tokens: number; failed: number }[];
  /** 时间窗 */
  windowLabel: string;
}

const STORAGE_KEY = "ai-employee:model-usage";
const MAX_RECORDS = 500;

/** 粗略 token 估算：中文按 1 字 ≈ 1 token，英文按 4 字符 ≈ 1 token。用于趋势而非计费。 */
export function estimateTokens(text: string): number {
  const value = String(text ?? "");
  const cjk = (value.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const rest = value.length - cjk;
  return cjk + Math.ceil(rest / 4);
}

export function loadUsage(): UsageRecord[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as UsageRecord[]).filter((row) => Number.isFinite(row?.at)) : [];
  } catch {
    return [];
  }
}

export function recordUsage(record: Omit<UsageRecord, "at"> & { at?: number }): UsageRecord[] {
  const next = [{ ...record, at: record.at ?? Date.now() }, ...loadUsage()].slice(0, MAX_RECORDS);
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // 隐私模式写失败不影响主流程
  }
  return next;
}

export function clearUsage(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // 忽略
  }
}

/** 从失败原因里识别是否属于配额/限流。 */
export function isQuotaError(error: string | undefined): boolean {
  return /429|quota|rate.?limit|配额|限流|用尽|too many/i.test(String(error ?? ""));
}

/** 汇总指定时间窗内的记录。 */
export function summarizeUsage(records: UsageRecord[], since: number, label = "近 24 小时"): UsageSummary {
  const rows = records.filter((row) => row.at >= since);
  const summary: UsageSummary = {
    calls: rows.length,
    ok: 0,
    failed: 0,
    tokens: 0,
    failRate: 0,
    avgMs: 0,
    byChannel: {},
    byModel: [],
    windowLabel: label,
  };
  const models = new Map<string, { model: string; calls: number; tokens: number; failed: number }>();
  let totalMs = 0;
  for (const row of rows) {
    const tokens = Number.isFinite(row.tokens) ? row.tokens : 0;
    summary.tokens += tokens;
    totalMs += Number.isFinite(row.ms) ? row.ms : 0;
    if (row.ok) summary.ok += 1;
    else summary.failed += 1;

    const channel = summary.byChannel[row.channel] ?? { calls: 0, tokens: 0, failed: 0 };
    channel.calls += 1;
    channel.tokens += tokens;
    if (!row.ok) channel.failed += 1;
    summary.byChannel[row.channel] = channel;

    const model = models.get(row.model || "未知") ?? { model: row.model || "未知", calls: 0, tokens: 0, failed: 0 };
    model.calls += 1;
    model.tokens += tokens;
    if (!row.ok) model.failed += 1;
    models.set(model.model, model);
  }
  summary.failRate = rows.length ? summary.failed / rows.length : 0;
  summary.avgMs = rows.length ? Math.round(totalMs / rows.length) : 0;
  summary.byModel = [...models.values()].sort((a, b) => b.tokens - a.tokens || b.calls - a.calls);
  return summary;
}

/** 今日 0 点时间戳（本地时区）。 */
export function startOfToday(now = Date.now()): number {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export interface UsageAlert {
  level: "ok" | "warn" | "danger";
  message: string;
}

/**
 * 预警：失败率高 / 出现配额错误 / 调用量陡增。
 * 阈值保守，只提示不阻断——配额上限因平台而异，不能硬编码成拦截。
 */
export function usageAlerts(records: UsageRecord[], now = Date.now()): UsageAlert[] {
  const recent = records.filter((row) => row.at >= now - 86_400_000);
  const day = summarizeUsage(records, startOfToday(now), "今日");
  const alerts: UsageAlert[] = [];

  const quotaFailures = recent.filter((row) => !row.ok && isQuotaError(row.error)).length;
  if (quotaFailures > 0) {
    alerts.push({
      level: "danger",
      message: `近 24 小时出现 ${quotaFailures} 次配额/限流失败——建议换通道或等到额度刷新`,
    });
  }
  if (recent.length >= 10 && day.failRate >= 0.3) {
    alerts.push({
      level: "warn",
      message: `今日失败率 ${Math.round(day.failRate * 100)}%（${day.failed}/${day.calls}），检查通道配置`,
    });
  }
  if (day.tokens >= 200_000) {
    alerts.push({ level: "warn", message: `今日已用约 ${(day.tokens / 1000).toFixed(1)}k tokens，注意平台额度` });
  }
  if (!alerts.length) {
    alerts.push({ level: "ok", message: recent.length ? "通道运行正常，无不稳定迹象" : "还没有调用记录" });
  }
  return alerts;
}

/** 近 N 小时的小时级调用数（用于迷你柱状图），下标 0 = 最旧。 */
export function hourlyBuckets(records: UsageRecord[], hours = 12, now = Date.now()): number[] {
  const buckets = new Array(hours).fill(0) as number[];
  const hourMs = 3_600_000;
  for (const row of records) {
    const diff = Math.floor((now - row.at) / hourMs);
    if (diff >= 0 && diff < hours) buckets[hours - 1 - diff] += 1;
  }
  return buckets;
}
