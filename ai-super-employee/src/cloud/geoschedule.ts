import { createPipeline, type Pipeline } from "./pipeline";

/**
 * GEO 监测周期模板（第二十九批，借鉴抓词 GEO「按周期自动运行监测」）：
 * 把「GEO 周期监测」做成一键创建的定时任务模板，复用既有 pipeline 定时任务
 * 机制（本机 localStorage + 30 秒轮询 + scheduler-worker 补跑），不新建执行通道。
 *
 * 频率表达复用 pipeline 的既有语义：mode="daily"（每日 HH:MM）或
 * mode="interval"（间隔小时数）。pipeline 没有「每周一」这类星期语义，
 * 每周监测用 interval=168 小时近似（从上次运行起算），与 worker 的
 * periodKey 计算保持一致；星期级调度属调度语义扩展，另行规划。
 *
 * 执行接线：pipeline.ts 的 executeStep 新增 "geo-monitor" 分支——
 * 运行时读该品牌当前问题集（keywordLibrary.loadQuestions）+ 步骤里存的竞品，
 * 调 runGeoMonitor 并 appendSnapshot。页面打开时的 30 秒轮询与
 * scheduler-worker 补跑（catchup.ts → runPipelineById）都走同一执行分支。
 */

export type GeoMonitorFrequency = "daily" | "every3days" | "weekly";

export const GEO_MONITOR_STEP_KIND = "geo-monitor" as const;

export const GEO_MONITOR_FREQUENCIES: {
  key: GeoMonitorFrequency;
  label: string;
  hint: string;
}[] = [
  { key: "daily", label: "每天 09:00", hint: "每日固定时刻跑一次" },
  { key: "every3days", label: "每 3 天", hint: "距上次运行满 72 小时跑一次" },
  {
    key: "weekly",
    label: "每周",
    hint: "距上次运行满 168 小时跑一次（推荐，趋势更稳）",
  },
];

/** 频率 → pipeline 调度字段（复用既有 daily/interval 语义）。 */
export function frequencyToPipelineFields(frequency: GeoMonitorFrequency): {
  mode: Pipeline["mode"];
  time: string;
  hours: number;
} {
  switch (frequency) {
    case "daily":
      return { mode: "daily", time: "09:00", hours: 24 };
    case "every3days":
      return { mode: "interval", time: "09:00", hours: 72 };
    case "weekly":
      return { mode: "interval", time: "09:00", hours: 168 };
  }
}

/** 周期监测任务名（带品牌，定时任务页可直接识别）。 */
export function geoMonitorPipelineName(brand: string): string {
  return `GEO 周期监测 · ${brand.trim() || "未命名品牌"}`;
}

/**
 * 构建一条 GEO 周期监测定时任务（默认启用）。
 * 步骤载荷带 GEO 监测标记：kind="geo-monitor" + params.geoMonitor=品牌名，
 * 供定时任务页展示与执行分支识别；竞品以逗号分隔存 params.competitors。
 * 问题集不在创建时冻结：运行时读该品牌当前问题集（界面已注明可比性口径）。
 */
export function buildGeoMonitorPipeline(input: {
  brand: string;
  competitors?: string[];
  frequency: GeoMonitorFrequency;
  now?: number;
}): Pipeline {
  const brand = input.brand.trim();
  const competitors = [
    ...new Set(
      (input.competitors ?? [])
        .map((c) => c.trim())
        .filter((c) => c && c !== brand),
    ),
  ].slice(0, 3);
  const fields = frequencyToPipelineFields(input.frequency);
  const base = createPipeline(geoMonitorPipelineName(brand));
  return {
    ...base,
    enabled: true,
    mode: fields.mode,
    time: fields.time,
    hours: fields.hours,
    createdAt: input.now ?? base.createdAt,
    steps: [
      {
        id: `step-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        kind: GEO_MONITOR_STEP_KIND,
        params: {
          brand,
          competitors: competitors.join(","),
          geoMonitor: brand,
        },
      },
    ],
  };
}

/** 是否 GEO 周期监测任务（任一步骤带 geo-monitor 标记）。 */
export function isGeoMonitorPipeline(pipeline: Pipeline): boolean {
  return pipeline.steps.some((step) => step.kind === GEO_MONITOR_STEP_KIND);
}

/** 找某品牌的 GEO 周期监测任务（按步骤参数里的品牌名匹配）。 */
export function findGeoMonitorPipeline(
  pipelines: Pipeline[],
  brand: string,
): Pipeline | undefined {
  const key = brand.trim();
  if (!key) return undefined;
  return pipelines.find((pipeline) =>
    pipeline.steps.some(
      (step) =>
        step.kind === GEO_MONITOR_STEP_KIND &&
        (step.params.geoMonitor ?? step.params.brand ?? "").trim() === key,
    ),
  );
}

/** 解析步骤参数里的竞品列表（逗号/中文逗号/空格分隔，最多 3 个，去重去本品牌）。 */
export function parseCompetitorsParam(
  raw: string | undefined,
  brand: string,
): string[] {
  const self = brand.trim();
  return [
    ...new Set(
      (raw ?? "")
        .split(/[,，、\s]+/)
        .map((c) => c.trim())
        .filter((c) => c && c !== self),
    ),
  ].slice(0, 3);
}
