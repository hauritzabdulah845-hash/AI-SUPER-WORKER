/**
 * 知识库检索与分页（纯函数）。
 *
 * 现状：后端 listKnowledgeDocs 只取最近 100 份，前端只能平铺。
 * 本模块补：① 关键词/2-gram 打分检索（标题权重高于正文）② 分页 ③ 高亮片段。
 * 不做向量检索（需嵌入模型与 Key），但打分函数可平滑替换为向量相似度。
 */

export interface KbDoc {
  id: number;
  title: string;
  doc_type: string;
  source: string;
  chunks: number;
  content?: string;
  created_at: string;
}

export interface KbHit {
  doc: KbDoc;
  score: number;
  /** 命中片段（标题命中时为标题，正文命中时为正文窗口） */
  snippet: string;
  /** 命中来源：标题 / 正文 / 类型 */
  where: "title" | "content" | "type" | "none";
}

/** 中英混合分词：英文/数字按词，中文按 2-gram（与现有知识库召回口径一致）。 */
export function tokenizeQuery(query: string): string[] {
  const text = String(query ?? "").toLowerCase().trim();
  if (!text) return [];
  const tokens = new Set<string>();
  for (const word of text.match(/[a-z0-9]+/g) ?? []) tokens.add(word);
  const cjk = text.replace(/[^\u4e00-\u9fff]/g, " ");
  for (const segment of cjk.split(/\s+/)) {
    if (!segment) continue;
    if (segment.length === 1) tokens.add(segment);
    for (let i = 0; i < segment.length - 1; i += 1) tokens.add(segment.slice(i, i + 2));
  }
  return [...tokens];
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

/** 标题命中权重 3、类型命中 2、正文命中 1；命中词种类越多分越高。 */
export function scoreDoc(doc: KbDoc, tokens: string[]): { score: number; where: KbHit["where"] } {
  if (!tokens.length) return { score: 0, where: "none" };
  const title = doc.title.toLowerCase();
  const type = `${doc.doc_type} ${doc.source ?? ""}`.toLowerCase();
  const content = (doc.content ?? "").toLowerCase();
  let score = 0;
  let titleHit = false;
  let typeHit = false;
  let contentHit = false;
  for (const token of tokens) {
    const inTitle = countOccurrences(title, token);
    const inType = countOccurrences(type, token);
    const inContent = countOccurrences(content, token);
    if (inTitle) {
      score += 3 * inTitle + 2; // 命中标题额外加成：搜「价格表」应先出价格表
      titleHit = true;
    }
    if (inType) {
      score += 2 * inType;
      typeHit = true;
    }
    if (inContent) {
      score += 1 * Math.min(inContent, 5); // 正文重复次数封顶，防长文刷分
      contentHit = true;
    }
  }
  const where: KbHit["where"] = titleHit ? "title" : contentHit ? "content" : typeHit ? "type" : "none";
  return { score, where };
}

/** 取正文首个命中位置附近的窗口作为片段。 */
export function snippetOf(doc: KbDoc, tokens: string[], width = 90): string {
  const content = (doc.content ?? "").trim();
  if (!content) return `${doc.doc_type} · ${doc.chunks} 个知识片段`;
  const lower = content.toLowerCase();
  let at = -1;
  for (const token of tokens) {
    const index = lower.indexOf(token);
    if (index >= 0 && (at < 0 || index < at)) at = index;
  }
  if (at < 0) return `${content.slice(0, width)}${content.length > width ? "…" : ""}`;
  const start = Math.max(0, at - Math.floor(width / 3));
  const end = Math.min(content.length, start + width);
  return `${start > 0 ? "…" : ""}${content.slice(start, end)}${end < content.length ? "…" : ""}`;
}

/**
 * 检索：空查询返回原顺序（按创建时间倒序的入参顺序），有查询按分数降序。
 * 分数为 0 的文档在有关键词时不返回（避免无关结果污染）。
 */
export function searchDocs(docs: KbDoc[], query: string, limit = 100): KbHit[] {
  const tokens = tokenizeQuery(query);
  if (!tokens.length) {
    return docs.slice(0, limit).map((doc) => ({ doc, score: 0, snippet: snippetOf(doc, []), where: "none" as const }));
  }
  const hits: KbHit[] = [];
  for (const doc of docs) {
    const { score, where } = scoreDoc(doc, tokens);
    if (score <= 0) continue;
    hits.push({ doc, score, snippet: snippetOf(doc, tokens), where });
  }
  hits.sort((a, b) => b.score - a.score || Date.parse(b.doc.created_at) - Date.parse(a.doc.created_at));
  return hits.slice(0, limit);
}

export interface PageResult<T> {
  items: T[];
  page: number;
  pageCount: number;
  total: number;
  /** 每页条数（入参非法时回落 10） */
  pageSize: number;
}

/** 分页：page 从 1 开始，越界自动夹到有效范围（删除/筛选后不会停在空页）。 */
export function paginate<T>(items: T[], page: number, pageSize = 10): PageResult<T> {
  const size = Number.isFinite(pageSize) && pageSize > 0 ? Math.floor(pageSize) : 10;
  const total = items.length;
  const pageCount = Math.max(1, Math.ceil(total / size));
  const safePage = Math.min(Math.max(1, Math.floor(Number.isFinite(page) ? page : 1)), pageCount);
  const start = (safePage - 1) * size;
  return { items: items.slice(start, start + size), page: safePage, pageCount, total, pageSize: size };
}
