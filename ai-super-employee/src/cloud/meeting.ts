import { askLLM } from "./runner";

/**
 * AI 会议能力层（域 09 AI 会议）：
 * 粘贴转写文本 → 结构化纪要（摘要 / 决议 / 待办 / 风险）。
 *
 * 纪律（写进提示词，也写进界面文案）：
 * - 只基于原文，不编造人名/日期；原文没有的负责人/期限一律写「待定」。
 * - 决议与待办分开；待办必须带负责人（缺失标待定，不猜）。
 * - 零 Key 降级：模型不可用时走启发式抽取（demo 标注），保证永远有交付物。
 * - 留档只存标题/时间/决议数/待办数，不存转写全文（隐私）。
 * - 平台录音转写接入后置，当前是粘贴文本版。
 */

export interface MeetingTodo {
  task: string;
  owner: string;
  due: string;
}

export interface MeetingMinutes {
  title: string;
  summary: string;
  decisions: string[];
  todos: MeetingTodo[];
  risks: string[];
  nextMeeting?: string;
  /** true = 启发式演示纪要（模型不可用时的降级产出） */
  demo?: boolean;
}

export const MEETING_NOTE = "平台录音转写接入后置，当前为粘贴文本版；纪要需参会人确认后使用。";

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
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function cleanLine(text: string): string {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

/** 结果归一化：字段限长、条数封顶、待办负责人/期限缺失标待定。 */
export function normalizeMinutes(input: Partial<MeetingMinutes> | null | undefined, fallbackTitle = ""): MeetingMinutes {
  const todos = (Array.isArray(input?.todos) ? input.todos : [])
    .map((todo) => ({
      task: cleanLine(todo?.task ?? "").slice(0, 120),
      owner: cleanLine(todo?.owner ?? "").slice(0, 20) || "待定",
      due: cleanLine(todo?.due ?? "").slice(0, 30) || "待定",
    }))
    .filter((todo) => todo.task)
    .slice(0, 15);
  return {
    title: cleanLine(input?.title ?? "").slice(0, 60) || cleanLine(fallbackTitle).slice(0, 60) || "未命名会议",
    summary: cleanLine(input?.summary ?? "").slice(0, 400),
    decisions: [...new Set((Array.isArray(input?.decisions) ? input.decisions : []).map((item) => cleanLine(item).slice(0, 160)).filter(Boolean))].slice(0, 10),
    todos,
    risks: [...new Set((Array.isArray(input?.risks) ? input.risks : []).map((item) => cleanLine(item).slice(0, 160)).filter(Boolean))].slice(0, 8),
    nextMeeting: cleanLine(input?.nextMeeting ?? "").slice(0, 60) || undefined,
    demo: input?.demo === true,
  };
}

/* ------------------------------ 启发式抽取 ------------------------------ */

export interface SpeakerLine {
  speaker: string;
  content: string;
}

/**
 * 解析说话人行：「张三：……」/「张三: ……」冒号前 1-12 字视为说话人。
 * 无冒号的行 speaker 为空串，content 为整行。
 */
export function parseSpeakerLines(text: string): SpeakerLine[] {
  return String(text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^([^：:，,。；;]{1,12})[：:]\s*(.+)$/);
      if (match) return { speaker: match[1].trim(), content: match[2].trim() };
      return { speaker: "", content: line };
    });
}

/** 按句切分（中文句号/分号/换行），供决议与待办抽取共用。 */
function splitSentences(text: string): string[] {
  return String(text ?? "")
    .split(/[。；;\n]/)
    .map((item) => cleanLine(item.replace(/^[^：:]{1,12}[：:]/, "")))
    .filter((item) => item.length >= 4);
}

const DECISION_WORDS = ["决定", "决议", "同意", "确认", "通过", "就这么定", "定下来"];
const TODO_WORDS = ["负责", "跟进", "完成", "提交", "待办", "下周", "截止", "需要", "记得", "安排"];
const RISK_WORDS = ["风险", "延期", "预算", "人手不足", "卡点", "来不及", "不确定", "担心"];

/** 抽取决议句：含决议词的句子，去重封顶。 */
export function extractDecisions(text: string): string[] {
  const found = splitSentences(text).filter((sentence) => DECISION_WORDS.some((word) => sentence.includes(word)));
  return [...new Set(found.map((item) => item.slice(0, 160)))].slice(0, 10);
}

const DUE_PATTERN = /(下周[一二三四五六日天]?|本周[一二三四五六日天]?|周[一二三四五六日天]|\d{1,2}月\d{1,2}日|\d{1,2}号|明天|后天|月底|月初)/;

