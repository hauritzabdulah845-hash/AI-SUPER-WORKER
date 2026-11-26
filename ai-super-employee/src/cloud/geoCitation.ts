import { sourceKey, type GeoSnapshot } from "./geotrack";
import type { GeoReviewItem } from "./geoReview";

/**
 * GEO 稿件级引用状态（第三十批，评审 P2）：把「信源 TOP」往下钻一层，
 * 回答「我发的哪篇稿被 AI 引用了」。
 *
 * 匹配是**启发式**：模型给的来源只有站点名/文章名/链接，没有稿件 ID，
 * 只能按「发布链接域名 → 标题关键词 → 品牌名+平台名」三路比对。
 * 结果仅供参考，界面必须标注口径（见 GeoMonitor 稿件引用状态区）。
 * 本模块纯函数、无 IO，可单测；不改快照结构。
 */

/** 参与匹配的稿件（由审核队列 approved 条目映射而来，字段可扩展） */
export interface CitationDraftInput {
  id: string;
  title: string;
  /** 正文节选（只用于提取发布链接与平台线索，不做全文比对） */
  body?: string;
  brand: string;
  /** 平台名（如「小红书」）；缺省时从标题/正文线索推断 */
  platform?: string;
  /** 发布链接（若有）；缺省时从正文节选里提取 URL */
  url?: string;
}

export type CitationMatchWay = "url" | "title" | "brand-platform";

export const CITATION_WAY_LABEL: Record<CitationMatchWay, string> = {
  url: "发布链接",
  title: "标题关键词",
  "brand-platform": "品牌+平台",
};

export interface DraftCitationStatus {
  draftId: string;
  title: string;
  platform: string;
  cited: boolean;
  /** 被引用次数：跨快照的命中来源出现次数（与 sourceRanking 同口径） */
  citationCount: number;
  /** 最近一次被引用的快照时间（ISO）；未被引用为 null */
  lastCitedAt: string | null;
  /** 命中的信源显示名（去重，最多 5 个） */
  matchedSources: string[];
  /** 命中的匹配路径（可多路） */
  matchWays: CitationMatchWay[];
}

/** 常见分发平台别名：canonical 名 → 在标题/来源里可能出现的写法 */
const PLATFORM_ALIASES: Record<string, string[]> = {
  小红书: ["小红书", "xiaohongshu", "rednote"],
  公众号: ["公众号", "微信公众号", "微信", "mp.weixin"],
  知乎: ["知乎", "zhihu"],
  抖音: ["抖音", "douyin"],
  百家号: ["百家号", "baijiahao"],
  今日头条: ["今日头条", "头条号", "toutiao"],
  B站: ["b站", "bilibili", "哔哩哔哩"],
  微博: ["微博", "weibo"],
  快手: ["快手", "kuaishou"],
  视频号: ["视频号"],
};

