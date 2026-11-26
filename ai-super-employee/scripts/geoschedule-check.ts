/**
 * GEO 监测周期模板纯逻辑自检（第二十九批）。
 * 关注点：频率换算、模板载荷构建（标记/竞品/启用态）、按品牌查找、竞品参数解析、
 * 与既有 pipeline 到期语义（isDue/nextRunLabel）的衔接。
 * 运行：npm run test:geoschedule
 */
import {
  buildGeoMonitorPipeline,
  findGeoMonitorPipeline,
  frequencyToPipelineFields,
  geoMonitorPipelineName,
  isGeoMonitorPipeline,
  parseCompetitorsParam,
} from "../src/cloud/geoschedule";
import { isDue, nextRunLabel, stepLabel } from "../src/cloud/pipeline";

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) {
    pass += 1;
    console.log(`✓ ${name}${detail ? ` ｜ ${detail}` : ""}`);
  } else {
    fail += 1;
    console.log(`✗ ${name}${detail ? ` ｜ ${detail}` : ""}`);
  }
};

const NOW = new Date("2026-11-26T08:00:00").getTime();

console.log("--- frequencyToPipelineFields：频率换算 ---");
{
  const daily = frequencyToPipelineFields("daily");
  ok("每天 → daily 09:00", daily.mode === "daily" && daily.time === "09:00");
  const every3 = frequencyToPipelineFields("every3days");
  ok("每3天 → interval 72h", every3.mode === "interval" && every3.hours === 72);
  const weekly = frequencyToPipelineFields("weekly");
  ok(
    "每周 → interval 168h",
    weekly.mode === "interval" && weekly.hours === 168,
  );
}

console.log("\n--- buildGeoMonitorPipeline：模板载荷 ---");
{
  const pipe = buildGeoMonitorPipeline({
    brand: "山野茶饮",
    competitors: ["竞品甲", "竞品乙", "山野茶饮"],
    frequency: "weekly",
    now: NOW,
  });
  ok(
    "任务名带品牌",
    pipe.name === "GEO 周期监测 · 山野茶饮" &&
      geoMonitorPipelineName("山野茶饮") === pipe.name,
  );
  ok("默认启用", pipe.enabled === true);
  ok("每周为 interval 168", pipe.mode === "interval" && pipe.hours === 168);
  ok(
    "单步 geo-monitor",
    pipe.steps.length === 1 && pipe.steps[0].kind === "geo-monitor",
  );
  ok(
    "载荷带 GEO 监测标记",
    pipe.steps[0].params.geoMonitor === "山野茶饮" &&
      pipe.steps[0].params.brand === "山野茶饮",
  );
  ok(
    "竞品去本品牌后存入",
    pipe.steps[0].params.competitors === "竞品甲,竞品乙",
    pipe.steps[0].params.competitors,
  );
  ok("创建时间用传入 now", pipe.createdAt === NOW);
  const dailyPipe = buildGeoMonitorPipeline({
    brand: "甲品牌",
    frequency: "daily",
    now: NOW,
  });
  ok(
    "每天模板为 daily 09:00 且无竞品",
    dailyPipe.mode === "daily" &&
      dailyPipe.time === "09:00" &&
      dailyPipe.steps[0].params.competitors === "",
  );
  ok("步骤标签可读", stepLabel(pipe.steps[0]).startsWith("GEO 周期监测"));
}

console.log("\n--- findGeoMonitorPipeline / isGeoMonitorPipeline ---");
{
  const pipe = buildGeoMonitorPipeline({
    brand: "山野茶饮",
    frequency: "weekly",
    now: NOW,
  });
  const other = buildGeoMonitorPipeline({
    brand: "别的品牌",
    frequency: "daily",
    now: NOW,
  });
  ok(
    "按品牌找到",
    findGeoMonitorPipeline([other, pipe], "山野茶饮")?.id === pipe.id,
  );
  ok(
    "找不到返回 undefined",
    findGeoMonitorPipeline([other], "山野茶饮") === undefined,
  );
  ok("空品牌不匹配", findGeoMonitorPipeline([pipe], "") === undefined);
  ok("isGeoMonitorPipeline 识别", isGeoMonitorPipeline(pipe) === true);
}

console.log("\n--- parseCompetitorsParam ---");
{
  ok(
    "逗号分隔解析",
    parseCompetitorsParam("竞品甲, 竞品乙", "山野茶饮").join("、") ===
      "竞品甲、竞品乙",
  );
  ok(
    "去本品牌与去重",
    parseCompetitorsParam("山野茶饮，竞品甲，竞品甲", "山野茶饮").length === 1,
  );
  ok("最多 3 个", parseCompetitorsParam("a,b,c,d", "x").length === 3);
  ok("空参数返回空", parseCompetitorsParam(undefined, "x").length === 0);
}

console.log("\n--- 与既有到期语义衔接 ---");
{
  const weekly = buildGeoMonitorPipeline({
    brand: "山野茶饮",
    frequency: "weekly",
    now: NOW,
  });
  ok("新建每周任务未到期", isDue(weekly, NOW) === false);
  ok("满 168h 后到期", isDue(weekly, NOW + 168 * 3_600_000) === true);
  ok(
    "下次运行文案非空",
    nextRunLabel(weekly, NOW).length > 0,
    nextRunLabel(weekly, NOW),
  );
  const daily = buildGeoMonitorPipeline({
    brand: "山野茶饮",
    frequency: "daily",
    now: NOW,
  });
  const afterNine = new Date("2026-11-26T09:30:00").getTime();
  ok("每日 09:00 后到期", isDue(daily, afterNine) === true);
  ok("每日 09:00 前未到期", isDue(daily, NOW) === false);
}

console.log(`\n全部通过（${pass} 通过 / ${fail} 失败）`);
if (fail > 0) process.exit(1);
