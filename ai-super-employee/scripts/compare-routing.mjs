/**
 * 验证「岗位路由」是不是真提升：
 * 同一个步骤（生成产品图与海报），分别用「本地门店增长官」和「商品视觉官」的提示词，
 * 看产出是否真的不同。
 *
 * 用法：DS_KEY=sk-xxx node scripts/compare-routing.mjs
 */
const KEY = process.env.DS_KEY;
if (!KEY) {
  console.error("缺少 DS_KEY");
  process.exit(1);
}

const { PROMPTS } = await import("./official-prompts.mjs");

const TASK = "引用《开业内容素材包》中的产品卖点，生成 10 张产品场景图与 3 张开业促销海报，交付《视觉素材包》。";
const CONTEXT = `企业总目标：杭州西湖区新开的养生茶饮店「山野煮茶」，10 月 20 日开业，给我一套小红书推广方案
你当前负责的环节：商品视觉官 —— ${TASK}
企业资料：门店现煮、可选温度和甜度、0添加香精；陈皮普洱礼盒 380 元/250g、桂花乌龙礼盒 268 元/200g、五指毛桃祛湿茶礼盒 328 元/200g；现煮单杯 18/16/20 元；门店 42㎡、8 个座位、地址文三路 128 号。`;

async function chat(system) {
  const res = await fetch("https://api.deepseek.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: "deepseek-chat",
      messages: [
        { role: "system", content: system },
        { role: "user", content: CONTEXT },
      ],
      max_tokens: 1400,
      stream: false,
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()).choices?.[0]?.message?.content ?? "";
}

const [wrongRoute, rightRoute] = await Promise.all([
  chat(PROMPTS["local-store"]),
  chat(PROMPTS["visual-designer"]),
]);

const MARKERS = {
  生图提示词: /提示词|prompt/i,
  画幅比例: /比例|3:4|1:1|4:5|16:9/,
  构图光线: /构图|光线|打光|景别/,
  排版文案: /排版|主标题|副标题|角标|利益点/,
  英文提示词: /[A-Za-z]{20,}/,
  卖点映射: /映射|对应|卖点→|卖点 -/,
};

function score(text) {
  const hit = Object.entries(MARKERS).filter(([, re]) => re.test(text)).map(([k]) => k);
  return { hit: hit.length, list: hit, len: text.length };
}

const a = score(wrongRoute);
const b = score(rightRoute);

console.log("测试步骤：生成 10 张产品场景图 + 3 张开业海报\n");
console.log("维度".padEnd(14) + "错路由(门店增长官)".padEnd(22) + "对路由(商品视觉官)");
console.log("可用要素".padEnd(13) + `${a.hit}/6`.padEnd(24) + `${b.hit}/6`);
console.log("输出字数".padEnd(14) + String(a.len).padEnd(24) + String(b.len));
console.log("\n错路由具备：", a.list.join("、") || "无");
console.log("对路由具备：", b.list.join("、") || "无");
console.log("\n--- 错路由输出（前 500 字）---\n" + wrongRoute.slice(0, 500));
console.log("\n--- 对路由输出（前 500 字）---\n" + rightRoute.slice(0, 500));
