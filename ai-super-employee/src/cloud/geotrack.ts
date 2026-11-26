/**
 * GEO 持续监测与趋势追踪（纯函数层，无 IO，可单测）。
 *
 * 为什么需要这层：原来的提及率测试是「跑一次、看一个数」——
 * GEO 是长期博弈，一次命中不代表下月还在，没有趋势就无法证明工作有效，
 * 也无法判断某次素材投放到底有没有用。
 *
 * 这里只做「快照 → 序列 → 趋势」的纯计算；存储与网络在 geotrack.ts。
 */

/** 单次监测里、单个品牌在某条回答中的提及信号（竞品用） */
export interface BrandSignal {
  brand: string;
  mentioned: boolean;
  hits: number;
  /** 品牌在回答中的首个字符位置；-1 表示未出现 */
  firstPos: number;
}

/** 单次监测里、单条问题的结果 */
export interface MentionSample {
  question: string;
  mentioned: boolean;
  /** 回答里品牌名出现次数（不止 0/1，能区分「提了一句」和「重点推荐」） */
  hits: number;
  /** 品牌在回答中的首个字符位置；-1 表示未出现。越靠前越可能被用户看到 */
  firstPos: number;
  /** 回答字数，用于判断模型是否敷衍 */
  answerLength: number;
  /** 可选（第 26 批新增）：同一回答里各竞品的提及信号，旧快照无此字段 */
  competitors?: BrandSignal[];
  /** 可选（第 26 批新增）：模型在回答末尾给出的参考来源，旧快照无此字段 */
  sources?: string[];
}

/** 快照级竞品汇总（第 26 批新增，向后兼容的可选字段） */
export interface CompetitorStat {
  brand: string;
  /** 该竞品在本轮问题集中的提及率 0~1 */
  mentionRate: number;
  /** 该竞品命中回答的平均首次位置；无命中为 null */
  firstPos: number | null;
}

/** 一次完整监测的快照 */
export interface GeoSnapshot {
  id: string;
  /** ISO 时间 */
  at: string;
  brand: string;
  /** 参与本次监测的问题列表（快照固定，便于前后对比同口径） */
  questions: string[];
  samples: MentionSample[];
  /** 通道标识，例如 "demo" / "deepseek"：换通道后趋势不可直接比 */
  channel: string;
  /** 可选（第 26 批新增）：本轮竞品汇总，旧快照无此字段时报表降级为只看本品牌 */
  competitors?: CompetitorStat[];
  /** 可选（第 26 批新增）：按问题存的模型参考来源，旧快照无此字段 */
  sources?: { question: string; sources: string[] }[];
}

/** 单次提及率（0~1） */
export function mentionRate(snapshot: GeoSnapshot): number {
  if (!snapshot.samples.length) return 0;
  return snapshot.samples.filter((s) => s.mentioned).length / snapshot.samples.length;
}

/** 单次「首次提及位置」均值（只统计命中的），越小越好；无命中返回 null */
export function avgFirstPos(snapshot: GeoSnapshot): number | null {
  const hit = snapshot.samples.filter((s) => s.mentioned && s.firstPos >= 0);
  if (!hit.length) return null;
  return hit.reduce((sum, s) => sum + s.firstPos, 0) / hit.length;
}

/** 首次提及位置的相对排名（0~1，越小越靠前）：按回答长度归一，避免长回答吃亏 */
export function avgPositionRatio(snapshot: GeoSnapshot): number | null {
  const hit = snapshot.samples.filter((s) => s.mentioned && s.firstPos >= 0 && s.answerLength > 0);
  if (!hit.length) return null;
  const total = hit.reduce((sum, s) => sum + s.firstPos / Math.max(1, s.answerLength), 0);
  return total / hit.length;
}

export type TrendDirection = "up" | "down" | "flat" | "insufficient";

export interface TrendResult {
  direction: TrendDirection;
  /** 最新一次提及率 */
  current: number;
  /** 上一次提及率（无历史时为 null） */
  previous: number | null;
  /** 差值（current - previous），无历史时为 null */
  delta: number | null;
  /** 参与比较的快照数 */
  points: number;
  /** 一句话说明，可直接展示给用户 */
  summary: string;
}

