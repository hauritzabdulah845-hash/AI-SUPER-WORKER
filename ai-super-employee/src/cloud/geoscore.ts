/**
 * GEO 指标体系（纯函数层，无 IO，可单测）。
 *
 * 为什么需要这层：原来的监测只回答「提没提」——
 *   · 提了但排在竞品后面 → 用户根本看不到，却和「首位推荐」记同一个 1；
 *   · AI 把品牌说错了（价格/能力错） → 提及率反而变成负资产；
 *   · 只说「我们被提及了 40%」，客户无法判断这笔投入值不值。
 *
 * 这里把行业通行的三个口径算清楚，并给出「本品牌 vs 竞品」的相对位置：
 *   · 提及率 mentionRate  —— 回答里出现了品牌名
 *   · 推荐率 recommendRate —— 命中且被正向推荐（排除「不推荐」语境）
 *   · 首推率 topRate       —— 命中且排在第一个（用户实际看到的那一个）
 * 三个指标同尺子计算，本品牌与竞品共用同一套判定，避免「自己算得松、竞品算得紧」。
 *
 * 另一个关键设计：**样本可不可信要单独说**。样本量为 1 条时，任何比率都是噪声，
 * 直接展示「100%」会误导客户，所以 viewStats 会带 sampleAdequacy 让 UI 如实标注。
 */

/* ------------------------------ 语境判定 ------------------------------ */

/**
 * 否定/风险语境。命中品牌名但落在这些词后面，多半是「不推荐/需谨慎/有争议」，
 * 算进提及率但不算推荐率 —— 这正是「被提及」和「被推荐」的区别。
 */
const NEGATIVE_CUES = [
  "不推荐",
  "不建议",
  "不选",
  "别选",
  "避开",
  "慎选",
  "谨慎",
  "缺点",
  "劣势",
  "不足",
  "风险",
  "投诉",
  "差评",
  "翻车",
  "退费",
  "维权",
  "智商税",
  "不靠谱",
  "口碑差",
  "问题较多",
  "不建议购买",
  "性价比低",
  "踩坑",
];

/**
 * 正向推荐语境。注意：不能只靠「推荐」两个字 —— 「不推荐」里也含「推荐」，
 * 所以判定顺序是「先查否定语境，再查正向语境」，见 recommendSignal。
 */
const POSITIVE_CUES = [
  "推荐",
  "首选",
  "首推",
  "优先",
  "值得",
  "适合",
  "优势",
  "强项",
  "领先",
  "头部",
  "口碑好",
  "好评",
  "专业",
  "靠谱",
  "好用",
  "性价比高",
  "值得选",
  "可以考虑",
  "表现出色",
  "标杆",
  "第一梯队",
];

export type RecommendPolarity = "positive" | "negative" | "neutral";

/** 归一化：小写 + 去空白（与 geotrack.analyzeAnswer 同口径，保证位置可比） */
function normalize(text: string): string {
  return text.toLowerCase().replace(/[\s\u3000]+/g, "");
}

/** 品牌名在回答中的首次出现位置（归一化后坐标，-1 = 未出现） */
export function brandFirstPos(answer: string, brand: string): number {
  const needle = normalize(brand);
  if (!needle) return -1;
  return normalize(answer).indexOf(needle);
}

/** 品牌名在回答里的出现次数（封顶 99，防御模型刷屏） */
export function brandHits(answer: string, brand: string): number {
  const text = normalize(answer);
  const needle = normalize(brand);
  if (!needle) return 0;
  let hits = 0;
  let from = 0;
  for (;;) {
    const idx = text.indexOf(needle, from);
    if (idx === -1) break;
    hits += 1;
    if (hits >= 99) break;
    from = idx + needle.length;
  }
  return hits;
}

/**
 * 判断某个品牌在回答里被「怎么提」的。
 *
 * 取品牌名出现位置前后各 40 字作为语境窗口：太窄抓不到「XX 值得推荐」这种
 * 隔了几个字的搭配，太宽又会把别的品牌的评价算到它头上。
 * 否定优先于肯定 —— 「不推荐 XX」必须判成 negative。
 */
export function recommendSignal(answer: string, brand: string): RecommendPolarity {
  const pos = brandFirstPos(answer, brand);
  if (pos === -1) return "neutral";
  const text = normalize(answer);
  const windowStart = Math.max(0, pos - 40);
  // 品牌名本身可能较长，窗口右边界从名字结束处往后扩 40
  const windowEnd = Math.min(text.length, pos + normalize(brand).length + 40);
  const window = text.slice(windowStart, windowEnd);

  if (NEGATIVE_CUES.some((cue) => window.includes(cue))) return "negative";
  if (POSITIVE_CUES.some((cue) => window.includes(cue))) return "positive";
  return "neutral";
}

/* ------------------------------ 单品牌指标 ------------------------------ */

