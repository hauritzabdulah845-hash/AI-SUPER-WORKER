/**
 * 第十四批自检：知识库检索/分页 + 模型用量统计（纯函数，无浏览器依赖）。
 * 运行：npm run test:ops2
 */
import { paginate, scoreDoc, searchDocs, snippetOf, tokenizeQuery, type KbDoc } from "../src/cloud/kbsearch";
import {
  estimateTokens,
  hourlyBuckets,
  isQuotaError,
  startOfToday,
  summarizeUsage,
  usageAlerts,
  type UsageRecord,
} from "../src/cloud/usage";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failed += 1;
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` ｜ ${detail}` : ""}`);
};

/* ============================ 知识库检索 ============================ */

check("分词：中文按 2-gram", tokenizeQuery("价格表").join(",") === "价格,格表", tokenizeQuery("价格表").join(","));
check("分词：英文按词", tokenizeQuery("VIP 客户").includes("vip") && tokenizeQuery("VIP 客户").includes("客户"));
check("分词：空查询无词", tokenizeQuery("   ").length === 0);

const doc = (id: number, title: string, content: string, type = "产品手册", created = "2026-11-20T00:00:00Z"): KbDoc => ({
  id, title, doc_type: type, source: "手动录入", chunks: Math.max(1, Math.floor(content.length / 200)), content, created_at: created,
});

const docs: KbDoc[] = [
  doc(1, "2026 价格表", "基础版 199 元/年，专业版 599 元/年。价格含税。"),
  doc(2, "服务流程说明", "客户签约后 3 个工作日内启动，包含需求确认与方案评审。价格另议。"),
  doc(3, "常见问题", "支持退款吗？支持，7 天内无理由退款。"),
  doc(4, "Company Profile", "We provide AI solutions for SMEs."),
];

const priceHits = searchDocs(docs, "价格");
check("标题命中优先于正文", priceHits[0]?.doc.id === 1, `命中 ${priceHits.length} 条，首位=${priceHits[0]?.doc.title}`);
check("标题命中标记 where=title", priceHits[0]?.where === "title");
check("正文命中也会返回", priceHits.some((hit) => hit.doc.id === 2));
check("无关键词不返回无关文档", !priceHits.some((hit) => hit.doc.id === 3));

const enHits = searchDocs(docs, "SMES");
check("英文不区分大小写", enHits.length === 1 && enHits[0].doc.id === 4, `命中 ${enHits.length}`);

check("空查询返回全部且保持顺序", searchDocs(docs, "").length === 4 && searchDocs(docs, "")[0].doc.id === 1);
check("空查询无分数", searchDocs(docs, "").every((hit) => hit.score === 0));
check("limit 生效", searchDocs(docs, "", 2).length === 2);

const snippet = snippetOf(doc(9, "价格表", "前面一堆无关内容。基础版 199 元，专业版 599 元。后面还有别的。"), tokenizeQuery("599"));
check("片段围绕命中词", snippet.includes("599") && snippet.length <= 95, snippet);

const scored = scoreDoc(doc(1, "价格表", "价格价格价格价格价格价格"), tokenizeQuery("价格"));
check("正文重复次数封顶", scored.score <= 3 * 1 + 2 + 5, `score=${scored.score}`);

check("类型命中 where=type", scoreDoc(doc(5, "X", "无", "价格手册"), tokenizeQuery("价格手册")).where !== "none");

/* ============================== 分页 ============================== */

const page1 = paginate(Array.from({ length: 25 }, (_, i) => i), 1, 10);
check("首页 10 条", page1.items.length === 10 && page1.items[0] === 0 && page1.page === 1);
check("页数向上取整", page1.pageCount === 3 && page1.total === 25);
const page3 = paginate(Array.from({ length: 25 }, (_, i) => i), 3, 10);
check("末页 5 条", page3.items.length === 5 && page3.items[0] === 20);
check("越界页夹到末页", paginate(Array.from({ length: 25 }, (_, i) => i), 99, 10).page === 3);
check("负数页夹到首页", paginate([1, 2, 3], -5, 10).page === 1);
check("空列表恒 1 页", paginate([], 1, 10).pageCount === 1);
check("非法 pageSize 回落 10", paginate(Array.from({ length: 12 }), 1, 0).pageSize === 10);
check("筛选后仍在有效页", paginate(Array.from({ length: 5 }), 3, 10).page === 1);

/* ============================ 用量统计 ============================ */

check("中文 token 估算", estimateTokens("你好世界") === 4);
check("英文 token 估算", estimateTokens("abcdefgh") === 2);
check("混合估算", estimateTokens("你好abcd") === 3, String(estimateTokens("你好abcd")));

const NOW = Date.parse("2026-11-24T12:00:00Z");
const rec = (patch: Partial<UsageRecord>): UsageRecord => ({
  at: NOW, channel: "platform", model: "gpt-4o-mini", ok: true, tokens: 100, ms: 1000, ...patch,
});

const records: UsageRecord[] = [
  rec({}),
  rec({ at: NOW - 3600_000, tokens: 200 }),
  rec({ at: NOW - 7200_000, ok: false, error: "429 Too Many Requests", tokens: 50 }),
  rec({ at: NOW - 90_000_000, tokens: 999 }), // 超出 24h
  rec({ channel: "custom", model: "deepseek-chat", tokens: 300, at: NOW - 1800_000 }),
];
const day = summarizeUsage(records, NOW - 86_400_000, "近 24 小时");
check("24h 内统计", day.calls === 4 && day.ok === 3 && day.failed === 1, `calls=${day.calls}`);
check("tokens 求和", day.tokens === 650, String(day.tokens));
check("失败率", Math.abs(day.failRate - 0.25) < 1e-9, String(day.failRate));
check("平均耗时", day.avgMs === 1000, String(day.avgMs));
check("按通道分组", day.byChannel.platform?.calls === 3 && day.byChannel.custom?.calls === 1);
check("按模型按 tokens 降序", day.byModel[0].model === "gpt-4o-mini" && day.byModel[0].tokens === 350 && day.byModel.length === 2, JSON.stringify(day.byModel.map((m) => [m.model, m.tokens])));

check("配额错误识别", isQuotaError("Error: 429 Too Many Requests") && isQuotaError("quota exceeded") && !isQuotaError("timeout"));
check("今日起点为本地零点", new Date(startOfToday(NOW)).getHours() === 0);

const todayIsUtcMidnight = startOfToday(NOW);
const todays = summarizeUsage(records, todayIsUtcMidnight, "今日");
check("今日窗口过滤更早记录", todays.calls <= 4, `calls=${todays.calls}`);

const alertsQuota = usageAlerts(records, NOW);
check("配额失败触发 danger 预警", alertsQuota.some((alert) => alert.level === "danger" && alert.message.includes("配额")), JSON.stringify(alertsQuota.map((a) => a.level)));
const alertsClean = usageAlerts([rec({}), rec({ at: NOW - 1000 })], NOW);
check("正常时给 ok 提示", alertsClean.length === 1 && alertsClean[0].level === "ok");
check("空记录给提示", usageAlerts([], NOW)[0].message.includes("还没有调用"));

const buckets = hourlyBuckets([rec({}), rec({ at: NOW - 3600_000 }), rec({ at: NOW - 999_999_999 })], 12, NOW);
check("小时桶最后一位是当前小时", buckets[buckets.length - 1] === 1, buckets.join(","));
check("小时桶倒数第二位是上小时", buckets[buckets.length - 2] === 1);
check("超窗记录不进桶", buckets.reduce((a, b) => a + b, 0) === 2, String(buckets.reduce((a, b) => a + b, 0)));

console.log(`\n${failed === 0 ? "全部通过" : `${failed} 项失败`}`);
if (failed > 0) process.exit(1);
