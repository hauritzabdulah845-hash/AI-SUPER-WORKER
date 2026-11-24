/**
 * 渠道运营报表（域：数据洞察）。
 *
 * 口径：业务库（任务/线索）+ 本机库（视频任务/素材/流水线）聚合，
 * 只读统计，不写入、不上传。竞品的「接待人数/曝光私信」等口径依赖
 * 其桌面端 RPA 采集，我们不做，对应位置以真实可数的指标替代并注明。
 */
import type { LeadRow, TaskRow } from "./api";
import { loadPipelines } from "./pipeline";
import { listMedia } from "./media";
import { listVideoJobs } from "./video";

export interface OpsTile {
  key: string;
  label: string;
  value: number | string;
  hint: string;
}

export interface OpsTrendPoint {
  day: string;
  tasks: number;
  leads: number;
  videos: number;
}

export interface OpsReport {
  generatedAt: number;
  tiles: OpsTile[];
  trend: OpsTrendPoint[];
}

/** 本地日期键 YYYY-MM-DD（与用户时区一致）。 */
export function dayKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/** 最近 n 天的日期键（含今天，升序）。 */
export function lastNDayKeys(days: number, now: number): string[] {
  const keys: string[] = [];
  const base = new Date(now);
  base.setHours(0, 0, 0, 0);
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = new Date(base.getTime() - offset * 86_400_000);
    keys.push(dayKey(date));
  }
  return keys;
}

/** 把带时间戳的记录按天分桶（只统计最近 days 天）。 */
export function bucketCounts(rows: { at: number }[], days: number, now: number): Record<string, number> {
  const allowed = new Set(lastNDayKeys(days, now));
  const counts: Record<string, number> = {};
  for (const key of allowed) counts[key] = 0;
  for (const row of rows) {
    if (typeof row.at !== "number" || Number.isNaN(row.at)) continue;
    const key = dayKey(new Date(row.at));
    if (key in counts) counts[key] += 1;
  }
  return counts;
}

function parseTime(value: string | number | undefined | null): number {
  if (typeof value === "number") return value;
  if (!value) return Number.NaN;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Number.NaN : parsed;
}

export async function collectOpsMetrics(input: {
  tasks: TaskRow[];
  leads: LeadRow[];
  knowledgeCount: number;
  contentCount: number;
  now?: number;
}): Promise<OpsReport> {
  const now = input.now ?? Date.now();
  const { tasks, leads } = input;

  const [videoJobs, mediaAssets] = await Promise.all([
    listVideoJobs().catch(() => [] as Awaited<ReturnType<typeof listVideoJobs>>),
    listMedia().catch(() => [] as Awaited<ReturnType<typeof listMedia>>),
  ]);
  const pipelines = loadPipelines();

  const taskTimes = tasks.map((row) => parseTime(row.created_at)).filter((at) => !Number.isNaN(at));
  const leadTimes = leads.map((row) => parseTime(row.created_at)).filter((at) => !Number.isNaN(at));
  const videoTimes = videoJobs.map((row) => row.createdAt);

  const taskBuckets = bucketCounts(taskTimes.map((at) => ({ at })), 7, now);
  const leadBuckets = bucketCounts(leadTimes.map((at) => ({ at })), 7, now);
  const videoBuckets = bucketCounts(videoTimes.map((at) => ({ at })), 7, now);
  const days = lastNDayKeys(7, now);
  const trend: OpsTrendPoint[] = days.map((day) => ({
    day,
    tasks: taskBuckets[day] ?? 0,
    leads: leadBuckets[day] ?? 0,
    videos: videoBuckets[day] ?? 0,
  }));

  const since = now - 7 * 86_400_000;
  const newLeads7d = leadTimes.filter((at) => at >= since).length;
  const hot = leads.filter((lead) => lead.intent === "高意向").length;
  const won = leads.filter((lead) => lead.stage === "已成交").length;
  const pending = leads.filter((lead) => lead.stage === "新建" || lead.stage === "跟进中").length;
  const doneTasks = tasks.filter((task) => task.status === "done").length;
  const successRate = tasks.length ? Math.round((doneTasks / tasks.length) * 100) : 0;
  const videoDone = videoJobs.filter((job) => job.status === "succeeded").length;
  const videoDemo = videoJobs.filter((job) => job.demo).length;
  const pipeRuns = pipelines.reduce((sum, row) => sum + row.history.length, 0);
  const pipeEnabled = pipelines.filter((row) => row.enabled).length;

  const tiles: OpsTile[] = [
    { key: "leads", label: "线索总数", value: leads.length, hint: `7 日新增 ${newLeads7d} · 成交 ${won}` },
    { key: "hot", label: "高意向线索", value: hot, hint: `待跟进 ${pending} 条` },
    { key: "tasks", label: "任务执行", value: tasks.length, hint: `交付成功率 ${successRate}%` },
    { key: "content", label: "内容产出", value: input.contentCount, hint: "任务步骤沉淀到内容工厂" },
    { key: "videos", label: "视频任务", value: videoJobs.length, hint: `成功 ${videoDone} · 演示 ${videoDemo}` },
    { key: "media", label: "素材库存", value: mediaAssets.length, hint: "混剪工坊本机素材" },
    { key: "knowledge", label: "知识文档", value: input.knowledgeCount, hint: "可用于生成与 GEO 体检" },
    {
      key: "pipelines",
      label: "定时流水线",
      value: pipelines.length,
      hint: `启用 ${pipeEnabled} 条 · 累计运行 ${pipeRuns} 次`,
    },
  ];

  return { generatedAt: now, tiles, trend };
}

/** 报表转 CSV（BOM 头保证 Excel 中文不乱码）。 */
export function reportToCsv(report: OpsReport): string {
  const lines: string[] = ["\uFEFF指标,数值,说明"];
  for (const tile of report.tiles) {
    lines.push(`${tile.label},${String(tile.value).replace(/,/g, "，")},${tile.hint.replace(/,/g, "，")}`);
  }
  lines.push("");
  lines.push("日期,任务,线索,视频");
  for (const point of report.trend) {
    lines.push(`${point.day},${point.tasks},${point.leads},${point.videos}`);
  }
  return lines.join("\n");
}
