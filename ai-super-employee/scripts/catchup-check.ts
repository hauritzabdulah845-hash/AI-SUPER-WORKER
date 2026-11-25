/**
 * 调度补跑编排纯函数自检（不连 worker、不跑真实任务）。
 * 运行：npm run test:catchup
 */
import { CLAIM_TTL_MS, periodKeyOf, planCatchup, type CatchupClaims } from "../src/cloud/catchup";
import type { Pipeline } from "../src/cloud/pipeline";
import type { DueItem } from "../src/cloud/scheduler";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failed += 1;
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` ｜ ${detail}` : ""}`);
};

const HOUR = 3_600_000;
// 基准：今天 10:00（每日 09:00 已到点）
const base = new Date();
base.setHours(10, 0, 0, 0);
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

const due = (id: string, periodKey?: string): DueItem => ({ id, periodKey });

// 1. periodKeyOf 与 worker 语义对齐
check("periodKey 每日格式", /^daily:\d{4}-\d{2}-\d{2}@09:00$/.test(periodKeyOf(pipe({}), now)), periodKeyOf(pipe({}), now));
check("periodKey 每日同周期稳定", periodKeyOf(pipe({}), now) === periodKeyOf(pipe({}), now + HOUR));
check(
  "periodKey 间隔按到期时刻",
  periodKeyOf(pipe({ mode: "interval", hours: 6, lastRunAt: now - 7 * HOUR }), now) === `interval:${now - HOUR}`,
  periodKeyOf(pipe({ mode: "interval", hours: 6, lastRunAt: now - 7 * HOUR }), now),
);

// 2. 基本入选：worker 到期 + 本地到期
const plan1 = planCatchup([due("p1")], [pipe({})], {}, now);
check("到期入选补跑", plan1.toRun.length === 1 && plan1.toRun[0].pipeline.id === "p1");
check("本地兜底 periodKey", plan1.toRun[0].periodKey === periodKeyOf(pipe({}), now), plan1.toRun[0].periodKey);
const plan1b = planCatchup([due("p1", "daily:worker-key")], [pipe({})], {}, now);
check("优先用 worker periodKey", plan1b.toRun[0]?.periodKey === "daily:worker-key");

// 3. 防双跑：本地已跑过本周期（lastRunAt 在今天触发之后）
const ranToday = pipe({ lastRunAt: now - 30 * 60_000 });
const plan2 = planCatchup([due("p1")], [ranToday], {}, now);
check("本地已跑过本周期跳过", plan2.toRun.length === 0 && plan2.skipped[0]?.reason.includes("已跑过"), plan2.skipped[0]?.reason);

// 4. 停用 / 空步骤 / 本地不存在
check("停用跳过", planCatchup([due("p1")], [pipe({ enabled: false })], {}, now).toRun.length === 0);
check("空步骤跳过", planCatchup([due("p1")], [pipe({ steps: [] })], {}, now).toRun.length === 0);
const planMissing = planCatchup([due("ghost")], [pipe({})], {}, now);
check("本地不存在跳过", planMissing.toRun.length === 0 && planMissing.skipped[0]?.reason.includes("不存在"));

// 5. 补跑标记：未过期同周期跳过，过期允许重试，异周期不拦
const key = periodKeyOf(pipe({}), now);
const freshClaims: CatchupClaims = { p1: { periodKey: key, at: now - 60_000 } };
check("未过期标记跳过", planCatchup([due("p1", key)], [pipe({})], freshClaims, now).toRun.length === 0);
const staleClaims: CatchupClaims = { p1: { periodKey: key, at: now - CLAIM_TTL_MS - 1000 } };
check("过期标记允许重试", planCatchup([due("p1", key)], [pipe({})], staleClaims, now).toRun.length === 1);
const otherClaims: CatchupClaims = { p1: { periodKey: "daily:2000-01-01@09:00", at: now - 60_000 } };
check("异周期标记不拦", planCatchup([due("p1", key)], [pipe({})], otherClaims, now).toRun.length === 1);

// 6. 单轮上限：7 条到期只跑 5 条，余 2 条计 remaining
const many = Array.from({ length: 7 }, (_, i) => pipe({ id: `p${i + 1}` }));
const planCap = planCatchup(many.map((row) => due(row.id)), many, {}, now, 5);
check("单轮上限截断", planCap.toRun.length === 5 && planCap.remaining === 2, `run=${planCap.toRun.length} remaining=${planCap.remaining}`);
check("上限内顺序稳定", planCap.toRun.map((row) => row.pipeline.id).join(",") === "p1,p2,p3,p4,p5");

// 7. 间隔模式：未满间隔本地不到期，即使 worker 说到期也以本地为准
const intervalPipe = pipe({ mode: "interval", hours: 6, lastRunAt: now - 2 * HOUR });
check("间隔未满本地拦截", planCatchup([due("p1")], [intervalPipe], {}, now).toRun.length === 0);

console.log(`\n${failed === 0 ? "全部通过" : `${failed} 项失败`}`);
process.exit(failed === 0 ? 0 : 1);
