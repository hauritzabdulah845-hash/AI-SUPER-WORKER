/**
 * 任务失败与重试统计（纯函数）。
 *
 * 目标：把「失败原因只在详情里可见」升级为可排障的视图——
 * 失败原因聚类（同因合并计数）+ 重试建议 + 按天的失败趋势。
 * 判定依据 TaskRow/DemoTaskRow 的 status 与 error 字段。
 */

export interface TaskLike {
  id: number;
  status: string;
  error: string | null;
  created_at: string;
  steps?: { status: string; agent: string }[];
  result?: Record<string, unknown>;
}

export interface FailureGroup {
  /** 归一化后的原因标签 */
  reason: string;
  count: number;
  taskIds: number[];
  /** 建议动作 */
  advice: string;
  /** 最近一次发生时间（毫秒） */
  lastAt: number;
}

export interface TaskStats {
  total: number;
  running: number;
  done: number;
  partial: number;
  failed: number;
  /** 失败率（failed / (done+partial+failed)），无终态任务时为 0 */
  failRate: number;
  /** 失败原因聚类，按次数降序 */
  failures: FailureGroup[];
  /** 近 7 天每天失败数（最旧 → 最新），下标 0 = 6 天前 */
  dailyFailures: number[];
  /** 需要重跑的任务 id（失败 + 部分完成里带失败步骤的） */
  retryIds: number[];
}

const REASON_RULES: { pattern: RegExp; reason: string; advice: string }[] = [
  { pattern: /配额|429|quota|rate.?limit|用尽|超额/i, reason: "模型配额用尽", advice: "到「模型接入」换通道或等配额重置后重跑" },
  { pattern: /超时|timeout|timed.?out/i, reason: "请求超时", advice: "稍后重跑；连续出现时缩小单次任务范围" },
  { pattern: /网络|network|fetch failed|ECONN|DNS|连不上/i, reason: "网络异常", advice: "检查网络/服务地址后重跑" },
  { pattern: /密钥|key|401|403|未授权|unauthor/i, reason: "鉴权失败", advice: "检查 Key 与服务密钥配置" },
  { pattern: /解析|parse|JSON/i, reason: "模型输出解析失败", advice: "重跑一次；重复失败时补充更明确的指令" },
  { pattern: /取消|cancel|中止|abort/i, reason: "任务被取消", advice: "确认需求后重新发起" },
];

/** 原因归一化：命中规则取标签，否则截取首句（去掉过长堆栈）。 */
export function normalizeFailureReason(error: string | null | undefined): { reason: string; advice: string } {
  const text = String(error ?? "").trim();
  if (!text) return { reason: "未记录原因", advice: "打开任务详情查看失败步骤" };
  for (const rule of REASON_RULES) {
    if (rule.pattern.test(text)) return { reason: rule.reason, advice: rule.advice };
  }
  // 取首行/首句，最多 24 字，避免整段堆栈进统计
  const firstLine = text.split(/[\n。；;]/)[0]?.trim() ?? text;
  const short = firstLine.length > 24 ? `${firstLine.slice(0, 24)}…` : firstLine;
  return { reason: short || "未记录原因", advice: "查看任务详情定位失败步骤后重跑" };
}

function hasFailedStep(task: TaskLike): boolean {
  return (task.steps ?? []).some((step) => step.status === "failed");
}

export function summarizeTasks(tasks: TaskLike[], now = Date.now()): TaskStats {
  const stats: TaskStats = {
    total: tasks.length,
    running: 0,
    done: 0,
    partial: 0,
    failed: 0,
    failRate: 0,
    failures: [],
    dailyFailures: [0, 0, 0, 0, 0, 0, 0],
    retryIds: [],
  };
  const groups = new Map<string, FailureGroup>();

  for (const task of tasks) {
    if (task.status === "running") stats.running += 1;
    else if (task.status === "done") stats.done += 1;
    else if (task.status === "partial") stats.partial += 1;
    else if (task.status === "failed") stats.failed += 1;

    const failed = task.status === "failed";
    const partialWithFailure = task.status === "partial" && hasFailedStep(task);
    if (!failed && !partialWithFailure) continue;
    if (partialWithFailure) stats.retryIds.push(task.id);
    if (failed) stats.retryIds.push(task.id);

    const at = Date.parse(task.created_at) || now;
    const { reason, advice } = normalizeFailureReason(task.error);
    const group = groups.get(reason) ?? { reason, count: 0, taskIds: [], advice, lastAt: 0 };
    group.count += 1;
    group.taskIds.push(task.id);
    group.lastAt = Math.max(group.lastAt, at);
    groups.set(reason, group);

    const dayIndex = 6 - Math.floor((now - at) / 86_400_000);
    if (dayIndex >= 0 && dayIndex < 7) stats.dailyFailures[dayIndex] += 1;
  }

  const terminated = stats.done + stats.partial + stats.failed;
  stats.failRate = terminated ? stats.failed / terminated : 0;
  stats.failures = [...groups.values()].sort((a, b) => b.count - a.count || b.lastAt - a.lastAt);
  stats.retryIds = [...new Set(stats.retryIds)];
  return stats;
}

/** 一句话结论，用于卡片头部。 */
export function taskStatsHeadline(stats: TaskStats): string {
  if (stats.total === 0) return "还没有任务记录";
  if (stats.failed === 0 && stats.partial === 0) return `全部正常：${stats.done} 条已交付${stats.running ? `，${stats.running} 条执行中` : ""}`;
  const top = stats.failures[0];
  const pct = Math.round(stats.failRate * 100);
  return `失败率 ${pct}%${top ? ` · 主因「${top.reason}」${top.count} 次` : ""}${stats.retryIds.length ? ` · ${stats.retryIds.length} 条可重跑` : ""}`;
}
