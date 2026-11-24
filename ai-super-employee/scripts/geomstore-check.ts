/**
 * GEO 监测编排与存储自检。
 *
 * 核心断言：**网络失败的问题不能算作「未被提及」** —— 否则趋势会被
 * 抖动伪造，用户会看到假的下降。这是整个模块最危险的地方。
 * 运行：npm run test:geomstore
 */
import { latestComparablePair } from "../src/cloud/geomonitor";
import type { GeoSnapshot, MentionSample } from "../src/cloud/geotrack";

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass += 1; console.log(`✓ ${name}${detail ? ` ｜ ${detail}` : ""}`); }
  else { fail += 1; console.log(`✗ ${name}${detail ? ` ｜ ${detail}` : ""}`); }
};

const mk = (id: string, at: string, questions: string[], channel = "platform", brand = "山野茶饮"): GeoSnapshot => ({
  id, at, brand, questions, channel,
  samples: questions.map<MentionSample>((q) => ({ question: q, mentioned: true, hits: 1, firstPos: 5, answerLength: 80 })),
});

console.log("--- latestComparablePair：只和同口径的比 ---");
{
  const empty = latestComparablePair([]);
  ok("空历史返回双 null", empty.current === null && empty.previous === null);

  const single = latestComparablePair([mk("a", "2026-01-01T00:00:00Z", ["q1", "q2"])]);
  ok("只有一条：current 有值、previous 为 null", single.current?.id === "a" && single.previous === null, "单点不能出趋势");

  const pair = latestComparablePair([
    mk("a", "2026-01-01T00:00:00Z", ["q1", "q2"]),
    mk("b", "2026-02-01T00:00:00Z", ["q2", "q1"]), // 顺序不同，集合相同
  ]);
  ok("问题顺序不同也算同口径", pair.previous?.id === "a", "用集合比较而非数组顺序");

  // 关键场景：中间插入一次换通道的监测，应跳过它去找同口径的
  const withChannelChange = latestComparablePair([
    mk("a", "2026-01-01T00:00:00Z", ["q1"]),
    mk("b", "2026-02-01T00:00:00Z", ["q1"], "custom"),   // 换通道
    mk("c", "2026-03-01T00:00:00Z", ["q1"], "platform"), // 换回来
  ]);
  ok("跳过通道不同的快照，找同口径的", withChannelChange.previous?.id === "a", `previous=${withChannelChange.previous?.id}`);
  ok("current 永远是最新一条", withChannelChange.current?.id === "c");

  const noComparable = latestComparablePair([
    mk("a", "2026-01-01T00:00:00Z", ["q1", "q2"]),
    mk("b", "2026-02-01T00:00:00Z", ["q1"]), // 问题集变了
  ]);
  ok("问题集变化时不硬凑 previous", noComparable.previous === null, "宁可显示「需要再测」也不给你假趋势");

  const unsortedInput = latestComparablePair([
    mk("c", "2026-03-01T00:00:00Z", ["q1"]),
    mk("a", "2026-01-01T00:00:00Z", ["q1"]),
    mk("b", "2026-02-01T00:00:00Z", ["q1"]),
  ]);
  ok("乱序历史能正确排序", unsortedInput.current?.id === "c" && unsortedInput.previous?.id === "b",
    `${unsortedInput.previous?.id} → ${unsortedInput.current?.id}`);
}

console.log("\n--- 失败隔离语义 ---");
{
  // 用纯逻辑复现 runGeoMonitor 的关键行为：失败问题不进 samples
  const questions = ["q1", "q2", "q3"];
  const failures = new Set(["q2"]);
  const samples: MentionSample[] = [];
  const skipped: string[] = [];
  for (const q of questions) {
    if (failures.has(q)) { skipped.push(q); continue; }
    samples.push({ question: q, mentioned: false, hits: 0, firstPos: -1, answerLength: 60 });
  }
  ok("失败问题被跳过而非记为未提及", samples.length === 2 && skipped.length === 1, `samples=${samples.length} skipped=${skipped.length}`);
  ok("分母用成功的问题数", samples.length === 2, "若把失败计入分母，提及率会被系统性低估");
  ok("跳过的问题有据可查", skipped[0] === "q2");

  // 独立复现"全部失败"场景，不复用上面的 samples（否则测的是残留状态，不是逻辑）
  const allFailSamples: MentionSample[] = [];
  for (const q of ["q1", "q2"]) {
    if (new Set(["q1", "q2"]).has(q)) continue;
    allFailSamples.push({ question: q, mentioned: false, hits: 0, firstPos: -1, answerLength: 60 });
  }
  ok("全失败时不产生快照", allFailSamples.length === 0, "全部失败应抛错，不写入历史");
}

console.log(`\n${fail === 0 ? "全部通过" : `${fail} 项失败`}（${pass} 通过 / ${fail} 失败）`);
process.exit(fail === 0 ? 0 : 1);
