/**
 * 定时任务流水线（域：总控编排，对标竞品「定时任务/总控开关」）。
 *
 * 把多个模块的动作串成一条流水线，到点自动顺序执行：
 * - 页面打开时每 30 秒检查一次；每日任务错过时间后，下次打开页面会补跑一次；
 * - 关闭页面期间不会执行（浏览器端调度，不引入常驻服务）；
 * - 存本机 localStorage，不入库不上传；单条流水线失败不影响后续步骤（记 partial）。
 *
 * 与 im-bot-gateway 的边界一致：调度只在用户登录态的控制台里跑，网关不代跑任务。
 */
import { listLeads, loadKnowledgeContext } from "./api";
import { runGeoAudit } from "./geo";
import { appendSnapshot, runGeoMonitor } from "./geomonitor";
import { mentionRate, pct } from "./geotrack";
import { loadQuestions } from "./keywordLibrary";
import { groupMedia, listMedia } from "./media";
import { generateMixPlan, savePlan } from "./mixcut";
import { runAgentTask } from "./runner";
import { createVideoJob, saveVideoJob } from "./video";

export type PipelineStepKind = "task" | "geo" | "geo-monitor" | "video" | "mixcut" | "leads-scan";

export interface PipelineStep {
  id: string;
  kind: PipelineStepKind;
  params: Record<string, string>;
}

export interface PipelineStepResult {
  stepId: string;
  kind: PipelineStepKind;
  label: string;
  status: "done" | "failed";
  detail: string;
}

export interface PipelineRun {
  at: number;
  status: "done" | "partial" | "failed";
  durationMs: number;
  steps: PipelineStepResult[];
}

export interface Pipeline {
  id: string;
  name: string;
  enabled: boolean;
  mode: "daily" | "interval";
  /** daily 模式的本地触发时刻 "HH:MM" */
  time: string;
  /** interval 模式的间隔小时数 */
  hours: number;
  createdAt: number;
  lastRunAt: number | null;
  steps: PipelineStep[];
  history: PipelineRun[];
}

/** 步骤元数据：给表单渲染参数项，也给运行历史做展示。 */
export const STEP_META: Record<
  PipelineStepKind,
  { label: string; hint: string; params: { key: string; label: string; placeholder: string; def: string }[] }
> = {
  task: {
    label: "智能体任务",
    hint: "拆解目标、多岗位顺序执行，产出沉淀到任务中心与内容工厂",
    params: [
      {
        key: "goal",
        label: "任务目标",
        placeholder: "例：整理本周高意向客户并给出跟进话术",
        def: "整理今日重点客户与内容产出，给出下一步行动清单",
      },
    ],
  },
  geo: {
    label: "GEO 体检",
    hint: "取知识库资料做一次搜索可见度体检，记录评分与问题",
    params: [
      { key: "brand", label: "品牌/企业名", placeholder: "例：某某茶饮", def: "" },
      { key: "keywords", label: "目标搜索词", placeholder: "逗号分隔，例：加盟,开店", def: "" },
    ],
  },
  "geo-monitor": {
    label: "GEO 周期监测",
    hint: "按品牌当前监测问题集跑一次提及监测并存快照（GEO 工作台第 4 步一键创建）",
    params: [
      { key: "brand", label: "品牌/企业名", placeholder: "例：某某茶饮", def: "" },
      { key: "competitors", label: "竞品品牌（可选）", placeholder: "逗号分隔，最多 3 个", def: "" },
    ],
  },
  video: {
    label: "视频生成",
    hint: "文生视频入队；未配置视频通道时生成演示分镜",
    params: [
      {
        key: "prompt",
        label: "视频提示词",
        placeholder: "一句话描述画面",
        def: "门店清晨实拍，热气升腾的茶饮特写，镜头缓慢推近",
      },
    ],
  },
  mixcut: {
    label: "混剪方案",
    hint: "按素材组生成分镜级混剪方案，留档到混剪工坊",
    params: [
      { key: "topic", label: "混剪主题", placeholder: "例：新店开业引流", def: "" },
      { key: "duration", label: "成片时长(秒)", placeholder: "15 / 30 / 60", def: "15" },
    ],
  },
  "leads-scan": {
    label: "高意向扫描",
    hint: "盘点高意向与待跟进线索，结果写进运行记录",
    params: [],
  },
};

