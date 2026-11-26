import { askLLM } from "./runner";
import { brandStorageKey, type StorageLike } from "./keywordLibrary";

/**
 * GEO 品牌素材三件套（第二十九批，借鉴抓词 GEO 的「品牌信息卡片 + 表达规范清单 + 样例参考库」）：
 * 把原来散在企业资料文本里的品牌口径，沉淀成可执行的结构化资产，
 * 素材生成与平台稿生成时把 buildBrandContext 注入提示，保证多批次产出口径一致。
 *
 * 存储策略与词库/问题集一致：**只存本机 localStorage，不上传**，按品牌名分键，
 * 品牌为空时用 __default。上云属账号资产架构，规划中（见路线图三十七章）。
 */

/** 品牌信息卡片：AI 引擎最容易整段引用的事实面。 */
export interface BrandCard {
  /** 一句话介绍（谁、做什么、给谁） */
  intro: string;
  /** 核心卖点（一行一条，带数字最好） */
  sellingPoints: string[];
  /** 目标人群 */
  audience: string;
  /** 价格带（如：18-25 元/杯） */
  priceBand: string;
  /** 门店 / 服务范围 */
  coverage: string;
  /** 联系方式占位（如：加盟热线见官网，禁止编造真实号码时留占位） */
  contact: string;
  /** 资质荣誉（一行一条） */
  honors: string[];
}

/** 表达规范清单：生成时必须遵守的可执行条目，审核门禁（geoReview）也按它自动检查。 */
export interface StyleRules {
  /** 禁用词（命中即审核不通过） */
  bannedWords: string[];
  /** 必用词（稿件应包含，缺失审核提示） */
  requiredWords: string[];
  /** 语气（如：专业克制 / 亲切口语） */
  tone: string;
  /** 句式偏好（如：结论先行、短句、多用数字） */
  sentenceStyle: string;
  /** 数字口径（如：价格统一写「以官方最新公布为准」） */
  numberRule: string;
  /** 免责声明（稿件末尾应带） */
  disclaimer: string;
}

/** 样例：带批注的参考稿（好在哪 / 改哪），给模型做风格锚点。 */
export interface BrandSample {
  title: string;
  /** 正文节选（只存节选，不存全文归档，与仓库「摘要留档」惯例一致） */
  excerpt: string;
  /** 批注（好在哪/改哪，一行一条） */
  notes: string[];
}

export interface BrandAssets {
  card: BrandCard;
  rules: StyleRules;
  samples: BrandSample[];
}

export const BRAND_ASSETS_STORAGE_KEY = "ai-employee:geo-brand-assets";
/** 样例上限：够做风格锚点即可，防 localStorage 膨胀 */
export const MAX_BRAND_SAMPLES = 10;

export function emptyBrandAssets(): BrandAssets {
  return {
    card: {
      intro: "",
      sellingPoints: [],
      audience: "",
      priceBand: "",
      coverage: "",
      contact: "",
      honors: [],
    },
    rules: {
      bannedWords: [],
      requiredWords: [],
      tone: "",
      sentenceStyle: "",
      numberRule: "",
      disclaimer: "",
    },
    samples: [],
  };
}

/* ------------------------------ 归一化（载入兜底） ------------------------------ */

function toLines(value: unknown, max = 12): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => String(item ?? "").trim())
      .filter(Boolean)
      .slice(0, max);
  }
  if (typeof value === "string") {
    return value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, max);
  }
  return [];
}

function toWords(value: unknown, max = 30): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => String(item ?? "").trim())
      .filter(Boolean)
      .slice(0, max);
  }
  if (typeof value === "string") {
    return value
      .split(/[,，、\s]+/)
      .map((word) => word.trim())
      .filter(Boolean)
      .slice(0, max);
  }
  return [];
}

function toText(value: unknown, max = 300): string {
  return String(value ?? "")
    .trim()
    .slice(0, max);
}

