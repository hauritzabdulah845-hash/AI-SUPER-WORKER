import { useState } from "react";
import { ClipboardCopy, Download, FileSearch, LoaderCircle, Scale, Trash2, Upload } from "lucide-react";
import {
  CONTRACT_DISCLAIMER,
  CONTRACT_STANDPOINTS,
  exportContractMarkdown,
  loadContractReviews,
  removeContractReview,
  reviewContract,
  saveContractReview,
  toReviewRecord,
  type ContractReviewRecord,
  type ContractReviewResult,
  type ContractStandpoint,
} from "../cloud/contract";

function downloadMarkdown(filename: string, content: string) {
  const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(area);
    return ok;
  }
}

/**
 * 合同审查：粘贴/读取 .txt 合同文本 → 风险清单 + 缺失条款 + 下一步。
 * 结论是 AI 初筛，不构成法律意见；留档只存摘要，不存合同全文。
 */
export function ContractReview() {
  const [title, setTitle] = useState("");
  const [standpoint, setStandpoint] = useState<ContractStandpoint>("我方");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [result, setResult] = useState<ContractReviewResult | null>(null);
  const [history, setHistory] = useState<ContractReviewRecord[]>(() => loadContractReviews());

  const readFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      const content = await file.text();
      setText(content.slice(0, 60000));
      if (!title.trim()) setTitle(file.name.replace(/\.txt$/i, ""));
      setNotice(`已读取 ${file.name}（${content.length} 字）`);
      setError("");
    } catch {
      setError("文件读取失败，请确认是文本文件（.txt）");
    }
  };

  const runReview = async () => {
    if (!text.trim()) {
      setError("请先粘贴合同文本，或读取一个 .txt 文件。");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const reviewed = await reviewContract({ title, text, standpoint });
      setResult(reviewed);
      const record = toReviewRecord(reviewed, title, standpoint);
      setHistory(saveContractReview(record));
      setNotice(reviewed.demo ? "已完成演示初筛（关键词规则）" : "审查完成");
    } catch (err) {
      setError(err instanceof Error ? err.message : "审查失败，请重试");
    } finally {
      setBusy(false);
    }
  };

  const markdown = result ? exportContractMarkdown(result, title, standpoint) : "";

  return (
    <section className="contract-page">
      <div className="console-card contract-head">
        <div>
          <h2>
            <Scale size={16} /> 合同审查
          </h2>
          <p>粘贴合同文本快速过一遍风险点：付款、违约、知识产权、保密、解除、管辖优先核对。</p>
          <p className="contract-disclaimer">{CONTRACT_DISCLAIMER}留档只保存标题与评分摘要，不保存合同全文。</p>
        </div>
      </div>

      {error && <p className="form-error contract-banner">{error}</p>}
      {notice && <p className="contract-notice">{notice}</p>}

      <div className="console-card">
        <div className="console-card-header">
          <div>
            <h2>输入合同</h2>
            <p>支持直接粘贴，或读取 .txt 文件（正文最长取前 12000 字审查）</p>
          </div>
        </div>
        <div className="contract-body">
          <div className="contract-form">
            <label>
              <span>合同标题</span>
              <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="如：年度服务合同" />
            </label>
            <label>
              <span>审查立场</span>
              <select value={standpoint} onChange={(event) => setStandpoint(event.target.value as ContractStandpoint)}>
                {CONTRACT_STANDPOINTS.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            </label>
            <label className="contract-file">
              <span>读取 .txt 文件</span>
              <span className="contract-file-row">
                <Upload size={14} />
                <input type="file" accept=".txt,text/plain" onChange={(event) => void readFile(event.target.files?.[0])} />
              </span>
            </label>
          </div>
          <label className="contract-text">
            <span>合同文本 *</span>
            <textarea rows={10} value={text} onChange={(event) => setText(event.target.value)} placeholder="把合同正文粘贴到这里…" />
          </label>
          <div className="contract-actions">
            <button type="button" className="button button-primary" onClick={() => void runReview()} disabled={busy}>
              {busy ? <LoaderCircle size={14} className="spin" /> : <FileSearch size={14} />}
              {busy ? "审查中…" : "开始审查"}
            </button>
            <span className="contract-char-count">{text.trim().length} 字</span>
          </div>
        </div>
      </div>

      {result && (
        <div className="console-card">
          <div className="console-card-header">
            <div>
              <h2>审查结果 · {result.score} 分{result.demo ? "（演示初筛）" : ""}</h2>
              <p>{result.summary}</p>
            </div>
            <div className="contract-actions">
              <button
                type="button"
                className="button button-secondary"
                onClick={() => void copyText(markdown).then((ok) => setNotice(ok ? "报告已复制" : "复制失败，请用导出"))}
              >
                <ClipboardCopy size={14} />复制报告
              </button>
              <button type="button" className="button button-secondary" onClick={() => downloadMarkdown(`合同审查-${title.trim() || "未命名"}.md`, markdown)}>
                <Download size={14} />导出 Markdown
              </button>
            </div>
          </div>
          <div className="contract-body">
            <h3 className="contract-subtitle">风险清单（{result.risks.length} 项，按严重度排序）</h3>
            {result.risks.length === 0 ? (
              <p className="form-hint">未检出风险提示（不代表无风险，请法务复核）。</p>
            ) : (
              <ul className="contract-risk-list">
                {result.risks.map((risk, index) => (
                  <li key={`${risk.title}-${index}`} className={`sev-${risk.severity}`}>
                    <div className="contract-risk-head">
                      <em className="contract-sev-badge">{risk.severity}</em>
                      <strong>{risk.title}</strong>
                    </div>
                    {risk.clause && <p className="contract-clause">条款定位：{risk.clause}</p>}
                    <p>{risk.detail}</p>
                    <p className="contract-suggestion">建议：{risk.suggestion}</p>
                  </li>
                ))}
              </ul>
            )}

            <h3 className="contract-subtitle">缺失条款（{result.missingClauses.length} 项）</h3>
            {result.missingClauses.length === 0 ? (
              <p className="form-hint">常见条款均已检出。</p>
            ) : (
              <ul className="contract-plain-list">
                {result.missingClauses.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            )}

            <h3 className="contract-subtitle">下一步</h3>
            <ol className="contract-plain-list">
              {result.nextSteps.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ol>
            <p className="contract-disclaimer">{CONTRACT_DISCLAIMER}</p>
          </div>
        </div>
      )}

      <div className="console-card">
        <div className="console-card-header">
          <div>
            <h2>审查留档</h2>
            <p>只存标题、时间、评分与风险数（最多 20 条），不存合同全文</p>
          </div>
        </div>
        <div className="contract-body">
          {history.length === 0 ? (
            <p className="form-hint">还没有审查记录。</p>
          ) : (
            <ul className="contract-history">
              {history.map((row) => (
                <li key={row.id}>
                  <span className="contract-history-time">{new Date(row.at).toLocaleString("zh-CN", { hour12: false })}</span>
                  <strong>{row.title}</strong>
                  <span>
                    {row.standpoint} · {row.score} 分 · 风险 {row.riskCount}（高 {row.highCount}）{row.demo ? " · 演示" : ""}
                  </span>
                  <button type="button" className="text-link" onClick={() => setHistory(removeContractReview(row.id))}>
                    <Trash2 size={13} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}