const STORAGE_KEY = "ai-employee:pipelines";
const MAX_PIPELINES = 50;
const MAX_HISTORY = 10;
const DAY_MS = 86_400_000;

/** 当天的 "HH:MM" 对应本地时间戳（已过则仍是今天那个时刻）。 */
export function todayAt(time: string, now: number): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  const date = new Date(now);
  date.setSeconds(0, 0);
  if (!match) {
    date.setHours(9, 0, 0, 0);
    return date.getTime();
  }
  date.setHours(Math.min(23, Number(match[1])), Math.min(59, Number(match[2])), 0, 0);
  return date.getTime();
}

/** 下一次展示用触发时刻（用于 UI 倒计时，不参与是否到点判断）。 */
export function nextRunAt(pipeline: Pipeline, now: number): number {
  if (pipeline.mode === "interval") {
    const hours = Math.max(1, pipeline.hours || 24);
    const base = pipeline.lastRunAt ?? pipeline.createdAt;
    const next = base + hours * 3_600_000;
    return next > now ? next : now + 60_000;
  }
  const today = todayAt(pipeline.time, now);
  if (now < today) return today;
  // 已过今天时刻：若今天还没跑过，nextRunAt 只做展示，判定交给 isDue 补跑。
  return today + DAY_MS;
}

/**
 * 是否到点：
 * - 每日：今天触发时刻已到且今天还没跑过（关闭页面错过的，打开时补跑一次）；
 * - 间隔：距上次运行（首次为创建时间）已满 hours 小时。
 */
export function isDue(pipeline: Pipeline, now: number): boolean {
  if (!pipeline.enabled || !pipeline.steps.length) return false;
  if (pipeline.mode === "interval") {
    const hours = Math.max(1, pipeline.hours || 24);
    const base = pipeline.lastRunAt ?? pipeline.createdAt;
    return now >= base + hours * 3_600_000;
  }
  const today = todayAt(pipeline.time, now);
  return now >= today && (pipeline.lastRunAt ?? 0) < today;
}

/** 下次触发的展示文案：「今天 09:00」「明天 09:00」「2 小时后」。 */
export function nextRunLabel(pipeline: Pipeline, now: number): string {
  if (!pipeline.enabled) return "已停用";
  if (pipeline.mode === "interval") {
    const hours = Math.max(1, pipeline.hours || 24);
    const base = pipeline.lastRunAt ?? pipeline.createdAt;
    const remain = base + hours * 3_600_000 - now;
    if (remain <= 0) return "待补跑";
    if (remain < 3_600_000) return `${Math.max(1, Math.round(remain / 60_000))} 分钟后`;
    return `${Math.round(remain / 3_600_000)} 小时后`;
  }
  const today = todayAt(pipeline.time, now);
  if (now < today) return `今天 ${pipeline.time}`;
  if ((pipeline.lastRunAt ?? 0) < today) return "待补跑";
  return `明天 ${pipeline.time}`;
}

export function stepLabel(step: PipelineStep): string {
  const meta = STEP_META[step.kind];
  const primary = meta.params[0]?.key;
  const value = primary ? (step.params[primary] ?? "").trim() : "";
  if (!value) return meta.label;
  return `${meta.label}：${value.slice(0, 18)}`;
}

export function newStep(kind: PipelineStepKind): PipelineStep {
  const params: Record<string, string> = {};
  for (const item of STEP_META[kind].params) params[item.key] = item.def;
  return { id: `step-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, kind, params };
}

export function createPipeline(name: string): Pipeline {
  return {
    id: `pipe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: name.trim() || "未命名流水线",
    enabled: false,
    mode: "daily",
    time: "09:00",
    hours: 24,
    createdAt: Date.now(),
    lastRunAt: null,
    steps: [newStep("leads-scan")],
    history: [],
  };
}

/* ------------------------------------------------------------------ */
/* 本机存储                                                            */
/* ------------------------------------------------------------------ */

