/**
 * GEO 持续监测：编排 + 本机存储。
 *
 * 存储策略与项目其它模块一致：**只存本机 localStorage，不上传**。
 * 用户可在 UI 上看到「本机保存」标识。
 *
 * 为什么要存历史：单次提及率没有意义。GEO 是长期博弈，
 * 只有连续快照才能回答「我上周做的素材到底有没有用」。
 */
import { askLLM } from "./runner";
import { loadChannel } from "./provider";
import {
  analyzeAnswer,
  analyzeAnswerMulti,
  buildCompetitorStats,
  extractSources,
  type GeoSnapshot,
  type MentionSample,
} from "./geotrack";

const STORAGE_KEY = "supe-geo-snapshots";
/** 最多保留 60 次快照（约每 3 天一次 = 半年），防止 localStorage 膨胀 */
const MAX_SNAPSHOTS = 60;
/**
 * 单次最多测多少条问题（第 28 批由 8 提到 20，评审 P1：8 条样本太小、趋势可信度低）。
 * 监测逐条串行调用模型，问题越多耗时越长、配额消耗越大——UI 在问题集处有提示。
 */
export const MAX_QUESTIONS = 20;

/** 把当前通道映射成可比对的口径标签 */
function currentChannelLabel(): string {
  const channel = loadChannel();
  if (channel === "platform") return "platform";
  return "custom";
}

export interface RunMonitorResult {
  snapshot: GeoSnapshot;
  /** 只测成功的问题数；失败的问题不进快照，避免把网络错误当成"未被提及" */
  skipped: { question: string; reason: string }[];
}

/**
 * 跑一次完整监测。
 *
 * 与旧版 testBrandMention 的关键差异：
 *   1. 逐条失败不影响整体 —— 网络错误的问题被**跳过并报告**，不会污染成"未提及"
 *   2. 记录命中次数与首次位置，而不只是布尔值
 *   3. 产出可直接落库的快照
 */
export async function runGeoMonitor(input: {
  brand: string;
  questions: string[];
  /** 可选竞品品牌（最多 3 个）：同一批问题同时测竞品提及（第 26 批） */
  competitors?: string[];
  channel?: string;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number, question: string) => void;
}): Promise<RunMonitorResult> {
  const brand = input.brand.trim();
  if (!brand) throw new Error("请先填写品牌/企业名称，否则无法判断是否被提及。");
  const questions = input.questions.map((q) => q.trim()).filter(Boolean).slice(0, MAX_QUESTIONS);
  if (!questions.length) throw new Error("请至少填写 1 条测试问题。");
  const competitors = [...new Set((input.competitors ?? []).map((c) => c.trim()).filter((c) => c && c !== brand))].slice(0, 3);

  const samples: MentionSample[] = [];
  const skipped: { question: string; reason: string }[] = [];

  for (let i = 0; i < questions.length; i += 1) {
    const question = questions[i];
    if (input.signal?.aborted) throw new Error("监测已取消");
    input.onProgress?.(i, questions.length, question);
    try {
      const { text } = await askLLM(
        [
          {
            role: "system",
            content: "你是一个客观的搜索问答助手，直接回答用户问题，不寒暄，60-120 字。回答末尾另起一行列出参考来源（站点/文章名/链接，如有），格式「来源：…」；没有可列的来源就写「来源：无」。",
          },
          { role: "user", content: question },
        ],
        { signal: input.signal },
      );
      const signal = analyzeAnswer(text, brand);
      const sample: MentionSample = { question, ...signal };
      if (competitors.length) {
        sample.competitors = analyzeAnswerMulti(text, competitors);
      }
      const sources = extractSources(text);
      if (sources.length) sample.sources = sources;
      samples.push(sample);
    } catch (err) {
      // 关键：不能把失败当成"未被提及"，否则趋势会被网络抖动作假
      skipped.push({ question, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  if (!samples.length) {
    throw new Error(`全部 ${questions.length} 条问题都失败了，本次不计入趋势。${skipped[0] ? `首个错误：${skipped[0].reason}` : ""}`);
  }

  const snapshot: GeoSnapshot = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    at: new Date().toISOString(),
    brand,
    questions: samples.map((s) => s.question),
    samples,
    channel: input.channel ?? currentChannelLabel(),
    ...(competitors.length ? { competitors: buildCompetitorStats(samples, competitors) } : {}),
    ...(samples.some((s) => s.sources?.length)
      ? { sources: samples.map((s) => ({ question: s.question, sources: s.sources ?? [] })) }
      : {}),
  };

  return { snapshot, skipped };
}

/* ------------------------------------------------------------------ */
/* 本机存储                                                            */
/* ------------------------------------------------------------------ */

export function loadSnapshots(): GeoSnapshot[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const rows = JSON.parse(raw) as GeoSnapshot[];
    if (!Array.isArray(rows)) return [];
    return rows
      .filter((row) => row && typeof row.id === "string" && Array.isArray(row.samples))
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
      .slice(-MAX_SNAPSHOTS);
  } catch {
    return [];
  }
}

/**
 * 同一品牌只保留一条时间线。
 * 不同品牌的问题集与预期完全不同，混在一条线上会得出无意义的"趋势"。
 */
export function loadSnapshotsFor(brand: string): GeoSnapshot[] {
  const key = brand.trim();
  if (!key) return [];
  return loadSnapshots().filter((row) => row.brand === key);
}

export function appendSnapshot(snapshot: GeoSnapshot): GeoSnapshot[] {
  const all = loadSnapshots().filter((row) => row.id !== snapshot.id);
  const next = [...all, snapshot]
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    .slice(-MAX_SNAPSHOTS);
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // 隐私模式/配额满：本次展示仍可用，只是不落盘
  }
  return next;
}

export function removeSnapshot(id: string): GeoSnapshot[] {
  const next = loadSnapshots().filter((row) => row.id !== id);
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* 忽略 */
  }
  return next;
}

export function clearSnapshotsFor(brand: string): GeoSnapshot[] {
  const key = brand.trim();
  const next = loadSnapshots().filter((row) => row.brand !== key);
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* 忽略 */
  }
  return next;
}

/** 为趋势对比挑出「同一口径」的最近两条（通道 + 问题集都一致） */
export function latestComparablePair(history: GeoSnapshot[]): { current: GeoSnapshot | null; previous: GeoSnapshot | null } {
  if (!history.length) return { current: null, previous: null };
  const sorted = [...history].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const current = sorted[sorted.length - 1];
  const keyOf = (s: GeoSnapshot) => `${s.channel}::${[...s.questions].sort().join("|")}`;
  const currentKey = keyOf(current);
  for (let i = sorted.length - 2; i >= 0; i -= 1) {
    if (keyOf(sorted[i]) === currentKey) return { current, previous: sorted[i] };
  }
  return { current, previous: null };
}
