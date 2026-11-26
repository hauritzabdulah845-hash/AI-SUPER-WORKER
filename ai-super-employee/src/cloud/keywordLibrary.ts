import {
  GEO_KEYWORD_INTENTS,
  normalizeKeyword,
  wordToQuestion,
  type GeoKeyword,
  type GeoKeywordIntent,
  type GeoKeywordPriority,
} from "./geokeywords";

/**
 * GEO 词库与监测问题集（第 28 批，评审 P1）：
 *   1. 词库 —— 拓词结果不再是一次性展示，存为可管理资产（增删、改优先级、转问题、单条生成选题）；
 *   2. 问题集 —— 逐条编辑的纯函数（去重合并、上限截断、粘贴拆条）。
 *
 * 存储策略与监测快照一致：**只存本机 localStorage，不上传**，按品牌名分键，
 * 品牌为空时用 __default。词库/问题集上云属账号资产架构，规划中（见路线图三十六章）。
 */

export type KeywordSource = "expand" | "manual";

export interface KeywordLibraryEntry {
  word: string;
  intent: GeoKeywordIntent;
  priority: GeoKeywordPriority;
  /** 拓词时的种子词（单种子时记录；手动加词为空） */
  seed?: string;
  /** 入库时间（ISO） */
  addedAt: string;
  source: KeywordSource;
}

/** 词库上限：防 localStorage 膨胀，够一个品牌长期经营用 */
export const MAX_LIBRARY_ENTRIES = 300;

export const LIBRARY_STORAGE_KEY = "ai-employee:geo-keyword-library";
export const QUESTIONS_STORAGE_KEY = "ai-employee:geo-questions";
export const DEFAULT_BRAND_KEY = "__default";

/* ------------------------------ 词条纯函数 ------------------------------ */

const PRIORITY_RANK: Record<GeoKeywordPriority, number> = { 高: 3, 中: 2, 低: 1 };

/** 词面归一化键（与 geokeywords 去重同口径：忽略大小写与空格）。 */
export function keywordKey(word: string): string {
  return word.trim().toLowerCase().replace(/[\s\u3000]+/g, "");
}

/** 归一化一条词库条目（词面/意图/优先级走 geokeywords 兜底，来源与时间补默认）。 */
export function normalizeLibraryEntry(raw: Partial<KeywordLibraryEntry>): KeywordLibraryEntry | null {
  const base = normalizeKeyword(raw);
  if (!base) return null;
  const addedAt = typeof raw.addedAt === "string" && raw.addedAt ? raw.addedAt : new Date().toISOString();
  const entry: KeywordLibraryEntry = {
    ...base,
    addedAt,
    source: raw.source === "manual" ? "manual" : "expand",
  };
  const seed = typeof raw.seed === "string" ? raw.seed.trim().slice(0, 40) : "";
  if (seed) entry.seed = seed;
  return entry;
}

/** 把拓词结果的 GeoKeyword 转成词库条目。 */
export function toLibraryEntry(
  keyword: GeoKeyword,
  source: KeywordSource,
  seed?: string,
  addedAt = new Date().toISOString(),
): KeywordLibraryEntry | null {
  return normalizeLibraryEntry({ ...keyword, source, seed, addedAt });
}

export interface MergeKeywordsResult {
  entries: KeywordLibraryEntry[];
  /** 真正新增的条数 */
  added: number;
  /** 因重复合并（保留较高优先级）的条数 */
  merged: number;
  /** 因词库上限被丢弃的条数 */
  dropped: number;
}

/**
 * 合并词条入词库：按词面去重，重复词保留较高优先级（并保留先入的 addedAt/source，
 * 缺 seed 时补入）；新词按上限截断并报告丢弃数。
 */
export function mergeKeywords(
  existing: KeywordLibraryEntry[],
  incoming: KeywordLibraryEntry[],
  max = MAX_LIBRARY_ENTRIES,
): MergeKeywordsResult {
  const entries: KeywordLibraryEntry[] = [];
  const indexByKey = new Map<string, number>();
  for (const raw of existing) {
    const entry = normalizeLibraryEntry(raw);
    if (!entry) continue;
    const key = keywordKey(entry.word);
    if (indexByKey.has(key)) continue;
    indexByKey.set(key, entries.length);
    entries.push(entry);
  }
  let added = 0;
  let merged = 0;
  let dropped = 0;
  for (const raw of incoming) {
    const entry = normalizeLibraryEntry(raw);
    if (!entry) continue;
    const key = keywordKey(entry.word);
    const at = indexByKey.get(key);
    if (at !== undefined) {
      merged += 1;
      const current = entries[at];
      if (PRIORITY_RANK[entry.priority] > PRIORITY_RANK[current.priority]) {
        entries[at] = { ...current, priority: entry.priority, seed: current.seed ?? entry.seed };
      } else if (!current.seed && entry.seed) {
        entries[at] = { ...current, seed: entry.seed };
      }
      continue;
    }
    if (entries.length >= max) {
      dropped += 1;
      continue;
    }
    indexByKey.set(key, entries.length);
    entries.push(entry);
    added += 1;
  }
  return { entries, added, merged, dropped };
}