export function loadPipelines(): Pipeline[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const rows = raw ? (JSON.parse(raw) as Pipeline[]) : [];
    if (!Array.isArray(rows)) return [];
    return rows
      .filter((row) => row && typeof row.id === "string" && Array.isArray(row.steps))
      .slice(0, MAX_PIPELINES)
      .map((row) => ({ ...row, history: Array.isArray(row.history) ? row.history.slice(0, MAX_HISTORY) : [] }));
  } catch {
    return [];
  }
}

export function savePipelines(list: Pipeline[]): void {
  try {
    const rows = list.slice(0, MAX_PIPELINES).map((row) => ({ ...row, history: row.history.slice(0, MAX_HISTORY) }));
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(rows));
  } catch {
    // 隐私模式写入失败不影响本次操作
  }
}

/** 记录一次运行：更新 lastRunAt 并把 run 插到历史头部（保留最近 10 次）。 */
export function recordRun(pipelineId: string, run: PipelineRun): Pipeline[] {
  const list = loadPipelines();
  const next = list.map((row) =>
    row.id === pipelineId
      ? { ...row, lastRunAt: run.at, history: [run, ...row.history].slice(0, MAX_HISTORY) }
      : row,
  );
  savePipelines(next);
  return next;
}

/* ------------------------------------------------------------------ */
/* 步骤执行                                                            */
/* ------------------------------------------------------------------ */

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function executeStep(step: PipelineStep): Promise<{ status: "done" | "failed"; detail: string }> {
  switch (step.kind) {
    case "task": {
      const goal = (step.params.goal ?? "").trim() || "整理今日重点并给出下一步行动";
      const result = await runAgentTask({ goal, template: null });
      if (result.status === "failed") throw new Error(result.summary || "任务执行失败");
      return {
        status: "done",
        detail: `任务 #${result.taskId} ${result.status === "done" ? "已交付" : "部分完成"}：${result.summary.slice(0, 100)}`,
      };
    }
    case "geo": {
      const brand = (step.params.brand ?? "").trim();
      const keywords = (step.params.keywords ?? "").trim();
      const snippets = await loadKnowledgeContext(`${brand} ${keywords} 企业资料`.trim());
      if (!snippets.length) throw new Error("知识库暂无资料，先导入企业资料再跑 GEO 体检");
      const material = snippets
        .slice(0, 6)
        .map((doc) => `【${doc.title}】\n${doc.content}`)
        .join("\n\n")
        .slice(0, 12000);
      const result = await runGeoAudit({ brand, keywords, material });
      const topIssue = result.issues[0]?.title ? ` · 首要：${result.issues[0].title}` : "";
      return {
        status: "done",
        detail: `评分 ${result.score}/100 · ${result.issues.length} 条待修${topIssue}`.slice(0, 140),
      };
    }
    case "geo-monitor": {
      // 第 29 批接线点：GEO 周期监测。运行时读该品牌当前问题集（不冻结创建时的问题），
      // 竞品取步骤参数；跑完存快照，与手动「跑一次监测」同一条链路。
      // 页面打开时的 30 秒轮询与 scheduler-worker 补跑（catchup）都经 runPipelineById 走到这里。
      const brand = (step.params.brand ?? step.params.geoMonitor ?? "").trim();
      if (!brand) throw new Error("缺少品牌名，先在 GEO 工作台填写品牌再创建周期监测");
      const questions = loadQuestions(brand).map((item) => item.text.trim()).filter(Boolean);
      if (!questions.length) throw new Error("该品牌监测问题集为空，先到 GEO 工作台第 3 步填问题集");
      const competitors = [...new Set((step.params.competitors ?? "").split(/[,，、\s]+/).map((c) => c.trim()).filter((c) => c && c !== brand))].slice(0, 3);
      const { snapshot, skipped } = await runGeoMonitor({ brand, questions, competitors });
      appendSnapshot(snapshot);
      const hit = snapshot.samples.filter((s) => s.mentioned).length;
      const skipNote = skipped.length ? ` · ${skipped.length} 条失败跳过` : "";
      return {
        status: "done",
        detail: `提及率 ${pct(mentionRate(snapshot))}（${hit}/${snapshot.samples.length}）· 快照已存${skipNote}`.slice(0, 140),
      };
    }
    case "video": {
      const prompt = (step.params.prompt ?? "").trim();
      if (!prompt) throw new Error("缺少视频提示词");
      const job = await createVideoJob({ mode: "text2video", prompt, size: "9:16", duration: 5 });
      await saveVideoJob(job);
      if (job.status === "failed") throw new Error(job.error || "视频任务提交失败");
      return {
        status: "done",
        detail: job.demo
          ? "演示分镜已生成（未配置视频通道，接入后即真实出片）"
          : `视频任务已入队（${job.id.slice(-6)}，${job.status}）`,
      };
    }
    case "mixcut": {
      const topic = (step.params.topic ?? "").trim();
      if (!topic) throw new Error("缺少混剪主题");
      const duration = Math.min(60, Math.max(15, Number(step.params.duration) || 15));
      const assets = await listMedia();
      const groups = groupMedia(assets);
      if (!groups.length) throw new Error("素材库为空，先上传素材并归组");
      const plan = await generateMixPlan({
        topic,
        style: "口播向",
        duration,
        versions: 2,
        groups: groups.map((group) => ({
          name: group.name,
          count: group.assets.length,
          hints: group.assets.slice(0, 3).map((asset) => asset.name),
        })),
      });
      savePlan({ topic, style: "口播向", plan });
      return {
        status: "done",
        detail: `《${plan.title}》${plan.scenes.length} 镜 · ${plan.totalDuration}s${plan.demo ? "（模板降级）" : ""}`,
      };
    }
    case "leads-scan": {
      const leads = await listLeads();
      const hot = leads.filter((lead) => lead.intent === "高意向");
      const pending = leads.filter((lead) => lead.stage === "新建" || lead.stage === "跟进中");
      const names = hot.slice(0, 5).map((lead) => lead.name).join("、");
      return {
        status: "done",
        detail: `高意向 ${hot.length} 条（${names || "暂无"}）· 待跟进 ${pending.length} 条 · 线索总数 ${leads.length}`,
      };
    }
    default:
      throw new Error(`未知步骤类型：${String(step.kind)}`);
  }
}

