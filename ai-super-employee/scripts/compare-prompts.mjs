/**
 * 提示词改造前后对比测试
 *
 * 同一业务目标、同一模型，分别用 v1（旧提示词）和 v2（新提示词）跑完整流水线：
 * 规划 → 按岗位路由 → 逐步骤生成，然后在客观指标上对比。
 *
 * 用法：DS_KEY=sk-xxx node scripts/compare-prompts.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { createWorkBuddyCloud } from "@tencent-ai/workbuddy-cloud-sdk";
import { resolveStepTemplate } from "./_agent-routing.mjs";

const KEY = process.env.DS_KEY;
if (!KEY) {
  console.error("缺少 DS_KEY 环境变量");
  process.exit(1);
}

const GOAL = "杭州西湖区新开的养生茶饮店「山野煮茶」，10 月 20 日开业，给我一套小红书推广方案";

const cloud = createWorkBuddyCloud({
  endpoint: "https://super-agent-os.app.workbuddy.host",
  oauthRelayBaseUrl: "https://www.workbuddy.cn/v2/as/genie-baas/oauth",
  publishableKey: "wbpk_r1hMK5Enk0XVGpjJvncolP_XMyHEqD8JajXB1kUh62aV7E8rGgptkwU",
});

const { data: v2Rows } = await cloud.database
  .from("agent_templates")
  .select("id,code,name,domain,summary,role_prompt,workflow,outputs,approvals")
  .eq("is_official", true)
  .order("id");

const backup = JSON.parse(fs.readFileSync(path.join("scripts", "prompt-backup.json"), "utf8"));
const v1PromptByCode = Object.fromEntries(backup.map((row) => [row.code, row.role_prompt]));

const { data: docs } = await cloud.database
  .from("knowledge_docs")
  .select("title,doc_type,content")
  .limit(5);
const knowledgeBlock = (docs ?? [])
  .filter((d) => (d.content ?? "").length > 30)
  .map((d, i) => `【资料${i + 1}｜${d.title}（${d.doc_type}）】\n${d.content.slice(0, 1200)}`)
  .join("\n\n");

async function chat(system, user, maxTokens = 1400) {
  const body = {
    model: "deepseek-chat",
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    max_tokens: maxTokens,
    stream: false,
  };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const res = await fetch("https://api.deepseek.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      const json = await res.json();
      return json.choices?.[0]?.message?.content ?? "";
    }
    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
      continue;
    }
    throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 120)}`);
  }
  throw new Error("重试后仍失败（429）");
}

// ---------- 规划 ----------
const roster = (v2Rows ?? [])
  .map((t) => `- ${t.name}（${t.domain}）：${t.summary}`)
  .join("\n");

const planSystem = [
  "你是企业 AI 总控的任务规划器。老板只给一句话目标，你要把它拆成一份能直接开工的作战计划。",
  "",
  "规划纪律：",
  "1. 步骤 3 到 5 个，必须贴合下面给出的岗位标准流程，不要套用「调研—分析—执行—复盘」这种通用骨架。",
  "2. 每步的 action 写成「动词 + 对象 + 交付物」，例如「拆解 3 类客群并输出对应卖点卡」；禁止「分析市场」「优化方案」这类看不出产出物的写法。",
  "3. 步骤之间要有依赖：后一步能直接拿前一步的产出继续干。",
  "4. 最后一步必须是可验证的收口动作（审核清单、排期表、复盘结论），不能是「总结一下」。",
  "5. 企业资料里已有的价格、政策、案例，步骤要明确「引用资料」而不是重新编造。",
  "",
  "只输出 JSON，不要解释：",
  '{"title":"不超过20字，一眼看出这次做了什么","domain":"所属业务域","steps":[{"agent":"岗位名称","action":"具体动作与交付物"}]}',
].join("\n");

const planRaw = await chat(planSystem, `企业目标：${GOAL}\n\n可调用岗位清单（步骤的 agent 请直接使用这里的岗位名）：\n${roster}`, 800);
const plan = JSON.parse(planRaw.slice(planRaw.indexOf("{"), planRaw.lastIndexOf("}") + 1));

console.log(`目标：${GOAL}`);
console.log(`规划标题：${plan.title}｜业务域：${plan.domain}`);
console.log("步骤与岗位路由：");
const steps = plan.steps.map((step, i) => {
  const tpl = resolveStepTemplate(step, v2Rows, v2Rows?.[0] ?? null);
  console.log(`  ${i + 1}. [${step.agent}] → 提示词：${tpl?.name ?? "通用"}(${tpl?.code ?? "-"})`);
  console.log(`     动作：${step.action}`);
  return { ...step, tpl };
});

// ---------- 逐步骤生成 ----------
const DISCIPLINE = [
  "",
  "【交付纪律】",
  "1. 直接给成稿，不要解释你打算怎么写，不要复述任务，不要写「好的，我来帮你…」。",
  "2. 信息不足不要编：在成稿末尾单列「待补充：…」，写清缺什么、会影响哪部分。",
  "3. 不出现「赋能、闭环、抓手、生态、全面提升、助力」这类无法验证的词；每个结论都要有依据。",
  "4. 长度按交付物类型定：文案/方案 600-1200 字；话术、清单按条给全；分析类先给结论再给论据。",
  "5. 只做你这一步该做的事，不要重复前面步骤已经完成的产出，保持口径一致。",
].join("\n");

const outputs = { v1: [], v2: [] };
let context = "（这是第一步，没有前置产出）";

for (const step of steps) {
  const userMsg = [
    `企业总目标：${GOAL}`,
    `你当前负责的环节：${step.agent} —— ${step.action}`,
    `企业资料（价格、政策、案例、卖点必须以这里为准；资料没有的不要编）：\n${knowledgeBlock || "（本次未检索到相关企业资料）"}`,
    `前面步骤的产出：\n${context}`,
  ].join("\n\n");

  const v1Role = v1PromptByCode[step.tpl.code] ?? "你是企业里能干活的 AI 员工。";
  const v2Role = step.tpl.role_prompt ?? v1Role;

  const [v1, v2] = await Promise.all([
    chat(v1Role, userMsg).catch((e) => `ERR ${e.message}`),
    chat(`${v2Role}\n${DISCIPLINE}`, userMsg).catch((e) => `ERR ${e.message}`),
  ]);
  outputs.v1.push(v1);
  outputs.v2.push(v2);
  context = [`第 ${outputs.v1.length} 步产出（v2 版本）：${v2.slice(0, 600)}`].join("\n");
  console.log(`  已生成第 ${outputs.v1.length} 步（v1 ${v1.length} 字 / v2 ${v2.length} 字）`);
}

// ---------- 客观指标 ----------
const EMPTY_WORDS = ["赋能", "闭环", "抓手", "生态", "全面提升", "助力", "综上所述", "首先", "其次", "总而言之"];
const FACTS = ["380", "9.9", "文三路", "储值", "陈皮", "西湖"];
const count = (text, words) => words.reduce((sum, w) => sum + (text.split(w).length - 1), 0);

function stat(list) {
  const text = list.join("\n");
  return {
    总字数: text.length,
    平均每步: Math.round(text.length / list.length),
    待补充项: (text.match(/待补充/g) ?? []).length,
    空话词: count(text, EMPTY_WORDS),
    企业事实命中: FACTS.filter((f) => text.includes(f)).length + "/" + FACTS.length,
    结构标记: (text.match(/【/g) ?? []).length,
  };
}

console.log("\n" + "=".repeat(64));
console.log("指标对比");
console.log("=".repeat(64));
const s1 = stat(outputs.v1);
const s2 = stat(outputs.v2);
const keys = Object.keys(s1);
console.log("指标".padEnd(14) + "v1(旧)".padEnd(14) + "v2(新)");
for (const k of keys) {
  console.log(String(k).padEnd(14) + String(s1[k]).padEnd(14) + String(s2[k]));
}

console.log("\n" + "=".repeat(64));
console.log("第 1 步原文对比（前 600 字）");
console.log("=".repeat(64));
console.log("\n--- v1 旧提示词 ---\n" + outputs.v1[0].slice(0, 600));
console.log("\n--- v2 新提示词 ---\n" + outputs.v2[0].slice(0, 600));

fs.writeFileSync("scripts/prompt-compare-result.json", JSON.stringify({ plan, outputs }, null, 2), "utf8");
console.log("\n完整结果已写入 scripts/prompt-compare-result.json");
