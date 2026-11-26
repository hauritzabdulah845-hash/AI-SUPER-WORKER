/**
 * GEO 词库与问题集纯逻辑自检（第 28 批，评审 P1）。
 * 关注点：合并去重/优先级保留、删除、统计、转问题、问题集去重合并/上限/粘贴拆条、本机存取往返。
 * 运行：npm run test:keywordlibrary
 */
import {
  brandStorageKey,
  keywordKey,
  libraryStats,
  loadLibrary,
  loadQuestions,
  mergeKeywords,
  mergeQuestionItems,
  normalizeLibraryEntry,
  parsePastedQuestions,
  questionKey,
  removeKeyword,
  saveLibrary,
  saveQuestions,
  setPriority,
  toLibraryEntry,
  toQuestions,
  type KeywordLibraryEntry,
  type StorageLike,
} from "../src/cloud/keywordLibrary";
import { wordToQuestion } from "../src/cloud/geokeywords";

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass += 1; console.log(`✓ ${name}${detail ? ` ｜ ${detail}` : ""}`); }
  else { fail += 1; console.log(`✗ ${name}${detail ? ` ｜ ${detail}` : ""}`); };
};

function memoryStorage(): StorageLike & { dump: Map<string, string> } {
  const dump = new Map<string, string>();
  return {
    dump,
    getItem: (key) => dump.get(key) ?? null,
    setItem: (key, value) => { dump.set(key, value); },
  };
}

const entry = (word: string, priority: "高" | "中" | "低", intent: KeywordLibraryEntry["intent"] = "咨询", extra: Partial<KeywordLibraryEntry> = {}): KeywordLibraryEntry => ({
  word, intent, priority, addedAt: "2026-11-26T00:00:00.000Z", source: "expand", ...extra,
});

console.log("--- normalizeLibraryEntry / keywordKey ---");
{
  ok("非法来源兜底 expand", normalizeLibraryEntry({ word: "x", source: "乱写" as never })?.source === "expand");
  ok("空词返回 null", normalizeLibraryEntry({ word: "  " }) === null);
  ok("词面键忽略空格大小写", keywordKey("Tea 饮") === keywordKey("tea饮"));
  const made = toLibraryEntry({ word: "茶饮哪家好", intent: "选型", priority: "高" }, "manual");
  ok("toLibraryEntry 带来源与时间", made?.source === "manual" && Boolean(made?.addedAt));
}

console.log("\n--- mergeKeywords：合并去重/优先级保留 ---");
{
  const base = [entry("茶饮哪家好", "中", "选型"), entry("茶饮多少钱", "低")];
  const result = mergeKeywords(base, [entry("茶饮 哪家好", "高", "选型"), entry("茶饮怎么选", "高", "选型")]);
  ok("新增计数", result.added === 1 && result.entries.length === 3, `added=${result.added}`);
  ok("重复合并计数", result.merged === 1);
  ok("重复保留较高优先级", result.entries.find((e) => keywordKey(e.word) === keywordKey("茶饮哪家好"))?.priority === "高");
  ok("重复保留先入 addedAt", result.entries[0].addedAt === "2026-11-26T00:00:00.000Z");
  const lower = mergeKeywords([entry("茶饮哪家好", "高", "选型")], [entry("茶饮哪家好", "低", "选型")]);
  ok("低优先级不覆盖高优先级", lower.entries[0].priority === "高");
  const seeded = mergeKeywords([entry("茶饮哪家好", "中", "选型")], [entry("茶饮哪家好", "中", "选型", { seed: "茶饮" })]);
  ok("重复时补 seed", seeded.entries[0].seed === "茶饮");
  const capped = mergeKeywords([], Array.from({ length: 5 }, (_, i) => entry(`词${i}`, "中")), 3);
  ok("上限截断并报告丢弃", capped.entries.length === 3 && capped.dropped === 2);
}

