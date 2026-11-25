/**
 * GEO 拓词与选题纯逻辑自检（第 26 批）。
 * 关注点：种子词解析、降级拓词分组完整、去重、选题大纲与 Markdown 导出。
 * 运行：npm run test:geokeywords
 */
import {
  dedupeKeywords,
  fallbackExpandKeywords,
  fallbackTopics,
  groupKeywords,
  groupStats,
  normalizeKeyword,
  parseSeedWords,
  topicsMarkdown,
  GEO_KEYWORD_INTENTS,
  type GeoKeyword,
} from "../src/cloud/geokeywords";

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass += 1; console.log(`✓ ${name}${detail ? ` ｜ ${detail}` : ""}`); }
  else { fail += 1; console.log(`✗ ${name}${detail ? ` ｜ ${detail}` : ""}`); }
};

console.log("--- parseSeedWords：种子词解析 ---");
{
  ok("逗号/顿号/空格混合分隔", JSON.stringify(parseSeedWords("现煮茶饮, 下午茶、奶茶  咖啡")) === JSON.stringify(["现煮茶饮", "下午茶", "奶茶", "咖啡"]));
  ok("去重保序（大小写不敏感）", JSON.stringify(parseSeedWords("Tea, tea, 茶")) === JSON.stringify(["Tea", "茶"]));
  ok("空输入返回空", parseSeedWords("  ,， ").length === 0);
  ok("种子词上限 8", parseSeedWords(Array.from({ length: 20 }, (_, i) => `词${i}`).join(",")).length === 8);
}

console.log("\n--- normalizeKeyword / dedupeKeywords ---");
{
  ok("非法意图兜底咨询", normalizeKeyword({ word: "x", intent: "乱写" as never })?.intent === "咨询");
  ok("非法优先级兜底中", normalizeKeyword({ word: "x", priority: "急" as never })?.priority === "中");
  ok("空词返回 null", normalizeKeyword({ word: "  " }) === null);
  const list: GeoKeyword[] = [
    { word: "茶饮哪家好", intent: "选型", priority: "高" },
    { word: "茶饮 哪家好", intent: "选型", priority: "中" },
    { word: "茶饮哪家好", intent: "咨询", priority: "低" },
    { word: "茶饮多少钱", intent: "咨询", priority: "中" },
  ];
  ok("去重忽略空格且保序", dedupeKeywords(list).length === 2 && dedupeKeywords(list)[0].priority === "高");
  ok("去重上限截断", dedupeKeywords(Array.from({ length: 80 }, (_, i) => ({ word: `词${i}`, intent: "咨询" as const, priority: "中" as const })), 10).length === 10);
}

console.log("\n--- fallbackExpandKeywords：模板降级拓词 ---");
{
  const result = fallbackExpandKeywords(["现煮茶饮"]);
  ok("降级标注 demo", result.demo === true);
  ok("五类意图全覆盖", result.groups.every((g) => g.keywords.length > 0), result.groups.map((g) => `${g.intent}${g.keywords.length}`).join(" "));
  ok("分组顺序固定", JSON.stringify(result.groups.map((g) => g.intent)) === JSON.stringify([...GEO_KEYWORD_INTENTS]));
  ok("选型词为高优先级", result.keywords.some((k) => k.intent === "选型" && k.priority === "高"));
  ok("词面带种子词", result.keywords.every((k) => k.word.includes("现煮茶饮")));
  const stats = groupStats(result.groups);
  ok("分组统计合计 = 总词数", stats.reduce((sum, s) => sum + s.count, 0) === result.keywords.length);
  ok("空种子词返回空结果", fallbackExpandKeywords([]).keywords.length === 0);
}

console.log("\n--- fallbackTopics / topicsMarkdown ---");
{
  const keywords: GeoKeyword[] = [
    { word: "现煮茶饮哪家靠谱", intent: "选型", priority: "高" },
    { word: "现煮茶饮是什么", intent: "咨询", priority: "低" },
  ];
  const result = fallbackTopics(keywords);
  ok("选题降级标注 demo", result.demo === true);
  ok("高优先级排前面", result.topics[0].keyword === "现煮茶饮哪家靠谱");
  ok("每题有 3-5 个小节", result.topics.every((t) => t.sections.length >= 3 && t.sections.length <= 5));
  ok("目标问题是问句", result.topics.every((t) => t.targetQuestion.endsWith("？")));
  const md = topicsMarkdown({ brand: "山野茶饮", topics: result.topics, demo: true });
  ok("Markdown 含品牌与选题", md.includes("山野茶饮") && md.includes("现煮茶饮哪家靠谱"));
  ok("Markdown 标注降级", md.includes("模板降级"));
  ok("Markdown 含大纲小节", md.includes(result.topics[0].sections[0]));
  ok("groupKeywords 空组保留", groupKeywords([]).length === 5 && groupKeywords([]).every((g) => g.keywords.length === 0));
}

console.log(`\n${fail === 0 ? "全部通过" : `${fail} 项失败`}（${pass} 通过 / ${fail} 失败）`);
process.exit(fail === 0 ? 0 : 1);