/** 单条回答里、单个品牌的完整信号（比 MentionSample 多「推荐倾向」与「首位」） */
export interface BrandEval {
  brand: string;
  mentioned: boolean;
  hits: number;
  firstPos: number;
  /** 是否被正向推荐（mentioned && polarity === positive） */
  recommended: boolean;
  polarity: RecommendPolarity;
  /** 是否在回答里排第一（本品牌首个出现位置早于所有竞品） */
  top: boolean;
  answerLength: number;
}

/**
 * 在同一条回答里，把本品牌与竞品放在一起比位置，得出「谁被排在第一」。
 *
 * 并列的情况（同位置）不算首推：宁可少算，也不要虚报首推率。
 */
export function evalAnswer(
  answer: string,
  brand: string,
  competitors: string[] = [],
): { self: BrandEval; competitors: BrandEval[] } {
  const build = (name: string): BrandEval => {
    const firstPos = brandFirstPos(answer, name);
    const mentioned = firstPos >= 0;
    const polarity = mentioned ? recommendSignal(answer, name) : "neutral";
    return {
      brand: name,
      mentioned,
      hits: mentioned ? brandHits(answer, name) : 0,
      firstPos,
      recommended: mentioned && polarity === "positive",
      polarity,
      // 先占位，下面统一判定首推
      top: false,
      answerLength: answer.length,
    };
  };

  const self = build(brand);
  const rivalList = [...new Set(competitors.map((c) => c.trim()).filter(Boolean))]
    .filter((c) => c !== brand)
    .map(build);

  const all = [self, ...rivalList];
  for (const item of all) {
    if (!item.mentioned) continue;
    const others = all.filter((other) => other !== item && other.mentioned);
    // 严格早于所有命中竞品才算首推；并列不算
    item.top = others.every((other) => item.firstPos < other.firstPos);
  }

  return { self, competitors: rivalList };
}

/* ------------------------------ 汇总指标 ------------------------------ */

export interface GeoMetrics {
  /** 样本总数（分母） */
  sample: number;
  /** 提及率：mentioned / sample */
  mentionRate: number;
  /** 推荐率：recommended / sample（被正向推荐才算） */
  recommendRate: number;
  /** 首推率：top / sample（排第一才算） */
  topRate: number;
  /** 负面率：polarity === negative / sample —— 越高越危险，要单独盯 */
  negativeRate: number;
  /** 命中样本的平均首次位置（归一化后），无命中为 null */
  avgFirstPos: number | null;
}

/** 比率统一保留 3 位小数，避免 0.33333333 这种噪声进报表 */
function ratio(part: number, total: number): number {
  if (!total) return 0;
  return Math.round((part / total) * 1000) / 1000;
}

/** 把逐条评估汇总成四个比率指标 */
export function summarize(evals: BrandEval[]): GeoMetrics {
  const sample = evals.length;
  const hit = evals.filter((item) => item.mentioned);
  const firstPositions = hit.filter((item) => item.firstPos >= 0).map((item) => item.firstPos);
  return {
    sample,
    mentionRate: ratio(hit.length, sample),
    recommendRate: ratio(evals.filter((item) => item.recommended).length, sample),
    topRate: ratio(evals.filter((item) => item.top).length, sample),
    negativeRate: ratio(hit.filter((item) => item.polarity === "negative").length, sample),
    avgFirstPos: firstPositions.length
      ? Math.round((firstPositions.reduce((sum, pos) => sum + pos, 0) / firstPositions.length) * 10) / 10
      : null,
  };
}

/* ------------------------------ 样本可信度 ------------------------------ */

export type SampleAdequacy = "insufficient" | "weak" | "ok";

export interface SampleAdvice {
  adequacy: SampleAdequacy;
  /** 可直接展示给用户的一句话 */
  label: string;
  /** 建议补到多少条问题才有参考价值 */
  suggested: number;
}

/** 低于这个样本量，比率波动极大，只能当「有/无」看 */
export const MIN_SAMPLE_WEAK = 3;
/** 达到这个样本量，比率才值得写进对外材料 */
export const MIN_SAMPLE_OK = 8;

/**
 * 样本量够不够。
 *
 * 单条问题跑出来的「100% 提及率」在统计上没有意义 —— 换个措辞可能就变 0。
 * 这里不隐藏数字（用户要看真实结果），而是强制配一句可信度说明。
 */
export function sampleAdvice(sample: number): SampleAdvice {
  if (sample < MIN_SAMPLE_WEAK) {
    return {
      adequacy: "insufficient",
      label: `仅 ${sample} 条问题，比率波动极大，只能看「有没有被提」，不能当作效果结论`,
      suggested: MIN_SAMPLE_OK,
    };
  }
  if (sample < MIN_SAMPLE_OK) {
    return {
      adequacy: "weak",
      label: `${sample} 条问题可看趋势方向，建议补到 ${MIN_SAMPLE_OK} 条以上再对外引用`,
      suggested: MIN_SAMPLE_OK,
    };
  }
  return { adequacy: "ok", label: `${sample} 条问题，样本量可支撑比率结论`, suggested: MIN_SAMPLE_OK };
}

