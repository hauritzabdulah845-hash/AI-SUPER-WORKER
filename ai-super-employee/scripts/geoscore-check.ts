/**
 * GEO 指标体系纯逻辑自检（第 27 批）。
 * 关注点：推荐语境判定（否定优先）、首推判定（并列不算）、样本可信度、意图五层归类、
 *        竞品排名口径、信源缺口（自有域名边界）、内容可引用性体检、Brief 结构、报告导出。
 * 运行：npm run test:geoscore
 */
import {
  auditReadability,
  brandFirstPos,
  brandHits,
  brandStandings,
  buildBrief,
  buildIntentBuckets,
  classifyIntent,
  coverageGaps,
  evalAnswer,
  geoScoreMarkdown,
  hostOf,
  intentLabel,
  isOwnSource,
  recommendSignal,
  sampleAdvice,
  sourceGap,
  summarize,
  type BrandEval,
  type GeoScoreExport,
} from "../src/cloud/geoscore";
import { bucketsOfSnapshot, legacyEvals, metricsOfSnapshot } from "../src/cloud/geomonitor";

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass += 1; console.log(`✓ ${name}${detail ? ` ｜ ${detail}` : ""}`); }
  else { fail += 1; console.log(`✗ ${name}${detail ? ` ｜ ${detail}` : ""}`); }
};

const blank = (brand: string): BrandEval => ({
  brand, mentioned: false, hits: 0, firstPos: -1, recommended: false,
  polarity: "neutral", top: false, answerLength: 60,
});

console.log("--- 品牌定位基础 ---");
{
  ok("首次位置忽略空格与大小写", brandFirstPos("我推荐 Brand X 吧", "brandx") === 3);
  ok("未出现返回 -1", brandFirstPos("完全无关的回答", "山野茶饮") === -1);
  ok("空品牌名不误判", brandFirstPos("任意文本", "  ") === -1);
  ok("重复出现计数", brandHits("茶饮好，茶饮妙，茶饮顶", "茶饮") === 3);
  ok("计数封顶 99", brandHits("甲".repeat(300), "甲") === 99);
}

console.log("\n--- 推荐语境判定（否定优先） ---");
{
  ok("正向推荐判 positive", recommendSignal("首推山野茶饮，性价比高", "山野茶饮") === "positive");
  ok("「不推荐」判 negative 而不是 positive", recommendSignal("不推荐山野茶饮，口碑差", "山野茶饮") === "negative", "「不推荐」里含「推荐」，必须先查否定");
  ok("「需谨慎」判 negative", recommendSignal("选择山野茶饮需谨慎，有退费纠纷", "山野茶饮") === "negative");
  ok("纯陈述判 neutral", recommendSignal("市面上有山野茶饮这样的品牌。", "山野茶饮") === "neutral");
  ok("未提及一律 neutral", recommendSignal("推荐别人家", "山野茶饮") === "neutral");
  ok("语境窗口有限，远处负面不牵连", recommendSignal("山野茶饮很好用。".padEnd(200, "补") + "另一家不推荐", "山野茶饮") === "positive");
}

console.log("\n--- 首推判定 ---");
{
  const a = evalAnswer("首推山野茶饮，其次是竞品甲。", "山野茶饮", ["竞品甲"]);
  ok("排在竞品前算首推", a.self.top && !a.competitors[0].top);
  ok("被推荐才算推荐率", a.self.recommended && a.self.polarity === "positive");
  ok("竞品信号同时产出", a.competitors[0].mentioned && a.competitors[0].firstPos > a.self.firstPos);

  const b = evalAnswer("先看竞品甲，山野茶饮也可以。", "山野茶饮", ["竞品甲"]);
  ok("被竞品压后不算首推", !b.self.top && b.competitors[0].top, `selfPos=${b.self.firstPos}`);

  const c = evalAnswer("山野茶饮和竞品甲哪个好？", "山野茶饮", ["竞品甲"]);
  ok("二者均未提及首推（此处均命中）", c.self.mentioned && c.competitors[0].mentioned);
  ok("先出现者拿首推", c.self.top, "同句先出现者胜出，规则确定可复现");

  const d = evalAnswer("完全不提品牌", "山野茶饮", ["竞品甲"]);
  ok("全未提及时不产生首推", !d.self.top && !d.competitors[0].top);
  ok("空竞品名被过滤", evalAnswer("甲", "山野茶饮", [" ", ""]).competitors.length === 0);
  ok("品牌名当竞品时自动剔除", evalAnswer("甲", "山野茶饮", ["山野茶饮"]).competitors.length === 0);
}