console.log("\n--- removeKeyword / setPriority / libraryStats ---");
{
  const list = [entry("茶饮哪家好", "高", "选型"), entry("茶饮多少钱", "中"), entry("茶饮常见坑", "低", "避坑")];
  ok("删除按归一化词面", removeKeyword(list, "茶饮 哪家好").length === 2);
  ok("改优先级", setPriority(list, "茶饮多少钱", "高").find((e) => e.word === "茶饮多少钱")?.priority === "高");
  ok("改不存在的词原样返回", setPriority(list, "不存在", "高").length === 3);
  const stats = libraryStats(list);
  ok("统计总数与高优先级", stats.total === 3 && stats.high === 1);
  ok("按意图统计含空组", stats.byIntent.length === 5 && stats.byIntent.find((s) => s.intent === "教程")?.count === 0);
  ok("按优先级统计", stats.byPriority.find((s) => s.priority === "中")?.count === 1);
}

console.log("\n--- toQuestions / wordToQuestion ---");
{
  ok("非问句补问号", wordToQuestion("茶饮哪家好") === "茶饮哪家好？");
  ok("已是问句原样", wordToQuestion("茶饮哪家好？") === "茶饮哪家好？");
  const questions = toQuestions([entry("茶饮哪家好", "高", "选型")]);
  ok("转问题带意图", questions[0].text === "茶饮哪家好？" && questions[0].intent === "选型");
}

console.log("\n--- 问题集：parsePastedQuestions / mergeQuestionItems ---");
{
  ok("粘贴拆条去序号", JSON.stringify(parsePastedQuestions("1. 问题一？\n2、问题二？\n- 问题三？\n\n")) === JSON.stringify(["问题一？", "问题二？", "问题三？"]));
  ok("问题键忽略结尾问号", questionKey("茶饮哪家好？") === questionKey("茶饮哪家好"));
  const merged = mergeQuestionItems(
    [{ text: "茶饮哪家好？" }],
    [{ text: "茶饮哪家好", intent: "选型" }, { text: "茶饮多少钱？" }],
    20,
  );
  ok("问题去重合并", merged.added === 1 && merged.duplicates === 1 && merged.items.length === 2);
  ok("重复时补意图", merged.items[0].intent === "选型");
  const capped = mergeQuestionItems([], Array.from({ length: 25 }, (_, i) => ({ text: `问题${i}？` })), 20);
  ok("问题上限 20 截断", capped.items.length === 20 && capped.dropped === 5);
  ok("空问题被过滤", mergeQuestionItems([], [{ text: "  " }], 20).items.length === 0);
}

console.log("\n--- 本机存取往返（按品牌分键） ---");
{
  const storage = memoryStorage();
  ok("品牌键空用 __default", brandStorageKey("  ") === "__default");
  saveLibrary("山野茶饮", [entry("茶饮哪家好", "高", "选型")], storage);
  saveLibrary("", [entry("默认词", "中")], storage);
  ok("词库按品牌隔离", loadLibrary("山野茶饮", storage)[0]?.word === "茶饮哪家好" && loadLibrary("", storage)[0]?.word === "默认词");
  ok("未知品牌返回空", loadLibrary("不存在的品牌", storage).length === 0);
  saveQuestions("山野茶饮", [{ text: "茶饮哪家好？", intent: "选型" }, { text: "茶饮多少钱？" }], storage);
  const loaded = loadQuestions("山野茶饮", storage);
  ok("问题集往返保意图", loaded.length === 2 && loaded[0].intent === "选型" && loaded[1].intent === undefined);
  storage.setItem("ai-employee:geo-questions", JSON.stringify({ 旧品牌: ["旧问题一？", "旧问题二？"] }));
  ok("兼容旧版字符串数组存法", loadQuestions("旧品牌", storage).length === 2 && loadQuestions("旧品牌", storage)[0].text === "旧问题一？");
  storage.setItem("ai-employee:geo-keyword-library", "{坏数据");
  ok("坏数据返回空不抛错", loadLibrary("山野茶饮", storage).length === 0);
}

console.log(`\n${fail === 0 ? "全部通过" : `${fail} 项失败`}（${pass} 通过 / ${fail} 失败）`);
process.exit(fail === 0 ? 0 : 1);
