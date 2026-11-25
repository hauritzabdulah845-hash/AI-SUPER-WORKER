import { askLLM} from "./runner";

/**
* AI 人事能力层（域 10 AI 人事）：
* 岗位管理 / 简历解析（匹配分） / 面试题生成 / 面试记录。
*
* 纪律（写进提示词，也写进界面文案）：
* - 简历解析只基于简历原文，不编造学历/公司/经历；匹配分必须说明依据。
* - 零 Key 降级：启发式抽取（技能词典、年限正则、姓名首行）+ 模板题库，demo 标注。
* - 隐私：简历全文不留档，只存解析摘要；面试记录只存结论与评分摘要。
* - 招聘平台直连后置，当前支持粘贴文本与本地文件（.txt/.md/.docx/.pdf，解析见 docparse.ts）。
*/

export const HR_NOTE = "招聘平台直连后置，当前支持粘贴文本与本地文件（.txt/.md/.docx/.pdf）；解析结论仅供初筛，需面试核实。";

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

function clip(text: string, max: number): string {
const value = text.trim();
return value.length > max? `${value.slice(0, max)}…`: value;
}

function cleanLine(text: string): string {
return String(text?? "").replace(/\s+/g, " ").trim();
}

function newId(prefix: string): string {
return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function clampScore(value: unknown, fallback = 50): number {
const num = Number(value);
if (!Number.isFinite(num)) return fallback;
return Math.max(0, Math.min(100, Math.round(num)));
}

/* ---------------------------------- 岗位 ---------------------------------- */

export const JOB_STATUSES = ["招聘中", "已关闭"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export interface JobPosting {
id: string;
title: string;
dept: string;
requirements: string[];
responsibilities: string[];
status: JobStatus;
}

export const MAX_JOBS = 30;
const JOBS_KEY = "ai-employee:jobs";

export function createJob(title: string): JobPosting {
return { id: newId("job"), title: title.trim().slice(0, 40), dept: "", requirements: [], responsibilities: [], status: "招聘中"};
}

function normalizeStringList(input: unknown, maxItems: number, maxLen: number): string[] {
const rows = Array.isArray(input)? input: [];
return [...new Set(rows.map((item) => cleanLine(String(item)).slice(0, maxLen)).filter(Boolean))].slice(0, maxItems);
}

/** 归一化一条岗位记录。缺 id/标题返回 null。 */
export function normalizeJob(input: Partial<JobPosting> | null | undefined): JobPosting | null {
if (!input) return null;
const id = String(input.id?? "").trim();
const title = cleanLine(input.title?? "").slice(0, 40);
if (!id ||!title) return null;
const status = (JOB_STATUSES as readonly string[]).includes(String(input.status))? (input.status as JobStatus): "招聘中";
return {
id,
title,
dept: cleanLine(input.dept?? "").slice(0, 30),
requirements: normalizeStringList(input.requirements, 12, 120),
responsibilities: normalizeStringList(input.responsibilities, 12, 120),
status,
};
}

export interface JobValidation {
ok: boolean;
errors: string[];
}

/** 岗位校验：标题必填、状态白名单、要求/职责条数与长度上限、满员拦截新增。 */
export function validateJob(candidate: Partial<JobPosting>, existing: JobPosting[] = []): JobValidation {
const errors: string[] = [];
const title = cleanLine(candidate.title?? "");
if (!title) errors.push("岗位标题不能为空");
if (title.length > 40) errors.push("岗位标题不超过 40 字");
if (!(JOB_STATUSES as readonly string[]).includes(String(candidate.status?? "招聘中"))) errors.push("状态必须是招聘中 / 已关闭");
if (normalizeStringList(candidate.requirements, 99, 999).length > 12) errors.push("任职要求不超过 12 条");
if (normalizeStringList(candidate.responsibilities, 99, 999).length > 12) errors.push("岗位职责不超过 12 条");
if (existing.length >= MAX_JOBS &&!existing.some((row) => row.id === candidate.id)) errors.push(`岗位已达上限 ${MAX_JOBS} 个`);
return { ok: errors.length === 0, errors};
}

export function loadJobs(): JobPosting[] {
try {
const raw = localStorage.getItem(JOBS_KEY);
if (!raw) return [];
const parsed = JSON.parse(raw) as unknown;
if (!Array.isArray(parsed)) return [];
return parsed.map((row) => normalizeJob(row as Partial<JobPosting>)).filter((row): row is JobPosting => Boolean(row)).slice(0, MAX_JOBS);
} catch {
return [];
}
}

export function saveJobs(jobs: JobPosting[]): JobPosting[] {
const next = jobs.map((row) => normalizeJob(row)).filter((row): row is JobPosting => Boolean(row)).slice(0, MAX_JOBS);
try {
localStorage.setItem(JOBS_KEY, JSON.stringify(next));
} catch {
/* 节点测试环境无 localStorage / 隐私模式写失败不影响主流程 */
}
return next;
}

/* ------------------------------- 简历解析 ------------------------------- */

export interface ResumeParse {
name: string;
years: number;
skills: string[];
highlights: string[];
risks: string[];
matchScore: number;
/** 匹配分依据说明（纪律：分数必须可解释） */
matchReason: string;
summary: string;
demo?: boolean;
}

/** 归一化简历解析结果：年限夹紧、分数夹紧、列表去重封顶。 */
export function normalizeResumeParse(input: Partial<ResumeParse> | null | undefined): ResumeParse {
const yearsNum = Number(input?.years);
return {
name: cleanLine(input?.name?? "").slice(0, 20) || "未识别",
years: Number.isFinite(yearsNum)? Math.max(0, Math.min(50, Math.round(yearsNum * 10) / 10)): 0,
skills: normalizeStringList(input?.skills, 15, 40),
highlights: normalizeStringList(input?.highlights, 8, 160),
risks: normalizeStringList(input?.risks, 8, 160),
matchScore: clampScore(input?.matchScore),
matchReason: cleanLine(input?.matchReason?? "").slice(0, 240),
summary: cleanLine(input?.summary?? "").slice(0, 400),
demo: input?.demo === true,
};
}

const SKILL_DICTIONARY = [
"JavaScript", "TypeScript", "React", "Vue", "Python", "Java", "Go", "Node.js", "SQL", "MySQL",
"Excel", "PPT", "Word", "Photoshop", "Figma", "Premiere", "剪辑", "文案", "运营", "销售",
"客服", "产品经理", "项目管理", "数据分析", "英语", "日语", "抖音", "小红书", "直播", "电商",
"招聘", "培训", "财务", "会计", "法务", "设计", "市场推广", "新媒体", "社群", "CRM",
];

/** 启发式抽技能：词典命中（英文大小写不敏感）。 */
export function extractSkills(text: string): string[] {
const body = String(text?? "");
const lower = body.toLowerCase();
return SKILL_DICTIONARY.filter((skill) => lower.includes(skill.toLowerCase())).slice(0, 15);
}

/** 启发式抽年限：取「X年」最大值（如「5年经验」「工作3年」），无命中返回 0。 */
export function extractYears(text: string): number {
const matches = [...String(text?? "").matchAll(/(\d+(?:\.\d+)?)\s*年/g)].map((match) => Number(match[1])).filter((num) => Number.isFinite(num) && num <= 50);
return matches.length? Math.max(...matches): 0;
}

/** 启发式抽姓名：首行 2-8 字中文或分隔符前段，猜不到返回未识别。 */
export function extractName(text: string): string {
const firstLine = String(text?? "").split(/\r?\n/).map((line) => line.trim()).find(Boolean)?? "";
const head = firstLine.split(/[|｜,，\s]/)[0]?.trim()?? "";
if (/^[\u4e00-\u9fa5]{2,8}$/.test(head)) return head;
const labeled = String(text?? "").match(/姓名[：:]\s*([\u4e00-\u9fa5]{2,8})/);
return labeled? labeled[1]: "未识别";
}

/**
* 启发式匹配分：有岗位要求时按技能重合率计分，无岗位时按信息完整度计分。
* 纯函数可测，分数 0-100 夹紧，并给出依据说明。
*/
export function computeMatchScore(skills: string[], years: number, job?: JobPosting | null, textLength = 0): { score: number; reason: string} {
if (job && (job.requirements.length || job.title)) {
const jobText = `${job.title} ${job.requirements.join(" ")}`.toLowerCase();
const wanted = SKILL_DICTIONARY.filter((skill) => jobText.includes(skill.toLowerCase()));
if (wanted.length) {
const hit = wanted.filter((skill) => skills.some((own) => own.toLowerCase() === skill.toLowerCase()));
const score = clampScore(Math.round((hit.length / wanted.length) * 80) + (years >= 3? 20: years >= 1? 10: 0));
return { score, reason: `岗位技能 ${wanted.length} 项命中 ${hit.length} 项（${hit.join("、") || "无"}），年限 ${years} 年。演示口径，需面试核实。`};
}
}
const score = clampScore(30 + Math.min(40, skills.length * 5) + (years >= 3? 20: years >= 1? 10: 0) + (textLength >= 300? 10: 0));
return { score, reason: `未指定岗位要求，按信息完整度估算：技能 ${skills.length} 项、年限 ${years} 年。演示口径，需面试核实。`};
}

/** 启发式简历解析（零 Key 降级）：词典+正则抽取，亮点取含成果词的句子。 */
export function heuristicParseResume(resumeText: string, job?: JobPosting | null): ResumeParse {
const body = String(resumeText?? "").trim();
if (!body) throw new Error("请先粘贴简历文本，解析需要原文。");
const skills = extractSkills(body);
const years = extractYears(body);
const name = extractName(body);
const sentences = body.split(/[。；;\n]/).map((item) => cleanLine(item)).filter((item) => item.length >= 6);
const highlights = sentences.filter((item) => /负责|主导|提升|增长|完成|达成|%|万/.test(item)).slice(0, 8);
const risks: string[] = [];
if (!years) risks.push("未检出工作年限表述，面试需核实经历时间线");
if (skills.length < 3) risks.push("可识别技能较少，需在面试中深挖实际能力");
if (body.length < 200) risks.push("简历内容较短，信息完整度不足");
if (name === "未识别") risks.push("未识别到姓名，请人工核对简历抬头");
const { score, reason} = computeMatchScore(skills, years, job, body.length);
return normalizeResumeParse({
name,
years,
skills,
highlights: highlights.length? highlights: sentences.slice(0, 3),
risks,
matchScore: score,
matchReason: reason,
summary: `演示解析（启发式抽取）：${name}，约 ${years} 年经验，识别技能 ${skills.length} 项。仅供初筛，需面试核实。`,
demo: true,
});
}

const RESUME_SYSTEM = [
"你是招聘初筛助手。基于用户提供的简历原文输出结构化 JSON 解析。",
"硬性纪律：",
"1. 只基于简历原文，禁止编造学历、公司、项目经历；原文没有的写「未提及」或留空。",
"2. matchScore 必须给出依据（matchReason 写清命中了哪些岗位要求、缺哪些），不许只给分不解释。",
"3. risks 写需要面试核实的疑点（如时间线不清、技能只有名词没有成果），不要做歧视性判断。",
"只输出 JSON：",
'{"name":"姓名，未识别写未识别","years":工作年限数字,"skills":["技能"],"highlights":["亮点"],"risks":["需核实项"],"matchScore":0-100,"matchReason":"120字内依据","summary":"200字内摘要"}',
].join("\n");

/** 简历解析主入口：优先 askLLM，失败降级启发式（demo 标注）。 */
export async function parseResume(input: { job?: JobPosting | null; resumeText: string; signal?: AbortSignal}): Promise<ResumeParse> {
const body = clip(String(input.resumeText?? ""), 12000);
if (!body) throw new Error("请先粘贴简历文本，解析需要原文。");
const job = input.job?? null;
try {
const { text} = await askLLM(
[
{ role: "system", content: RESUME_SYSTEM},
{
role: "user",
content: [
job? `目标岗位：${job.title}（${job.dept || "部门未填"}）`: "目标岗位：（未指定，按通用初筛）",
job?.requirements.length? `岗位要求：${job.requirements.join("；")}`: "",
"",
"=== 简历原文 ===",
body,
].filter(Boolean).join("\n"),
},
],
{ json: true, signal: input.signal},
);
const parsed = parseJson<Partial<ResumeParse>>(text);
if (!parsed || typeof parsed.matchScore!== "number") throw new Error("简历解析结果解析失败");
return normalizeResumeParse({...parsed, demo: false});
} catch {
return heuristicParseResume(body, job);
}
}

/* ------------------------------- 面试 ------------------------------- */

export const INTERVIEW_VERDICTS = ["通过", "待定", "不通过"] as const;
export type InterviewVerdict = (typeof INTERVIEW_VERDICTS)[number];

export interface InterviewRecord {
id: string;
candidate: string;
jobTitle: string;
score: number;
notes: string;
verdict: InterviewVerdict;
at: number;
}

export const MAX_INTERVIEWS = 50;
const INTERVIEWS_KEY = "ai-employee:interviews";
const RESUMES_KEY = "ai-employee:resumes";
export const MAX_RESUME_SUMMARIES = 30;

export interface ResumeSummaryRecord {
id: string;
name: string;
jobTitle: string;
matchScore: number;
demo: boolean;
at: number;
}

/** 把一次解析转成留档摘要（不存简历全文）。 */
export function toResumeRecord(parse: ResumeParse, jobTitle: string, at = Date.now()): ResumeSummaryRecord {
return {
id: `resume-${at.toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
name: parse.name.slice(0, 20),
jobTitle: cleanLine(jobTitle).slice(0, 40) || "未指定岗位",
matchScore: parse.matchScore,
demo: parse.demo === true,
at,
};
}

export function loadResumeRecords(): ResumeSummaryRecord[] {
try {
const raw = localStorage.getItem(RESUMES_KEY);
if (!raw) return [];
const parsed = JSON.parse(raw) as unknown;
if (!Array.isArray(parsed)) return [];
return (parsed as ResumeSummaryRecord[]).filter((row) => row && Number.isFinite(row.at)).slice(0, MAX_RESUME_SUMMARIES);
} catch {
return [];
}
}

export function saveResumeRecord(record: ResumeSummaryRecord): ResumeSummaryRecord[] {
const next = [record,...loadResumeRecords()].slice(0, MAX_RESUME_SUMMARIES);
try {
localStorage.setItem(RESUMES_KEY, JSON.stringify(next));
} catch {
/* 同上 */
}
return next;
}

/** 模板题库（降级用）：专业 / 经历深挖 / 风险验证三类，按岗位关键词优先选专业题。 */
const QUESTION_BANK: { category: "专业" | "经历深挖" | "风险验证"; keywords: string[]; question: string}[] = [
{ category: "专业", keywords: ["运营", "新媒体", "抖音", "小红书"], question: "请讲一个你做过的账号/活动案例：目标、打法、数据结果分别是什么？"},
{ category: "专业", keywords: ["销售", "客服"], question: "遇到客户压价或投诉时，你通常怎么处理？请举一个真实例子。"},
{ category: "专业", keywords: ["产品", "项目"], question: "你如何判断一个需求该不该做？请用最近一个项目说明取舍过程。"},
{ category: "专业", keywords: ["开发", "Java", "Python", "React", "前端", "后端"], question: "请讲一个你解决过的最难的技术问题：定位过程和最终方案是什么？"},
{ category: "专业", keywords: ["设计", "剪辑"], question: "请选一个你最满意的作品，讲讲需求、思路和改稿过程。"},
{ category: "专业", keywords: ["数据", "财务", "会计"], question: "你常用的分析/对账方法是什幺？发现数据异常时怎么排查？"},
{ category: "经历深挖", keywords: [], question: "请按时间顺序介绍你的工作经历，每段最主要的成果是什么？"},
{ category: "经历深挖", keywords: [], question: "上一份工作中你最有成就感的一件事是什么？你具体做了什么？"},
{ category: "经历深挖", keywords: [], question: "团队协作中出现分歧时你怎么处理？请举例。"},
{ category: "风险验证", keywords: [], question: "简历里提到的成果数据，口径和统计方式是怎样的？能否现场拆解？"},
{ category: "风险验证", keywords: [], question: "你离开上一家公司的原因是什么？空窗期在做什么？"},
{ category: "风险验证", keywords: [], question: "这个岗位需要快速上手，你入职第一个月打算怎么开展工作？"},
];

/** 模板出题（纯函数）：按岗位标题+要求关键词命中优先，补齐 8 题，顺序确定性。 */
export function templateInterviewQuestions(jobTitle: string, requirements: string[] = []): string[] {
  const haystack = `${jobTitle} ${requirements.join(" ")}`.toLowerCase();
  const matched = QUESTION_BANK.filter((item) => item.keywords.some((word) => haystack.includes(word.toLowerCase())));
  const picked = [...matched];
  const byCategory = (category: string) => QUESTION_BANK.filter((item) => item.category === category && !picked.includes(item));
  const queues = [byCategory("专业"), byCategory("经历深挖"), byCategory("风险验证")];
  let cursor = 0;
  while (picked.length < 8 && queues.some((queue) => queue.length)) {
    const queue = queues[cursor % queues.length];
    const next = queue.shift();
    if (next) picked.push(next);
    cursor += 1;
  }
  return picked.slice(0, 8).map((item) => "[" + item.category + "]" + item.question);
}

const INTERVIEW_SYSTEM = [
"你是面试官助手。基于岗位信息与候选人摘要，生成面试问题清单，输出 JSON。",
"纪律：问题要能验证简历真实性与岗位匹配度，分专业/经历深挖/风险验证三类；不要问与岗位无关的隐私问题。",
'只输出 JSON：{"questions":["[专业]问题","[经历深挖]问题","[风险验证]问题"]}，共 8 条。',
].join("\n");

/** 生成面试题：优先 askLLM，失败降级模板题库（8 题）。 */
export async function generateInterviewQuestions(input: {
job?: JobPosting | null;
resumeSummary?: string;
signal?: AbortSignal;
}): Promise<string[]> {
const job = input.job?? null;
try {
const { text} = await askLLM(
[
{ role: "system", content: INTERVIEW_SYSTEM},
{
role: "user",
content: [
`岗位：${job?.title || "（未指定）"}`,
job?.requirements.length? `要求：${job.requirements.join("；")}`: "",
`候选人摘要：${clip(String(input.resumeSummary?? ""), 2000) || "（未提供）"}`,
].filter(Boolean).join("\n"),
},
],
{ json: true, signal: input.signal},
);
const parsed = parseJson<{ questions?: string[]}>(text);
const questions = normalizeStringList(parsed?.questions, 8, 200);
if (questions.length < 4) throw new Error("面试题生成结果不足");
return questions;
} catch {
return templateInterviewQuestions(job?.title?? "", job?.requirements?? []);
}
}

/** 归一化面试记录。缺候选人返回 null。 */
export function normalizeInterview(input: Partial<InterviewRecord> | null | undefined): InterviewRecord | null {
if (!input) return null;
const candidate = cleanLine(input.candidate?? "").slice(0, 20);
if (!candidate) return null;
const verdict = (INTERVIEW_VERDICTS as readonly string[]).includes(String(input.verdict))? (input.verdict as InterviewVerdict): "待定";
return {
id: String(input.id?? "").trim() || newId("interview"),
candidate,
jobTitle: cleanLine(input.jobTitle?? "").slice(0, 40) || "未指定岗位",
score: clampScore(input.score),
notes: cleanLine(input.notes?? "").slice(0, 300),
verdict,
at: Number.isFinite(input.at)? Number(input.at): Date.now(),
};
}

export function validateInterview(candidate: Partial<InterviewRecord>, existing: InterviewRecord[] = []): JobValidation {
const errors: string[] = [];
if (!cleanLine(candidate.candidate?? "")) errors.push("候选人不能为空");
if (!(INTERVIEW_VERDICTS as readonly string[]).includes(String(candidate.verdict?? "待定"))) errors.push("结论必须是 通过 / 待定 / 不通过");
const score = Number(candidate.score);
if (!Number.isFinite(score) || score < 0 || score > 100) errors.push("评分须在 0-100 之间");
if (existing.length >= MAX_INTERVIEWS &&!existing.some((row) => row.id === candidate.id)) errors.push(`面试记录已达上限 ${MAX_INTERVIEWS} 条`);
return { ok: errors.length === 0, errors};
}

export function loadInterviews(): InterviewRecord[] {
try {
const raw = localStorage.getItem(INTERVIEWS_KEY);
if (!raw) return [];
const parsed = JSON.parse(raw) as unknown;
if (!Array.isArray(parsed)) return [];
return parsed.map((row) => normalizeInterview(row as Partial<InterviewRecord>)).filter((row): row is InterviewRecord => Boolean(row)).slice(0, MAX_INTERVIEWS);
} catch {
return [];
}
}

export function saveInterviews(records: InterviewRecord[]): InterviewRecord[] {
const next = records.map((row) => normalizeInterview(row)).filter((row): row is InterviewRecord => Boolean(row)).slice(0, MAX_INTERVIEWS);
try {
localStorage.setItem(INTERVIEWS_KEY, JSON.stringify(next));
} catch {
/* 同上 */
}
return next;
}

/* ------------------------------- 导出 ------------------------------- */

/** 人事汇总导出 Markdown：岗位 + 候选人摘要 + 面试记录。 */
export function exportHrMarkdown(input: {
jobs: JobPosting[];
resumes: ResumeSummaryRecord[];
interviews: InterviewRecord[];
lastParse?: ResumeParse | null;
}): string {
const lines: string[] = ["# AI 人事汇总", ""];
lines.push(`导出时间：${new Date().toLocaleString("zh-CN", { hour12: false})}`);
lines.push(`> ${HR_NOTE}`, "");
lines.push(`## 岗位（${input.jobs.length} 个）`, "");
if (!input.jobs.length) lines.push("暂无岗位。", "");
input.jobs.forEach((job) => {
lines.push(`### ${job.title}${job.dept? ` · ${job.dept}`: ""}（${job.status}）`, "");
if (job.requirements.length) lines.push(`- 要求：${job.requirements.join("；")}`);
if (job.responsibilities.length) lines.push(`- 职责：${job.responsibilities.join("；")}`);
lines.push("");
});
if (input.lastParse) {
const parse = input.lastParse;
lines.push("## 最近一次简历解析", "");
lines.push(`- 候选人：${parse.name} · 约 ${parse.years} 年 · 匹配分 ${parse.matchScore}${parse.demo? "（演示解析）": ""}`);
lines.push(`- 技能：${parse.skills.join("、") || "未识别"}`);
lines.push(`- 依据：${parse.matchReason || "（无）"}`);
lines.push(`- 摘要：${parse.summary}`, "");
}
lines.push(`## 候选人摘要留档（${input.resumes.length} 条，不含简历全文）`, "");
input.resumes.forEach((row) => lines.push(`- ${row.name} · ${row.jobTitle} · 匹配分 ${row.matchScore}${row.demo? " · 演示": ""} · ${new Date(row.at).toLocaleString("zh-CN", { hour12: false})}`));
if (input.resumes.length) lines.push("");
lines.push(`## 面试记录（${input.interviews.length} 条）`, "");
if (input.interviews.length) {
lines.push("| 候选人 | 岗位 | 评分 | 结论 | 备注 |", "|---|---|---|---|---|");
input.interviews.forEach((row) => lines.push(`| ${row.candidate} | ${row.jobTitle} | ${row.score} | ${row.verdict} | ${row.notes} |`));
lines.push("");
} else {
lines.push("暂无面试记录。", "");
}
lines.push("---", HR_NOTE);
return lines.join("\n");
}
