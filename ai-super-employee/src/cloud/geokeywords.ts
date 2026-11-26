import { askLLM } from "./runner";

/**
 * GEO 拓词与选题（借鉴抓词 GEO 的「拓词 → 选题」生产侧能力）：
 *   1. 拓词 —— 把种子词扩展成长尾词，按用户意图分组（咨询/选型/对比/教程/避坑）；
 *   2. 选题 —— 按词生成选题 + 大纲 + 目标问题，可导出 Markdown 送入素材生成。
 *
 * 全部走 runner 的 askLLM（与 GEO 体检同通道），不新增任何外部依赖。
 * 模型不可用/解析失败时走模板拼接降级并标注 demo（沿用仓库惯例，不冒充模型结论）。
 */

export const GEO_KEYWORD_INTENTS = ["咨询", "选型", "对比", "教程", "避坑"] as const;
export type GeoKeywordIntent = (typeof GEO_KEYWORD_INTENTS)[number];
export type GeoKeywordPriority = "高" | "中" | "低";

export interface GeoKeyword {
  word: string;
  intent: GeoKeywordIntent;
  priority: GeoKeywordPriority;
}

export interface GeoKeywordGroup {
  intent: GeoKeywordIntent;
  keywords: GeoKeyword[];
}

export interface GeoExpandResult {
  keywords: GeoKeyword[];
  groups: GeoKeywordGroup[];
  /** true = 模板降级产出（模型不可用时的演示结果） */
  demo: boolean;
}

export interface GeoTopic {
  title: string;
  keyword: string;
  intent: GeoKeywordIntent;
  /** 3-5 个小节标题 */
  sections: string[];
  /** 这篇内容要回答的用户问题（可直接进监测问题集） */
  targetQuestion: string;
}

export interface GeoTopicsResult {
  topics: GeoTopic[];
  demo: boolean;
}

export const MAX_SEED_WORDS = 8;
export const MAX_KEYWORDS = 60;
export const MAX_TOPICS = 12;

/* ------------------------------ 纯函数 ------------------------------ */

/** 把用户输入的种子词文本拆成词表（逗号/顿号/空白/换行分隔，去重保序）。 */
export function parseSeedWords(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split(/[,，、\s]+/)) {
    const word = raw.trim();
    if (!word) continue;
    const key = word.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(word);
    if (out.length >= MAX_SEED_WORDS) break;
  }
  return out;
}

function normalizeIntent(value: unknown): GeoKeywordIntent {
  return (GEO_KEYWORD_INTENTS as readonly string[]).includes(String(value))
    ? (String(value) as GeoKeywordIntent)
    : "咨询";
}

function normalizePriority(value: unknown): GeoKeywordPriority {
  return value === "高" || value === "低" ? value : "中";
}

/** 归一化一条词（裁剪长度、意图/优先级兜底）。 */
export function normalizeKeyword(raw: Partial<GeoKeyword>): GeoKeyword | null {
  const word = String(raw.word ?? "").trim().slice(0, 40);
  if (!word) return null;
  return { word, intent: normalizeIntent(raw.intent), priority: normalizePriority(raw.priority) };
}

/** 按词面去重（忽略大小写与空格），保序，超上限截断。 */
export function dedupeKeywords(list: GeoKeyword[], max = MAX_KEYWORDS): GeoKeyword[] {
  const seen = new Set<string>();
  const out: GeoKeyword[] = [];
  for (const item of list) {
    const normalized = normalizeKeyword(item);
    if (!normalized) continue;
    const key = normalized.word.toLowerCase().replace(/[\s\u3000]+/g, "");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
    if (out.length >= max) break;
  }
  return out;
}

/** 按意图分组（固定顺序，空组也保留便于 UI 展示覆盖缺口）。 */
export function groupKeywords(list: GeoKeyword[]): GeoKeywordGroup[] {
  return GEO_KEYWORD_INTENTS.map((intent) => ({
    intent,
    keywords: list.filter((item) => item.intent === intent),
  }));
}

/** 分组统计：每组词数 + 高优先级词数。 */
export function groupStats(groups: GeoKeywordGroup[]): { intent: GeoKeywordIntent; count: number; high: number }[] {
  return groups.map((group) => ({
    intent: group.intent,
    count: group.keywords.length,
    high: group.keywords.filter((item) => item.priority === "高").length,
  }));
}