/**
 * 比较最后两次快照。
 *
 * 单点无法判断趋势 —— 这是原来「只测一次」的根本缺陷。少于 2 次返回 insufficient。
 * `epsilon` 用于吸收采样抖动：GEO 单次采样波动大，1% 以内视为持平，
 * 否则每次都会显示"下降"，用户会误以为工作没效果。
 */
export function computeTrend(snapshots: GeoSnapshot[], epsilon = 0.02): TrendResult {
  const sorted = [...snapshots].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const points = sorted.length;
  if (points === 0) {
    return { direction: "insufficient", current: 0, previous: null, delta: null, points: 0, summary: "还没有监测记录，先跑一次基线。" };
  }
  const current = mentionRate(sorted[points - 1]);
  if (points === 1) {
    return {
      direction: "insufficient",
      current,
      previous: null,
      delta: null,
      points,
      summary: `当前提及率 ${pct(current)}，需要再测一次才能形成趋势。`,
    };
  }
  const previous = mentionRate(sorted[points - 2]);
  const delta = current - previous;
  const direction: TrendDirection = Math.abs(delta) <= epsilon ? "flat" : delta > 0 ? "up" : "down";
  const arrow = direction === "up" ? "上升" : direction === "down" ? "下降" : "持平";
  return {
    direction,
    current,
    previous,
    delta,
    points,
    summary: `${pct(previous)} → ${pct(current)}（${arrow} ${Math.abs(delta * 100).toFixed(0)} 个百分点）`,
  };
}

/** 逐条问题对比：哪些问题上次命中、这次丢了 —— 这是最有行动价值的信号 */
export interface QuestionDelta {
  question: string;
  before: boolean | null;
  after: boolean;
  change: "gained" | "lost" | "stable-hit" | "stable-miss" | "new";
}

export function questionDeltas(previous: GeoSnapshot | null, current: GeoSnapshot): QuestionDelta[] {
  const beforeMap = new Map<string, boolean>();
  if (previous) for (const s of previous.samples) beforeMap.set(s.question, s.mentioned);
  return current.samples.map((s) => {
    if (!beforeMap.has(s.question)) {
      return { question: s.question, before: null, after: s.mentioned, change: "new" as const };
    }
    const before = beforeMap.get(s.question)!;
    if (before === s.mentioned) {
      return { question: s.question, before, after: s.mentioned, change: before ? ("stable-hit" as const) : ("stable-miss" as const) };
    }
    return { question: s.question, before, after: s.mentioned, change: before ? ("lost" as const) : ("gained" as const) };
  });
}

/** 序列化的关注点（用于画趋势线）：返回 0~1 的提及率数组 */
export function rateSeries(snapshots: GeoSnapshot[]): number[] {
  return [...snapshots]
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    .map(mentionRate);
}

/**
 * 生成 SVG 折线点。这里不用图表库——一个趋势线不值得引入依赖，
 * 而且纯字符串输出便于单测（可直接断言坐标）。
 */
export interface SparkPoint {
  x: number;
  y: number;
  rate: number;
}

export function sparklinePoints(series: number[], width: number, height: number, padding = 4): SparkPoint[] {
  if (!series.length) return [];
  const innerW = Math.max(1, width - padding * 2);
  const innerH = Math.max(1, height - padding * 2);
  const stepX = series.length > 1 ? innerW / (series.length - 1) : 0;
  return series.map((rate, i) => {
    const clamped = Math.min(1, Math.max(0, rate));
    return {
      x: +(padding + (series.length > 1 ? i * stepX : innerW / 2)).toFixed(2),
      // SVG y 轴向下，提及率越高越靠上
      y: +(padding + (1 - clamped) * innerH).toFixed(2),
      rate,
    };
  });
}

/** 转成 SVG polyline 的 points 属性 */
export function polylineAttr(points: SparkPoint[]): string {
  return points.map((p) => `${p.x},${p.y}`).join(" ");
}

/** 0.667 → "67%" */
export function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/**
 * 判断某次快照是否「口径可比」。
 * 换通道（demo→真实模型）或问题集变了，趋势不能直接比 —— 必须告诉用户，
 * 否则等于用假数据骗自己。
 */