/** 负责人候选黑名单：动词/副词片段不是人名（如「我负责」「上午继续」）。 */
const OWNER_STOPWORDS = ["负责", "跟进", "提交", "完成", "需要", "记得", "安排", "继续", "上午", "下午", "我们", "大家", "会议"];

function isPlausibleOwner(name: string): boolean {
  return Boolean(name) && !OWNER_STOPWORDS.some((word) => name.includes(word));
}

/** 从句子里猜负责人：优先「由X负责」「X负责」「X跟进」，其次说话人。猜不到标待定。 */
function guessOwner(sentence: string, speaker: string): string {
  const byPattern = sentence.match(/由([\u4e00-\u9fa5A-Za-z]{2,6})(?:负责|跟进|来)/);
  if (byPattern && isPlausibleOwner(byPattern[1])) return byPattern[1];
  const direct = sentence.match(/([\u4e00-\u9fa5]{2,4})(?:负责|跟进|提交|完成)/);
  if (direct && isPlausibleOwner(direct[1])) return direct[1];
  if (speaker) return speaker;
  return "待定";
}

function guessDue(sentence: string): string {
  const match = sentence.match(DUE_PATTERN);
  return match ? match[1] : "待定";
}

/** 抽取待办：逐行找待办词，结合说话人推负责人，期限用日期词匹配。 */
export function extractTodos(text: string): MeetingTodo[] {
  const todos: MeetingTodo[] = [];
  const seen = new Set<string>();
  for (const line of parseSpeakerLines(text)) {
    for (const sentence of splitSentences(line.content)) {
      if (!TODO_WORDS.some((word) => sentence.includes(word))) continue;
      if (DECISION_WORDS.some((word) => sentence.includes(word)) && !sentence.includes("负责") && !sentence.includes("跟进")) continue;
      const task = sentence.slice(0, 120);
      if (seen.has(task)) continue;
      seen.add(task);
      todos.push({ task, owner: guessOwner(sentence, line.speaker), due: guessDue(sentence) });
      if (todos.length >= 15) return todos;
    }
  }
  return todos;
}

/** 抽取风险句：含风险词的句子。 */
export function extractRisks(text: string): string[] {
  const found = splitSentences(text).filter((sentence) => RISK_WORDS.some((word) => sentence.includes(word)));
  return [...new Set(found.map((item) => item.slice(0, 160)))].slice(0, 8);
}

/**
 * 启发式纪要（零 Key 降级）：决议/待办/风险按词典抽取，摘要取首尾句拼接。
 * 结果带 demo 标注，只做快速整理，需参会人确认。
 */
export function heuristicMinutes(text: string, title = ""): MeetingMinutes {
  const body = String(text ?? "").trim();
  if (!body) throw new Error("请先粘贴会议转写文本，生成纪要需要原文。");
  const sentences = splitSentences(body);
  const decisions = extractDecisions(body);
  const todos = extractTodos(body);
  const risks = extractRisks(body);
  const summaryParts = [sentences[0], sentences[sentences.length - 1]].filter(Boolean);
  return normalizeMinutes(
    {
      title,
      summary: `演示纪要（启发式抽取）：共识别 ${decisions.length} 条决议、${todos.length} 条待办、${risks.length} 条风险提示。${summaryParts.join("；")}`.slice(0, 400),
      decisions,
      todos,
      risks,
      demo: true,
    },
    title,
  );
}

/* ------------------------------ LLM 纪要 ------------------------------ */

const MEETING_SYSTEM = [
  "你是会议纪要助手。基于用户提供的会议转写文本，输出结构化 JSON 纪要。",
  "硬性纪律：",
  "1. 只基于原文，不编造人名、日期、数字；原文没提到的负责人/期限一律写「待定」。",
  "2. 决议（已拍板的事）与待办（要去做的事）严格分开，不要混放。",
  "3. 待办必须带负责人和期限（缺失标待定），task 写清动作与交付物。",
  "4. summary 只概括讨论主题与结论，不要加入原文没有的评价。",
  "只输出 JSON：",
  '{"title":"会议标题","summary":"200字内摘要","decisions":["决议"],"todos":[{"task":"待办动作","owner":"负责人或待定","due":"期限或待定"}],"risks":["风险/未决事项"],"nextMeeting":"下次会议安排，没有就留空"}',
  "decisions 最多 10 条，todos 最多 15 条，risks 最多 8 条。",
].join("\n");

/**
 * 生成纪要主入口：优先走 askLLM，模型不可用/解析失败时降级启发式抽取（demo 标注）。
 */