/* 模板降级：种子词 × 意图问法拼接。优先级按问法商业价值粗排（选型/对比最高）。 */
const FALLBACK_TEMPLATES: { intent: GeoKeywordIntent; priority: GeoKeywordPriority; make: (seed: string) => string }[] = [
  { intent: "咨询", priority: "中", make: (s) => `${s}是什么` },
  { intent: "咨询", priority: "中", make: (s) => `${s}多少钱` },
  { intent: "选型", priority: "高", make: (s) => `${s}哪家比较靠谱` },
  { intent: "选型", priority: "高", make: (s) => `${s}怎么选` },
  { intent: "对比", priority: "高", make: (s) => `${s}和同类有什么区别` },
  { intent: "对比", priority: "中", make: (s) => `${s}优缺点` },
  { intent: "教程", priority: "中", make: (s) => `${s}怎么用` },
  { intent: "教程", priority: "低", make: (s) => `${s}新手入门步骤` },
  { intent: "避坑", priority: "中", make: (s) => `${s}要注意什么` },
  { intent: "避坑", priority: "低", make: (s) => `${s}常见坑` },
];

/** 启发式拓词（零 Key 降级）：种子词套问法模板，结果带 demo 标注。 */
export function fallbackExpandKeywords(seedWords: string[]): GeoExpandResult {
  const seeds = dedupeKeywords(seedWords.map((word) => ({ word, intent: "咨询" as const, priority: "中" as const })), MAX_SEED_WORDS)
    .map((item) => item.word);
  const expanded: GeoKeyword[] = [];
  for (const seed of seeds) {
    for (const tpl of FALLBACK_TEMPLATES) {
      expanded.push({ word: tpl.make(seed), intent: tpl.intent, priority: tpl.priority });
    }
  }
  const keywords = dedupeKeywords(expanded);
  return { keywords, groups: groupKeywords(keywords), demo: true };
}

const TOPIC_SECTION_TEMPLATES: Record<GeoKeywordIntent, (word: string) => string[]> = {
  咨询: (w) => [`先给结论：${w}的核心答案`, "关键事实与数字", "适用人群与场景", "常见追问"],
  选型: () => ["选之前先看这 3 个标准", "主流方案逐个对比", "不同预算怎么选", "结论与推荐"],
  对比: () => ["一句话结论", "逐项对比表", "各自适合谁", "怎么选不踩坑"],
  教程: () => ["准备工作", "分步操作", "容易出错的环节", "完成后的检查清单"],
  避坑: () => ["最常见的 3 个坑", "每个坑的识别方法", "避开的正确做法", "已经踩坑怎么补救"],
};

/** 词面 → 监测问题问法：已是问句则原样，否则补「？」（选题 targetQuestion 与词库转问题共用同一口径）。 */
export function wordToQuestion(word: string): string {
  const text = word.trim();
  if (!text) return "";
  return text.endsWith("？") || text.endsWith("?") ? text : `${text}？`;
}

/** 启发式选题（降级）：按词套大纲模板，目标问题即词面问法。 */
export function fallbackTopics(keywords: GeoKeyword[], max = MAX_TOPICS): GeoTopicsResult {
  const picked = [...keywords]
    .sort((a, b) => (a.priority === "高" ? 0 : a.priority === "中" ? 1 : 2) - (b.priority === "高" ? 0 : b.priority === "中" ? 1 : 2))
    .slice(0, max);
  return {
    topics: picked.map((item) => ({
      title: item.word,
      keyword: item.word,
      intent: item.intent,
      sections: TOPIC_SECTION_TEMPLATES[item.intent](item.word),
      targetQuestion: wordToQuestion(item.word),
    })),
    demo: true,
  };
}

/** 选题导出 Markdown（本地下载，不落库）。 */
export function topicsMarkdown(input: { brand: string; topics: GeoTopic[]; demo?: boolean }): string {
  const lines: string[] = [`# GEO 选题清单 · ${input.brand || "未命名品牌"}`, ""];
  lines.push(`导出时间：${new Date().toLocaleString("zh-CN", { hour12: false })}`);
  if (input.demo) lines.push("", "> 本清单为模板降级产出（模型不可用），仅作选题占位，请人工校准后再生产。");
  lines.push("");
  input.topics.forEach((topic, index) => {
    lines.push(`## ${index + 1}. ${topic.title}`, "");
    lines.push(`- 目标词：${topic.keyword}（${topic.intent}）`);
    lines.push(`- 目标问题：${topic.targetQuestion}`);
    lines.push("- 大纲：");
    topic.sections.forEach((section) => lines.push(`  - ${section}`));
    lines.push("");
  });
  return lines.join("\n");
}

/* ------------------------------ LLM 路径 ------------------------------ */