export function comparability(a: GeoSnapshot, b: GeoSnapshot): { ok: boolean; reason: string } {
  if (a.channel !== b.channel) {
    return { ok: false, reason: `通道不同（${a.channel} → ${b.channel}），提及率不可直接比较` };
  }
  const setA = new Set(a.questions);
  const setB = new Set(b.questions);
  const same = setA.size === setB.size && [...setA].every((q) => setB.has(q));
  if (!same) return { ok: false, reason: "问题集有变化，只能参考，不能当作同一基线" };
  return { ok: true, reason: "同通道同问题集，可直接比较" };
}

/**
 * 从模型回答里提取提及信号。
 * 比原来 `includes` 强的地方：
 *   - 大小写不敏感、忽略全半角空格，避免"品牌名"写法不同就漏判
 *   - 返回出现次数与首次位置，能区分「顺带一提」和「重点推荐」
 */
export function analyzeAnswer(answer: string, brand: string): Omit<MentionSample, "question"> {
  const clean = (s: string) => s.toLowerCase().replace(/[\s\u3000]+/g, "");
  const text = clean(answer);
  const needle = clean(brand);
  if (!needle) return { mentioned: false, hits: 0, firstPos: -1, answerLength: answer.length };
  let hits = 0;
  let firstPos = -1;
  let from = 0;
  for (;;) {
    const idx = text.indexOf(needle, from);
    if (idx === -1) break;
    if (hits === 0) firstPos = idx;
    // 防御：异常超长重复（模型偶尔会刷屏）。封顶 99，避免后续统计被极端值带偏。
    if (hits >= 99) break;
    hits += 1;
    from = idx + needle.length;
  }
  return { mentioned: hits > 0, hits, firstPos, answerLength: answer.length };
}

/* ------------------------------------------------------------------ */
/* 第 26 批：竞品对比 + 引用来源（借鉴抓词 GEO 的监测维度）            */
/* ------------------------------------------------------------------ */

/**
 * 多品牌分析：同一条回答同时测本品牌与竞品。
 * 复用 analyzeAnswer 的归一化口径，保证本品牌与竞品同尺子。
 */
export function analyzeAnswerMulti(answer: string, brands: string[]): BrandSignal[] {
  const seen = new Set<string>();
  const out: BrandSignal[] = [];
  for (const raw of brands) {
    const brand = raw.trim();
    if (!brand) continue;
    const key = brand.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const signal = analyzeAnswer(answer, brand);
    out.push({ brand, mentioned: signal.mentioned, hits: signal.hits, firstPos: signal.firstPos });
  }
  return out;
}

/** 从样本汇总竞品快照级统计（提及率 + 平均首次位置）。 */
export function buildCompetitorStats(samples: MentionSample[], competitorBrands: string[]): CompetitorStat[] {
  const brands = [...new Set(competitorBrands.map((b) => b.trim()).filter(Boolean))].slice(0, 3);
  return brands.map((brand) => {
    const signals = samples.flatMap((s) => (s.competitors ?? []).filter((c) => c.brand === brand));
    const hit = signals.filter((c) => c.mentioned && c.firstPos >= 0);
    return {
      brand,
      mentionRate: samples.length ? signals.filter((c) => c.mentioned).length / samples.length : 0,
      firstPos: hit.length ? hit.reduce((sum, c) => sum + c.firstPos, 0) / hit.length : null,
    };
  });
}

export interface CompetitorRow {
  brand: string;
  isSelf: boolean;
  mentionRate: number;
  firstPos: number | null;
  /** 与本品牌的提及率差值（本品牌行恒为 0） */
  deltaRate: number;
  /** 按提及率降序的名次（1 起，并列同名次取先出现） */
  rank: number;
}

/**
 * 竞品对比表：本品牌 vs 竞品的提及率/首位位置差值与排名。
 * 旧快照没有 competitors 字段时只返回本品牌一行（报表降级，不报错）。
 */