/** 删除一条词（按词面归一化匹配）。 */
export function removeKeyword(entries: KeywordLibraryEntry[], word: string): KeywordLibraryEntry[] {
  const key = keywordKey(word);
  return entries.filter((entry) => keywordKey(entry.word) !== key);
}

/** 修改一条词的优先级（找不到原样返回）。 */
export function setPriority(
  entries: KeywordLibraryEntry[],
  word: string,
  priority: GeoKeywordPriority,
): KeywordLibraryEntry[] {
  const key = keywordKey(word);
  return entries.map((entry) => (keywordKey(entry.word) === key ? { ...entry, priority } : entry));
}

export interface LibraryStats {
  total: number;
  high: number;
  byIntent: { intent: GeoKeywordIntent; count: number; high: number }[];
  byPriority: { priority: GeoKeywordPriority; count: number }[];
}

/** 词库统计：总数、高优先级数、按意图与按优先级计数（固定顺序，空组保留）。 */
export function libraryStats(entries: KeywordLibraryEntry[]): LibraryStats {
  return {
    total: entries.length,
    high: entries.filter((entry) => entry.priority === "高").length,
    byIntent: GEO_KEYWORD_INTENTS.map((intent) => ({
      intent,
      count: entries.filter((entry) => entry.intent === intent).length,
      high: entries.filter((entry) => entry.intent === intent && entry.priority === "高").length,
    })),
    byPriority: (["高", "中", "低"] as GeoKeywordPriority[]).map((priority) => ({
      priority,
      count: entries.filter((entry) => entry.priority === priority).length,
    })),
  };
}

/* ------------------------------ 问题集纯函数 ------------------------------ */

export interface GeoQuestionItem {
  text: string;
  /** 可选意图标签（与词库五类意图同口径） */
  intent?: GeoKeywordIntent;
}

/** 问题归一化键：去空白、忽略大小写、去掉结尾问号/句号后比较（「…靠谱？」与「…靠谱」算同一条）。 */
export function questionKey(text: string): string {
  return text.trim().toLowerCase().replace(/[\s\u3000]+/g, "").replace(/[？?。．.]+$/g, "");
}

/**
 * 把词条转成监测问题：问法生成复用 geokeywords 的 wordToQuestion
 * （与降级选题 targetQuestion 同一口径：词面已是问句则原样，否则补「？」），
 * 意图标签随词条带入。
 */
export function toQuestions(entries: KeywordLibraryEntry[]): GeoQuestionItem[] {
  return entries
    .map((entry) => ({ text: wordToQuestion(entry.word), intent: entry.intent }))
    .filter((item) => item.text.trim().length > 0);
}

/** 批量粘贴拆条：按行拆，去掉行首序号/项目符号，过滤空行。 */
export function parsePastedQuestions(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^(?:[-*•·]|\d+\s*[.、)）:：])\s*/, "").trim())
    .filter(Boolean);
}

export interface MergeQuestionsResult {
  items: GeoQuestionItem[];
  /** 真正新增的条数 */
  added: number;
  /** 因重复跳过的条数 */
  duplicates: number;
  /** 因上限截断丢弃的条数 */
  dropped: number;
}

/**
 * 合并问题入问题集：按归一化键去重保序（已有条目优先，重复时不覆盖已有意图，
 * 已有无意图而新条有意图时补上），超上限截断并报告丢弃数。
 */
