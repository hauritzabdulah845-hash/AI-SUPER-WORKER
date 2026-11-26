/**
 * GEO 品牌素材三件套纯逻辑自检（第二十九批）。
 * 关注点：完整度评分、品牌上下文拼接、Markdown 导出、启发式提取、按品牌存取往返。
 * 运行：npm run test:brandassets
 */
import {
  buildBrandContext,
  emptyBrandAssets,
  exportBrandAssetsMarkdown,
  extractBrandCardHeuristic,
  loadBrandAssets,
  normalizeBrandAssets,
  saveBrandAssets,
  validateBrandCard,
  type BrandAssets,
} from "../src/cloud/brandAssets";
import type { StorageLike } from "../src/cloud/keywordLibrary";

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

function memoryStorage(): StorageLike & { dump: Map<string, string> } {
  const dump = new Map<string, string>();
  return {
    dump,
    getItem: (key) => dump.get(key) ?? null,
    setItem: (key, value) => {
      dump.set(key, value);
    },
  };
}

const fullAssets: BrandAssets = {
  card: {
    intro: "山野茶饮是杭州现煮茶饮连锁",
    sellingPoints: ["现煮鲜奶茶", "手作柠檬茶", "支持企业团购"],
    audience: "25-35 岁白领与加盟商",
    priceBand: "18-25 元",
    coverage: "杭州 12 家门店",
    contact: "加盟热线见官网",
    honors: ["2025 杭州餐饮协会年度新锐品牌"],
  },
  rules: {
    bannedWords: ["最好", "第一"],
    requiredWords: ["山野茶饮", "现煮"],
    tone: "亲切口语",
    sentenceStyle: "结论先行、短句",
    numberRule: "价格以官方最新公布为准",
    disclaimer: "本文不构成投资建议",
  },
  samples: [
    {
      title: "样例稿",
      excerpt: "山野茶饮的现煮鲜奶茶……",
      notes: ["好在结论先行"],
    },
  ],
};

console.log("--- validateBrandCard：完整度评分 ---");
{
  const empty = validateBrandCard(emptyBrandAssets().card);
  ok("空卡片 0 分", empty.score === 0, `score=${empty.score}`);
  ok("空卡片缺失项列全", empty.missing.length >= 6, empty.missing.join("、"));
  const full = validateBrandCard(fullAssets.card);
  ok(
    "完整卡片 100 分",
    full.score === 100 && full.missing.length === 0,
    `score=${full.score}`,
  );
  const partial = validateBrandCard({
    ...emptyBrandAssets().card,
    intro: "一句话",
    sellingPoints: ["一个卖点"],
  });
  ok("部分卡片：介绍20+卖点10", partial.score === 30, `score=${partial.score}`);
  ok(
    "部分卡片提示补卖点",
    partial.missing.some((item) => item.includes("核心卖点")),
  );
}

console.log("\n--- buildBrandContext：上下文拼接 ---");
{
  ok("全空返回空串", buildBrandContext(emptyBrandAssets()) === "");
  const ctx = buildBrandContext(fullAssets);
  ok(
    "含信息卡片段",
    ctx.includes("品牌信息卡片") &&
      ctx.includes("山野茶饮是杭州现煮茶饮连锁"),
  );
  ok(
    "含表达规范段与禁用词",
    ctx.includes("表达规范") &&
      ctx.includes("禁用词") &&
      ctx.includes("最好"),
  );
  ok(
    "含必用词与免责声明",
    ctx.includes("必用词") && ctx.includes("本文不构成投资建议"),
  );
  ok(
    "含样例段与批注",
    ctx.includes("参考样例") && ctx.includes("好在结论先行"),
  );
  const onlyRules = buildBrandContext({
    ...emptyBrandAssets(),
    rules: { ...emptyBrandAssets().rules, tone: "专业克制" },
  });
  ok(
    "只有规范时只出规范段",
    onlyRules.includes("语气：专业克制") && !onlyRules.includes("品牌信息卡片"),
  );
}