export function competitorComparison(snapshot: GeoSnapshot): CompetitorRow[] {
  const selfRate = mentionRate(snapshot);
  const rows: CompetitorRow[] = [
    { brand: snapshot.brand, isSelf: true, mentionRate: selfRate, firstPos: avgFirstPos(snapshot), deltaRate: 0, rank: 1 },
    ...(snapshot.competitors ?? []).map((c) => ({
      brand: c.brand,
      isSelf: false,
      mentionRate: c.mentionRate,
      firstPos: c.firstPos,
      deltaRate: c.mentionRate - selfRate,
      rank: 1,
    })),
  ];
  const sorted = [...rows].sort((a, b) => b.mentionRate - a.mentionRate);
  sorted.forEach((row, index) => { row.rank = index + 1; });
  // 展示顺序：本品牌置顶，其余按提及率降序（rank 已按全局序算好）
  return [rows[0], ...sorted.filter((row) => !row.isSelf)];
}

/** 多品牌提及率序列（趋势对比）：brand 为本品牌时等价于 rateSeries。 */
export function rateSeriesFor(snapshots: GeoSnapshot[], brand: string): number[] {
  return [...snapshots]
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    .map((snapshot) => {
      if (brand === snapshot.brand) return mentionRate(snapshot);
      return snapshot.competitors?.find((c) => c.brand === brand)?.mentionRate ?? 0;
    });
}

const SOURCE_URL_RE = /https?:\/\/[^\s<>"'）)】]+/gi;
const SOURCE_SECTION_RE = /(?:参考来源|参考资料|来源|出处|引用来源)\s*[：:]\s*([^\n]+(?:\n[^\n]+)*)/i;

/**
 * 从模型回答里解析参考来源：URL 提取 + 「来源：」段落解析。
 * 无来源返回空数组（调用方如实标注「模型未给出处」，不编造）。
 */
export function extractSources(answer: string, max = 8): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (value: string) => {
    const cleaned = value.trim().replace(/[。；;，,]+$/u, "").slice(0, 120);
    if (!cleaned || cleaned === "无") return;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(cleaned);
  };

  for (const match of answer.match(SOURCE_URL_RE) ?? []) push(match.replace(/[）)】]+$/u, ""));

  const section = answer.match(SOURCE_SECTION_RE);
  if (section) {
    for (const part of section[1].split(/[、,，;；\n]/)) {
      // 去掉序号/项目符号前缀，URL 已在上一步收过则去重
      push(part.replace(/^\s*(?:[-*•·]|\d+[.、)])\s*/u, ""));
    }
  }
  return out.slice(0, max);
}

/** 来源归并键：URL 取域名，纯文本取去空白小写。 */
export function sourceKey(source: string): string {
  const urlMatch = source.match(/https?:\/\/([^/\s]+)/i);
  if (urlMatch) return urlMatch[1].toLowerCase().replace(/^www\./, "");
  return source.trim().toLowerCase().replace(/[\s\u3000]+/g, "");
}

export interface SourceRankRow {
  source: string;
  count: number;
}

/**
 * 被引用信源 TOP：跨快照统计来源出现次数（按域名/名称归并）。
 * 优先读快照级 sources，旧结构回退到样本级 sources；都没有则返回空。
 */
export function sourceRanking(snapshots: GeoSnapshot[], top = 10): SourceRankRow[] {
  const counts = new Map<string, { source: string; count: number }>();
  const add = (source: string) => {
    const key = sourceKey(source);
    if (!key) return;
    const row = counts.get(key) ?? { source: source.trim(), count: 0 };
    row.count += 1;
    counts.set(key, row);
  };
  for (const snapshot of snapshots) {
    if (snapshot.sources?.length) {
      for (const item of snapshot.sources) for (const source of item.sources) add(source);
    } else {
      for (const sample of snapshot.samples) for (const source of sample.sources ?? []) add(source);
    }
  }
  return [...counts.values()]
    .sort((a, b) => b.count - a.count || a.source.localeCompare(b.source))
    .slice(0, top);
}

/* ------------------------------------------------------------------ */
/* 第 27 批：顶部概览条 + 分步导航状态（版面重构，纯函数）              */
/* ------------------------------------------------------------------ */

