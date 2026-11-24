/**
 * 知识库本地相关性排序（TF-IDF + 余弦，零 Key、零依赖）。
 *
 * 现状：`extractTerms` 只做「命中就加分」，所有词的权重一样，
 * 像「的」「我们」这种高频词和「报价单」权重相同，排序经常不理想。
 * 这里用文档集合自身统计出的 IDF 给词加权，再用余弦相似度排序——
 * 没有嵌入模型也能明显改善（不需要 Key，纯本机计算）。
 * 真正语义检索仍需嵌入模型，见路线图接入清单。
 */

export interface RankDoc {
  id: number;
  title: string;
  content?: string;
}

export interface RankHit {
  id: number;
  score: number;
  /** 命中的关键词（按权重降序取前 5），用于 UI 解释「为什么这条靠前」 */
  matched: string[];
}

/** 中英混合分词：英文/数字按词并小写，中文按 2-gram（单字兜底）。 */
export function terms(text: string): string[] {
  const value = String(text ?? "").toLowerCase();
  const out: string[] = [];
  for (const word of value.match(/[a-z0-9][a-z0-9._-]*/g) ?? []) {
    if (word.length >= 2) out.push(word);
  }
  for (const segment of value.replace(/[^\u4e00-\u9fff]+/g, " ").split(/\s+/)) {
    if (!segment) continue;
    if (segment.length === 1) out.push(segment);
    for (let i = 0; i < segment.length - 1; i += 1) out.push(segment.slice(i, i + 2));
  }
  return out;
}

/** 停用词：中文虚词与英文常见词，命中也不加权（否则「的/我们」会主导排序）。 */
const STOPWORDS = new Set([
  "的", "了", "是", "在", "和", "与", "及", "或", "我", "我们", "你", "你们", "他", "它",
  "这", "那", "有", "就", "都", "而", "被", "把", "也", "还", "但", "并", "对", "从",
  "the", "and", "for", "with", "that", "this", "are", "was", "have", "has",
]);

export function filteredTerms(text: string): string[] {
  return terms(text).filter((term) => !STOPWORDS.has(term) && term.trim().length > 0);
}

function termFreq(list: string[]): Map<string, number> {
  const freq = new Map<string, number>();
  for (const term of list) freq.set(term, (freq.get(term) ?? 0) + 1);
  return freq;
}

/**
 * 对文档集合排序：返回按分数降序的命中（分数为 0 的丢弃）。
 * 标题词频按 3 倍计入（标题更代表主题）。
 */
export function rankDocs(docs: RankDoc[], query: string, limit = 50): RankHit[] {
  const queryTerms = [...new Set(filteredTerms(query))];
  if (!queryTerms.length || !docs.length) return [];

  // 文档词频（标题 3 倍）
  const docFreqs = docs.map((doc) => {
    const titleList = filteredTerms(doc.title);
    const bodyList = filteredTerms(doc.content ?? "");
    const freq = termFreq(bodyList);
    for (const term of titleList) freq.set(term, (freq.get(term) ?? 0) + 3);
    return { doc, freq, length: Math.max(1, bodyList.length + titleList.length * 3) };
  });

  // IDF：出现在越少文档中的词越有区分度（平滑，避免除零）
  const docCount = docs.length;
  const df = new Map<string, number>();
  for (const { freq } of docFreqs) {
    for (const term of freq.keys()) df.set(term, (df.get(term) ?? 0) + 1);
  }
  const idf = (term: string) => Math.log(1 + (docCount - (df.get(term) ?? 0) + 0.5) / ((df.get(term) ?? 0) + 0.5));

  // 查询向量（词频 × IDF），并归一化
  const queryFreq = termFreq(queryTerms);
  const queryVector = new Map<string, number>();
  let queryNorm = 0;
  for (const [term, count] of queryFreq) {
    const weight = count * idf(term);
    queryVector.set(term, weight);
    queryNorm += weight * weight;
  }
  queryNorm = Math.sqrt(queryNorm) || 1;

  const hits: RankHit[] = [];
  for (const { doc, freq, length } of docFreqs) {
    let dot = 0;
    let norm = 0;
    const matched: { term: string; weight: number }[] = [];
    for (const [term, count] of freq) {
      // TF 用对数饱和，长文档不至于靠堆词占优
      const tf = count / (count + 1.2 * (length / 100 + 0.5));
      const weight = tf * idf(term);
      norm += weight * weight;
      const q = queryVector.get(term);
      if (q) {
        dot += q * weight;
        matched.push({ term, weight: q * weight });
      }
    }
    if (dot <= 0) continue;
    const similarity = dot / (queryNorm * (Math.sqrt(norm) || 1));
    hits.push({
      id: doc.id,
      score: Number(similarity.toFixed(6)),
      matched: matched.sort((a, b) => b.weight - a.weight).slice(0, 5).map((item) => item.term),
    });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}
