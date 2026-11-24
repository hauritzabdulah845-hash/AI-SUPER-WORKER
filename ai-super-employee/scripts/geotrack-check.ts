/**
 * GEO 持续监测纯逻辑自检。
 * 关注点：趋势判断不会被单次采样抖动误导、口径不同要拒绝比较、位置归一。
 * 运行：npm run test:geotrack
 */
import {
  analyzeAnswer,
  avgFirstPos,
  avgPositionRatio,
  comparability,
  computeTrend,
  mentionRate,
  pct,
  polylineAttr,
  questionDeltas,
  rateSeries,
  sparklinePoints,
  type GeoSnapshot,
  type MentionSample,
} from "../src/cloud/geotrack";

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass += 1; console.log(`✓ ${name}${detail ? ` ｜ ${detail}` : ""}`); }
  else { fail += 1; console.log(`✗ ${name}${detail ? ` ｜ ${detail}` : ""}`); }
};

const sample = (question: string, mentioned: boolean, hits = mentioned ? 1 : 0, firstPos = mentioned ? 10 : -1, answerLength = 100): MentionSample =>
  ({ question, mentioned, hits, firstPos, answerLength });

const snap = (at: string, samples: MentionSample[], extra: Partial<GeoSnapshot> = {}): GeoSnapshot => ({
  id: `${at}-${samples.length}`,
  at,
  brand: "山野茶饮",
  questions: samples.map((s) => s.question),
  samples,
  channel: "demo",
  ...extra,
});

console.log("--- analyzeAnswer：提及识别 ---");
{
  const r1 = analyzeAnswer("推荐山野茶饮，山野茶饮性价比高。", "山野茶饮");
  ok("识别多次提及", r1.hits === 2 && r1.mentioned, `hits=${r1.hits}`);
  ok("首次位置正确", r1.firstPos === 2, `firstPos=${r1.firstPos}`);

  const r2 = analyzeAnswer("推荐 山野 茶饮，性价比高。", "山野茶饮");
  ok("忽略空格写法差异", r2.mentioned, "全半角/空格不影响判断");

  const r3 = analyzeAnswer("Recommend SHANYE Tea", "shanye tea");
  ok("大小写不敏感", r3.mentioned);

  const r4 = analyzeAnswer("完全没有的品牌", "山野茶饮");
  ok("未出现时 firstPos = -1", !r4.mentioned && r4.firstPos === -1);

  const r5 = analyzeAnswer("任何回答", "");
  ok("空品牌名不误判", !r5.mentioned && r5.hits === 0);

  const r6 = analyzeAnswer("山".repeat(200), "山");
  ok("异常重复有上限", r6.hits <= 99, `hits=${r6.hits}`);
}

console.log("\n--- mentionRate / avgFirstPos / avgPositionRatio ---");
{
  const s = snap("2026-01-01T00:00:00Z", [sample("q1", true), sample("q2", false), sample("q3", true), sample("q4", false)]);
  ok("提及率 = 命中/总数", Math.abs(mentionRate(s) - 0.5) < 1e-9, `${mentionRate(s)}`);
  ok("空样本提及率 0", mentionRate(snap("2026-01-01T00:00:00Z", [])) === 0);

  const hit = snap("2026-01-01T00:00:00Z", [sample("q1", true, 1, 10), sample("q2", true, 1, 30)]);
  ok("平均首次位置", avgFirstPos(hit) === 20, `${avgFirstPos(hit)}`);
  ok("无命中时返回 null", avgFirstPos(snap("2026-01-01T00:00:00Z", [sample("q", false)])) === null);

  const pos = snap("2026-01-01T00:00:00Z", [sample("a", true, 1, 10, 100), sample("b", true, 1, 20, 200)]);
  ok("位置按回答长度归一", Math.abs((avgPositionRatio(pos) ?? 0) - 0.1) < 1e-9, `${avgPositionRatio(pos)}`);
}

