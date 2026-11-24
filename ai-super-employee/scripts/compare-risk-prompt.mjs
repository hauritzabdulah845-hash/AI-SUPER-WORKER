/**
 * 聚焦测试：合规风控官在 v1 / v2 提示词下的实际表现
 *
 * 输入是一段故意埋了 6 处违规的营销文案，看两个版本各能抓出几条、
 * 是否给出可替换的成稿，而不是只说「可能违规」。
 *
 * 用法：DS_KEY=sk-xxx node scripts/compare-risk-prompt.mjs
 */
import fs from "node:fs";
import path from "node:path";

const KEY = process.env.DS_KEY;
if (!KEY) {
  console.error("缺少 DS_KEY");
  process.exit(1);
}

const V2 = (await import("./official-prompts.mjs")).PROMPTS["risk-guard"];
const backup = JSON.parse(fs.readFileSync(path.join("scripts", "prompt-backup.json"), "utf8"));
const V1 = backup.find((row) => row.code === "risk-guard")?.role_prompt ?? "";

const COPY = `【山野煮茶 · 开业宣传文案】

全网最低价的养生茶饮来了！我们的茶饮纯天然、无任何副作用，
能治疗失眠、改善脾胃虚寒，三天见效，喝过的都说好。

开业仅限今天，最后 3 个名额，错过再等一年！
现在充值 500 元送 80 元，还能获得某明星同款茶具一套。
地址：杭州市西湖区文三路 128 号，电话 138****8888。`;

const GROUND_TRUTH = [
  "绝对化用语（全网最低价）",
  "普通食品宣称治疗功效（治疗失眠）",
  "绝对化 + 无副作用承诺（纯天然、无任何副作用）",
  "功效承诺与时效（三天见效）",
  "虚假紧迫感（仅限今天 / 最后 3 个名额，实际活动 10.20-11.5）",
  "未授权明星代言（某明星同款）",
];

async function chat(system) {
  const body = {
    model: "deepseek-chat",
    messages: [
      { role: "system", content: system },
      { role: "user", content: `请审核下面这段即将投放的文案，告诉我能不能发、要改哪里：\n\n${COPY}` },
    ],
    max_tokens: 1200,
    stream: false,
  };
  const res = await fetch("https://api.deepseek.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  return json.choices?.[0]?.message?.content ?? "";
}

const [v1, v2] = await Promise.all([chat(V1), chat(V2)]);

const HITS = {
  "绝对化用语": ["最低价", "绝对化", "广告法第九条"],
  "疗效宣称": ["治疗", "疗效", "疾病", "医疗"],
  "无副作用": ["副作用", "纯天然"],
  "见效承诺": ["三天见效", "见效"],
  "虚假紧迫": ["名额", "仅限今天", "紧迫", "活动期", "10月20", "11月5"],
  "明星代言": ["明星", "代言", "肖像", "同款"],
};

function score(text) {
  const hit = Object.entries(HITS).filter(([, words]) => words.some((w) => text.includes(w))).map(([k]) => k);
  return {
    命中: hit.length,
    明细: hit,
    给出替换文案: /改成|修改为|建议改为|替换为|改为[:：]/.test(text),
    分级: /高|中|低/.test(text),
    字数: text.length,
  };
}

const s1 = score(v1);
const s2 = score(v2);

console.log(`标准答案共 ${GROUND_TRUTH.length} 处风险\n`);
console.log("维度".padEnd(16) + "v1(旧·31字)".padEnd(18) + "v2(新·527字)");
console.log("命中风险数".padEnd(14) + `${s1.命中}/6`.padEnd(20) + `${s2.命中}/6`);
console.log("给出替换文案".padEnd(13) + String(s1.给出替换文案).padEnd(19) + String(s2.给出替换文案));
console.log("风险分级".padEnd(15) + String(s1.分级).padEnd(19) + String(s2.分级));
console.log("输出字数".padEnd(14) + String(s1.字数).padEnd(19) + String(s2.字数));
console.log("\nv1 漏掉：", GROUND_TRUTH.filter((_, i) => !s1.明细[i]).join("、") || "无");
console.log("v2 命中明细：", s2.明细.join("、"));

console.log("\n" + "=".repeat(60) + "\n--- v1 输出 ---\n" + v1.slice(0, 900));
console.log("\n" + "=".repeat(60) + "\n--- v2 输出 ---\n" + v2.slice(0, 900));

fs.writeFileSync("scripts/risk-compare-result.json", JSON.stringify({ v1, v2, s1, s2 }, null, 2), "utf8");