console.log("\n--- 指标汇总 ---");
{
  const evals: BrandEval[] = [
    { ...blank("本"), mentioned: true, hits: 2, firstPos: 2, recommended: true, polarity: "positive", top: true },
    { ...blank("本"), mentioned: true, hits: 1, firstPos: 30, recommended: false, polarity: "neutral", top: false },
    { ...blank("本"), mentioned: true, hits: 1, firstPos: 5, recommended: false, polarity: "negative", top: false },
    { ...blank("本") },
  ];
  const m = summarize(evals);
  ok("提及率按命中/样本", m.mentionRate === 0.75, `${m.mentionRate}`);
  ok("推荐率只算正向", m.recommendRate === 0.25, `${m.recommendRate}`);
  ok("首推率只算排第一", m.topRate === 0.25, `${m.topRate}`);
  ok("负面率单独统计", m.negativeRate === 0.25, `${m.negativeRate}`);
  ok("平均首次位置只算命中", m.avgFirstPos === 12.3, `${m.avgFirstPos}`);
  ok("样本数为 0 不除零", summarize([]).mentionRate === 0 && summarize([]).avgFirstPos === null);
  ok("比率保留 3 位小数", summarize([{ ...blank("本"), mentioned: true }, blank("本"), blank("本")]).mentionRate === 0.333);
}

console.log("\n--- 样本可信度 ---");
{
  ok("1 条判 insufficient", sampleAdvice(1).adequacy === "insufficient");
  ok("insufficient 明确不可当结论", sampleAdvice(1).label.includes("不能当作效果结论"));
  ok("5 条判 weak 并给建议数", sampleAdvice(5).adequacy === "weak" && sampleAdvice(5).suggested === 8);
  ok("8 条判 ok", sampleAdvice(8).adequacy === "ok");
}

console.log("\n--- 意图五层归类 ---");
{
  ok("是什么 → L1", classifyIntent("GEO 是什么意思？") === "L1");
  ok("怎么做 → L2", classifyIntent("GEO 具体怎么做？") === "L2");
  ok("哪家好 → L3", classifyIntent("现煮茶饮哪家比较靠谱？") === "L3");
  ok("多少钱 → L4", classifyIntent("企业做 GEO 多少钱？") === "L4");
  ok("踩坑 → L5", classifyIntent("做 GEO 有哪些坑？") === "L5");
  ok("退费优先落 L5 而非 L4", classifyIntent("这家退费吗") === "L5", "退款类属口碑风险层");
  ok("无法归类落 L3", classifyIntent("嗯") === "L3");
  ok("层级标签可读", intentLabel("L3") === "评估");
  ok("全角空格不影响归类", classifyIntent("哪　家　好") === "L3");
}

