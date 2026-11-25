/**
 * 合同审查自检：启发式命中/无命中/空文本、结果归一化、Markdown 导出、留档不存全文。
 * 只测纯函数与降级路径，不真调 LLM（LLM 成功路径需真实通道，见接入清单）。
 * 运行：npm run test:contract
 */
import {
  CONTRACT_DISCLAIMER,
  exportContractMarkdown,
  heuristicReview,
  loadContractReviews,
  normalizeReview,
  removeContractReview,
  reviewContract,
  saveContractReview,
  toReviewRecord,
} from "../src/cloud/contract";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failed += 1;
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` ｜ ${detail}` : ""}`);
};

// node 环境 localStorage 垫片（与 analysis-check 同写法）
const memory = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => void memory.set(key, String(value)),
  removeItem: (key: string) => void memory.delete(key),
};

const riskyText = [
  "甲方委托乙方提供年度服务，服务费按验收后付款，账期 90 天。",
  "乙方违约的，应支付合同总额 50% 的违约金，并赔偿全部损失。",
  "本合同成果的全部知识产权归甲方所有，乙方不得另行使用。",
  "任何一方可单方解除本合同，无需承担责任。",
  "本合同期满自动续约一年。",
  "双方应对合作内容保密，不得泄露。",
  "争议由甲方所在地法院管辖。",
].join("\n");

const cleanText = "双方本着友好协商原则开展合作，具体事项另行商定，本文件为意向说明。";

// 1. 启发式命中
const risky = heuristicReview(riskyText, "我方");
check("启发式标注 demo", risky.demo === true);
check("命中高风险（违约金）", risky.risks.some((risk) => risk.severity === "高" && risk.title.includes("违约")), JSON.stringify(risky.risks.map((r) => r.title)));
check("命中知识产权风险", risky.risks.some((risk) => risk.title.includes("知识产权")));
check("命中单方解除风险", risky.risks.some((risk) => risk.title.includes("单方解除")));
check("命中自动续约风险", risky.risks.some((risk) => risk.title.includes("自动续约")));
check("风险按严重度排序（高在前）", risky.risks[0]?.severity === "高");
check("条款定位含原文片段", risky.risks.every((risk) => risk.clause.length > 0));
check("风险多时评分被扣", risky.score < 100, `score=${risky.score}`);
check("应备条款齐全时缺失为空", risky.missingClauses.length === 0, JSON.stringify(risky.missingClauses));

// 2. 无命中 / 缺失条款
const clean = heuristicReview(cleanText, "中立");
check("无风险词时风险为空", clean.risks.length === 0);
check("缺失条款被检出", clean.missingClauses.includes("付款方式与期限") && clean.missingClauses.includes("违约责任"));
check("无命中评分仍在 30-100", clean.score >= 30 && clean.score <= 100, `score=${clean.score}`);

// 3. 空文本
let threw = false;
try {
  heuristicReview("   ", "我方");
} catch {
  threw = true;
}
check("空文本抛错", threw);

let reviewThrew = false;
try {
  await reviewContract({ title: "空", text: "", standpoint: "我方" });
} catch {
  reviewThrew = true;
}
check("reviewContract 空文本抛错", reviewThrew);

// 4. 归一化
const normalized = normalizeReview({
  score: 150,
  summary: "总评",
  risks: [
    { severity: "低", clause: "a", title: "低风险", detail: "d", suggestion: "s" },
    { severity: "严重" as never, clause: "b", title: "非法严重度", detail: "d", suggestion: "s" },
    { severity: "高", clause: "c", title: "高风险", detail: "d", suggestion: "s" },
    { severity: "高", clause: "", title: "", detail: "", suggestion: "" },
  ],
  missingClauses: ["付款"],
  nextSteps: ["复核"],
});
check("归一化评分夹紧 100", normalized.score === 100);
check("归一化非法 severity 回退中", normalized.risks.some((risk) => risk.title === "非法严重度" && risk.severity === "中"));
check("归一化丢弃无标题风险", normalized.risks.length === 3);
check("归一化按严重度排序", normalized.risks[0].severity === "高" && normalized.risks[2].severity === "低");
check("归一化空输入不抛错", normalizeReview(null).score === 60 && normalizeReview(undefined).risks.length === 0);

// 5. Markdown 导出
const md = exportContractMarkdown(risky, "年度服务合同", "我方");
check("Markdown 含标题与评分", md.startsWith("# 合同审查报告 · 年度服务合同") && md.includes(`${risky.score} 分`));
check("Markdown 含免责文案", md.includes(CONTRACT_DISCLAIMER) && md.includes("不构成法律意见"));
check("Markdown 标注演示初筛", md.includes("演示初筛"));
check("Markdown 含风险与建议", md.includes("违约") && md.includes("建议："));
const mdModel = exportContractMarkdown({ ...risky, demo: false, summary: "模型审查总评，AI 初筛，需法务复核。" }, "正式合同", "中立");
check("非演示报告不标演示", !mdModel.includes("演示初筛") && mdModel.includes(CONTRACT_DISCLAIMER));

// 6. 留档不存全文
const record = toReviewRecord(risky, "年度服务合同", "我方", 1700000000000);
check("留档记录含评分与风险数", record.score === risky.score && record.riskCount === risky.risks.length && record.highCount >= 1);
check("留档记录不含合同全文", !JSON.stringify(record).includes("赔偿全部损失") && !("text" in record));
saveContractReview(record);
check("留档写入后可读", loadContractReviews().length === 1 && loadContractReviews()[0].title === "年度服务合同");
removeContractReview(record.id);
check("留档可删除", loadContractReviews().length === 0);

console.log(`\n${failed === 0 ? "全部通过" : `${failed} 项失败`}`);
process.exit(failed === 0 ? 0 : 1);