/* ------------------------------ 问题词矩阵 ------------------------------ */

/**
 * 问题词五层意图模型（对齐行业通行的决策链路分层）：
 *   L1 认知 —— 品类是什么、有没有这种东西
 *   L2 探索 —— 有哪些方案/平台，怎么用
 *   L3 评估 —— 哪家好、怎么选（成交前最关键的一层）
 *   L4 决策 —— 价格、对比、合同、售后
 *   L5 口碑 —— 真实评价、踩坑、退费
 *
 * 分层不是为了好看：不同层的问题，AI 的回答策略完全不同，
 * 混在一起统计会让「品类词命中率高」掩盖「选型词全丢」这个真问题。
 */
export const GEO_INTENT_LEVELS = [
  { key: "L1", label: "认知", hint: "品类是什么、值不值得做" },
  { key: "L2", label: "探索", hint: "有哪些方案、怎么开始" },
  { key: "L3", label: "评估", hint: "哪家好、怎么选（成交关键层）" },
  { key: "L4", label: "决策", hint: "价格、对比、交付与售后" },
  { key: "L5", label: "口碑", hint: "真实评价、踩坑与风险" },
] as const;

export type GeoIntentLevel = (typeof GEO_INTENT_LEVELS)[number]["key"];

const LEVEL_PATTERNS: { level: GeoIntentLevel; re: RegExp }[] = [
  // 顺序有意义：先判更具体的层，避免「哪家好多少钱」被 L1 抢走
  { level: "L5", re: /(差评|投诉|翻车|踩坑|退费|退款|维权|真实评价|后悔|有坑|坑吗|哪些坑|的坑|避坑)/ },
  { level: "L4", re: /(多少钱|价格|收费|报价|费用|对比|区别|和.+比|合同|售后|发票|交付)/ },
  { level: "L3", re: /(哪家|哪个好|怎么选|推荐|排行榜|排名|top\s*\d|首选|值得选|靠谱|口碑)/ },
  { level: "L2", re: /(有哪些|怎么做|如何|怎么用|流程|步骤|方案|平台|工具|入门|教程)/ },
  { level: "L1", re: /(是什么|什么是|什么意思|为什么|有用吗|值得做吗|前景|趋势)/ },
];

/**
 * 判断一个问题属于哪一层意图。
 * 规则写死在代码里而不是交给模型：分层结果要能复现、要能在测试里断言，
 * 而且用户改了问题措辞后归类不该漂移。无法归类时落到 L3（评估层）——
 * 商业问题绝大多数是「选谁」，归到中间层最不容易误导。
 */
export function classifyIntent(question: string): GeoIntentLevel {
  const text = question.toLowerCase().replace(/[\s\u3000]+/g, "");
  for (const { level, re } of LEVEL_PATTERNS) {
    if (re.test(text)) return level;
  }
  return "L3";
}

export function intentLabel(level: GeoIntentLevel): string {
  const found = GEO_INTENT_LEVELS.find((item) => item.key === level);
  return found ? found.label : level;
}

/* ------------------------------ 问题矩阵汇总 ------------------------------ */

export interface IntentBucket {
  level: GeoIntentLevel;
  label: string;
  hint: string;
  questions: string[];
  /** 该层的问题数 */
  count: number;
  /** 该层的提及率（按问题数加权，不是各层平均） */
  mentionRate: number;
  /** 该层的推荐率 */
  recommendRate: number;
  /** 该层的首推率 */
  topRate: number;
}

/**
 * 按意图分层汇总。
 * 五个层级固定输出（空层也保留），这样 UI 能直接看出「哪一层完全没覆盖」——
 * 只列出有数据的层，会让缺口隐形。
 */
export function buildIntentBuckets(evals: { question: string; self: BrandEval }[]): IntentBucket[] {
  return GEO_INTENT_LEVELS.map((level) => {
    const rows = evals.filter((row) => classifyIntent(row.question) === level.key);
    const metrics = summarize(rows.map((row) => row.self));
    return {
      level: level.key,
      label: level.label,
      hint: level.hint,
      questions: rows.map((row) => row.question),
      count: rows.length,
      mentionRate: metrics.mentionRate,
      recommendRate: metrics.recommendRate,
      topRate: metrics.topRate,
    };
  });
}

/**
 * 覆盖缺口：哪些层级问题太少（或完全没有）。
 * 用来直接生成「下一步该补什么问题」的动作项，而不是让用户自己数。
 */