console.log("\n--- 问题矩阵汇总 ---");
{
  const rows = [
    { question: "GEO 是什么意思？", self: { ...blank("本"), mentioned: true, top: true, recommended: true, polarity: "positive" as const, firstPos: 1 } },
    { question: "现煮茶饮哪家好？", self: { ...blank("本"), mentioned: false } },
    { question: "GEO 多少钱？", self: { ...blank("本"), mentioned: false } },
  ];
  const buckets = buildIntentBuckets(rows);
  ok("五层固定输出（空层保留）", buckets.length === 5);
  ok("L1 归到 1 条", buckets[0].count === 1, `${buckets[0].count}`);
  ok("L1 提及率 100%", buckets[0].mentionRate === 1);
  ok("L3 提及率 0%", buckets[2].count === 1 && buckets[2].mentionRate === 0);
  ok("空层比率为 0 且有问题数为 0", buckets[1].count === 0 && buckets[1].mentionRate === 0);

  const gaps = coverageGaps(buckets);
  ok("缺口只列不足层", gaps.length === 5, `${gaps.map((g) => g.level).join(",")}`);
  ok("完全没覆盖标记 empty", gaps.some((g) => g.empty && g.level === "L2"));
  ok("覆盖足够时不报缺口", coverageGaps(buckets, 1).length === 2, "只剩完全没覆盖的 L2/L5");
}

console.log("\n--- 竞品排名口径 ---");
{
  const evals = [
    { self: { ...blank("本"), mentioned: true, top: false, recommended: true, polarity: "positive" as const, firstPos: 20 },
      competitors: [{ ...blank("竞品甲"), mentioned: true, top: true, recommended: true, polarity: "positive" as const, firstPos: 2 }] },
    { self: { ...blank("本"), mentioned: true, top: false, recommended: false, polarity: "neutral" as const, firstPos: 30 },
      competitors: [{ ...blank("竞品甲"), mentioned: true, top: true, recommended: true, polarity: "positive" as const, firstPos: 1 }] },
  ];
  const rows = brandStandings("本", ["竞品甲"], evals);
  ok("本品牌置顶输出", rows[0].isSelf);
  ok("竞品靠首推率排第一", rows[1].rank === 1 && rows[0].rank === 2, `selfRank=${rows[0].rank}`);
  ok("差值以本品牌为基准", rows[0].deltaTop === 0 && rows[1].deltaTop === 1);
  ok("推荐率差值同步", rows[1].deltaRecommend === 0.5, `${rows[1].deltaRecommend}`);
  ok("竞品缺席时按未提及计", (() => {
    const r = brandStandings("本", ["竞品乙"], [{ self: { ...blank("本"), mentioned: true, top: true }, competitors: [] }]);
    return r[1].metrics.mentionRate === 0 && r[0].rank === 1;
  })());
}

console.log("\n--- 信源缺口 ---");
{
  ok("URL 取域名去 www", hostOf("https://www.example.com/a/b") === "example.com");
  ok("带端口去端口", hostOf("https://example.com:8080/x") === "example.com");
  ok("纯文本返回空", hostOf("某某新闻网") === "");
  ok("自有域名直配", isOwnSource("https://example.com/a", "example.com"));
  ok("子域名算自有", isOwnSource("https://blog.example.com/a", "example.com"));
  ok("同后缀不同域不算自有", !isOwnSource("https://evil-example.com/a", "example.com"), "防后缀误判");
  ok("带协议的自有域名输入可处理", isOwnSource("https://www.example.com/a", "https://www.example.com/"));

  const rows = [
    { source: "https://example.com/a", count: 2 },
    { source: "https://news.example.org/b", count: 5 },
  ];
  const gap = sourceGap(rows, "example.com");
  ok("自有/第三方分离统计", gap.ownCount === 2 && gap.thirdPartyCount === 5);
  ok("自有占比计算", gap.ownRatio === 0.286, `${gap.ownRatio}`);
  ok("自有占比低时给站外建议", gap.verdict.includes("补站外信源"), gap.verdict);
  ok("未配域名时不误判为 0", sourceGap(rows, "").verdict.includes("未填写自有域名"));
  ok("无数据时提示先监测", sourceGap([], "example.com").verdict.includes("先跑一次监测"));
  ok("自有占比高时给正向结论", sourceGap([{ source: "https://example.com/a", count: 9 }], "example.com").verdict.includes("保持更新节奏"));
  ok("TOP 最多 5 条", sourceGap(Array.from({ length: 8 }, (_, i) => ({ source: `https://s${i}.com`, count: i })), "x.com").top.length === 5);
}

