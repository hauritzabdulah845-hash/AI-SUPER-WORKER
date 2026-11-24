/**
 * 定时流水线 + 运营报表纯函数自检（不依赖浏览器与模型通道）。
 * 运行：npm run test:pipeline
 */
import { dayKey, bucketCounts, lastNDayKeys, reportToCsv, type OpsReport } from "../src/cloud/metrics";
import { duePipelines, isDue, nextRunAt, nextRunLabel, stepLabel, todayAt, type Pipeline } from "../src/cloud/pipeline";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failed += 1;
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` ｜ ${detail}` : ""}`);
};

const HOUR = 3_600_000;
// 固定一个“今天 08:00”的基准，避免测试依赖真实墙钟
const base = new Date();
base.setHours(8, 0, 0, 0);
const now = base.getTime();

const pipe = (patch: Partial<Pipeline>): Pipeline => ({
  id: "p1",
  name: "测试流水线",
  enabled: true,
  mode: "daily",
  time: "09:00",
  hours: 6,
  createdAt: now - 30 * 24 * HOUR,
  lastRunAt: null,
  steps: [{ id: "s1", kind: "leads-scan", params: {} }],
  history: [],
  ...patch,
});

// 1. todayAt
check("todayAt 解析 09:00", todayAt("09:00", now) === new Date(base).setHours(9, 0, 0, 0));
check("todayAt 非法时间回退 09:00", todayAt("bad", now) === todayAt("09:00", now));
check("todayAt 分钟截断", new Date(todayAt("09:37", now)).getMinutes() === 37);

// 2. isDue 每日
check("每日：未到点不触发", !isDue(pipe({}), now)); // 08:00 < 09:00
check("每日：到点未跑触发", isDue(pipe({}), now + HOUR)); // 09:00 已到，lastRunAt=null
check("每日：今天已跑不重复", !isDue(pipe({ lastRunAt: now + HOUR }), now + 2 * HOUR));
check("每日：昨天跑过+今天到点=补跑", isDue(pipe({ lastRunAt: now - 23 * HOUR }), now + HOUR));
check("停用不触发", !isDue(pipe({ enabled: false }), now + HOUR));
check("无步骤不触发", !isDue(pipe({ steps: [] }), now + HOUR));

// 3. isDue 间隔
check("间隔：未满不触发", !isDue(pipe({ mode: "interval", hours: 6, lastRunAt: now - 5 * HOUR }), now));
check("间隔：满了触发", isDue(pipe({ mode: "interval", hours: 6, lastRunAt: now - 7 * HOUR }), now));
check("间隔：从未跑过按创建时间", isDue(pipe({ mode: "interval", hours: 6, createdAt: now - 7 * HOUR, lastRunAt: null }), now));

// 4. nextRunAt / nextRunLabel
check("nextRunAt 每日返回今天 09:00", nextRunAt(pipe({}), now) === todayAt("09:00", now));
check("nextRunAt 已过点返回明天", nextRunAt(pipe({}), now + 2 * HOUR) === todayAt("09:00", now) + 86_400_000);
check("nextRunLabel 未到点=今天", nextRunLabel(pipe({}), now) === "今天 09:00");
check("nextRunLabel 停用", nextRunLabel(pipe({ enabled: false }), now) === "已停用");
check("nextRunLabel 待补跑", nextRunLabel(pipe({}), now + 2 * HOUR) === "待补跑");
const intervalLabel = nextRunLabel(pipe({ mode: "interval", hours: 6, lastRunAt: now - 4 * HOUR }), now);
check("nextRunLabel 间隔小时", intervalLabel === "2 小时后", intervalLabel);

// 5. stepLabel / duePipelines
check(
  "stepLabel 带参数截断",
  stepLabel({ id: "s", kind: "leads-scan", params: {} }) === "高意向扫描" &&
    stepLabel({ id: "s", kind: "geo", params: { brand: "某某茶饮" } }).startsWith("GEO 体检："),
);
const due = duePipelines([pipe({}), pipe({ id: "p2", enabled: false }), pipe({ id: "p3", lastRunAt: now + HOUR })], now + HOUR);
check("duePipelines 只挑到点的", due.length === 1 && due[0].id === "p1", `due=${due.map((row) => row.id).join(",")}`);

// 6. 日期分桶
const keys = lastNDayKeys(7, now);
check("lastNDayKeys 7 天升序含今天", keys.length === 7 && keys[6] === dayKey(new Date(now)) && keys[0] < keys[6]);
const todayKey = dayKey(new Date(now));
const rows = [
  { at: now }, // 今天
  { at: now - 24 * HOUR }, // 昨天
  { at: now - 30 * 24 * HOUR }, // 30 天前：应被窗口剔除
  { at: Number.NaN }, // 非法时间
];
const buckets = bucketCounts(rows, 7, now);
check("bucketCounts 今天+1", buckets[todayKey] === 1, JSON.stringify(buckets));
check("bucketCounts 剔除窗口外", Object.values(buckets).reduce((sum, value) => sum + value, 0) === 2);

// 7. CSV 导出
const report: OpsReport = {
  generatedAt: now,
  tiles: [
    { key: "leads", label: "线索总数", value: 12, hint: "7 日新增 3 · 成交 1" },
    { key: "hot", label: "高意向线索", value: 4, hint: "待跟进 2 条" },
  ],
  trend: [{ day: todayKey, tasks: 2, leads: 1, videos: 0 }],
};
const csv = reportToCsv(report);
check("CSV 含 BOM 与表头", csv.startsWith("\uFEFF指标,数值,说明"));
check("CSV 含指标与趋势", csv.includes("线索总数,12") && csv.includes(`${todayKey},2,1,0`));

console.log(`\n${failed === 0 ? "全部通过" : `${failed} 项失败`}`);
process.exit(failed === 0 ? 0 : 1);
