/**
 * 客服渠道规则引擎 + 群发计划 纯函数自检（不依赖浏览器与服务端）。
 * 运行：npm run test:kf
 */
import {
  matchDefaultRule,
  matchKeywordRule,
  renderTemplate,
  seedRules,
  simulateReply,
} from "../src/cloud/kfchannels";
import {
  createBroadcast,
  dueBroadcasts,
  isBroadcastDue,
  renderContent,
  selectRecipients,
} from "../src/cloud/broadcast";
import type { LeadRow } from "../src/cloud/api";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failed += 1;
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` ｜ ${detail}` : ""}`);
};

const rules = seedRules();

// 1. 关键词命中（与服务端 rules.mjs 同语义）
check("关键词包含命中", matchKeywordRule(rules, "你们多少钱啊")?.id === "price");
check("关键词完全相等命中", matchKeywordRule(rules, "人工")?.id === "human");
check("按数组顺序取第一条（价格先于地址）", matchKeywordRule(rules, "价格和地址")?.id === "price");
check("无命中返回 null", matchKeywordRule(rules, "今天天气不错") === null);
check("默认规则不参与关键词匹配", matchKeywordRule(rules, "") === null && matchKeywordRule(rules, "默认兜底关键词不存在") === null);
const disabled = rules.map((rule) => (rule.id === "price" ? { ...rule, enabled: false } : rule));
check("停用规则被跳过", matchKeywordRule(disabled, "多少钱")?.id !== "price");

// 2. 默认兜底
check("默认兜底存在", matchDefaultRule(rules)?.id === "fallback");
check("无默认返回 null", matchDefaultRule(rules.filter((rule) => !rule.isDefault)) === null);

// 3. 模拟器走向
check("模拟器关键词命中", simulateReply(rules, "怎么收费的").via === "keyword");
check("模拟器默认兜底", simulateReply(rules, "在吗").via === "default");
const noFallback = rules.filter((rule) => !rule.isDefault);
check("无兜底时未命中", simulateReply(noFallback, "在吗").via === "none");

// 4. 模板变量
check("模板 {{name}} 与缺省「你」", renderTemplate("你好{{name}}", { name: "王总" }).includes("王总") && renderTemplate("你好{{name}}", null).includes("你好你"));
check(
  "模板 stage/source 变量",
  renderTemplate("{{stage}}·{{source}}", { stage: "高意向", source: "地图获客" }) === "高意向·地图获客",
);

// 5. 种子规则质量
check(
  "种子含默认兜底且回复非空",
  rules.some((rule) => rule.isDefault) && rules.every((rule) => rule.reply.trim().length > 10),
);

// 6. 群发受众筛选
const leads = [
  { id: 1, name: "王总", source: "地图获客", intent: "高意向", need: "", owner: "我", stage: "跟进中", channel: "地图", external_userid: "wm1", created_at: "" },
  { id: 2, name: "李经理", source: "手动录入", intent: "中意向", need: "", owner: "我", stage: "新建", channel: "", external_userid: null, created_at: "" },
  { id: 3, name: "赵女士", source: "地图获客", intent: "高意向", need: "", owner: "我", stage: "已成交", channel: "地图", external_userid: "wm3", created_at: "" },
] as unknown as LeadRow[];

const all = selectRecipients(leads, { stages: [], intents: [] });
check("空筛选=全部线索", all.matched.length === 3 && all.deliverable.length === 2 && all.noExternalId.length === 1);

const hot = selectRecipients(leads, { stages: [], intents: ["高意向"] });
check("按意向筛选", hot.matched.length === 2 && hot.matched.every((lead) => lead.intent === "高意向"));

const stageAndIntent = selectRecipients(leads, { stages: ["跟进中", "新建"], intents: ["高意向"] });
check("阶段与意向取交集", stageAndIntent.matched.length === 1 && stageAndIntent.matched[0].name === "王总");

const none = selectRecipients(leads, { stages: ["已预约"], intents: [] });
check("无命中返回空", none.matched.length === 0);

// 7. 群发内容变量
check(
  "内容变量替换",
  renderContent("{{name}}你好，{{stage}}可享专属跟进", { name: "王总", stage: "高意向", source: "" }) === "王总你好，高意向可享专属跟进",
);

// 8. 到点判定
const now = Date.now();
const basePlan = createBroadcast("测试");
const scheduled = { ...basePlan, status: "scheduled" as const, scheduleAt: new Date(now - 1000).toISOString() };
const future = { ...basePlan, status: "scheduled" as const, scheduleAt: new Date(now + 60_000).toISOString() };
const draft = { ...basePlan, status: "draft" as const, scheduleAt: "" };
check("已到点=应发", isBroadcastDue(scheduled, now));
check("未到点=不发", !isBroadcastDue(future, now));
check("草稿=不发", !isBroadcastDue(draft, now));
check("非法时间=不发", !isBroadcastDue({ ...basePlan, status: "scheduled", scheduleAt: "not-a-date" }, now));
check(
  "dueBroadcasts 只挑到点的",
  dueBroadcasts([scheduled, future, draft], now).length === 1,
);

console.log(`\n${failed === 0 ? "全部通过" : `${failed} 项失败`}`);
process.exit(failed === 0 ? 0 : 1);