console.log("\n--- 内容可引用性体检 ---");
{
  ok("空内容 0 分并给提示", auditReadability("").score === 0 && auditReadability("   ").findings.length === 1);

  const bad = "我们是一家很好的公司，服务很多客户，价格实惠，欢迎大家咨询。";
  const badResult = auditReadability(bad);
  ok("无数字无结论判低分", badResult.score < 60, `score=${badResult.score}`);
  ok("事实密度指出缺数字", badResult.findings.find((f) => f.key === "facts")!.score < 70);
  ok("结论先行不达标", badResult.findings.find((f) => f.key === "conclusion")!.score === 30);
  ok("低分项给具体修法", badResult.findings.filter((f) => f.score < 70).every((f) => Boolean(f.fix)));

  const good = [
    "# 现煮茶饮怎么选（2026 年 11 月更新）",
    "结论：单店日销 80 杯以下不建议上现煮设备。",
    "",
    "## 选型要看 4 个指标",
    "- 出杯速度：800 杯/小时为及格线",
    "- 单杯成本：控制在 3.2 元以内",
    "- 保养周期：建议 30 天一次",
    "- 售后响应：24 小时内上门",
    "",
    "## 常见问题",
    "Q：现煮茶饮设备多少钱？",
    "A：主流区间 1.8 万-3.5 万，含 2 年保修。",
    "Q：和竞品比贵吗？",
    "A：单杯成本低 0.4 元，一年回本。",
  ].join("\n");
  const goodResult = auditReadability(good);
  ok("结构化内容得高分", goodResult.score >= 80, `score=${goodResult.score}`);
  ok("结论先行达标", goodResult.findings.find((f) => f.key === "conclusion")!.score === 100);
  ok("FAQ 提升问答对齐", goodResult.findings.find((f) => f.key === "qa")!.score === 100);
  ok("日期标记达标", goodResult.findings.find((f) => f.key === "fresh")!.score === 100);
  ok("超长段落扣分", auditReadability("啊".repeat(400)).findings.find((f) => f.key === "grain")!.score < 100);
  ok("同一内容两次体检同分（可复算）", auditReadability(good).score === goodResult.score);
}

console.log("\n--- 内容 Brief ---");
{
  const brief = buildBrief({ brand: "山野茶饮", question: "现煮茶饮设备哪家好？", competitors: ["竞品甲"], facts: ["基础版：1.8 万元"] });
  ok("意图归类为评估层", brief.intent === "L3" && brief.intentLabel === "评估");
  ok("标题含品牌与问题", brief.title.includes("山野茶饮") && brief.title.includes("现煮茶饮设备哪家好"));
  ok("问号被清理", !brief.title.includes("？？"));
  ok("段落数固定为 4", brief.sections.length === 4);
  ok("每段至少 1 个要点", brief.sections.every((s) => s.points.length >= 1));
  ok("事实卡进入必须包含", brief.mustInclude.some((item) => item.includes("1.8 万元")));
  ok("强制要求品牌与品类同句", brief.mustInclude.some((item) => item.includes("同句")));
  ok("竞品进入禁止事项（不贬损）", brief.mustAvoid.some((item) => item.includes("竞品甲") && item.includes("不")));
  ok("绝对化表述被禁", brief.mustAvoid.some((item) => item.includes("行业第一")));
  ok("字数目标按层不同", buildBrief({ brand: "x", question: "这是什么" }).wordTarget === 1200);
  ok("未知层沿用 L3 兜底", buildBrief({ brand: "x", question: "嗯" }).intent === "L3");
  ok("空品牌不产出空标题", buildBrief({ brand: "", question: "哪家好" }).title.includes("本品牌"));
  ok("事实超出 6 条被截断", buildBrief({ brand: "x", question: "哪家好", facts: Array.from({ length: 10 }, (_, i) => `f${i}`) }).mustInclude.filter((i) => /^f\d$/.test(i)).length === 6);
}

