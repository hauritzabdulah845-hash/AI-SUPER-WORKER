/**
 * GEO 竞品对比 + 引用来源纯逻辑自检（第 26 批）。
 * 关注点：多品牌同尺子分析、对比差值与排名、来源解析不编造、旧快照兼容降级。
 * 运行：npm run test:geocompare
 */
import {
  analyzeAnswerMulti,
  buildCompetitorStats,
  competitorComparison,
  extractSources,
  mentionRate,
  rateSeriesFor,
  sourceKey,
  sourceRanking,
  type GeoSnapshot,
  type MentionSample,
} from "../src/cloud/geotrack";

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass += 1; console.log(`✓ ${name}${detail ? ` ｜ ${detail}` : ""}`); }
  else { fail += 1; console.log(`✗ ${name}${detail ? ` ｜ ${detail}` : ""}`); }
};

const sample = (question: string, mentioned: boolean, extra: Partial<MentionSample> = {}): MentionSample => ({
  question, mentioned, hits: mentioned ? 1 : 0, firstPos: mentioned ? 10 : -1, answerLength: 100, ...extra,
});

const snap = (at: string, samples: MentionSample[], extra: Partial<GeoSnapshot> = {}): GeoSnapshot => ({
  id: `${at}-${samples.length}`, at, brand: "山野茶饮",
  questions: samples.map((s) => s.question), samples, channel: "demo", ...extra,
});

console.log("--- analyzeAnswerMulti：多品牌同尺子 ---");
{
  const answer = "首选山野茶饮，其次竞品甲，竞品甲也不错。";
  const multi = analyzeAnswerMulti(answer, ["山野茶饮", "竞品甲", "竞品乙"]);
  ok("三品牌都出信号", multi.length === 3);
  ok("本品牌命中且位置最前", multi[0].mentioned && multi[0].firstPos === 2, `pos=${multi[0].firstPos}`);
  ok("竞品多次命中计数", multi[1].hits === 2, `hits=${multi[1].hits}`);
  ok("未出现竞品不误判", !multi[2].mentioned && multi[2].firstPos === -1);
  ok("重复/空品牌去重", analyzeAnswerMulti(answer, ["竞品甲", "竞品甲", " ", ""]).length === 1);
}

console.log("\n--- buildCompetitorStats / competitorComparison ---");
{
  const samples: MentionSample[] = [
    sample("q1", true, { competitors: [{ brand: "竞品甲", mentioned: true, hits: 1, firstPos: 20 }] }),
    sample("q2", false, { competitors: [{ brand: "竞品甲", mentioned: true, hits: 1, firstPos: 40 }] }),
    sample("q3", true, { competitors: [{ brand: "竞品甲", mentioned: false, hits: 0, firstPos: -1 }] }),
    sample("q4", false, { competitors: [{ brand: "竞品甲", mentioned: false, hits: 0, firstPos: -1 }] }),
  ];
  const stats = buildCompetitorStats(samples, ["竞品甲"]);
  ok("竞品提及率 2/4", stats[0].mentionRate === 0.5, `${stats[0].mentionRate}`);
  ok("竞品平均首位 30", stats[0].firstPos === 30, `${stats[0].firstPos}`);
  ok("竞品上限 3 个", buildCompetitorStats(samples, ["a", "b", "c", "d"]).length === 3);

  const snapshot = snap("2026-01-01T00:00:00Z", samples, { competitors: stats });
  const rows = competitorComparison(snapshot);
  ok("对比表本品牌置顶", rows[0].isSelf && rows.length === 2);
  ok("同率差值为 0", rows[1].deltaRate === 0, `${rows[1].deltaRate}`);
  ok("名次已算", rows.every((r) => r.rank >= 1));

  const weaker = snap("2026-01-01T00:00:00Z", [sample("q1", true), sample("q2", true)], {
    competitors: [{ brand: "竞品甲", mentionRate: 0.5, firstPos: 5 }],
  });
  const rows2 = competitorComparison(weaker);
  ok("竞品弱于本品牌差值为负", rows2[1].deltaRate === -0.5, `${rows2[1].deltaRate}`);
  ok("本品牌名次第 1", rows2.find((r) => r.isSelf)?.rank === 1);

  // 旧快照兼容：没有 competitors 字段
  const legacy = snap("2025-12-01T00:00:00Z", [sample("q1", true)]);
  const legacyRows = competitorComparison(legacy);
  ok("旧快照只回本品牌一行", legacyRows.length === 1 && legacyRows[0].isSelf);
  ok("旧快照提及率不受影响", mentionRate(legacy) === 1);
}