console.log("\n--- computeTrend：趋势判断 ---");
{
  const t0 = computeTrend([]);
  ok("无记录 → insufficient", t0.direction === "insufficient" && t0.points === 0);

  const one = computeTrend([snap("2026-01-01T00:00:00Z", [sample("q", true)])]);
  ok("单点 → insufficient（不能凭一次判断趋势）", one.direction === "insufficient" && one.previous === null, one.summary);

  const up = computeTrend([
    snap("2026-01-01T00:00:00Z", [sample("q1", false), sample("q2", false)]),
    snap("2026-02-01T00:00:00Z", [sample("q1", true), sample("q2", true)]),
  ]);
  ok("上升识别正确", up.direction === "up" && Math.abs((up.delta ?? 0) - 1) < 1e-9, up.summary);

  const down = computeTrend([
    snap("2026-01-01T00:00:00Z", [sample("q1", true), sample("q2", true)]),
    snap("2026-02-01T00:00:00Z", [sample("q1", true), sample("q2", false)]),
  ]);
  ok("下降识别正确", down.direction === "down" && Math.abs((down.delta ?? 0) + 0.5) < 1e-9, down.summary);

  // 关键：1% 以内视为持平，否则每次采样抖动都会显示"下降"
  const flat = computeTrend([
    snap("2026-01-01T00:00:00Z", Array.from({ length: 100 }, (_, i) => sample(`q${i}`, i < 50))),
    snap("2026-02-01T00:00:00Z", Array.from({ length: 100 }, (_, i) => sample(`q${i}`, i < 51))),
  ]);
  ok("1% 抖动视为持平（epsilon 生效）", flat.direction === "flat", flat.summary);

  // 乱序输入也要按时间排
  const unsorted = computeTrend([
    snap("2026-03-01T00:00:00Z", [sample("q", true)]),
    snap("2026-01-01T00:00:00Z", [sample("q", false)]),
    snap("2026-02-01T00:00:00Z", [sample("q", false)]),
  ]);
  ok("乱序快照按时间排序", unsorted.current === 1, `current=${unsorted.current}`);
}

console.log("\n--- questionDeltas：逐条得失 ---");
{
  const prev = snap("2026-01-01T00:00:00Z", [sample("q1", true), sample("q2", false), sample("q3", true)]);
  const cur = snap("2026-02-01T00:00:00Z", [sample("q1", true), sample("q2", true), sample("q3", false), sample("q4", true)]);
  const d = questionDeltas(prev, cur);
  ok("保持命中", d.find((x) => x.question === "q1")?.change === "stable-hit");
  ok("新增命中", d.find((x) => x.question === "q2")?.change === "gained", "上次没提、这次提了 = 最有价值的信号");
  ok("丢失命中", d.find((x) => x.question === "q3")?.change === "lost", "上次提了、这次没提 = 最需要警惕");
  ok("新问题标记 new", d.find((x) => x.question === "q4")?.change === "new");
  ok("无历史时全为 new", questionDeltas(null, cur).every((x) => x.change === "new"));
}

console.log("\n--- 序列 / sparkline ---");
{
  const list = [
    snap("2026-02-01T00:00:00Z", [sample("q", true), sample("q2", true)]),
    snap("2026-01-01T00:00:00Z", [sample("q", false), sample("q2", false)]),
  ];
  ok("序列按时间升序", JSON.stringify(rateSeries(list)) === "[0,1]", JSON.stringify(rateSeries(list)));

  const pts = sparklinePoints([0, 0.5, 1], 100, 50, 5);
  ok("点数与数据一致", pts.length === 3);
  ok("首点 x = padding", pts[0].x === 5, `x=${pts[0].x}`);
  ok("末点 x = width - padding", pts[2].x === 95, `x=${pts[2].x}`);
  ok("0 提及率在底部", pts[0].y === 45, `y=${pts[0].y}`);
  ok("100% 提及率在顶部", pts[2].y === 5, `y=${pts[2].y}`);
  ok("超范围值被夹紧", sparklinePoints([-1, 2], 100, 50, 5).every((p) => p.y >= 5 && p.y <= 45));
  ok("单点居中", sparklinePoints([0.5], 100, 50, 5)[0].x === 50);
  ok("空序列返回空", sparklinePoints([], 100, 50).length === 0);
  ok("polyline 输出格式", polylineAttr([{ x: 1, y: 2, rate: 0 }, { x: 3, y: 4, rate: 1 }]) === "1,2 3,4");
}

console.log("\n--- comparability：口径守卫 ---");
{
  const a = snap("2026-01-01T00:00:00Z", [sample("q1", true)]);
  const bSame = snap("2026-02-01T00:00:00Z", [sample("q1", false)]);
  ok("同通道同问题集可比较", comparability(a, bSame).ok);

  const bChannel = snap("2026-02-01T00:00:00Z", [sample("q1", false)], { channel: "deepseek" });
  const c1 = comparability(a, bChannel);
  ok("换通道拒绝比较", !c1.ok && c1.reason.includes("通道"), c1.reason);

  const bQuestions = snap("2026-02-01T00:00:00Z", [sample("q1", true), sample("q9", true)]);
  const c2 = comparability(a, bQuestions);
  ok("问题集变化拒绝比较", !c2.ok && c2.reason.includes("问题"), c2.reason);
}

console.log("\n--- pct 格式化 ---");
{
  ok("0 → 0%", pct(0) === "0%");
  ok("0.667 → 67%", pct(0.667) === "67%");
  ok("1 → 100%", pct(1) === "100%");
}

console.log(`\n${fail === 0 ? "全部通过" : `${fail} 项失败`}（${pass} 通过 / ${fail} 失败）`);
process.exit(fail === 0 ? 0 : 1);
