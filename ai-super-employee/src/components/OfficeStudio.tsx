import { friendlyError } from "../cloud/friendlyError";
import { useEffect, useState } from "react";
import { Download, FileText, LoaderCircle, Presentation, Save, Sparkles, Trash2 } from "lucide-react";
import {
  buildDocxBlob,
  buildPptxBlob,
  docMarkdown,
  generateDocOutline,
  generatePptOutline,
  loadSavedDocs,
  removeSavedDoc,
  saveOfficeDoc,
  type DocOutline,
  type OfficeKind,
  type PptOutline,
  type StoredOfficeDoc,
} from "../cloud/office";

const AUDIENCES = ["管理层汇报", "客户提案", "内部培训", "招商路演"];
const PPT_STYLES = ["通用汇报", "产品发布", "培训课件", "招商方案"];
const DOC_TYPES = ["方案", "会议纪要", "工作报告", "制度文件", "培训资料"];
const SLIDE_COUNTS = [6, 8, 10];

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString("zh-CN", { hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(filename ? url : url);
}

function downloadText(filename: string, content: string, mime: string): void {
  downloadBlob(filename, new Blob([content], { type: mime }));
}

/**
 * AI 办公：大纲生成（LLM，降级模板）+ 本机渲染 .pptx / .docx。
 * 文件不经过外部服务；大纲留档最多 10 份，可重新预览与下载。
 */
export function OfficeStudio() {
  const [tab, setTab] = useState<OfficeKind>("pptx");

  const [pptTopic, setPptTopic] = useState("");
  const [pptAudience, setPptAudience] = useState(AUDIENCES[0]);
  const [pptStyle, setPptStyle] = useState(PPT_STYLES[0]);
  const [pptCount, setPptCount] = useState(8);
  const [pptOutline, setPptOutline] = useState<PptOutline | null>(null);

  const [docTopic, setDocTopic] = useState("");
  const [docType, setDocType] = useState(DOC_TYPES[0]);
  const [docPoints, setDocPoints] = useState("");
  const [docOutline, setDocOutline] = useState<DocOutline | null>(null);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [saved, setSaved] = useState<StoredOfficeDoc[]>([]);

  useEffect(() => {
    setSaved(loadSavedDocs());
  }, []);

  const runPptGenerate = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const outline = await generatePptOutline({ topic: pptTopic, audience: pptAudience, style: pptStyle, slideCount: pptCount });
      setPptOutline(outline);
      setNotice(outline.demo ? "模型不可用，已给出演示大纲（结构完整，可直接改）" : "演示大纲已生成");
    } catch (err) {
      setError(err instanceof Error ? friendlyError(err) : "大纲生成失败");
    } finally {
      setBusy(false);
    }
  };

  const runDocGenerate = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const outline = await generateDocOutline({ topic: docTopic, docType, points: docPoints });
      setDocOutline(outline);
      setNotice(outline.demo ? "模型不可用，已给出演示大纲（结构完整，可直接改）" : "文档大纲已生成");
    } catch (err) {
      setError(err instanceof Error ? friendlyError(err) : "大纲生成失败");
    } finally {
      setBusy(false);
    }
  };

  const archive = (kind: OfficeKind) => {
    const outline = kind === "pptx" ? pptOutline : docOutline;
    if (!outline) return;
    saveOfficeDoc({ kind, title: outline.title, outline });
    setSaved(loadSavedDocs());
    setNotice("大纲已留档（本机最多 10 份）");
  };

  const downloadPptx = async () => {
    if (!pptOutline) return;
    setBusy(true);
    try {
      const blob = await buildPptxBlob(pptOutline);
      downloadBlob(`${pptOutline.title || "演示"}.pptx`, blob);
      setNotice(`PPT 已生成（${pptOutline.slides.length + 1} 页，本机渲染）`);
    } catch (err) {
      setError(err instanceof Error ? friendlyError(err) : "PPT 生成失败");
    } finally {
      setBusy(false);
    }
  };

  const downloadDocx = async () => {
    if (!docOutline) return;
    setBusy(true);
    try {
      const blob = await buildDocxBlob(docOutline);
      downloadBlob(`${docOutline.title || "文档"}.docx`, blob);
      setNotice("Word 文档已生成（本机渲染）");
    } catch (err) {
      setError(err instanceof Error ? friendlyError(err) : "文档生成失败");
    } finally {
      setBusy(false);
    }
  };

  const loadSaved = (row: StoredOfficeDoc) => {
    if (row.kind === "pptx") {
      setTab("pptx");
      setPptOutline(row.outline as PptOutline);
    } else {
      setTab("docx");
      setDocOutline(row.outline as DocOutline);
    }
    setNotice(`已载入留档：${row.title}`);
  };

  return (
    <section className="office-page">
      <div className="console-card office-head">
        <div>
          <h2>AI 办公</h2>
          <p>
            生成结构化大纲并在本机渲染成 .pptx / .docx——不经过任何外部办公服务；模型不可用时降级演示大纲并标注。
            留档最多 10 份，仅存本机。
          </p>
        </div>
        <div className="office-tabs">
          <button type="button" className={tab === "pptx" ? "active" : ""} onClick={() => setTab("pptx")}>
            <Presentation size={15} />PPT 演示
          </button>
          <button type="button" className={tab === "docx" ? "active" : ""} onClick={() => setTab("docx")}>
            <FileText size={15} />Word 文档
          </button>
        </div>
      </div>

      {notice && <div className="pipeline-toast">{notice}</div>}
      {error && <p className="geo-error">{error}</p>}

      {tab === "pptx" ? (
        <div className="office-grid">
          <div className="console-card office-form">
            <div className="console-card-header">
              <div>
                <h2>演示大纲</h2>
                <p>先出大纲再下载，预览即最终结构</p>
              </div>
            </div>
            <label className="office-field">
              <span>主题</span>
              <input value={pptTopic} onChange={(event) => setPptTopic(event.target.value)} placeholder="例：2026 新店开业招商方案" />
            </label>
            <div className="office-form-row">
              <label className="office-field">
                <span>受众</span>
                <select value={pptAudience} onChange={(event) => setPptAudience(event.target.value)}>
                  {AUDIENCES.map((item) => (
                    <option key={item}>{item}</option>
                  ))}
                </select>
              </label>
              <label className="office-field">
                <span>风格</span>
                <select value={pptStyle} onChange={(event) => setPptStyle(event.target.value)}>
                  {PPT_STYLES.map((item) => (
                    <option key={item}>{item}</option>
                  ))}
                </select>
              </label>
              <label className="office-field">
                <span>页数</span>
                <select value={pptCount} onChange={(event) => setPptCount(Number(event.target.value))}>
                  {SLIDE_COUNTS.map((item) => (
                    <option key={item} value={item}>
                      {item} 页
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <button type="button" className="button button-primary" onClick={() => void runPptGenerate()} disabled={busy}>
              {busy ? <LoaderCircle size={15} className="spin" /> : <Sparkles size={15} />}
              生成大纲
            </button>
          </div>

          <div className="console-card office-preview">
            <div className="console-card-header">
              <div>
                <h2>{pptOutline ? pptOutline.title : "预览区"}</h2>
                <p>{pptOutline ? `${pptOutline.subtitle}${pptOutline.demo ? " · 演示大纲" : ""} · ${pptOutline.slides.length} 页内容 + 封面` : "生成后在此预览每页要点"}</p>
              </div>
              {pptOutline && (
                <div className="office-actions">
                  <button type="button" className="button button-secondary" onClick={() => archive("pptx")}>
                    <Save size={14} />留档
                  </button>
                  <button type="button" className="button button-primary" onClick={() => void downloadPptx()} disabled={busy}>
                    <Download size={14} />下载 .pptx
                  </button>
                </div>
              )}
            </div>
            {pptOutline ? (
              <div className="office-slides">
                <div className="office-slide cover">
                  <strong>{pptOutline.title}</strong>
                  <span>{pptOutline.demo ? `${pptOutline.subtitle}（演示大纲）` : pptOutline.subtitle}</span>
                </div>
                {pptOutline.slides.map((slide, index) => (
                  <div className="office-slide" key={`${slide.title}-${index}`}>
                    <em>{index + 1}</em>
                    <div>
                      <strong>{slide.title}</strong>
                      <ul>
                        {slide.bullets.map((bullet) => (
                          <li key={bullet}>{bullet}</li>
                        ))}
                      </ul>
                      {slide.note && <small>讲稿：{slide.note}</small>}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="console-card module-page-card empty-search">
                <Presentation size={24} />
                <strong>还没有大纲</strong>
                <span>填写主题后点「生成大纲」</span>
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="office-grid">
          <div className="console-card office-form">
            <div className="console-card-header">
              <div>
                <h2>文档大纲</h2>
                <p>可下载 .docx 或 .md，正文按大纲直接展开</p>
              </div>
            </div>
            <label className="office-field">
              <span>主题</span>
              <input value={docTopic} onChange={(event) => setDocTopic(event.target.value)} placeholder="例：门店服务流程制度" />
            </label>
            <div className="office-form-row">
              <label className="office-field">
                <span>类型</span>
                <select value={docType} onChange={(event) => setDocType(event.target.value)}>
                  {DOC_TYPES.map((item) => (
                    <option key={item}>{item}</option>
                  ))}
                </select>
              </label>
            </div>
            <label className="office-field">
              <span>补充要点（可选）</span>
              <textarea
                value={docPoints}
                onChange={(event) => setDocPoints(event.target.value)}
                rows={4}
                placeholder="要覆盖的事实、约束、时间点…一行一条"
              />
            </label>
            <button type="button" className="button button-primary" onClick={() => void runDocGenerate()} disabled={busy}>
              {busy ? <LoaderCircle size={15} className="spin" /> : <Sparkles size={15} />}
              生成大纲
            </button>
          </div>

          <div className="console-card office-preview">
            <div className="console-card-header">
              <div>
                <h2>{docOutline ? docOutline.title : "预览区"}</h2>
                <p>{docOutline ? `${docOutline.subtitle}${docOutline.demo ? " · 演示大纲" : ""} · ${docOutline.sections.length} 章` : "生成后在此预览章节结构"}</p>
              </div>
              {docOutline && (
                <div className="office-actions">
                  <button type="button" className="button button-secondary" onClick={() => archive("docx")}>
                    <Save size={14} />留档
                  </button>
                  <button
                    type="button"
                    className="button button-secondary"
                    onClick={() => {
                      downloadText(`${docOutline.title || "文档"}.md`, docMarkdown(docOutline), "text/markdown;charset=utf-8");
                      setNotice("Markdown 已下载");
                    }}
                  >
                    <Download size={14} />.md
                  </button>
                  <button type="button" className="button button-primary" onClick={() => void downloadDocx()} disabled={busy}>
                    <Download size={14} />下载 .docx
                  </button>
                </div>
              )}
            </div>
            {docOutline ? (
              <div className="office-doc">
                <h3>{docOutline.title}</h3>
                <p className="office-doc-sub">{docOutline.demo ? `${docOutline.subtitle}（演示大纲）` : docOutline.subtitle}</p>
                {docOutline.sections.map((section, index) => (
                  <div className="office-doc-section" key={`${section.heading}-${index}`}>
                    <strong>{section.heading}</strong>
                    {section.paragraphs.map((paragraph) => (
                      <p key={paragraph}>{paragraph}</p>
                    ))}
                  </div>
                ))}
              </div>
            ) : (
              <div className="console-card module-page-card empty-search">
                <FileText size={24} />
                <strong>还没有大纲</strong>
                <span>填写主题后点「生成大纲」</span>
              </div>
            )}
          </div>
        </div>
      )}

      {saved.length > 0 && (
        <div className="console-card office-saved">
          <div className="console-card-header">
            <div>
              <h2>留档（{saved.length}）</h2>
              <p>大纲存本机，点击载入预览后可重新下载；最多 10 份</p>
            </div>
          </div>
          <ul>
            {saved.map((row) => (
              <li key={row.savedAt}>
                <div className="office-saved-info">
                  <strong>{row.title}</strong>
                  <span>
                    {row.kind === "pptx" ? "PPT" : "文档"} · {formatTime(row.savedAt)}
                    {(row.outline as PptOutline).demo ? " · 演示大纲" : ""}
                  </span>
                </div>
                <div className="office-saved-actions">
                  <button type="button" className="text-link" onClick={() => loadSaved(row)}>
                    载入
                  </button>
                  <button
                    type="button"
                    className="text-link"
                    onClick={() => {
                      removeSavedDoc(row.savedAt);
                      setSaved(loadSavedDocs());
                    }}
                  >
                    <Trash2 size={13} />删除
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

export default OfficeStudio;