console.log("\n--- 报告导出 ---");
{
  const empty: GeoScoreExport = {
    brand: "", ownDomain: "", standings: [], buckets: buildIntentBuckets([]),
    gaps: coverageGaps(buildIntentBuckets([])), samples: sampleAdvice(0),
    sources: null, readability: null, briefs: [],
  };
  const md = geoScoreMarkdown(empty);
  ok("空报告写「未测」而不是留空", md.includes("未测"));
  ok("空品牌有占位名", md.includes("未命名品牌"));
  ok("报告声明样本纪律", md.includes("样本不足时不给效果结论"));

  const full: GeoScoreExport = {
    ...empty,
    brand: "山野茶饮",
    ownDomain: "example.com",
    samples: sampleAdvice(10),
    standings: brandStandings("山野茶饮", ["竞品甲"], []),
    sources: sourceGap([{ source: "https://example.com/a", count: 3 }], "example.com"),
    readability: auditReadability("结论：可以。2026 年 11 月更新，价格 3 元。"),
    briefs: [buildBrief({ brand: "山野茶饮", question: "哪家好？" })],
  };
  const fullMd = geoScoreMarkdown(full);
  ok("报告含指标表", fullMd.includes("| 品牌 | 提及率 | 推荐率 | 首推率 |"));
  ok("报告含五层覆盖表", fullMd.includes("L3 评估"));
  ok("报告含信源结论", fullMd.includes("自有站点"));
  ok("报告含体检修法", fullMd.includes("修法："));
  ok("报告含 Brief 红线", fullMd.includes("禁止："));
  ok("报告标注样本量", fullMd.includes("10 条问题"));
}

console.log("\n--- 旧快照兼容（第 27 批新增字段为可选） ---");
{
  const legacySnap = {
    id: "old-1", at: "2026-11-01T00:00:00.000Z", brand: "山野茶饮",
    channel: "platform",
    questions: ["现煮茶饮哪家好？", "GEO 是什么？"],
    samples: [
      { question: "现煮茶饮哪家好？", mentioned: true, hits: 2, firstPos: 8, answerLength: 120,
        competitors: [{ brand: "竞品甲", mentioned: true, hits: 1, firstPos: 30 }] },
      { question: "GEO 是什么？", mentioned: false, hits: 0, firstPos: -1, answerLength: 90 },
    ],
  };
  const rows = legacyEvals(legacySnap);
  ok("旧快照可还原逐条评估", rows.length === 2 && rows.every((row) => row.legacy));
  ok("提及还原准确", rows[0].self.mentioned && !rows[1].self.mentioned);
  ok("首推可还原（排在竞品前）", rows[0].self.top === true);
  ok("推荐率不冒充有数据", rows[0].self.recommended === false);
  ok("未命中不判首推", rows[1].self.top === false);

  const metricView = metricsOfSnapshot(legacySnap);
  ok("旧快照指标标记 legacy", metricView.legacy === true);
  ok("旧快照提及率正确", metricView.metrics?.mentionRate === 0.5, `${metricView.metrics?.mentionRate}`);
  ok("旧快照首推率正确", metricView.metrics?.topRate === 0.5);
  ok("旧快照推荐率如实为 0", metricView.metrics?.recommendRate === 0);

  const newSnap = { ...legacySnap, metrics: summarize(rows.map((r) => r.self)), buckets: buildIntentBuckets(rows) };
  ok("新快照直接用落库指标", metricsOfSnapshot(newSnap).legacy === false);
  ok("新快照五层覆盖直接用落库值", bucketsOfSnapshot(newSnap).legacy === false && bucketsOfSnapshot(newSnap).buckets.length === 5);
  ok("旧快照五层覆盖可重建", bucketsOfSnapshot(legacySnap).legacy === true && bucketsOfSnapshot(legacySnap).buckets.length === 5);
  ok("空快照不报错", metricsOfSnapshot(null).metrics === null && bucketsOfSnapshot(null).buckets.length === 0);
}

console.log(`\n全部通过（${pass} 通过 / ${fail} 失败）`);
if (fail > 0) process.exit(1);