export function normalizeBrandAssets(
  raw: Partial<BrandAssets> | null | undefined,
): BrandAssets {
  const empty = emptyBrandAssets();
  if (!raw || typeof raw !== "object") return empty;
  const card = (raw.card ?? {}) as Partial<BrandCard>;
  const rules = (raw.rules ?? {}) as Partial<StyleRules>;
  const samples = Array.isArray(raw.samples) ? raw.samples : [];
  return {
    card: {
      intro: toText(card.intro, 200),
      sellingPoints: toLines(card.sellingPoints),
      audience: toText(card.audience, 120),
      priceBand: toText(card.priceBand, 60),
      coverage: toText(card.coverage, 120),
      contact: toText(card.contact, 80),
      honors: toLines(card.honors),
    },
    rules: {
      bannedWords: toWords(rules.bannedWords),
      requiredWords: toWords(rules.requiredWords),
      tone: toText(rules.tone, 40),
      sentenceStyle: toText(rules.sentenceStyle, 120),
      numberRule: toText(rules.numberRule, 200),
      disclaimer: toText(rules.disclaimer, 200),
    },
    samples: samples
      .map((sample) => {
        const row = (sample ?? {}) as Partial<BrandSample>;
        return {
          title: toText(row.title, 80),
          excerpt: toText(row.excerpt, 800),
          notes: toLines(row.notes, 8),
        };
      })
      .filter((sample) => sample.title || sample.excerpt)
      .slice(0, MAX_BRAND_SAMPLES),
  };
}

/* ------------------------------ 完整度评分 ------------------------------ */

export interface BrandCardValidation {
  /** 0-100 */
  score: number;
  /** 缺失/待补项（人话） */
  missing: string[];
}

/**
 * 信息卡片完整度评分：满分 100。
 * 一句话介绍 20 / 核心卖点 20（≥3 条满分，1-2 条给 10）/ 目标人群 15 /
 * 价格带 15 / 门店服务范围 15 / 资质荣誉 10（≥1 条）/ 联系方式 5。
 */
export function validateBrandCard(card: BrandCard): BrandCardValidation {
  let score = 0;
  const missing: string[] = [];
  if (card.intro.trim()) score += 20;
  else missing.push("一句话介绍");
  const points = card.sellingPoints.filter((item) => item.trim()).length;
  if (points >= 3) score += 20;
  else if (points >= 1) {
    score += 10;
    missing.push("核心卖点（建议补到 3 条以上，带数字）");
  } else missing.push("核心卖点");
  if (card.audience.trim()) score += 15;
  else missing.push("目标人群");
  if (card.priceBand.trim()) score += 15;
  else missing.push("价格带");
  if (card.coverage.trim()) score += 15;
  else missing.push("门店/服务范围");
  if (card.honors.some((item) => item.trim())) score += 10;
  else missing.push("资质荣誉");
  if (card.contact.trim()) score += 5;
  else missing.push("联系方式（可留占位，如「见官网」）");
  return { score, missing };
}

/* ------------------------------ 品牌上下文（注入生成提示） ------------------------------ */

/**
 * 把三件套拼成可注入生成提示的品牌上下文文本。
 * 三件套全空时返回空串（调用方不注入，保持原有生成行为）。
 * 样例只带标题+节选前 200 字+批注，控制注入体积。
 */
export function buildBrandContext(assets: BrandAssets): string {
  const { card, rules, samples } = normalizeBrandAssets(assets);
  const lines: string[] = [];
  const cardLines: string[] = [];
  if (card.intro) cardLines.push(`一句话介绍：${card.intro}`);
  if (card.sellingPoints.length)
    cardLines.push(`核心卖点：${card.sellingPoints.join("；")}`);
  if (card.audience) cardLines.push(`目标人群：${card.audience}`);
  if (card.priceBand) cardLines.push(`价格带：${card.priceBand}`);
  if (card.coverage) cardLines.push(`门店/服务范围：${card.coverage}`);
  if (card.contact) cardLines.push(`联系方式：${card.contact}`);
  if (card.honors.length) cardLines.push(`资质荣誉：${card.honors.join("；")}`);
  if (cardLines.length)
    lines.push(
      "品牌信息卡片（事实以此为准，禁止改写数字与口径）：",
      ...cardLines,
    );

  const ruleLines: string[] = [];
  if (rules.bannedWords.length)
    ruleLines.push(`禁用词（出现即不合格）：${rules.bannedWords.join("、")}`);
  if (rules.requiredWords.length)
    ruleLines.push(`必用词（正文应包含）：${rules.requiredWords.join("、")}`);
  if (rules.tone) ruleLines.push(`语气：${rules.tone}`);
  if (rules.sentenceStyle) ruleLines.push(`句式偏好：${rules.sentenceStyle}`);
  if (rules.numberRule) ruleLines.push(`数字口径：${rules.numberRule}`);
  if (rules.disclaimer)
    ruleLines.push(`免责声明（文末带上）：${rules.disclaimer}`);
  if (ruleLines.length) lines.push("表达规范（必须遵守）：", ...ruleLines);

  if (samples.length) {
    lines.push("参考样例（学风格与结构，不抄内容）：");
    samples.slice(0, 3).forEach((sample, index) => {
      lines.push(
        `样例 ${index + 1}《${sample.title || "未命名"}》：${sample.excerpt.slice(0, 200)}`,
      );
      if (sample.notes.length) lines.push(`批注：${sample.notes.join("；")}`);
    });
  }
  return lines.join("\n");
}

