import { useMemo, useState } from "react";
import { BookOpen, CheckCircle2, ChevronLeft, ChevronRight, FileText, Search, X } from "lucide-react";
import { paginate, snippetOf, tokenizeQuery, type KbDoc } from "../cloud/kbsearch";
import { rankDocs } from "../cloud/kbrank";

interface KnowledgeListProps {
  docs: KbDoc[];
  /** 点击打开全文 */
  onOpen: (doc: KbDoc) => void;
}

const PAGE_SIZE = 10;

/**
 * 知识库列表：关键词检索（标题优先）+ 分页。
 * 检索在前端内存里做——docs 已是后端取回的一批（默认最近 100 份），
 * 向量检索需要嵌入模型，见路线图接入清单。
 */
export function KnowledgeList({ docs, onOpen }: KnowledgeListProps) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);

  /**
   * 检索：有查询时用 TF-IDF 余弦排序（词权重按文档集统计，比简单命中更准），
   * 并保留「标题命中优先」的直觉——标题命中的人为提到前面。
   */
  type Hit = { doc: KbDoc; score: number; snippet: string; where: "none" | "title" | "content"; matched?: string[] };
  const hits = useMemo<Hit[]>(() => {
    if (!query.trim()) {
      return docs.map((doc) => ({ doc, score: 0, snippet: snippetOf(doc, []), where: "none" as const }));
    }
    const ranked = rankDocs(docs.map((doc) => ({ id: doc.id, title: doc.title, content: doc.content })), query, 500);
    const tokens = tokenizeQuery(query);
    return ranked.map((hit) => {
      const doc = docs.find((item) => item.id === hit.id) as KbDoc;
      const titleHit = tokens.some((token) => doc.title.toLowerCase().includes(token));
      return {
        doc,
        score: hit.score,
        snippet: snippetOf(doc, tokens),
        where: titleHit ? ("title" as const) : ("content" as const),
        matched: hit.matched,
      };
    });
  }, [docs, query]);
  const paged = useMemo(() => paginate(hits, page, PAGE_SIZE), [hits, page]);

  const changeQuery = (value: string) => {
    setQuery(value);
    setPage(1); // 换关键词回到第一页
  };

  return (
    <div className="console-card knowledge-list">
      <div className="console-card-header">
        <div>
          <h2>知识资料（{docs.length}）</h2>
          <p>
            {query.trim()
              ? `「${query.trim()}」命中 ${hits.length} 份 · 标题命中优先`
              : "点击查看全文，智能体会按权限调用这些知识"}
          </p>
        </div>
        <label className="knowledge-search">
          <Search size={14} />
          <input
            aria-label="搜索知识库"
            placeholder="搜标题或正文，如：价格表"
            value={query}
            onChange={(event) => changeQuery(event.target.value)}
          />
          {query && (
            <button type="button" className="icon-button" aria-label="清空搜索" onClick={() => changeQuery("")}>
              <X size={13} />
            </button>
          )}
        </label>
      </div>

      {docs.length === 0 && (
        <div className="empty-search">
          <BookOpen size={24} />
          <strong>知识库还是空的</strong>
          <span>选择本地文件夹批量导入，或手动录入产品手册、价格表</span>
        </div>
      )}

      {docs.length > 0 && hits.length === 0 && (
        <div className="empty-search">
          <Search size={22} />
          <strong>没有匹配的资料</strong>
          <span>换个关键词，或清空搜索看全部</span>
        </div>
      )}

      {paged.items.map((hit) => (
        <button type="button" className="knowledge-doc" key={hit.doc.id} onClick={() => onOpen(hit.doc)}>
          <div>
            <FileText size={19} />
          </div>
          <span>
            <strong>{hit.doc.title}</strong>
            <small>
              {hit.doc.doc_type} · {hit.doc.chunks} 个知识片段
              {hit.where === "title" && <em className="kb-hit-badge">标题命中</em>}
            </small>
            {query.trim() && (
              <span className="kb-snippet">
                {hit.matched?.length ? <em className="kb-terms">匹配：{hit.matched.slice(0, 4).join("、")}</em> : null}
                {hit.snippet}
              </span>
            )}
          </span>
          <time>{new Date(hit.doc.created_at).toLocaleDateString("zh-CN")}</time>
          <CheckCircle2 size={17} />
        </button>
      ))}

      {paged.pageCount > 1 && (
        <div className="kb-pager">
          <button
            type="button"
            className="text-link"
            disabled={paged.page <= 1}
            onClick={() => setPage(paged.page - 1)}
            aria-label="上一页"
          >
            <ChevronLeft size={14} />上一页
          </button>
          <span>
            第 {paged.page} / {paged.pageCount} 页 · 共 {paged.total} 条
          </span>
          <button
            type="button"
            className="text-link"
            disabled={paged.page >= paged.pageCount}
            onClick={() => setPage(paged.page + 1)}
            aria-label="下一页"
          >
            下一页<ChevronRight size={14} />
          </button>
        </div>
      )}
    </div>
  );
}

export default KnowledgeList;