export async function generateMinutes(input: {
  title: string;
  transcript: string;
  attendees?: string;
  signal?: AbortSignal;
}): Promise<MeetingMinutes> {
  const body = clip(String(input.transcript ?? ""), 12000);
  if (!body) throw new Error("请先粘贴会议转写文本，生成纪要需要原文。");
  try {
    const { text } = await askLLM(
      [
        { role: "system", content: MEETING_SYSTEM },
        {
          role: "user",
          content: [
            `会议标题：${input.title.trim() || "（未命名）"}`,
            `参会人：${String(input.attendees ?? "").trim() || "（未填写）"}`,
            "",
            "=== 转写原文 ===",
            body,
          ].join("\n"),
        },
      ],
      { json: true, signal: input.signal },
    );
    const parsed = parseJson<Partial<MeetingMinutes>>(text);
    if (!parsed || typeof parsed.summary !== "string") throw new Error("纪要结果解析失败");
    return normalizeMinutes({ ...parsed, demo: false }, input.title);
  } catch {
    return heuristicMinutes(body, input.title);
  }
}

/* ------------------------------ 导出与留档 ------------------------------ */

/** 纪要导出 Markdown（含待办表与演示标注）。 */
export function exportMinutesMarkdown(minutes: MeetingMinutes): string {
  const lines: string[] = [`# 会议纪要 · ${minutes.title}`, ""];
  lines.push(`导出时间：${new Date().toLocaleString("zh-CN", { hour12: false })}`);
  lines.push(`> ${MEETING_NOTE}${minutes.demo ? " 本纪要为演示纪要（启发式抽取），非模型整理结论。" : ""}`, "");
  lines.push("## 摘要", "", minutes.summary || "（无摘要）", "");
  lines.push(`## 决议（${minutes.decisions.length} 条）`, "");
  if (!minutes.decisions.length) lines.push("未识别到明确决议。", "");
  minutes.decisions.forEach((item, index) => lines.push(`${index + 1}. ${item}`));
  if (minutes.decisions.length) lines.push("");
  lines.push(`## 待办（${minutes.todos.length} 条）`, "");
  if (!minutes.todos.length) {
    lines.push("未识别到待办。", "");
  } else {
    lines.push("| # | 待办 | 负责人 | 期限 |", "|---|---|---|---|");
    minutes.todos.forEach((todo, index) => lines.push(`| ${index + 1} | ${todo.task} | ${todo.owner} | ${todo.due} |`));
    lines.push("");
  }
  lines.push(`## 风险与未决事项（${minutes.risks.length} 条）`, "");
  if (!minutes.risks.length) lines.push("未识别到风险提示。", "");
  minutes.risks.forEach((item) => lines.push(`- ${item}`));
  if (minutes.risks.length) lines.push("");
  if (minutes.nextMeeting) lines.push("## 下次会议", "", minutes.nextMeeting, "");
  lines.push("---", MEETING_NOTE);
  return lines.join("\n");
}

const MEETINGS_KEY = "ai-employee:meetings";
export const MAX_MEETINGS = 20;

export interface MeetingRecord {
  id: string;
  title: string;
  decisionCount: number;
  todoCount: number;
  demo: boolean;
  at: number;
}

/** 把一次纪要转成留档记录（只留摘要，不存转写全文）。 */
export function toMeetingRecord(minutes: MeetingMinutes, at = Date.now()): MeetingRecord {
  return {
    id: `meeting-${at.toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    title: minutes.title.slice(0, 60) || "未命名会议",
    decisionCount: minutes.decisions.length,
    todoCount: minutes.todos.length,
    demo: minutes.demo === true,
    at,
  };
}

export function loadMeetingRecords(): MeetingRecord[] {
  try {
    const raw = localStorage.getItem(MEETINGS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return (parsed as MeetingRecord[]).filter((row) => row && Number.isFinite(row.at) && typeof row.title === "string").slice(0, MAX_MEETINGS);
  } catch {
    return [];
  }
}

export function saveMeetingRecord(record: MeetingRecord): MeetingRecord[] {
  const next = [record, ...loadMeetingRecords()].slice(0, MAX_MEETINGS);
  try {
    localStorage.setItem(MEETINGS_KEY, JSON.stringify(next));
  } catch {
    /* 节点测试环境无 localStorage / 隐私模式写失败不影响主流程 */
  }
  return next;
}

export function removeMeetingRecord(id: string): MeetingRecord[] {
  const next = loadMeetingRecords().filter((row) => row.id !== id);
  try {
    localStorage.setItem(MEETINGS_KEY, JSON.stringify(next));
  } catch {
    /* 同上 */
  }
  return next;
}