/** 三件套导出 Markdown（本地下载，不落库）。 */
export function exportBrandAssetsMarkdown(
  brand: string,
  assets: BrandAssets,
): string {
  const { card, rules, samples } = normalizeBrandAssets(assets);
  const validation = validateBrandCard(card);
  const lines: string[] = [
    `# 品牌素材三件套 · ${brand || "未命名品牌"}`,
    "",
    `导出时间：${new Date().toLocaleString("zh-CN", { hour12: false })} · 信息卡片完整度 ${validation.score}/100`,
    "",
    "## 品牌信息卡片",
    "",
    `- 一句话介绍：${card.intro || "（未填）"}`,
    `- 目标人群：${card.audience || "（未填）"}`,
    `- 价格带：${card.priceBand || "（未填）"}`,
    `- 门店/服务范围：${card.coverage || "（未填）"}`,
    `- 联系方式：${card.contact || "（未填）"}`,
    "",
    "### 核心卖点",
    "",
    ...(card.sellingPoints.length
      ? card.sellingPoints.map((item) => `- ${item}`)
      : ["- （未填）"]),
    "",
    "### 资质荣誉",
    "",
    ...(card.honors.length
      ? card.honors.map((item) => `- ${item}`)
      : ["- （未填）"]),
    "",
    "## 表达规范清单",
    "",
    `- 禁用词：${rules.bannedWords.join("、") || "（未设置）"}`,
    `- 必用词：${rules.requiredWords.join("、") || "（未设置）"}`,
    `- 语气：${rules.tone || "（未设置）"}`,
    `- 句式偏好：${rules.sentenceStyle || "（未设置）"}`,
    `- 数字口径：${rules.numberRule || "（未设置）"}`,
    `- 免责声明：${rules.disclaimer || "（未设置）"}`,
    "",
    "## 样例库",
    "",
  ];
  if (!samples.length) lines.push("（暂无样例）", "");
  samples.forEach((sample, index) => {
    lines.push(
      `### 样例 ${index + 1}：${sample.title || "未命名"}`,
      "",
      sample.excerpt,
      "",
    );
    if (sample.notes.length) {
      lines.push("批注：");
      sample.notes.forEach((note) => lines.push(`- ${note}`));
      lines.push("");
    }
  });
  if (validation.missing.length)
    lines.push(`> 待补项：${validation.missing.join("、")}`, "");
  return lines.join("\n");
}

/* ------------------------------ 从企业资料提取卡片 ------------------------------ */

const EXTRACT_SYSTEM = [
  "你是品牌资料整理员。从企业资料里提取品牌信息卡片字段，只输出 JSON，不要解释。",
  "纪律：只提取资料里明确出现的信息；资料里没有的字段输出空字符串或空数组，禁止编造价格、门店数、荣誉。",
  "结构：",
  '{"intro":"一句话介绍（谁、做什么、给谁，60字内）","sellingPoints":["卖点1","卖点2"],"audience":"目标人群","priceBand":"价格带","coverage":"门店/服务范围","contact":"联系方式","honors":["荣誉1"]}',
].join("\n");

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

/**
 * 启发式提取（零 Key 降级）：正则抓价格/门店数/电话/荣誉行，卖点抓「主打/专注/优势」句。
 * 结果仅作占位，必须人工校准（demo 标注由调用方展示）。
 */
