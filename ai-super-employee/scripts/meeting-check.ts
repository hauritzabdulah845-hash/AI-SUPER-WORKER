/**
 * AI 会议自检：说话人解析、决议/待办/风险抽取、空文本、归一化、Markdown、留档不存全文。
 * 只测纯函数与降级路径，不真调 LLM（LLM 成功路径需真实通道，见接入清单）。
 * 运行：npm run test:meeting
 */
import {
  MEETING_NOTE,
  exportMinutesMarkdown,
  extractDecisions,
  extractRisks,
  extractTodos,
  generateMinutes,
  heuristicMinutes,
  loadMeetingRecords,
  normalizeMinutes,
  parseSpeakerLines,
  removeMeetingRecord,
  saveMeetingRecord,
  toMeetingRecord,
} from "../src/cloud/meeting";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failed += 1;
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` ｜ ${detail}` : ""}`);
};

const memory = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => void memory.set(key, String(value)),
  removeItem: (key: string) => void memory.delete(key),
};

const transcript = [
  "张三：大家好，今天讨论新版上线时间。",
  "李四：测试已经通过了，我同意下周三上线。",
  "张三：好，我们决定新版下周三正式上线。",
  "王五：我负责跟进上线前的回归测试，周二前提交报告。",
  "李四：运营物料由赵六负责，下周一完成。",
  "张三：另外预算有点紧，担心延期，大家注意风险。",
  "王五：下次会议下周一上午继续跟进。",
].join("\n");

// 1. 说话人解析
const lines = parseSpeakerLines(transcript);
check("说话人行数", lines.length === 7, `lines=${lines.length}`);
check("说话人姓名解析", lines[0].speaker === "张三" && lines[3].speaker === "王五");
check("无说话人行内容保留", parseSpeakerLines("没有冒号的一行")[0].speaker === "" && parseSpeakerLines("没有冒号的一行")[0].content === "没有冒号的一行");
check("空行被过滤", parseSpeakerLines("张三：你好\n\n\n李四：在的").length === 2);

// 2. 决议抽取
const decisions = extractDecisions(transcript);
check("决议命中决定句", decisions.some((item) => item.includes("决定")), JSON.stringify(decisions));
check("决议命中同意/通过句", decisions.some((item) => item.includes("同意")) || decisions.some((item) => item.includes("通过")));
check("无决议词时为空", extractDecisions("今天天气不错，大家随便聊聊。").length === 0);

// 3. 待办抽取
const todos = extractTodos(transcript);
check("待办被抽取", todos.length >= 2, JSON.stringify(todos));
check("待办负责人=说话人", todos.some((todo) => todo.owner === "王五"), JSON.stringify(todos.map((t) => t.owner)));
check("待办负责人=由X负责", todos.some((todo) => todo.owner === "赵六"), JSON.stringify(todos.map((t) => t.owner)));
check("待办期限被识别", todos.some((todo) => todo.due.includes("周")), JSON.stringify(todos.map((t) => t.due)));
check("待办缺期限标待定", extractTodos("张三：记得整理会议材料。").every((todo) => todo.due === "待定"));

// 4. 风险抽取
const risks = extractRisks(transcript);
check("风险句被抽取", risks.some((item) => item.includes("风险") || item.includes("预算")), JSON.stringify(risks));

// 5. 启发式纪要
const demo = heuristicMinutes(transcript, "产品例会");
check("启发式标注 demo", demo.demo === true);
check("启发式标题保留", demo.title === "产品例会");
check("启发式决议与待办非空", demo.decisions.length >= 1 && demo.todos.length >= 2);

// 6. 空文本
let threw = false;
try {
  heuristicMinutes("   ");
} catch {
  threw = true;
}
check("启发式空文本抛错", threw);

let genThrew = false;
try {
  await generateMinutes({ title: "空", transcript: "" });
} catch {
  genThrew = true;
}
check("generateMinutes 空文本抛错", genThrew);

// 7. 归一化
const normalized = normalizeMinutes({
  title: "  测试会  ",
  summary: "摘要",
  decisions: ["决议A", "决议A", ""],
  todos: [
    { task: "做报告", owner: "", due: "" },
    { task: "", owner: "张三", due: "周五" },
  ],
  risks: ["风险1", "风险1"],
  demo: true,
});
check("归一化决议去重去空", normalized.decisions.length === 1);
check("归一化待办丢弃空任务", normalized.todos.length === 1);
check("归一化负责人缺失标待定", normalized.todos[0].owner === "待定" && normalized.todos[0].due === "待定");
check("归一化空输入不抛错", normalizeMinutes(null).title === "未命名会议" && normalizeMinutes(undefined).todos.length === 0);
check("归一化 fallback 标题", normalizeMinutes({}, "备用标题").title === "备用标题");

// 8. Markdown 导出
const md = exportMinutesMarkdown(demo);
check("Markdown 含标题", md.startsWith("# 会议纪要 · 产品例会"));
check("Markdown 含待办表", md.includes("| # | 待办 | 负责人 | 期限 |") && md.includes("王五"));
check("Markdown 标注演示纪要", md.includes("演示纪要"));
check("Markdown 含后置说明", md.includes(MEETING_NOTE));
const mdModel = exportMinutesMarkdown({ ...demo, demo: false, summary: "模型整理摘要。" });
check("非演示纪要不标演示", !mdModel.includes("演示纪要") && mdModel.includes(MEETING_NOTE));

// 9. 留档不存全文
const record = toMeetingRecord(demo, 1700000000000);
check("留档含条数摘要", record.decisionCount === demo.decisions.length && record.todoCount === demo.todos.length);
check("留档不含转写全文", !JSON.stringify(record).includes("回归测试") && !("transcript" in record));
saveMeetingRecord(record);
check("留档写入后可读", loadMeetingRecords().length === 1 && loadMeetingRecords()[0].title === "产品例会");
removeMeetingRecord(record.id);
check("留档可删除", loadMeetingRecords().length === 0);

console.log(`\n${failed === 0 ? "全部通过" : `${failed} 项失败`}`);
process.exit(failed === 0 ? 0 : 1);