export function coverageGaps(buckets: IntentBucket[], minPerLevel = 2): { level: GeoIntentLevel; label: string; count: number; empty: boolean }[] {
  return buckets
    .filter((bucket) => bucket.count < minPerLevel)
    .map((bucket) => ({ level: bucket.level, label: bucket.label, count: bucket.count, empty: bucket.count === 0 }));
}

/* ------------------------------ 竞品相对位置 ------------------------------ */

export interface BrandStanding {
  brand: string;
  isSelf: boolean;
  metrics: GeoMetrics;
  /** 首推率名次（1 起，按 topRate → recommendRate → mentionRate 依次比较） */
  rank: number;
  /** 与本品牌首推率的差（本品牌行为 0） */
  deltaTop: number;
  /** 与本品牌推荐率的差 */
  deltaRecommend: number;
}

/** 指标排序比较：首推率优先，其次推荐率，最后提及率 */
function compareMetrics(a: GeoMetrics, b: GeoMetrics): number {
  return b.topRate - a.topRate || b.recommendRate - a.recommendRate || b.mentionRate - a.mentionRate;
}

/**
 * 多品牌同一尺子排名。
 *
 * 排序口径刻意选「首推率 > 推荐率 > 提及率」：用户问「哪家好」时只会照第一个做的，
 * 提及率第 3 名实际拿不到流量。只按提及率排名会让客户误以为势均力敌。
 */
export function brandStandings(
  brand: string,
  competitors: string[],
  evals: { self: BrandEval; competitors: BrandEval[] }[],
): BrandStanding[] {
  const names = [brand, ...competitors.filter((c) => c && c !== brand)];
  const rows = names.map((name) => {
    const isSelf = name === brand;
    const list = evals.map((row) => (isSelf ? row.self : row.competitors.find((c) => c.brand === name) ?? {
      brand: name, mentioned: false, hits: 0, firstPos: -1,
      recommended: false, polarity: "neutral" as RecommendPolarity, top: false, answerLength: 0,
    }));
    return { brand: name, isSelf, metrics: summarize(list), rank: 1 };
  });

  const sorted = [...rows].sort((a, b) => compareMetrics(a.metrics, b.metrics));
  sorted.forEach((row, index) => { row.rank = index + 1; });

  const selfMetrics = rows[0].metrics;
  return rows.map((row) => ({
    ...row,
    deltaTop: Math.round((row.metrics.topRate - selfMetrics.topRate) * 1000) / 1000,
    deltaRecommend: Math.round((row.metrics.recommendRate - selfMetrics.recommendRate) * 1000) / 1000,
  }));
}

/* ------------------------------ 来源缺口 ------------------------------ */

/**
 * 信源缺口分析：AI 引用了哪些信源，其中多少是「你自己的域名」。
 *
 * 这是最容易被忽略、但对 GEO 最致命的一条：
 * 如果 AI 全部引用第三方媒体，说明你的官网内容根本没进 AI 的检索视野，
 * 优化自己的站内页面等于白做 —— 必须先做站外信源。
 */
export interface SourceGap {
  /** 去重后的信源总数 */
  total: number;
  /** 自有域名被引用次数 */
  ownCount: number;
  /** 第三方信源被引用次数 */
  thirdPartyCount: number;
  /** 自有域名占比 0~1 */
  ownRatio: number;
  /** 结论一句话 */
  verdict: string;
  /** 引用最多的信源（最多 5 条） */
  top: { source: string; count: number }[];
}