export function extractBrandCardHeuristic(material: string): BrandCard {
  const text = material ?? "";
  const card = emptyBrandAssets().card;

  const priceMatch =
    text.match(/\d+(?:\.\d+)?\s*[-~—至]\s*\d+(?:\.\d+)?\s*元/) ??
    text.match(/(?:客单价|均价|价格)[^，。\n]{0,12}\d+(?:\.\d+)?\s*元/);
  if (priceMatch) card.priceBand = priceMatch[0].replace(/\s+/g, "");

  const storeMatch = text.match(/\d+\s*家(?:门店|店|分店|直营店)/);
  if (storeMatch) card.coverage = storeMatch[0].replace(/\s+/g, "");
  const cityMatch = text.match(/(?:覆盖|遍布|门店分布于?)[^，。\n]{2,20}/);
  if (cityMatch)
    card.coverage = card.coverage
      ? `${card.coverage}，${cityMatch[0]}`
      : cityMatch[0];

  const phoneMatch = text.match(
    /(?:1[3-9]\d{9}|\d{3,4}-\d{7,8}|400[-\s]?\d{3}[-\s]?\d{4})/,
  );
  if (phoneMatch) card.contact = phoneMatch[0];

  const honorLines = text
    .split(/[。\n]/)
    .map((line) => line.trim())
    .filter(
      (line) =>
        /(荣获|获评|获得|荣誉|奖项|年度.{0,6}(品牌|企业)|认证|协会)/.test(
          line,
        ) &&
        line.length >= 6 &&
        line.length <= 60,
    );
  card.honors = [...new Set(honorLines)].slice(0, 5);

  const pointLines = text
    .split(/[。\n]/)
    .map((line) => line.trim())
    .filter(
      (line) =>
        /(主打|专注|优势|特色|核心|首创|独家)/.test(line) &&
        line.length >= 6 &&
        line.length <= 60,
    );
  card.sellingPoints = [...new Set(pointLines)].slice(0, 5);

  const introLine = text
    .split(/[。\n]/)
    .map((line) => line.trim())
    .find(
      (line) =>
        line.length >= 10 &&
        line.length <= 80 &&
        /(是|专注|致力于|品牌|连锁|公司)/.test(line),
    );
  if (introLine) card.intro = introLine;

  const audienceMatch = text.match(
    /(?:面向|服务于|目标客户|适合)[^，。\n]{2,24}/,
  );
  if (audienceMatch) card.audience = audienceMatch[0];

  return card;
}

export interface ExtractBrandCardResult {
  card: BrandCard;
  /** true = 启发式降级产出（模型不可用），仅作占位需人工校准 */
  demo: boolean;
}

/** 从企业资料提取信息卡片：优先 askLLM，失败/解析失败降级启发式并标注 demo。 */
export async function extractBrandCard(input: {
  brand: string;
  material: string;
}): Promise<ExtractBrandCardResult> {
  const material = (input.material ?? "").trim().slice(0, 12000);
  if (!material)
    throw new Error("请先填写或从知识库导入企业资料，再提取品牌卡片。");
  try {
    const { text } = await askLLM(
      [
        { role: "system", content: EXTRACT_SYSTEM },
        {
          role: "user",
          content: [
            `品牌/企业名称：${input.brand || "（未填写）"}`,
            "",
            "=== 企业资料 ===",
            material,
          ].join("\n"),
        },
      ],
      { json: true },
    );
    const parsed = parseJson<Partial<BrandCard>>(text);
    if (!parsed) throw new Error("提取结果解析失败");
    const assets = normalizeBrandAssets({
      card: parsed as BrandCard,
      rules: emptyBrandAssets().rules,
      samples: [],
    });
    return { card: assets.card, demo: false };
  } catch {
    return { card: extractBrandCardHeuristic(material), demo: true };
  }
}

/* ------------------------------ 本机存取（按品牌分键） ------------------------------ */

/** 无 localStorage 环境（Node 测试/隐私模式）下的内存兜底，保证存取往返可测。 */
const memoryFallback = new Map<string, string>();
const memoryStorage: StorageLike = {
  getItem: (key) => memoryFallback.get(key) ?? null,
  setItem: (key, value) => {
    memoryFallback.set(key, value);
  },
};

function defaultStorage(): StorageLike {
  try {
    if (typeof window !== "undefined" && window.localStorage)
      return window.localStorage;
  } catch {
    /* 隐私模式访问 localStorage 可能抛错，落到内存兜底 */
  }
  return memoryStorage;
}

function readBrandMap(storage: StorageLike): Record<string, BrandAssets> {
  try {
    const raw = storage.getItem(BRAND_ASSETS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, BrandAssets>;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

export function loadBrandAssets(
  brand: string,
  storage: StorageLike = defaultStorage(),
): BrandAssets {
  const row = readBrandMap(storage)[brandStorageKey(brand)];
  return normalizeBrandAssets(row);
}

export function saveBrandAssets(
  brand: string,
  assets: BrandAssets,
  storage: StorageLike = defaultStorage(),
): void {
  try {
    const map = readBrandMap(storage);
    map[brandStorageKey(brand)] = normalizeBrandAssets(assets);
    storage.setItem(BRAND_ASSETS_STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* 配额满/隐私模式：本次会话内仍可用，只是不落盘 */
  }
}