console.log("\n--- exportBrandAssetsMarkdown ---");
{
  const md = exportBrandAssetsMarkdown("山野茶饮", fullAssets);
  ok("标题含品牌名", md.includes("# 品牌素材三件套 · 山野茶饮"));
  ok("含完整度", md.includes("100/100"));
  ok(
    "含三段",
    md.includes("## 品牌信息卡片") &&
      md.includes("## 表达规范清单") &&
      md.includes("## 样例库"),
  );
  const emptyMd = exportBrandAssetsMarkdown("", emptyBrandAssets());
  ok(
    "空三件套有未填标记与待补项",
    emptyMd.includes("（未填）") && emptyMd.includes("待补项"),
  );
}

console.log("\n--- extractBrandCardHeuristic：启发式提取 ---");
{
  const material =
    "山野茶饮是杭州现煮茶饮连锁，12家门店，主打现煮鲜奶茶和手作柠檬茶，客单价18-25元，支持企业下午茶团购和加盟。2025年获杭州餐饮协会年度新锐品牌。加盟热线 0571-88888888。";
  const card = extractBrandCardHeuristic(material);
  ok(
    "抓价格带",
    card.priceBand.includes("18") && card.priceBand.includes("25"),
    card.priceBand,
  );
  ok("抓门店数", card.coverage.includes("12"), card.coverage);
  ok("抓电话", card.contact.includes("0571"), card.contact);
  ok("抓荣誉", card.honors.length >= 1, card.honors.join("、"));
  ok("抓卖点句", card.sellingPoints.length >= 1);
  ok("抓一句话介绍", card.intro.includes("山野茶饮"), card.intro);
  const none = extractBrandCardHeuristic("随便一段没有品牌信息的文字。");
  ok(
    "无信息时不编造",
    none.priceBand === "" && none.contact === "" && none.honors.length === 0,
  );
}

console.log("\n--- normalize / 存取往返 ---");
{
  const normalized = normalizeBrandAssets({
    card: { intro: "  x  ", sellingPoints: "a\nb" as never, honors: ["h"] },
    rules: { bannedWords: "最好，第一" as never, requiredWords: ["山野"] },
    samples: [
      { title: "t", excerpt: "e", notes: ["n"] },
      { title: "", excerpt: "" },
    ],
  } as never);
  ok("字符串卖点拆行", normalized.card.sellingPoints.length === 2);
  ok("字符串禁用词拆词", normalized.rules.bannedWords.length === 2);
  ok("空样例过滤", normalized.samples.length === 1);
  ok("坏数据返回空三件套", normalizeBrandAssets(null).card.intro === "");

  const storage = memoryStorage();
  saveBrandAssets("山野茶饮", fullAssets, storage);
  const loaded = loadBrandAssets("山野茶饮", storage);
  ok(
    "存取往返：卡片一致",
    loaded.card.intro === fullAssets.card.intro &&
      loaded.card.sellingPoints.length === 3,
  );
  ok(
    "存取往返：规范一致",
    loaded.rules.bannedWords.join("、") === "最好、第一",
  );
  ok(
    "存取往返：样例一致",
    loaded.samples.length === 1 &&
      loaded.samples[0].notes[0] === "好在结论先行",
  );
  ok(
    "品牌隔离：别的品牌读不到",
    loadBrandAssets("别的品牌", storage).card.intro === "",
  );
  saveBrandAssets(
    "",
    { ...fullAssets, card: { ...fullAssets.card, intro: "默认品牌介绍" } },
    storage,
  );
  ok(
    "空品牌走 __default",
    loadBrandAssets("", storage).card.intro === "默认品牌介绍",
  );
}

console.log(`\n全部通过（${pass} 通过 / ${fail} 失败）`);
if (fail > 0) process.exit(1);