/** 顺序执行一条流水线的全部步骤；单步失败记入结果但不中断后续步骤。 */
export async function runPipeline(
  pipeline: Pipeline,
  onStep?: (result: PipelineStepResult) => void,
): Promise<PipelineRun> {
  const started = Date.now();
  const results: PipelineStepResult[] = [];
  for (const step of pipeline.steps) {
    const label = stepLabel(step);
    let result: PipelineStepResult;
    try {
      const outcome = await executeStep(step);
      result = { stepId: step.id, kind: step.kind, label, status: outcome.status, detail: outcome.detail };
    } catch (error) {
      result = { stepId: step.id, kind: step.kind, label, status: "failed", detail: errorMessage(error) };
    }
    results.push(result);
    onStep?.(result);
  }
  const failed = results.filter((item) => item.status === "failed").length;
  return {
    at: started,
    status: failed === 0 ? "done" : failed === results.length ? "failed" : "partial",
    durationMs: Date.now() - started,
    steps: results,
  };
}

/** 进程内并发闸：同一条流水线不重复跑（含 30 秒轮询与手动点击撞车）。 */
const runningIds = new Set<string>();

export function isPipelineRunning(id: string): boolean {
  return runningIds.has(id);
}

/** 按 id 运行并落历史；并发时直接返回 null。 */
export async function runPipelineById(
  id: string,
  onStep?: (result: PipelineStepResult) => void,
): Promise<PipelineRun | null> {
  if (runningIds.has(id)) return null;
  const pipeline = loadPipelines().find((row) => row.id === id);
  if (!pipeline) return null;
  runningIds.add(id);
  try {
    const run = await runPipeline(pipeline, onStep);
    recordRun(id, run);
    return run;
  } finally {
    runningIds.delete(id);
  }
}

/** 找出所有到点的流水线（纯判定，供调度与测试共用）。 */
export function duePipelines(list: Pipeline[], now: number): Pipeline[] {
  return list.filter((row) => isDue(row, now));
}