/**
 * 首位率（0~1）：本品牌在回答里「第一个被提到」的题目占比。
 * 有竞品信号时按真实竞速（本品牌首次位置早于所有竞品）；无竞品信号时
 * 以「出现在回答前 30%」近似首位（旧快照/未填竞品时仍有可比口径）。
 */
export function firstPosRate(snapshot: GeoSnapshot): number {
  if (!snapshot.samples.length) return 0;
  let first = 0;
  for (const sample of snapshot.samples) {
    if (!sample.mentioned || sample.firstPos < 0) continue;
    const competitors = sample.competitors ?? [];
    if (competitors.length) {
      if (competitors.every((c) => !c.mentioned || c.firstPos > sample.firstPos)) first += 1;
    } else if (sample.answerLength > 0 && sample.firstPos / sample.answerLength <= 0.3) {
      first += 1;
    }
  }
  return first / snapshot.samples.length;
}

/** 单次快照里被引用的信源个数（按域名/名称归并去重）。 */
export function snapshotSourceCount(snapshot: GeoSnapshot): number {
  const keys = new Set<string>();
  if (snapshot.sources?.length) {
    for (const item of snapshot.sources) for (const source of item.sources) keys.add(sourceKey(source));
  } else {
    for (const sample of snapshot.samples) for (const source of sample.sources ?? []) keys.add(sourceKey(source));
  }
  keys.delete("");
  return keys.size;
}

export interface GeoOverview {
  /** 监测总次数 */
  runs: number;
  brand: string;
  /** 最近一次监测时间（ISO） */
  latestAt: string;
  mentionRate: number;
  /** 与上一次的提及率差值；只有一次记录时为 null */
  mentionDelta: number | null;
  firstPosRate: number;
  firstPosDelta: number | null;
  /** 本品牌在竞品中的名次（1 起）；未填竞品/旧快照无竞品数据时为 null */
  competitorRank: number | null;
  competitorCount: number;
  /** 最新一次被引用的信源个数（归并去重后） */
  sourceCount: number;
}

/** 顶部概览条数据：最新一次快照 + 与上一次的涨跌。无快照返回 null。 */
export function overviewStats(snapshots: GeoSnapshot[]): GeoOverview | null {
  if (!snapshots.length) return null;
  const sorted = [...snapshots].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const latest = sorted[sorted.length - 1];
  const previous = sorted.length > 1 ? sorted[sorted.length - 2] : null;
  const comparison = competitorComparison(latest);
  const selfRow = comparison.find((row) => row.isSelf);
  const hasCompetitors = comparison.length > 1;
  return {
    runs: sorted.length,
    brand: latest.brand,
    latestAt: latest.at,
    mentionRate: mentionRate(latest),
    mentionDelta: previous ? mentionRate(latest) - mentionRate(previous) : null,
    firstPosRate: firstPosRate(latest),
    firstPosDelta: previous ? firstPosRate(latest) - firstPosRate(previous) : null,
    competitorRank: hasCompetitors && selfRow ? selfRow.rank : null,
    competitorCount: hasCompetitors ? comparison.length - 1 : 0,
    sourceCount: snapshotSourceCount(latest),
  };
}

export interface GeoStepInput {
  /** ①资料体检：体检有结果 */
  hasAudit: boolean;
  /** ②拓词选题：有拓词结果或有选题 */
  hasKeywordsOrTopics: boolean;
  /** ③监测问题集：问题条数 */
  questionCount: number;
  /** ④监测与报告：快照条数 */
  snapshotCount: number;
}

/** 四步完成状态（顺序：资料体检 / 拓词选题 / 监测问题集 / 监测与报告）。 */
export function geoStepStatus(input: GeoStepInput): boolean[] {
  return [
    input.hasAudit,
    input.hasKeywordsOrTopics,
    input.questionCount > 0,
    input.snapshotCount > 0,
  ];
}

/** 第一个未完成步骤（1 起）；全部完成时停在最后一步（监测与报告）。 */
export function firstIncompleteStep(status: boolean[]): number {
  const index = status.findIndex((done) => !done);
  return index === -1 ? status.length : index + 1;
}
