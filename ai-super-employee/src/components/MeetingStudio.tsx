import { friendlyError } from "../cloud/friendlyError";
import { useState } from "react";
import { ClipboardCopy, Download, LoaderCircle, NotebookPen, Sparkles, Trash2, Upload } from "lucide-react";
import {
  MEETING_NOTE,
  exportMinutesMarkdown,
  generateMinutes,
  loadMeetingRecords,
  removeMeetingRecord,
  saveMeetingRecord,
  toMeetingRecord,
  type MeetingMinutes,
  type MeetingRecord,
} from "../cloud/meeting";

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
 * AI 会议：粘贴转写文本 → 摘要 / 决议 / 待办表 / 风险。
 * 平台录音转写接入后置；留档只存摘要，不存转写全文。
 */
export function MeetingStudio() {
  const [title, setTitle] = useState("");
  const [attendees, setAttendees] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [result, setResult] = useState<MeetingMinutes | null>(null);
  const [history, setHistory] = useState<MeetingRecord[]>(() => loadMeetingRecords());

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

  const runGenerate = async () => {
    if (!text.trim()) {
      setError("请先粘贴会议转写文本，或读取一个 .txt 文件。");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const minutes = await generateMinutes({ title, transcript: text, attendees });
      setResult(minutes);
      setHistory(saveMeetingRecord(toMeetingRecord(minutes)));
      setNotice(minutes.demo ? "已生成演示纪要（启发式抽取）" : "纪要已生成");
    } catch (err) {
      setError(err instanceof Error ? friendlyError(err) : "生成失败，请重试");
    } finally {
      setBusy(false);
    }
  };

  const markdown = result ? exportMinutesMarkdown(result) : "";

  return (
    <section className="meeting-page">
      <div className="console-card meeting-head">
        <div>
          <h2>
            <NotebookPen size={16} /> AI 会议
          </h2>
          <p>把会议转写整理成纪要：摘要、决议、带负责人的待办表、风险与未决事项。</p>
          <p className="meeting-note">{MEETING_NOTE}留档只保存标题与条数摘要，不保存转写全文。</p>
        </div>
      </div>

      {error && <p className="form-error meeting-banner">{error}</p>}
      {notice && <p className="meeting-notice">{notice}</p>}

      <div className="console-card">
        <div className="console-card-header">
          <div>
            <h2>输入转写</h2>
            <p>直接粘贴转写文本，或读取 .txt 文件（正文最长取前 12000 字生成）</p>
          </div>
        </div>
        <div className="meeting-body">
          <div className="meeting-form">
            <label>
              <span>会议标题</span>
              <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="如：周一产品例会" />
            </label>
            <label>
              <span>参会人（选填）</span>
              <input value={attendees} onChange={(event) => setAttendees(event.target.value)} placeholder="如：张三、李四、王五" />
            </label>
            <label className="meeting-file">
              <span>读取 .txt 文件</span>
              <span className="meeting-file-row">
                <Upload size={14} />
                <input type="file" accept=".txt,text/plain" onChange={(event) => void readFile(event.target.files?.[0])} />
              </span>
            </label>
          </div>
          <label className="meeting-text">
            <span>转写文本 *</span>
            <textarea rows={10} value={text} onChange={(event) => setText(event.target.value)} placeholder={"把转写粘贴到这里，带说话人效果更好，如：\n张三：我们决定下周上线新版。\n李四：我负责跟进测试，周三前提交报告。"} />
          </label>
          <div className="meeting-actions">
            <button type="button" className="button button-primary" onClick={() => void runGenerate()} disabled={busy}>
              {busy ? <LoaderCircle size={14} className="spin" /> : <Sparkles size={14} />}
              {busy ? "生成中…" : "生成纪要"}
            </button>
            <span className="meeting-char-count">{text.trim().length} 字</span>
          </div>
        </div>
      </div>

      {result && (
        <div className="console-card">
          <div className="console-card-header">
            <div>
              <h2>会议纪要 · {result.title}{result.demo ? "（演示纪要）" : ""}</h2>
              <p>{result.summary}</p>
            </div>
            <div className="meeting-actions">
              <button type="button" className="button button-secondary" onClick={() => void copyText(markdown).then((ok) => setNotice(ok ? "纪要已复制" : "复制失败，请用导出"))}>
                <ClipboardCopy size={14} />复制纪要
              </button>
              <button type="button" className="button button-secondary" onClick={() => downloadMarkdown(`会议纪要-${result.title}.md`, markdown)}>
                <Download size={14} />导出 Markdown
              </button>
            </div>
          </div>
          <div className="meeting-body">
            <h3 className="meeting-subtitle">决议（{result.decisions.length} 条）</h3>
            {result.decisions.length === 0 ? (
              <p className="form-hint">未识别到明确决议。</p>
            ) : (
              <ol className="meeting-plain-list">
                {result.decisions.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ol>
            )}

            <h3 className="meeting-subtitle">待办（{result.todos.length} 条）</h3>
            {result.todos.length === 0 ? (
              <p className="form-hint">未识别到待办。</p>
            ) : (
              <div className="meeting-table-wrap">
                <table className="meeting-table">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>待办</th>
                      <th>负责人</th>
                      <th>期限</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.todos.map((todo, index) => (
                      <tr key={`${todo.task}-${index}`}>
                        <td>{index + 1}</td>
                        <td>{todo.task}</td>
                        <td>{todo.owner}</td>
                        <td>{todo.due}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <h3 className="meeting-subtitle">风险与未决事项（{result.risks.length} 条）</h3>
            {result.risks.length === 0 ? (
              <p className="form-hint">未识别到风险提示。</p>
            ) : (
              <ul className="meeting-plain-list">
                {result.risks.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            )}
            {result.nextMeeting && <p className="form-hint">下次会议：{result.nextMeeting}</p>}
            <p className="meeting-note">{MEETING_NOTE}</p>
          </div>
        </div>
      )}

      <div className="console-card">
        <div className="console-card-header">
          <div>
            <h2>纪要留档</h2>
            <p>只存标题、时间与条数（最多 20 条），不存转写全文</p>
          </div>
        </div>
        <div className="meeting-body">
          {history.length === 0 ? (
            <p className="form-hint">还没有纪要记录。</p>
          ) : (
            <ul className="meeting-history">
              {history.map((row) => (
                <li key={row.id}>
                  <span className="meeting-history-time">{new Date(row.at).toLocaleString("zh-CN", { hour12: false })}</span>
                  <strong>{row.title}</strong>
                  <span>决议 {row.decisionCount} · 待办 {row.todoCount}{row.demo ? " · 演示" : ""}</span>
                  <button type="button" className="text-link" onClick={() => setHistory(removeMeetingRecord(row.id))}>
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