export function mergeQuestionItems(
  current: GeoQuestionItem[],
  incoming: GeoQuestionItem[],
  max: number,
): MergeQuestionsResult {
  const items: GeoQuestionItem[] = [];
  const indexByKey = new Map<string, number>();
  for (const raw of current) {
    const text = raw.text.trim();
    if (!text) continue;
    const key = questionKey(text);
    if (indexByKey.has(key)) continue;
    indexByKey.set(key, items.length);
    items.push(raw.intent ? { text, intent: raw.intent } : { text });
  }
  let added = 0;
  let duplicates = 0;
  let dropped = 0;
  for (const raw of incoming) {
    const text = raw.text.trim();
    if (!text) continue;
    const key = questionKey(text);
    const at = indexByKey.get(key);
    if (at !== undefined) {
      duplicates += 1;
      if (!items[at].intent && raw.intent) items[at] = { ...items[at], intent: raw.intent };
      continue;
    }
    if (items.length >= max) {
      dropped += 1;
      continue;
    }
    indexByKey.set(key, items.length);
    items.push(raw.intent ? { text, intent: raw.intent } : { text });
    added += 1;
  }
  return { items, added, duplicates, dropped };
}

/* ------------------------------ 本机存取（按品牌分键） ------------------------------ */

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** 无 localStorage 环境（Node 测试/隐私模式）下的内存兜底，保证存取往返可测。 */
const memoryFallback = new Map<string, string>();
const memoryStorage: StorageLike = {
  getItem: (key) => memoryFallback.get(key) ?? null,
  setItem: (key, value) => { memoryFallback.set(key, value); },
};

function defaultStorage(): StorageLike {
  try {
    if (typeof window !== "undefined" && window.localStorage) return window.localStorage;
  } catch {
    /* 隐私模式访问 localStorage 可能抛错，落到内存兜底 */
  }
  return memoryStorage;
}

export function brandStorageKey(brand: string): string {
  return brand.trim() || DEFAULT_BRAND_KEY;
}

function readBrandMap<T>(storageKey: string, storage: StorageLike): Record<string, T> {
  try {
    const raw = storage.getItem(storageKey);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, T>;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeBrandMap<T>(storageKey: string, map: Record<string, T>, storage: StorageLike): void {
  try {
    storage.setItem(storageKey, JSON.stringify(map));
  } catch {
    /* 配额满/隐私模式：本次会话内仍可用，只是不落盘 */
  }
}

export function loadLibrary(brand: string, storage: StorageLike = defaultStorage()): KeywordLibraryEntry[] {
  const rows = readBrandMap<unknown>(LIBRARY_STORAGE_KEY, storage)[brandStorageKey(brand)];
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row) => {
    const entry = normalizeLibraryEntry((row ?? {}) as Partial<KeywordLibraryEntry>);
    return entry ? [entry] : [];
  }).slice(0, MAX_LIBRARY_ENTRIES);
}

export function saveLibrary(brand: string, entries: KeywordLibraryEntry[], storage: StorageLike = defaultStorage()): void {
  const map = readBrandMap<KeywordLibraryEntry[]>(LIBRARY_STORAGE_KEY, storage);
  map[brandStorageKey(brand)] = entries.slice(0, MAX_LIBRARY_ENTRIES);
  writeBrandMap(LIBRARY_STORAGE_KEY, map, storage);
}

/** 载入问题集：兼容旧版纯字符串数组存法，统一归一化为 {text, intent?}。 */
export function loadQuestions(brand: string, storage: StorageLike = defaultStorage()): GeoQuestionItem[] {
  const rows = readBrandMap<unknown>(QUESTIONS_STORAGE_KEY, storage)[brandStorageKey(brand)];
  if (!Array.isArray(rows)) return [];
  const items: GeoQuestionItem[] = [];
  for (const row of rows) {
    if (typeof row === "string") {
      const text = row.trim();
      if (text) items.push({ text });
    } else if (row && typeof row === "object") {
      const record = row as Partial<GeoQuestionItem>;
      const text = String(record.text ?? "").trim();
      if (!text) continue;
      const intent = (GEO_KEYWORD_INTENTS as readonly string[]).includes(String(record.intent))
        ? (record.intent as GeoKeywordIntent)
        : undefined;
      items.push(intent ? { text, intent } : { text });
    }
  }
  return items;
}

export function saveQuestions(brand: string, items: GeoQuestionItem[], storage: StorageLike = defaultStorage()): void {
  const map = readBrandMap<GeoQuestionItem[]>(QUESTIONS_STORAGE_KEY, storage);
  map[brandStorageKey(brand)] = items
    .map((item) => ({ text: item.text.trim(), ...(item.intent ? { intent: item.intent } : {}) }))
    .filter((item) => item.text);
  writeBrandMap(QUESTIONS_STORAGE_KEY, map, storage);
}