const URL_RE = /https?:\/\/[^\s<>"'）)】]+/gi;

/** 归一化：小写、去空白（与 geotrack.analyzeAnswer 同口径） */
function normalize(text: string): string {
  return text.toLowerCase().replace(/[\s\u3000]+/g, "");
}

function stripPunct(text: string): string {
  return normalize(text).replace(/[，。！？、；：·…—\-_|/\\()（）【】[\]{}<>《》"'“”‘’?！!.,:;]+/gu, "");
}

/** 从文本里提取 URL 域名（去 www.），与 sourceKey 同口径 */
function domainsOf(text: string): string[] {
  const out: string[] = [];
  for (const match of text.match(URL_RE) ?? []) {
    const key = sourceKey(match.replace(/[）)】]+$/u, ""));
    if (key && !out.includes(key)) out.push(key);
  }
  return out;
}

/** 推断稿件平台：显式字段 → 标题「平台稿：」前缀 → 标题/正文里的平台别名 */
export function draftPlatform(draft: CitationDraftInput): string {
  if (draft.platform?.trim()) return draft.platform.trim();
  const prefix = draft.title.match(/^(.+?)稿[：:]/u);
  if (prefix) return prefix[1].trim();
  const haystack = normalize(`${draft.title}\n${draft.body ?? ""}`);
  for (const [name, aliases] of Object.entries(PLATFORM_ALIASES)) {
    if (aliases.some((alias) => haystack.includes(normalize(alias)))) return name;
  }
  return "";
}

/** 审核队列条目 → 匹配输入（正文只取节选，够提取链接与平台线索） */
export function reviewItemToCitationDraft(item: GeoReviewItem): CitationDraftInput {
  return {
    id: item.id,
    title: item.title,
    body: item.body.slice(0, 600),
    brand: item.brand,
  };
}

/**
 * 标题关键词：去品牌名与标点后切分。
 * - 完整标题（≥6 字）本身算一个强关键词；
 * - 按分隔符切出的片段里，≥4 字的算强关键词，2-3 字的算弱关键词；
 * - 中文标题常无分隔符，再补 3 字滑窗片段作弱关键词（上限 30 个防膨胀）。
 * 命中规则：任一强关键词命中，或 ≥2 个弱关键词同时命中（避免单个常用词误判）。
 */
function titleKeywords(title: string, brand: string): { strong: string[]; weak: string[] } {
  const cleaned = stripPunct(title.replace(/^.+?稿[：:]/u, ""));
  const brandKey = stripPunct(brand);
  const strong: string[] = [];
  const weak: string[] = [];
  if (cleaned.length >= 6) strong.push(cleaned);
  for (const part of title.split(/[\s，。！？、；：·…—\-_|/\\()（）【】[\]{}<>《》"'“”‘’?！!.,:;]+/u)) {
    const word = stripPunct(part);
    if (!word || word === brandKey || word.length < 2) continue;
    if (word.length >= 4) {
      if (!strong.includes(word)) strong.push(word);
    } else if (!weak.includes(word)) {
      weak.push(word);
    }
  }
  // 无分隔长标题：3 字滑窗兜底（跳过含品牌名的片段，避免品牌名本身刷命中）
  if (cleaned.length >= 6) {
    for (let i = 0; i + 3 <= cleaned.length && weak.length < 30; i += 1) {
      const gram = cleaned.slice(i, i + 3);
      if (brandKey && gram.includes(brandKey)) continue;
      if (!weak.includes(gram)) weak.push(gram);
    }
  }
  return { strong, weak };
}

function titleMatches(sourceText: string, keywords: { strong: string[]; weak: string[] }): boolean {
  const haystack = stripPunct(sourceText);
  if (!haystack) return false;
  if (keywords.strong.some((word) => haystack.includes(word))) return true;
  return keywords.weak.filter((word) => haystack.includes(word)).length >= 2;
}

/** 单次快照的全部来源（快照级优先，旧结构回退样本级；与 sourceRanking 同口径） */
function snapshotSources(snapshot: GeoSnapshot): string[] {
  if (snapshot.sources?.length) {
    return snapshot.sources.flatMap((item) => item.sources);
  }
  return snapshot.samples.flatMap((sample) => sample.sources ?? []);
}

/**
 * 稿件引用状态匹配：每篇稿件 × 全部快照来源，三路任一命中即记一次引用。
 * - url：稿件发布链接域名出现在来源里（最强信号；来源无协议头时按域名包含判断）
 * - title：来源文本命中标题强关键词，或 ≥2 个弱关键词
 * - brand-platform：来源同时含品牌名与稿件平台名/别名（最弱，只作参考）
 */
export function matchDraftCitations(
  drafts: CitationDraftInput[],
  snapshots: GeoSnapshot[],
): DraftCitationStatus[] {
  const sorted = [...snapshots].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const perSnapshot = sorted.map((snapshot) => ({ at: snapshot.at, sources: snapshotSources(snapshot) }));

  return drafts.map((draft) => {
    const platform = draftPlatform(draft);
    const domains = domainsOf(`${draft.url ?? ""}\n${draft.body ?? ""}`);
    const keywords = titleKeywords(draft.title, draft.brand);
    const brandKey = normalize(draft.brand);
    const platformAliases = platform
      ? (PLATFORM_ALIASES[platform] ?? [platform]).map(normalize)
      : [];

    let citationCount = 0;
    let lastCitedAt: string | null = null;
    const matched = new Map<string, string>();
    const ways = new Set<CitationMatchWay>();

    for (const { at, sources } of perSnapshot) {
      for (const source of sources) {
        const sourceNorm = normalize(source);
        const hitWays: CitationMatchWay[] = [];
        if (domains.length && domains.some((domain) => sourceNorm.includes(domain))) hitWays.push("url");
        if (titleMatches(source, keywords)) hitWays.push("title");
        if (
          brandKey &&
          platformAliases.length &&
          sourceNorm.includes(brandKey) &&
          platformAliases.some((alias) => sourceNorm.includes(alias))
        ) {
          hitWays.push("brand-platform");
        }
        if (!hitWays.length) continue;
        citationCount += 1;
        lastCitedAt = at;
        for (const way of hitWays) ways.add(way);
        const key = sourceKey(source);
        if (key && !matched.has(key)) matched.set(key, source.trim());
      }
    }

    return {
      draftId: draft.id,
      title: draft.title,
      platform,
      cited: citationCount > 0,
      citationCount,
      lastCitedAt,
      matchedSources: [...matched.values()].slice(0, 5),
      matchWays: [...ways],
    };
  });
}
