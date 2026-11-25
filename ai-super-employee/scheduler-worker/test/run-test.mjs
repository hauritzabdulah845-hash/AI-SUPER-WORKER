/**
 * 本地自测：常驻调度 worker 全链路（不连外部服务）。
 * 覆盖：心跳 → 鉴权 → 计划同步 → 到期判定（每日/间隔/停用/空步骤/补跑）
 *       → 运行回写 → 历史上限 → 参数校验 → 纯函数语义。
 */
import os from "node:os";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { createService } from "../src/server.mjs";
import { isDue, nextRunLabel, normalizeSchedule, todayAt } from "../src/schedule.mjs";

const SECRET = "test-admin-secret";
let failed = 0;

function check(name, ok, detail = "") {
  if (!ok) failed += 1;
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` ｜ ${detail}` : ""}`);
}

async function postJson(port, path, payload, headers = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function getJson(port, path, headers = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const DAY = 86_400_000;

function plan(overrides = {}) {
  return {
    id: "pipe-1",
    name: "每日晨报",
    enabled: true,
    mode: "daily",
    time: "09:00",
    hours: 24,
    createdAt: Date.now() - DAY,
    lastRunAt: null,
    steps: [{ id: "s1", kind: "leads-scan", params: {} }],
    ...overrides,
  };
}

async function main() {
  console.log("—— 常驻调度 worker · 本地自测 ——\n");

  const config = { port: 0, adminSecret: SECRET, dataDir: mkdtempSync(join(os.tmpdir(), "sched-test-")) };
  const { server } = createService({ config, logger: { info() {}, warn() {}, error() {} } });
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const auth = { "x-admin-secret": SECRET };

  // 1. 心跳
  const health = await getJson(port, "/health");
  check("心跳返回版本与计数", health.body.ok === true && health.body.service === "scheduler-worker" && Boolean(health.body.version), `v=${health.body.version}`);

  // 2. 鉴权
  const denied = await getJson(port, "/api/schedules", { "x-admin-secret": "wrong" });
  check("错误密钥 403", denied.status === 403, `status=${denied.status}`);
  const deniedPost = await postJson(port, "/api/schedules", { schedules: [] });
  check("无密钥同步 403", deniedPost.status === 403, `status=${deniedPost.status}`);

  // 3. 参数校验
  const bad = await postJson(port, "/api/schedules", { schedules: "nope" }, auth);
  check("schedules 非数组 400", bad.status === 400, `status=${bad.status}`);

  // 4. 计划同步 + 读回
  const now = todayAt("09:00", Date.now()) + 60_000; // 今天 09:01（本地）
  const synced = await postJson(port, "/api/schedules", {
    schedules: [
      plan(),
      plan({ id: "pipe-2", name: "间隔扫描", mode: "interval", hours: 2, createdAt: now - 3 * 3_600_000 }),
      plan({ id: "pipe-3", name: "已停用", enabled: false }),
      plan({ id: "pipe-4", name: "空步骤", steps: [] }),
      plan({ id: "pipe-5", name: "今天已跑", lastRunAt: todayAt("09:00", now) + 1000 }),
    ],
  }, auth);
  check("计划同步 5 条", synced.body.ok === true && synced.body.count === 5, `count=${synced.body.count}`);
  const back = await getJson(port, "/api/schedules", auth);
  check("计划读回", back.body.schedules?.length === 5, `n=${back.body.schedules?.length}`);

  // 5. 到期判定（注入 now）：每日到点 + 间隔到点；停用/空步骤/今天已跑不算
  const due = await getJson(port, `/api/due?now=${now}`, auth);
  const dueIds = (due.body.due ?? []).map((row) => row.id).sort();
  check("到期集合正确", JSON.stringify(dueIds) === JSON.stringify(["pipe-1", "pipe-2"]), dueIds.join(","));
  check("到期带展示文案", (due.body.due ?? []).every((row) => typeof row.nextRunLabel === "string" && row.nextRunLabel.length > 0));

  // 6. 运行回写 + 回填 lastRunAt 后不再到期
  const run = await postJson(port, "/api/runs", {
    scheduleId: "pipe-1", at: now, status: "done", durationMs: 1200,
    steps: [{ stepId: "s1", kind: "leads-scan", label: "高意向扫描", status: "done", detail: "高意向 2 条" }],
  }, auth);
  check("运行回写", run.body.ok === true && run.body.run.scheduleId === "pipe-1");
  const dueAfter = await getJson(port, `/api/due?now=${now}`, auth);
  check("回写后每日计划不再到期", !(dueAfter.body.due ?? []).some((row) => row.id === "pipe-1"));

  // 7. 回写校验
  const badRun = await postJson(port, "/api/runs", { status: "done" }, auth);
  check("回写缺 scheduleId 400", badRun.status === 400, `status=${badRun.status}`);

  // 8. 历史读取与上限（回写 205 条只留 200）
  for (let i = 0; i < 204; i += 1) {
    await postJson(port, "/api/runs", { scheduleId: "pipe-2", at: now + i, status: "partial", durationMs: 1, steps: [] }, auth);
  }
  const runs = await getJson(port, "/api/runs?limit=500", auth);
  check("历史封顶 200", runs.body.runs?.length === 200, `n=${runs.body.runs?.length}`);
  const runs10 = await getJson(port, "/api/runs?limit=10", auth);
  check("历史 limit 生效", runs10.body.runs?.length === 10, `n=${runs10.body.runs?.length}`);

  // 9. 纯函数语义（与 pipeline.ts 对齐）
  check("todayAt 非法回退 09:00", new Date(todayAt("bad", now)).getHours() === 9);
  check("isDue 停用不触发", isDue(plan({ enabled: false }), now) === false);
  check("isDue 空步骤不触发", isDue(plan({ steps: [] }), now) === false);
  check("isDue 间隔未满不触发", isDue(plan({ mode: "interval", hours: 24, createdAt: now - 1000 }), now) === false);
  check("nextRunLabel 待补跑", nextRunLabel(plan(), now) === "待补跑", nextRunLabel(plan(), now));
  check("normalizeSchedule 无 id 丢弃", normalizeSchedule({ name: "x" }) === null);
  check("normalizeSchedule 非法 time 夹紧", normalizeSchedule(plan({ time: "99:99" })).time === "23:59", normalizeSchedule(plan({ time: "99:99" })).time);
  check("normalizeSchedule 垃圾 time 回退", normalizeSchedule(plan({ time: "abc" })).time === "09:00");

  server.close();
  console.log(`\n${failed === 0 ? "全部通过" : `${failed} 项失败`}`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
