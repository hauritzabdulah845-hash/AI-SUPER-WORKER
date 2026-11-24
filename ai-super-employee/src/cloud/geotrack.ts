/**
 * GEO 持续监测与趋势追踪（纯函数层，无 IO，可单测）。
 *
 * 为什么需要这层：原来的提及率测试是「跑一次、看一个数」——
 * GEO 是长期博弈，一次命中不代表下月还在，没有趋势就无法证明工作有效，
 * 也无法判断某次素材投放到底有没有用。
 *
 * 这里只做「快照 → 序列 → 趋势」的纯计算；存储与网络在 geotrack.ts。
 */

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
