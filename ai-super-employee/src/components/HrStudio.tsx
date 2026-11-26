import { friendlyError } from "../cloud/friendlyError";
import { useMemo, useState } from "react";
import { Briefcase, ClipboardCopy, Download, LoaderCircle, Plus, Save, Trash2, Upload, UserSearch } from "lucide-react";
import {
  HR_NOTE,
  INTERVIEW_VERDICTS,
  JOB_STATUSES,
  createJob,
  exportHrMarkdown,
  generateInterviewQuestions,
  loadInterviews,
  loadJobs,
  loadResumeRecords,
  normalizeJob,
  parseResume,
  saveInterviews,
  saveJobs,
  saveResumeRecord,
  toResumeRecord,
  validateInterview,
  validateJob,
  type InterviewRecord,
  type InterviewVerdict,
  type JobPosting,
  type JobStatus,
  type ResumeParse,
  type ResumeSummaryRecord,
} from "../cloud/hr";
import { DOC_ACCEPT, extractDocumentText } from "../cloud/docparse";

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

function splitLines(text: string): string[] {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

/**
 * AI 人事：岗位管理 / 简历解析 / 面试题与面试记录。
 * 招聘平台直连后置；简历全文不留档，只存解析摘要。
 */
export function HrStudio() {
  const [jobs, setJobs] = useState<JobPosting[]>(() => loadJobs());
  const [resumes, setResumes] = useState<ResumeSummaryRecord[]>(() => loadResumeRecords());
  const [interviews, setInterviews] = useState<InterviewRecord[]>(() => loadInterviews());
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  // 岗位表单
  const [editingJob, setEditingJob] = useState<JobPosting | null>(null);
  const [jobRequirementsText, setJobRequirementsText] = useState("");
  const [jobResponsibilitiesText, setJobResponsibilitiesText] = useState("");

  // 简历解析
  const [selectedJobId, setSelectedJobId] = useState("");
  const [resumeText, setResumeText] = useState("");
  const [parseBusy, setParseBusy] = useState(false);
  const [lastParse, setLastParse] = useState<ResumeParse | null>(null);
  const [questions, setQuestions] = useState<string[]>([]);
  const [questionBusy, setQuestionBusy] = useState(false);

  // 面试记录表单
  const [interviewForm, setInterviewForm] = useState({ candidate: "", score: "80", notes: "", verdict: "待定" as InterviewVerdict });

  const selectedJob = useMemo(() => jobs.find((row) => row.id === selectedJobId) ?? jobs.find((row) => row.status === "招聘中") ?? null, [jobs, selectedJobId]);

  const persistJobs = (next: JobPosting[]) => {
    setJobs(next);
    saveJobs(next);
  };

  const openNewJob = () => {
    const job = createJob("");
    setEditingJob(job);
    setJobRequirementsText("");
    setJobResponsibilitiesText("");
    setError("");
  };

  const openEditJob = (job: JobPosting) => {
    setEditingJob({ ...job });
    setJobRequirementsText(job.requirements.join("\n"));
    setJobResponsibilitiesText(job.responsibilities.join("\n"));
    setError("");
  };

  const saveEditingJob = () => {
    if (!editingJob) return;
    const candidate: JobPosting = {
      ...editingJob,
      requirements: splitLines(jobRequirementsText),
      responsibilities: splitLines(jobResponsibilitiesText),
    };
    const validation = validateJob(candidate, jobs);
    if (!validation.ok) {
      setError(validation.errors.join("；"));
      return;
    }
    const normalized = normalizeJob(candidate);
    if (!normalized) {
      setError("岗位信息不完整，请检查标题。");
      return;
    }
    const exists = jobs.some((row) => row.id === normalized.id);
    persistJobs(exists ? jobs.map((row) => (row.id === normalized.id ? normalized : row)) : [...jobs, normalized]);
    setEditingJob(null);
    setError("");
    setNotice(exists ? "岗位已更新" : "岗位已添加");
  };

  const [resumeParsing, setResumeParsing] = useState(false);

  const readResumeFile = async (file: File | undefined) => {
    if (!file) return;
    setResumeParsing(true);
    try {
      const doc = await extractDocumentText(file);
      setResumeText(doc.text);
      setNotice(
        doc.truncated
          ? `已解析 ${file.name}（共 ${doc.totalChars} 字，取前 ${doc.text.length} 字）`
          : `已解析 ${file.name}（${doc.text.length} 字）`,
      );
      setError("");
    } catch (err) {
      setError(err instanceof Error ? friendlyError(err) : "文件解析失败，请改用粘贴文本");
    } finally {
      setResumeParsing(false);
    }
  };

  const runParse = async () => {
    if (!resumeText.trim()) {
      setError("请先粘贴简历文本，或读取一个简历文件。");
      return;
    }
    setParseBusy(true);
    setError("");
    setNotice("");
    try {
      const parsed = await parseResume({ job: selectedJob, resumeText });
      setLastParse(parsed);
      setResumes(saveResumeRecord(toResumeRecord(parsed, selectedJob?.title ?? "")));
      setNotice(parsed.demo ? "已完成演示解析（启发式抽取）" : "解析完成");
    } catch (err) {
      setError(err instanceof Error ? friendlyError(err) : "解析失败，请重试");
    } finally {
      setParseBusy(false);
    }
  };

  const runQuestions = async () => {
    setQuestionBusy(true);
    setError("");
    try {
      const generated = await generateInterviewQuestions({ job: selectedJob, resumeSummary: lastParse?.summary ?? "" });
      setQuestions(generated);
      setNotice("面试题已生成");
    } catch (err) {
      setError(err instanceof Error ? friendlyError(err) : "面试题生成失败，请重试");
    } finally {
      setQuestionBusy(false);
    }
  };

  const addInterview = () => {
    const candidate: InterviewRecord = {
      id: `interview-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      candidate: interviewForm.candidate.trim(),
      jobTitle: selectedJob?.title ?? "未指定岗位",
      score: Number(interviewForm.score) || 0,
      notes: interviewForm.notes.trim(),
      verdict: interviewForm.verdict,
      at: Date.now(),
    };
    const validation = validateInterview(candidate, interviews);
    if (!validation.ok) {
      setError(validation.errors.join("；"));
      return;
    }
    const next = [candidate, ...interviews];
    setInterviews(next);
    saveInterviews(next);
    setInterviewForm({ candidate: "", score: "80", notes: "", verdict: "待定" });
    setError("");
    setNotice("面试记录已添加");
  };

  const removeInterview = (id: string) => {
    const next = interviews.filter((row) => row.id !== id);
    setInterviews(next);
    saveInterviews(next);
    setNotice("面试记录已删除");
  };

  const markdown = exportHrMarkdown({ jobs, resumes, interviews, lastParse });

  return (
    <section className="hr-page">
      <div className="console-card hr-head">
        <div>
          <h2>
            <UserSearch size={16} /> AI 人事
          </h2>
          <p>岗位管理、简历初筛（匹配分+亮点+风险）、面试题与面试记录。</p>
          <p className="hr-note">{HR_NOTE}简历全文不留档，只保存解析摘要。</p>
        </div>
        <div className="hr-stats">
          <span>{jobs.filter((row) => row.status === "招聘中").length} 个招聘中岗位</span>
          <span>{interviews.length} 条面试记录</span>
        </div>
      </div>

      {error && <p className="form-error hr-banner">{error}</p>}
      {notice && <p className="hr-notice">{notice}</p>}

      <div className="console-card">
        <div className="console-card-header">
          <div>
            <h2>岗位管理</h2>
            <p>本机留档（上限 30 个），招聘平台直连后置</p>
          </div>
          <button type="button" className="button button-primary" onClick={openNewJob}>
            <Plus size={14} />新建岗位
          </button>
        </div>
        <div className="hr-body">
          {editingJob && (
            <div className="hr-form">
              <label>
                <span>岗位标题 *</span>
                <input value={editingJob.title} onChange={(event) => setEditingJob({ ...editingJob, title: event.target.value })} placeholder="如：新媒体运营" />
              </label>
              <label>
                <span>部门</span>
                <input value={editingJob.dept} onChange={(event) => setEditingJob({ ...editingJob, dept: event.target.value })} placeholder="如：市场部" />
              </label>
              <label>
                <span>状态</span>
                <select value={editingJob.status} onChange={(event) => setEditingJob({ ...editingJob, status: event.target.value as JobStatus })}>
                  {JOB_STATUSES.map((item) => (
                    <option key={item} value={item}>{item}</option>
                  ))}
                </select>
              </label>
              <label className="hr-form-wide">
                <span>任职要求（每行一条）</span>
                <textarea rows={3} value={jobRequirementsText} onChange={(event) => setJobRequirementsText(event.target.value)} placeholder={"熟悉抖音/小红书运营\n2年以上相关经验"} />
              </label>
              <label className="hr-form-wide">
                <span>岗位职责（每行一条）</span>
                <textarea rows={3} value={jobResponsibilitiesText} onChange={(event) => setJobResponsibilitiesText(event.target.value)} placeholder={"负责账号内容规划与发布\n跟进线索转化"} />
              </label>
              <div className="hr-form-actions">
                <button type="button" className="button button-primary" onClick={saveEditingJob}>
                  <Save size={14} />保存岗位
                </button>
                <button type="button" className="button button-secondary" onClick={() => setEditingJob(null)}>取消</button>
              </div>
            </div>
          )}
          {jobs.length === 0 ? (
            <p className="form-hint">还没有岗位，先新建一个。</p>
          ) : (
            <ul className="hr-job-list">
              {jobs.map((job) => (
                <li key={job.id} className={job.status === "已关闭" ? "disabled" : ""}>
                  <div className="hr-job-info">
                    <strong>
                      <Briefcase size={13} />{job.title}
                      <em className="hr-status-badge">{job.status}</em>
                    </strong>
                    <span>{job.dept || "部门未填"} · 要求 {job.requirements.length} 条 · 职责 {job.responsibilities.length} 条</span>
                  </div>
                  <button type="button" className="text-link" onClick={() => openEditJob(job)}>编辑</button>
                  <button type="button" className="text-link" onClick={() => { persistJobs(jobs.filter((row) => row.id !== job.id)); setNotice("岗位已删除"); }}>
                    <Trash2 size={13} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="console-card">
        <div className="console-card-header">
          <div>
            <h2>简历解析</h2>
            <p>粘贴简历文本或读取 .txt/.md/.docx/.pdf 文件（最大 5MB），按所选岗位给出匹配分与依据（简历全文不留档）</p>
          </div>
        </div>
        <div className="hr-body">
          <div className="hr-form">
            <label>
              <span>目标岗位</span>
              <select value={selectedJob?.id ?? ""} onChange={(event) => setSelectedJobId(event.target.value)}>
                <option value="">未指定（通用初筛）</option>
                {jobs.map((job) => (
                  <option key={job.id} value={job.id}>{job.title}</option>
                ))}
              </select>
            </label>
            <label className="hr-file">
              <span>读取简历文件{resumeParsing ? "（解析中…）" : ""}</span>
              <span className="hr-file-row">
                {resumeParsing ? <LoaderCircle size={14} className="spin" /> : <Upload size={14} />}
                <input type="file" accept={DOC_ACCEPT} disabled={resumeParsing} onChange={(event) => void readResumeFile(event.target.files?.[0])} />
              </span>
            </label>
          </div>
          <label className="hr-text">
            <span>简历文本 *</span>
            <textarea rows={8} value={resumeText} onChange={(event) => setResumeText(event.target.value)} placeholder="把简历正文粘贴到这里…" />
          </label>
          <div className="hr-actions">
            <button type="button" className="button button-primary" onClick={() => void runParse()} disabled={parseBusy}>
              {parseBusy ? <LoaderCircle size={14} className="spin" /> : <UserSearch size={14} />}
              {parseBusy ? "解析中…" : "解析简历"}
            </button>
            <button type="button" className="button button-secondary" onClick={() => void runQuestions()} disabled={questionBusy}>
              {questionBusy ? <LoaderCircle size={14} className="spin" /> : null}
              {questionBusy ? "生成中…" : "生成面试题"}
            </button>
            <span className="hr-char-count">{resumeText.trim().length} 字</span>
          </div>

          {lastParse && (
            <div className="hr-parse-result">
              <h3 className="hr-subtitle">{lastParse.name} · 约 {lastParse.years} 年 · 匹配分 {lastParse.matchScore}{lastParse.demo ? "（演示解析）" : ""}</h3>
              <p>{lastParse.summary}</p>
              <p className="hr-reason">匹配依据：{lastParse.matchReason || "（无）"}</p>
              <p>技能：{lastParse.skills.join("、") || "未识别"}</p>
              <h4 className="hr-mini-title">亮点</h4>
              {lastParse.highlights.length ? (
                <ul className="hr-plain-list">{lastParse.highlights.map((item) => <li key={item}>{item}</li>)}</ul>
              ) : (
                <p className="form-hint">未检出明确亮点。</p>
              )}
              <h4 className="hr-mini-title">需面试核实</h4>
              {lastParse.risks.length ? (
                <ul className="hr-plain-list">{lastParse.risks.map((item) => <li key={item}>{item}</li>)}</ul>
              ) : (
                <p className="form-hint">暂无明显疑点（仍需面试核实）。</p>
              )}
            </div>
          )}

          {questions.length > 0 && (
            <div>
              <h3 className="hr-subtitle">面试题（{questions.length} 题）</h3>
              <ol className="hr-plain-list">
                {questions.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ol>
            </div>
          )}
        </div>
      </div>

      <div className="console-card">
        <div className="console-card-header">
          <div>
            <h2>面试记录</h2>
            <p>录入评分与结论（上限 50 条），汇总可导出</p>
          </div>
          <div className="hr-actions">
            <button type="button" className="button button-secondary" onClick={() => void copyText(markdown).then((ok) => setNotice(ok ? "汇总已复制" : "复制失败，请用导出"))}>
              <ClipboardCopy size={14} />复制汇总
            </button>
            <button type="button" className="button button-secondary" onClick={() => downloadMarkdown("AI人事汇总.md", markdown)}>
              <Download size={14} />导出 Markdown
            </button>
          </div>
        </div>
        <div className="hr-body">
          <div className="hr-form">
            <label>
              <span>候选人 *</span>
              <input value={interviewForm.candidate} onChange={(event) => setInterviewForm({ ...interviewForm, candidate: event.target.value })} placeholder="姓名" />
            </label>
            <label>
              <span>评分（0-100）</span>
              <input type="number" min={0} max={100} value={interviewForm.score} onChange={(event) => setInterviewForm({ ...interviewForm, score: event.target.value })} />
            </label>
            <label>
              <span>结论</span>
              <select value={interviewForm.verdict} onChange={(event) => setInterviewForm({ ...interviewForm, verdict: event.target.value as InterviewVerdict })}>
                {INTERVIEW_VERDICTS.map((item) => (
                  <option key={item} value={item}>{item}</option>
                ))}
              </select>
            </label>
            <label className="hr-form-wide">
              <span>备注</span>
              <input value={interviewForm.notes} onChange={(event) => setInterviewForm({ ...interviewForm, notes: event.target.value })} placeholder="面试要点、待核实事项" />
            </label>
            <div className="hr-form-actions">
              <button type="button" className="button button-primary" onClick={addInterview}>
                <Plus size={14} />添加记录（岗位：{selectedJob?.title ?? "未指定岗位"}）
              </button>
            </div>
          </div>
          {interviews.length === 0 ? (
            <p className="form-hint">还没有面试记录。</p>
          ) : (
            <div className="hr-table-wrap">
              <table className="hr-table">
                <thead>
                  <tr>
                    <th>候选人</th>
                    <th>岗位</th>
                    <th>评分</th>
                    <th>结论</th>
                    <th>备注</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {interviews.map((row) => (
                    <tr key={row.id}>
                      <td>{row.candidate}</td>
                      <td>{row.jobTitle}</td>
                      <td>{row.score}</td>
                      <td>{row.verdict}</td>
                      <td>{row.notes}</td>
                      <td>
                        <button type="button" className="text-link" onClick={() => removeInterview(row.id)}>
                          <Trash2 size={13} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="hr-note">{HR_NOTE}</p>
        </div>
      </div>
    </section>
  );
}