/** 从 URL 或名称里抠出域名（去 www.），非 URL 返回空串 */
export function hostOf(source: string): string {
  const match = source.match(/https?:\/\/([^/\s?#]+)/i);
  if (!match) return "";
  return match[1].toLowerCase().replace(/^www\./, "").replace(/:\d+$/, "");
}

/**
 * 判断某条来源是否属于自有域名。
 * 用「域名相等或以 .自有域名 结尾」判定，避免 evil-example.com 误判成 example.com。
 */
export function isOwnSource(source: string, ownDomain: string): boolean {
  const host = hostOf(source);
  const own = ownDomain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
  if (!host || !own) return false;
  return host === own || host.endsWith(`.${own}`);
}

/**
 * 信源缺口统计。
 * 没填自有域名时 ownRatio 记 0 且结论明确说「未配置」，
 * 不能默认当成「自有信源为 0」去吓用户。
 */
export function sourceGap(
  rows: { source: string; count: number }[],
  ownDomain: string,
): SourceGap {
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  const own = ownDomain.trim()
    ? rows.filter((row) => isOwnSource(row.source, ownDomain)).reduce((sum, row) => sum + row.count, 0)
    : 0;
  const thirdParty = total - own;
  const ownRatio = total ? Math.round((own / total) * 1000) / 1000 : 0;

  let verdict: string;
  if (!total) {
    verdict = "还没有采集到 AI 引用的信源，先跑一次监测。";
  } else if (!ownDomain.trim()) {
    verdict = `AI 共引用 ${total} 次信源，但未填写自有域名，无法判断站内内容占比。`;
  } else if (own === 0) {
    verdict = `AI 引用的 ${total} 次信源里没有你的站点 —— 官网内容未进 AI 检索视野，优先补站外权威信源。`;
  } else if (ownRatio < 0.3) {
    verdict = `自有站点仅占 ${Math.round(ownRatio * 100)}%，AI 更信任第三方来源，需继续补站外信源。`;
  } else {
    verdict = `自有站点占 ${Math.round(ownRatio * 100)}%，站内内容已被 AI 采信，保持更新节奏即可。`;
  }

  return {
    total,
    ownCount: own,
    thirdPartyCount: thirdParty,
    ownRatio,
    verdict,
    top: [...rows].sort((a, b) => b.count - a.count).slice(0, 5),
  };
}

/* ------------------------------ 内容可引用性体检 ------------------------------ */

export interface ReadabilityFinding {
  key: string;
  label: string;
  /** 0~100 */
  score: number;
  /** 一句话结论（带实测数字） */
  note: string;
  /** 是否建议修（低分项给具体动作） */
  fix?: string;
}

export interface ReadabilityResult {
  score: number;
  findings: ReadabilityFinding[];
}

/** 中文正文里「能被 AI 整段引用」的硬结构特征，全部可确定性地测出来 */
const STRUCTURE_RULES = {
  /** 结论先行：开头 150 字内出现结论性表达 */
  conclusionRe: /(总之|结论|一句话|简单说|核心是|答案是|先说结论)/,
  /** 数字密度：每 200 字至少 1 个数字，AI 偏爱可核验的具体值 */
  minNumbersPer200: 1,
  /** 单段超过这个字数，模型切段时会丢上下文 */
  maxParagraphChars: 220,
};

/**
 * 内容可引用性体检（规则化，不走模型）。
 *
 * 为什么不交给 LLM：用户要的是「改哪里」，而 LLM 每次给的结论不一样，
 * 改完也无法验证是否真的变好了。这里每条都是可复算的确定性指标，
 * 改完再跑一次分数一定会动 —— 这才叫「可验收」。
 */
export function auditReadability(content: string): ReadabilityResult {
  const text = content.trim();
  if (!text) {
    return {
      score: 0,
      findings: [{ key: "empty", label: "内容", score: 0, note: "没有正文，先粘贴要发布的文章或落地页文案。" }],
    };
  }

  const length = text.length;
  const numbers = (text.match(/\d+(?:\.\d+)?%?/g) ?? []).length;
  const paragraphs = text.split(/\n{1,}/).map((p) => p.trim()).filter(Boolean);
  const longest = paragraphs.reduce((max, p) => Math.max(max, p.length), 0);
  const headings = (text.match(/^#{1,6}\s+/gm) ?? []).length;
  const bullets = (text.match(/^\s*(?:[-*•]|\d+[.、)])\s+/gm) ?? []).length;
  const questions = (text.match(/[？?]/g) ?? []).length;
  const hasFaq = /(常见问题|FAQ|Q&A|问答)/i.test(text);
  const head = text.slice(0, 150);
  const hasConclusion = STRUCTURE_RULES.conclusionRe.test(head);
  const dates = (text.match(/\d{4}\s*[-年/]\s*\d{1,2}/g) ?? []).length;

  const findings: ReadabilityFinding[] = [];

  // 1. 事实密度：数字多 = AI 敢引用，因为可核验
  const numberTarget = Math.max(1, Math.floor(length / 200) * STRUCTURE_RULES.minNumbersPer200);
  const factScore = Math.min(100, Math.round((numbers / numberTarget) * 100));
  findings.push({
    key: "facts",
    label: "事实密度",
    score: factScore,
    note: `${length} 字里有 ${numbers} 个数字，按每 200 字 1 个算期望 ${numberTarget} 个`,
    fix: factScore < 70 ? "把「很多客户」「价格实惠」换成具体数字（客户数、价格、年限、百分比）" : undefined,
  });

  // 2. 结论先行：AI 摘要是抓开头，开头没结论就抓不到立场
  findings.push({
    key: "conclusion",
    label: "结论先行",
    score: hasConclusion ? 100 : 30,
    note: hasConclusion ? "开头 150 字内给出了明确结论，便于引擎直接摘取" : "开头 150 字内没有结论性表达，引擎只能摘到背景介绍",
    fix: hasConclusion ? undefined : "第一段就写出结论（「结论：…」或「一句话：…」），背景放到后面",
  });

  // 3. 分块粒度：超长段落被切段时会丢上下文
  const grainScore = longest <= STRUCTURE_RULES.maxParagraphChars ? 100 : Math.max(20, Math.round((STRUCTURE_RULES.maxParagraphChars / longest) * 100));
  findings.push({
    key: "grain",
    label: "分块粒度",
    score: grainScore,
    note: `共 ${paragraphs.length} 段，最长一段 ${longest} 字（建议 ≤ ${STRUCTURE_RULES.maxParagraphChars}）`,
    fix: grainScore < 70 ? "把最长段落按「一个观点一段」拆开，标题层级用小节标出" : undefined,
  });

  // 4. 结构化：标题 + 列表，让引擎能定位到具体小节
  const structureScore = Math.min(100, headings * 12 + Math.min(40, bullets * 6) + (hasFaq ? 20 : 0) + 8);
  findings.push({
    key: "structure",
    label: "结构化程度",
    score: structureScore,
    note: `${headings} 个小标题、${bullets} 条列表项${hasFaq ? "、含 FAQ 区块" : "、无 FAQ 区块"}`,
    fix: structureScore < 70 ? "补小标题（每 300 字一个）与要点列表；文末加 FAQ 区块" : undefined,
  });

  // 5. 问答对齐：内容里有没有直接回答用户的问句
  const qaScore = Math.min(100, questions * 20 + (hasFaq ? 60 : 0));
  findings.push({
    key: "qa",
    label: "问答对齐",
    score: qaScore,
    note: `${questions} 处问句${hasFaq ? "、有 FAQ" : "、无 FAQ"}，问句越贴近用户原话越容易被命中`,
    fix: qaScore < 70 ? "把小节标题改成用户会问的原话（「多少钱？」「和 X 有什么区别？」）" : undefined,
  });

  // 6. 时效性：带日期/版本号，AI 更容易判断信息新旧
  findings.push({
    key: "fresh",
    label: "时效标记",
    score: dates > 0 ? 100 : 40,
    note: dates > 0 ? `出现 ${dates} 处日期/版本标记` : "没有日期或版本标记，引擎无法判断信息是否过期",
    fix: dates > 0 ? undefined : "在标题或关键数据旁标注日期（如「2026 年 11 月更新」）与数据来源年份",
  });

  // 总分：事实密度与结论先行权重更高（这两项决定 AI 敢不敢引用）
  const weights: Record<string, number> = { facts: 0.25, conclusion: 0.2, grain: 0.15, structure: 0.15, qa: 0.15, fresh: 0.1 };
  const score = Math.round(findings.reduce((sum, item) => sum + item.score * (weights[item.key] ?? 0), 0));

  return { score, findings };
}

/* ------------------------------ 内容 Brief ------------------------------ */

export interface BriefInput {
  brand: string;
  question: string;
  /** 这一层意图的说明，用来调整写作重心 */
  intentLabel?: string;
  /** 竞品名（用于对比段） */
  competitors?: string[];
  /** 品牌事实卡里的硬事实（价格/数据），要求写进正文 */
  facts?: string[];
}

export interface ContentBrief {
  title: string;
  intent: GeoIntentLevel;
  intentLabel: string;
  /** 一句话结论（结论先行） */
  conclusion: string;
  sections: { heading: string; points: string[] }[];
  /** 必须出现的事实（来自事实卡，禁止编造） */
  mustInclude: string[];
  /** 禁止出现的内容（合规红线） */
  mustAvoid: string[];
  /** 建议字数 */
  wordTarget: number;
  /** 发布渠道建议 */
  channels: string[];
}

/** 各意图层的写作重心与字数目标（规则化，保证同层 brief 结构一致） */
const BRIEF_PLAYBOOK: Record<GeoIntentLevel, {
  angle: string;
  sections: string[];
  words: number;
  channels: string[];
}> = {
  L1: {
    angle: "把品类讲清楚，先给定义再给判断标准",
    sections: ["一句话定义", "这类东西解决什么问题", "判断值不值得用的 3 个标准", "常见误解"],
    words: 1200,
    channels: ["官网知识页", "公众号", "知乎"],
  },
  L2: {
    angle: "给出可执行的路径，步骤要能被单独摘出来用",
    sections: ["有哪几类做法", "每类适合谁", "从零开始的第一步", "常见卡点"],
    words: 1500,
    channels: ["官网教程页", "知乎", "B站"],
  },
  L3: {
    angle: "直接回应「选谁」，用可核验的差异建立推荐理由",
    sections: ["先说结论：什么情况下选我们", "选型要看哪 4 个指标", "主流方案逐项对比", "不同预算怎么选"],
    words: 1800,
    channels: ["官网选型页", "知乎", "小红书"],
  },
  L4: {
    angle: "把价格、交付、售后讲透，消除决策阻力",
    sections: ["价格构成与区间", "包含什么、不包含什么", "交付周期与服务边界", "和替代方案的成本对比"],
    words: 1500,
    channels: ["官网价格页", "公众号", "知乎"],
  },
  L5: {
    angle: "正视风险与口碑，用可核验的第三方证据建立信任",
    sections: ["真实使用效果（带数据）", "客户最常反馈的问题及处理方式", "退款/售后政策原文", "第三方评价与资质"],
    words: 1400,
    channels: ["官网 FAQ", "小红书", "知乎"],
  },
};

/**
 * 生成内容 Brief（规则化，零模型调用）。
 *
 * 为什么不走 LLM：brief 是给人和下游模型共同遵守的「契约」，
 * 每次生成都必须同构（同样的段位、同样的红线），否则审核无从下手。
 * 需要创意的是正文，不是 brief 的骨架。
 */
export function buildBrief(input: BriefInput): ContentBrief {
  const intent = classifyIntent(input.question);
  const play = BRIEF_PLAYBOOK[intent];
  const label = input.intentLabel ?? intentLabel(intent);
  const brand = input.brand.trim() || "本品牌";
  const question = input.question.trim() || "（未填写目标问题）";
  const rivals = (input.competitors ?? []).map((c) => c.trim()).filter(Boolean);

  const mustInclude = [
    ...(input.facts ?? []).map((f) => f.trim()).filter(Boolean).slice(0, 6),
    `文中至少出现一次完整品牌名「${brand}」并与品类词同句出现`,
    "至少 3 个可核验数字（价格、年限、客户数、比例任选）",
  ];

  const mustAvoid = [
    "不要写资料里没有的价格、政策、案例与客户名",
    "不要用「行业第一」「最好」「唯一」等无法举证的绝对化表述",
    ...(rivals.length ? [`对比 ${rivals.join("、")} 时只用公开可查的信息，不做贬损性描述`] : []),
  ];

  const sections = play.sections.map((heading, index) => ({
    heading,
    points: briefPoints(intent, index, brand, question, rivals),
  }));

  return {
    title: `${question.replace(/[？?]$/, "")}｜${brand} GEO 内容 Brief`,
    intent,
    intentLabel: label,
    conclusion: `在「${label}」这一层，这篇文章要回答的唯一结论是：${question.replace(/[？?]$/, "")}——先给立场，再给证据。`,
    sections,
    mustInclude,
    mustAvoid,
    wordTarget: play.words,
    channels: play.channels,
  };
}

/** 各段要点（按意图 × 段位组合，保证要点具体可写） */
function briefPoints(intent: GeoIntentLevel, index: number, brand: string, question: string, rivals: string[]): string[] {
  const rivalText = rivals.length ? rivals.join("、") : "同类方案";
  const table: Record<GeoIntentLevel, string[][]> = {
    L1: [
      ["用一句不超过 40 字的话定义品类", "说明它替代了过去的什么做法"],
      ["列出 3 个典型使用场景", "每个场景说清一个具体痛点"],
      ["标准要可判断（如「是否支持 X」「多久见效」）", "每条标准给出及格线"],
      ["写 2 个常见误解并纠正", "误解要来自真实用户提问"],
    ],
    L2: [
      ["按「自己做 / 买工具 / 找服务商」分三类", `每类给一句适合谁`],
      ["用「预算 + 人力 + 见效周期」三个维度对比", "给出选择建议"],
      ["第一步要具体到可当天执行", "附一个最小可行示例"],
      ["列出 2-3 个最常见的卡点", "每个卡点给解法"],
    ],
    L3: [
      [`先说结论：什么情况下选 ${brand}，什么情况下不选`, "结论要在 80 字内"],
      [`4 个指标必须可核验，例如「${rivalText} 也公开的参数」`, "每个指标给判断方法"],
      [`与 ${rivalText} 逐项对比，只写公开信息`, "对比用表格，不写形容词"],
      ["按预算/规模给 3 档建议", "每档附一句风险提示"],
    ],
    L4: [
      ["拆出价格构成（人力/工具/服务占比）", "给区间不给单一数字"],
      ["明确写入与不写入的范围", "划清服务边界"],
      ["交付周期给出上限", "售后响应时间写明"],
      ["和「自己组建团队」的成本对比", "对比要含隐性成本"],
    ],
    L5: [
      ["用带时间与样本量的数据说明效果", "避免只说「效果很好」"],
      ["列出最常被反馈的 2-3 个问题", "每个问题给当前处理方式"],
      ["退款/售后政策引用原文", "不概括、不修饰"],
      ["列第三方资质与可查评价渠道", "给出可点击核验的路径"],
    ],
  };
  const rows = table[intent];
  return rows[index] ?? [`围绕「${question}」补充可核验事实`];
}

/* ------------------------------ 导出 ------------------------------ */

export interface GeoScoreExport {
  brand: string;
  ownDomain: string;
  standings: BrandStanding[];
  buckets: IntentBucket[];
  gaps: { level: GeoIntentLevel; label: string; count: number; empty: boolean }[];
  samples: SampleAdvice;
  sources: SourceGap | null;
  readability: ReadabilityResult | null;
  briefs: ContentBrief[];
}

const pctText = (value: number) => `${Math.round(value * 100)}%`;

/**
 * 诊断报告 Markdown。
 * 这是给客户看的东西，所以：指标一定带样本量、缺项一定写「未测」而不是留空、
 * 不写任何没有数据支撑的结论。
 */
export function geoScoreMarkdown(input: GeoScoreExport): string {
  const lines: string[] = [`# GEO 诊断报告 · ${input.brand || "未命名品牌"}`, ""];
  lines.push(`生成时间：${new Date().toLocaleString("zh-CN", { hour12: false })}`, "");
  lines.push("> 所有比率的样本量在报告内单独标注；样本不足时不给效果结论。", "");

  lines.push("## 一、核心指标（本品牌 vs 竞品）", "");
  if (!input.standings.length) {
    lines.push("未测。先在工作台运行一次监测。", "");
  } else {
    lines.push(`样本量：${input.samples.label}`, "");
    lines.push("| 品牌 | 提及率 | 推荐率 | 首推率 | 负面率 | 首推名次 |");
    lines.push("|---|---|---|---|---|---|");
    for (const row of input.standings) {
      const name = row.isSelf ? `**${row.brand}（本品牌）**` : row.brand;
      lines.push(
        `| ${name} | ${pctText(row.metrics.mentionRate)} | ${pctText(row.metrics.recommendRate)} | ${pctText(row.metrics.topRate)} | ${pctText(row.metrics.negativeRate)} | ${row.rank} |`,
      );
    }
    lines.push("");
    const self = input.standings.find((row) => row.isSelf);
    if (self && self.rank === 1) lines.push("结论：本品牌在首推率上领先。", "");
    else if (self) lines.push(`结论：本品牌首推率排第 ${self.rank}，用户最常看到的第一个答案不是我们。`, "");
  }

  lines.push("## 二、问题词覆盖（五层意图）", "");
  if (!input.buckets.some((bucket) => bucket.count > 0)) {
    lines.push("未测。", "");
  } else {
    lines.push("| 层级 | 问题数 | 提及率 | 推荐率 | 首推率 |");
    lines.push("|---|---|---|---|---|");
    for (const bucket of input.buckets) {
      lines.push(
        `| ${bucket.level} ${bucket.label} | ${bucket.count} | ${bucket.count ? pctText(bucket.mentionRate) : "—"} | ${bucket.count ? pctText(bucket.recommendRate) : "—"} | ${bucket.count ? pctText(bucket.topRate) : "—"} |`,
      );
    }
    lines.push("");
  }
  if (input.gaps.length) {
    lines.push("### 覆盖缺口", "");
    for (const gap of input.gaps) {
      lines.push(`- ${gap.level} ${gap.label}：${gap.empty ? "完全没有问题覆盖" : `仅 ${gap.count} 条，样本不足`}`);
    }
    lines.push("");
  }

  if (input.readability) {
    lines.push("## 三、内容可引用性体检", "");
    lines.push(`总分：${input.readability.score} / 100`, "");
    for (const item of input.readability.findings) {
      lines.push(`- **${item.label}** ${item.score} 分 — ${item.note}`);
      if (item.fix) lines.push(`  - 修法：${item.fix}`);
    }
    lines.push("");
  }

  if (input.sources) {
    lines.push("## 四、信源分析", "");
    lines.push(input.sources.verdict, "");
    if (input.sources.total) {
      lines.push(`自有站点 ${input.sources.ownCount} 次 / 第三方 ${input.sources.thirdPartyCount} 次（自有占比 ${pctText(input.sources.ownRatio)}）`, "");
      lines.push("引用最多的信源：", "");
      for (const row of input.sources.top) lines.push(`- ${row.source}（${row.count} 次）`);
      lines.push("");
    }
  }

  if (input.briefs.length) {
    lines.push("## 五、内容 Brief", "");
    for (const brief of input.briefs) {
      lines.push(`### ${brief.title}`, "");
      lines.push(`- 意图层：${brief.intent} ${brief.intentLabel}`);
      lines.push(`- 目标字数：约 ${brief.wordTarget} 字`);
      lines.push(`- 建议渠道：${brief.channels.join("、")}`);
      lines.push(`- 结论：${brief.conclusion}`);
      lines.push("- 结构：");
      for (const section of brief.sections) {
        lines.push(`  - ${section.heading}`);
        for (const point of section.points) lines.push(`    - ${point}`);
      }
      lines.push("- 必须包含：");
      for (const item of brief.mustInclude) lines.push(`  - ${item}`);
      lines.push("- 禁止：");
      for (const item of brief.mustAvoid) lines.push(`  - ${item}`);
      lines.push("");
    }
  }

  return lines.join("\n");
}
