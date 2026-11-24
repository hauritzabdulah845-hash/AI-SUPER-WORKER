/**
 * 运营保障自检（第十三批）：
 * - 群发风控审批：状态流转、发送门禁、到点队列过滤、风险预检；
 * - 线索 CSV：表头识别、引号/内嵌逗号、去重（文件内 + 已有）、去重键优先级；
 * - 任务失败统计：原因归一化、聚类排序、失败率、7 天趋势、重跑清单。
 * 运行：npm run test:ops
 */
import {
  broadcastBlockReason,
  broadcastRiskHints,
  createBroadcast,
  decideApproval,
  dueBroadcasts,
  isBroadcastSendable,
  requestApproval,
  type BroadcastPlan,
} from "../src/cloud/broadcast";
import { dedupeLeads, leadKey, parseLeadsCsv, splitCsvLine } from "../src/cloud/leadcsv";
import { normalizeFailureReason, summarizeTasks, taskStatsHeadline } from "../src/cloud/tasksummary";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) console.log(`✓ ${name}${detail ? ` ｜ ${detail}` : ""}`);
  else {
    failed += 1;
    console.error(`✗ ${name}${detail ? ` ｜ ${detail}` : ""}`);
  }
};

/** 固定「现在」，让 7 天趋势可断言 */
const NOW = Date.parse("2026-11-24T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

/* ============================ 群发风控审批 ============================ */

const draft = createBroadcast("双十一回访");
check("新计划默认免审批", draft.approval === "none" && isBroadcastSendable(draft));
check("免审批计划无拦截原因", broadcastBlockReason(draft) === "");

const pending: BroadcastPlan = requestApproval({ ...draft, content: "老客户专属优惠" });
check("提交审批 → 待审批", pending.approval === "pending");
check("待审批被拦截", !isBroadcastSendable(pending) && broadcastBlockReason(pending).includes("等待审批"));

const approved = decideApproval(pending, true);
check("审批通过可发送", approved.approval === "approved" && isBroadcastSendable(approved) && broadcastBlockReason(approved) === "");
check("审批时间已记录", typeof approved.approvalAt === "number" && approved.approvalAt > 0);
check("已通过再提交审批不变", requestApproval(approved).approval === "approved");

const rejected = decideApproval(pending, false, "话术含绝对化用语");
check("驳回带原因且拦截", rejected.approval === "rejected" && broadcastBlockReason(rejected).includes("绝对化"));

// 到点队列：仅放行无需审批/已审批的
const pastIso = new Date(NOW - 60_000).toISOString();
const queue = dueBroadcasts(
  [
    { ...draft, id: "p-open", scheduleAt: pastIso, status: "scheduled" as const },
    { ...pending, id: "p-pending", scheduleAt: pastIso, status: "scheduled" as const },
    { ...approved, id: "p-ok", scheduleAt: pastIso, status: "scheduled" as const },
    { ...rejected, id: "p-no", scheduleAt: pastIso, status: "scheduled" as const },
  ],
  NOW,
);
check(
  "到点队列过滤待审批/驳回",
  queue.map((plan) => plan.id).join(",") === "p-open,p-ok",
  queue.map((plan) => plan.id).join(",") || "(空)",
);

const risky = broadcastRiskHints({ ...draft, content: "全网最低价，稳赚不赔", scheduleAt: new Date(NOW - 1000).toISOString() }, 320, NOW);
check("风险预检命中违禁词", risky.some((hint) => hint.includes("全网最低")) && risky.some((hint) => hint.includes("稳赚")));
check("风险预检提示受众超量", risky.some((hint) => hint.includes(">200")));
check("风险预检提示排期已过", risky.some((hint) => hint.includes("排期时间已过")));
check("正常话术无误报", broadcastRiskHints({ ...draft, content: "本周新品到店，欢迎回访" }, 30).length === 0);

/* ============================== 线索 CSV ============================== */

check(
  "CSV 切分：引号与内嵌逗号",
  splitCsvLine('"王总,华东","抖音",高').join("|") === "王总,华东|抖音|高",
);
check("CSV 切分：转义双引号", splitCsvLine('"他说""再看看""",x').join("|") === '他说"再看看"|x');

const exportStyle = "客户,来源,意向等级,最新需求,跟进人,阶段,创建时间\n" +
  '"张三",抖音,高意向,"想了解团购, 含配送",小李,跟进中,2026/11/20\n' +
  '"李四",企微,中意向,咨询价格,小王,已预约,2026/11/21\n';
const parsedExport = parseLeadsCsv(exportStyle);
check("识别导出表头", parsedExport.rows.length === 2 && parsedExport.rows[0].name === "张三" && parsedExport.rows[0].need === "想了解团购, 含配送", JSON.stringify(parsedExport.headers));
check("意向简写归一", parsedExport.rows[0].intent === "高意向" && parsedExport.rows[1].intent === "中意向");
check("阶段保留合法值", parsedExport.rows[0].stage === "跟进中" && parsedExport.rows[1].stage === "已预约");

const englishHeader = "name,source,intent,need,owner,stage,external_userid\n王五,转介绍,高,需要报价,小赵,新建,wmABC\n";
const parsedEn = parseLeadsCsv(englishHeader);
check("识别英文表头", parsedEn.rows.length === 1 && parsedEn.rows[0].external_userid === "wmABC" && parsedEn.rows[0].intent === "高意向");

const noHeader = "赵六,抖音,低意向,随便看看,,,\n钱七,官网,高意向,要方案,,,\n";
const parsedNoHeader = parseLeadsCsv(noHeader);
check("无表头按导出顺序解析", parsedNoHeader.rows.length === 2 && parsedNoHeader.rows[0].name === "赵六" && parsedNoHeader.rows[0].source === "抖音", JSON.stringify(parsedNoHeader.rows.map((row) => row.name)));

const dupCsv = "客户,来源,意向,需求\n孙八,抖音,高,要报价\n孙八,抖音,高,要报价\n,抖音,高,缺名字\n";
const parsedDup = parseLeadsCsv(dupCsv);
check("文件内重复只留一条", parsedDup.rows.length === 1 && parsedDup.duplicatesInFile === 1, `rows=${parsedDup.rows.length} dup=${parsedDup.duplicatesInFile}`);
check("缺客户名计为跳过", parsedDup.skipped === 1);

const parsedExisting = parseLeadsCsv("客户,需求,企微ID\n周九,想了解价格,wmEXIST\n吴十,新品咨询,wmNEW\n", [
  { name: "周九", need: "别的需求", external_userid: "wmexist" },
]);
check("与已有线索重复按企微ID识别", parsedExisting.rows.length === 1 && parsedExisting.duplicatesExisting === 1 && parsedExisting.rows[0].external_userid === "wmNEW");

check("去重键优先企微ID且忽略大小写空白", leadKey({ name: "甲", need: "x", external_userid: " wmX " }) === "id:wmx", leadKey({ name: "甲", need: "x", external_userid: " wmX " }));
check("同名不同需求不误合并", leadKey({ name: "甲", need: "A" }) !== leadKey({ name: "甲", need: "B" }));

const dedupeFixture = [
  { name: "张三", need: "A", external_userid: "wm1" },
  { name: "张三", need: "B", external_userid: "wm1" },
  { name: "李四", need: "A" },
  { name: "李四", need: "A" },
];
const deduped = dedupeLeads(dedupeFixture);
check("已有线索去重保留最早一条", deduped.kept.length === 2 && deduped.removed.length === 2, `kept=${deduped.kept.length}`);

/* ============================ 任务失败统计 ============================ */

check("配额原因归一", normalizeFailureReason("Error: 429 Too Many Requests quota exceeded").reason === "模型配额用尽");
check("超时原因归一", normalizeFailureReason("请求超时了").reason === "请求超时");
check("未知原因截断", normalizeFailureReason("某些奇怪的报错信息，后面还有一大段堆栈").reason.length <= 25);

const tasks = [
  { id: 1, status: "done", error: null, created_at: daysAgo(0) },
  { id: 2, status: "failed", error: "429 quota exceeded", created_at: daysAgo(0) },
  { id: 3, status: "failed", error: "429 Too Many Requests", created_at: daysAgo(2) },
  { id: 4, status: "failed", error: "请求超时", created_at: daysAgo(2) },
  { id: 5, status: "partial", error: null, created_at: daysAgo(1), steps: [{ status: "failed", agent: "写手" }, { status: "done", agent: "审校" }] },
  { id: 6, status: "running", error: null, created_at: daysAgo(0) },
  { id: 7, status: "partial", error: null, created_at: daysAgo(3), steps: [{ status: "done", agent: "写手" }] },
];
const stats = summarizeTasks(tasks, NOW);
check("任务状态计数", stats.total === 7 && stats.done === 1 && stats.failed === 3 && stats.partial === 2 && stats.running === 1, JSON.stringify(stats).slice(0, 80));
check("失败原因聚类合并同因", stats.failures[0].reason === "模型配额用尽" && stats.failures[0].count === 2, JSON.stringify(stats.failures.map((item) => [item.reason, item.count])));
check("聚类带建议动作", stats.failures.every((group) => group.advice.length > 0));
check("失败率按终态计算", Math.abs(stats.failRate - 3 / 6) < 1e-9, String(stats.failRate));
// 今天(0天前)=1 条 failed；1 天前=1 条 partial 带失败步骤；2 天前=2 条 failed
check("7 天趋势定位到天", stats.dailyFailures.join(",") === "0,0,0,0,2,1,1", stats.dailyFailures.join(","));
check("重跑清单含失败与失败步骤", stats.retryIds.includes(2) && stats.retryIds.includes(5) && !stats.retryIds.includes(7), stats.retryIds.join(","));
check("结论文案含失败率与主因", taskStatsHeadline(stats).includes("失败率 50%") && taskStatsHeadline(stats).includes("模型配额用尽"));
check("全绿时结论友好", taskStatsHeadline(summarizeTasks([{ id: 1, status: "done", error: null, created_at: daysAgo(0) }], NOW)).includes("全部正常"));

console.log(`\n${failed === 0 ? "全部通过" : `${failed} 项失败`}`);
if (failed > 0) process.exit(1);