function parseJson<T>(raw: string): T | null {
  const text = raw.replace(/```(?:json)?/g, "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

const EXPAND_SYSTEM = [
  "你是 GEO 拓词专家。把种子词扩展成用户在 AI 问答里真的会问的长尾词。",
  "纪律：",
  "1. 每词必须是一个真实问法或搜索说法（如「现煮茶饮哪家靠谱」），不要输出单个名词堆砌。",
  "2. 按意图分组：咨询（是什么/多少钱）、选型（怎么选/哪家好）、对比（区别/优缺点）、教程（怎么用/步骤）、避坑（注意什么/常见问题）。",
  "3. 优先级：离成交近的（选型/对比）给「高」，泛咨询给「中」，冷门给「低」。",
  "4. 总数 25-40 条，五类意图都要有，不要重复、不要带品牌名以外的编造信息。",
  "只输出 JSON：",
  '{"keywords":[{"word":"长尾词","intent":"咨询|选型|对比|教程|避坑","priority":"高|中|低"}]}',
].join("\n");

/** 拓词：种子词 → 长尾词分组表。模型不可用时降级模板并标注 demo。 */
export async function expandKeywords(input: {
  brand: string;
  seedWords: string[];
  industry?: string;
  signal?: AbortSignal;
}): Promise<GeoExpandResult> {
  const seeds = input.seedWords.map((w) => w.trim()).filter(Boolean).slice(0, MAX_SEED_WORDS);
  if (!seeds.length) throw new Error("请先填写至少 1 个种子词（例如：现煮茶饮）。");
  try {
    const { text } = await askLLM(
      [
        { role: "system", content: EXPAND_SYSTEM },
        {
          role: "user",
          content: [
            `品牌/企业名称：${input.brand.trim() || "（未填写）"}`,
            input.industry?.trim() ? `行业：${input.industry.trim()}` : "",
            `种子词：${seeds.join("、")}`,
          ].filter(Boolean).join("\n"),
        },
      ],
      { json: true, signal: input.signal },
    );
    const parsed = parseJson<{ keywords?: Partial<GeoKeyword>[] }>(text);
    const keywords = dedupeKeywords((parsed?.keywords ?? []).flatMap((row) => {
      const normalized = normalizeKeyword(row);
      return normalized ? [normalized] : [];
    }));
    if (!keywords.length) throw new Error("拓词结果解析失败");
    return { keywords, groups: groupKeywords(keywords), demo: false };
  } catch (err) {
    if (input.signal?.aborted) throw err;
    return fallbackExpandKeywords(seeds);
  }
}

const TOPICS_SYSTEM = [
  "你是 GEO 选题策划。按目标词生成能被 AI 引擎引用的内容选题。",
  "纪律：",
  "1. 标题直接回应目标词的问题，结论先行，不用夸张修饰。",
  "2. 每题给 3-5 个小节标题，小节要能独立成段、带事实或对比，不要空泛口号。",
  "3. targetQuestion 是用户在 AI 问答里的真实问法，一句完整问句。",
  "4. 选题数与输入词数一致（最多 12 条），顺序按优先级从高到低。",
  "只输出 JSON：",
  '{"topics":[{"title":"选题标题","keyword":"对应目标词","intent":"咨询|选型|对比|教程|避坑","sections":["小节1","小节2","小节3"],"targetQuestion":"用户问法？"}]}',
].join("\n");

/** 选题：按词生成选题+大纲。模型不可用时降级模板并标注 demo。 */
export async function generateTopics(input: {
  brand: string;
  keywords: GeoKeyword[];
  signal?: AbortSignal;
}): Promise<GeoTopicsResult> {
  const keywords = dedupeKeywords(input.keywords).slice(0, MAX_TOPICS);
  if (!keywords.length) throw new Error("请先拓词或填写目标词，再生成选题。");
  try {
    const { text } = await askLLM(
      [
        { role: "system", content: TOPICS_SYSTEM },
        {
          role: "user",
          content: [
            `品牌/企业名称：${input.brand.trim() || "（未填写）"}`,
            "目标词：",
            ...keywords.map((item) => `- ${item.word}（${item.intent}，优先级${item.priority}）`),
          ].join("\n"),
        },
      ],
      { json: true, signal: input.signal },
    );
    const parsed = parseJson<{ topics?: Partial<GeoTopic>[] }>(text);
    const topics: GeoTopic[] = (parsed?.topics ?? []).flatMap((row) => {
      const title = String(row.title ?? "").trim().slice(0, 80);
      if (!title) return [];
      return [{
        title,
        keyword: String(row.keyword ?? title).trim().slice(0, 40),
        intent: normalizeIntent(row.intent),
        sections: (row.sections ?? []).map((s) => String(s).trim().slice(0, 60)).filter(Boolean).slice(0, 5),
        targetQuestion: String(row.targetQuestion ?? "").trim().slice(0, 80),
      }];
    }).slice(0, MAX_TOPICS);
    if (!topics.length) throw new Error("选题结果解析失败");
    return { topics, demo: false };
  } catch (err) {
    if (input.signal?.aborted) throw err;
    return fallbackTopics(keywords);
  }
}