console.log("\n--- rateSeriesFor：多品牌趋势序列 ---");
{
  const list = [
    snap("2026-02-01T00:00:00Z", [sample("q", true)], { competitors: [{ brand: "竞品甲", mentionRate: 0.25, firstPos: 3 }] }),
    snap("2026-01-01T00:00:00Z", [sample("q", false)], { competitors: [{ brand: "竞品甲", mentionRate: 0.75, firstPos: 3 }] }),
  ];
  ok("本品牌序列按时间升序", JSON.stringify(rateSeriesFor(list, "山野茶饮")) === "[0,1]");
  ok("竞品序列取快照汇总", JSON.stringify(rateSeriesFor(list, "竞品甲")) === "[0.75,0.25]");
  ok("无此品牌序列为 0", JSON.stringify(rateSeriesFor(list, "不存在")) === "[0,0]");
}

console.log("\n--- extractSources：来源解析不编造 ---");
{
  ok("URL 提取", extractSources("推荐山野茶饮。来源：https://example.com/a").includes("https://example.com/a"));
  ok("来源段落多项拆分", extractSources("结论如上。\n来源：知乎专栏、小红书笔记").length === 2);
  ok("序号前缀去掉", extractSources("来源：1. 知乎专栏").some((s) => s === "知乎专栏"));
  ok("无来源返回空", extractSources("推荐山野茶饮，性价比高。").length === 0);
  ok("来源：无 不算来源", extractSources("推荐山野茶饮。来源：无").length === 0);
  ok("去重", extractSources("来源：知乎、知乎").length === 1);
  ok("上限截断", extractSources(`来源：${Array.from({ length: 20 }, (_, i) => `站${i}`).join("、")}`, 5).length === 5);
  ok("sourceKey 域名归并", sourceKey("https://www.zhihu.com/p/1") === "zhihu.com");
  ok("sourceKey 文本归一", sourceKey("知乎 专栏") === "知乎专栏");
}

console.log("\n--- sourceRanking：信源排行 ---");
{
  const withSources = snap("2026-01-01T00:00:00Z", [sample("q1", true), sample("q2", true)], {
    sources: [
      { question: "q1", sources: ["https://www.zhihu.com/p/1", "小红书笔记"] },
      { question: "q2", sources: ["https://zhihu.com/p/2"] },
    ],
  });
  const ranking = sourceRanking([withSources]);
  ok("同域名归并计数", ranking[0].count === 2 && ranking[0].source.includes("zhihu"), JSON.stringify(ranking));
  ok("排行降序", ranking.every((row, i) => i === 0 || ranking[i - 1].count >= row.count));

  const legacy = snap("2025-12-01T00:00:00Z", [sample("q1", true)]);
  ok("旧快照无来源排行空", sourceRanking([legacy]).length === 0);

  const sampleLevel = snap("2026-01-02T00:00:00Z", [sample("q1", true, { sources: ["知乎专栏"] })]);
  ok("样本级来源可回退统计", sourceRanking([sampleLevel])[0]?.source === "知乎专栏");
  ok("TOP 上限", sourceRanking([withSources], 1).length === 1);
}

console.log(`\n${fail === 0 ? "全部通过" : `${fail} 项失败`}（${pass} 通过 / ${fail} 失败）`);
process.exit(fail === 0 ? 0 : 1);
