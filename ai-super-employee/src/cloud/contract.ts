import { askLLM } from "./runner";

/**
 * 合同审查能力层（域 13 法务）：
 * 粘贴合同文本 → 风险清单 + 缺失条款 + 下一步建议。
 *
 * 纪律（写进提示词，也写进界面文案）：
 * - 只基于原文判断，不编造法条编号；结论是「AI 初筛，需法务复核」，不构成法律意见。
 * - 高风险优先：付款 / 违约 / 知识产权 / 保密 / 解除 / 管辖。
 * - 零 Key 降级：模型不可用时走启发式关键词初筛（demo 标注），保证永远有交付物。
 * - 留档只存标题/时间/评分/风险数，不存合同全文（隐私）。
 */

export const CONTRACT_STANDPOINTS = ["我方", "对方", "中立"] as const;
export type ContractStandpoint = (typeof CONTRACT_STANDPOINTS)[number];

export type ContractSeverity = "高" | "中" | "低";

export interface ContractRisk {
  severity: ContractSeverity;
  /** 条款定位：原文片段或章节描述 */
  clause: string;
  title: string;
  detail: string;
  suggestion: string;
}

export interface ContractReviewResult {
  /** 0-100，越高越稳妥（风险越少） */
  score: number;
  summary: string;
  risks: ContractRisk[];
  missingClauses: string[];
  nextSteps: string[];
  /** true = 启发式演示初筛（模型不可用时的降级产出） */
  demo?: boolean;
}

export const CONTRACT_DISCLAIMER = "AI 初筛，不构成法律意见，需法务复核后使用。";

/** 从 LLM 回复里稳健地抠出 JSON（与 geo.ts 同写法）。 */
function parseJson<T>(raw: string): T | null {
  const text = raw.replace(/```(?:json)?/g, "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

function clip(text: string, max: number): string {
  const value = text.trim();
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

const SEVERITY_ORDER: Record<ContractSeverity, number> = { 高: 0, 中: 1, 低: 2 };

/** 结果归一化：评分夹紧、severity 白名单、条数封顶、字段限长、按严重度排序。 */
export function normalizeReview(input: Partial<ContractReviewResult> | null | undefined): ContractReviewResult {
  const score = Number.isFinite(input?.score) ? Math.max(0, Math.min(100, Math.round(Number(input?.score)))) : 60;
  const risks = (Array.isArray(input?.risks) ? input.risks : [])
    .map((risk) => ({
      severity: (risk?.severity === "高" || risk?.severity === "低" ? risk.severity : "中") as ContractSeverity,
      clause: String(risk?.clause ?? "").slice(0, 120),
      title: String(risk?.title ?? "").slice(0, 60),
      detail: String(risk?.detail ?? "").slice(0, 240),
      suggestion: String(risk?.suggestion ?? "").slice(0, 240),
    }))
    .filter((risk) => risk.title)
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
    .slice(0, 12);
  return {
    score,
    summary: String(input?.summary ?? "").slice(0, 300),
    risks,
    missingClauses: (Array.isArray(input?.missingClauses) ? input.missingClauses : []).map((item) => String(item).slice(0, 80)).filter(Boolean).slice(0, 8),
    nextSteps: (Array.isArray(input?.nextSteps) ? input.nextSteps : []).map((item) => String(item).slice(0, 120)).filter(Boolean).slice(0, 6),
    demo: input?.demo === true,
  };
}

/* ------------------------------ 启发式初筛 ------------------------------ */

interface HeuristicRule {
  keywords: string[];
  severity: ContractSeverity;
  title: string;
  detail: string;
  suggestion: string;
}

/** 关键词词典：命中即生成一条风险项（演示初筛，不替代法务判断）。 */
const HEURISTIC_RULES: HeuristicRule[] = [
  { keywords: ["违约金", "赔偿全部损失", "承担全部责任"], severity: "高", title: "违约责任偏重", detail: "出现高额违约金或全额赔偿表述，需核对是否与合同金额成比例、是否有上限。", suggestion: "建议设置违约金上限（如不超过合同总额一定比例），并区分故意与过失。" },
  { keywords: ["知识产权归", "全部知识产权", "成果归甲方所有"], severity: "高", title: "知识产权归属需确认", detail: "成果/知识产权归属表述较绝对，需确认是否包含既有技术与通用组件。", suggestion: "建议明确：既有知识产权归原权利人，定制成果归属与许可范围分开写。" },
  { keywords: ["自动续约", "自动续期", "期满自动"], severity: "中", title: "自动续约条款", detail: "存在自动续约/续期安排，需留意续约期限与退出通知期。", suggestion: "建议补充提前书面通知可终止续约的期限（如提前 30 日）。" },
  { keywords: ["单方解除", "随时解除", "有权单方终止"], severity: "高", title: "单方解除权不对等", detail: "出现单方解除/随时终止表述，需核对双方权利是否对等、是否有补偿。", suggestion: "建议限定解除事由、增加催告期，并约定已履行部分的结算方式。" },
  { keywords: ["保密", "不得泄露", "保密义务"], severity: "中", title: "保密条款需细化", detail: "有保密义务表述，需核对保密范围、期限与例外情形是否明确。", suggestion: "建议写明保密信息范围、保密期限及依法披露等例外情形。" },
  { keywords: ["管辖", "仲裁", "诉讼"], severity: "中", title: "争议解决与管辖", detail: "出现管辖/仲裁/诉讼安排，需确认地点对我方是否便利、仲裁与诉讼二选一是否明确。", suggestion: "建议争议解决方式只选一种并写明机构/法院，避免约定不明。" },
  { keywords: ["付款周期", "账期", "验收后付款", "分期付款"], severity: "中", title: "付款条件需核对", detail: "付款与验收/账期挂钩，需核对验收标准、付款节点与逾期处理。", suggestion: "建议写明验收标准与期限，逾期付款的违约责任与催告流程。" },
  { keywords: ["排他", "独家", "不得与第三方合作"], severity: "中", title: "排他/独家限制", detail: "存在排他或独家合作限制，可能影响后续业务空间。", suggestion: "建议限定排他范围与期限，并约定排他对应的对价或保底。" },
  { keywords: ["不可抗力"], severity: "低", title: "不可抗力已约定", detail: "已出现不可抗力条款，可核对通知义务与减损要求是否完整。", suggestion: "建议补充不可抗力发生后的通知时限与证明要求。" },
  { keywords: ["最终解释权", "解释权归"], severity: "低", title: "最终解释权表述", detail: "出现单方解释权表述，正式合同中建议删除或改为双方协商解释。", suggestion: "建议删除最终解释权条款，改为未尽事宜协商补充。" },
];

/** 缺失条款检查：常见应备条款在原文中是否出现（只查关键词，演示口径）。 */
const EXPECTED_CLAUSES: { label: string; keywords: string[] }[] = [
  { label: "付款方式与期限", keywords: ["付款", "支付", "结算", "账期"] },
  { label: "违约责任", keywords: ["违约"] },
  { label: "保密义务", keywords: ["保密"] },
  { label: "合同解除/终止", keywords: ["解除", "终止"] },
  { label: "争议解决（管辖/仲裁）", keywords: ["管辖", "仲裁", "诉讼"] },
  { label: "知识产权归属", keywords: ["知识产权", "著作权", "专利"] },
];

/** 截取命中词上下文作为条款定位（前后各约 20 字）。 */
function excerptAround(text: string, keyword: string): string {
  const index = text.indexOf(keyword);
  if (index === -1) return keyword;
  const start = Math.max(0, index - 20);
  const end = Math.min(text.length, index + keyword.length + 20);
  return `${start > 0 ? "…" : ""}${text.slice(start, end).replace(/\s+/g, " ")}${end < text.length ? "…" : ""}`;
}

/**
 * 启发式初筛（零 Key 降级）：关键词命中生成风险项，缺失条款按应备清单核对。
 * 评分：100 起扣，高 -12 / 中 -6 / 低 -2，下限 30。结果带 demo 标注。
 */
export function heuristicReview(text: string, standpoint: ContractStandpoint = "中立"): ContractReviewResult {
  const body = String(text ?? "").trim();
  if (!body) throw new Error("请先粘贴合同文本，审查需要原文。");

  const risks: ContractRisk[] = [];
  for (const rule of HEURISTIC_RULES) {
    const hit = rule.keywords.find((keyword) => body.includes(keyword));
    if (!hit) continue;
    risks.push({
      severity: rule.severity,
      clause: excerptAround(body, hit),
      title: rule.title,
      detail: rule.detail,
      suggestion: rule.suggestion,
    });
  }

  const missingClauses = EXPECTED_CLAUSES.filter((item) => !item.keywords.some((keyword) => body.includes(keyword))).map((item) => item.label);

  const deduction = risks.reduce((sum, risk) => sum + (risk.severity === "高" ? 12 : risk.severity === "中" ? 6 : 2), 0);
  const score = Math.max(30, Math.min(100, 100 - deduction - missingClauses.length * 3));

  return normalizeReview({
    score,
    summary: `演示初筛（关键词规则，立场：${standpoint}）：命中 ${risks.length} 项风险提示、${missingClauses.length} 项常见条款未检出。仅供快速过目，需法务复核。`,
    risks,
    missingClauses,
    nextSteps: [
      "把高风险项逐条与对方确认，能改的先改再签",
      "缺失条款补进合同或另签补充协议",
      "正式签署前交法务/律师复核一遍",
    ],
    demo: true,
  });
}

/* ------------------------------ LLM 审查 ------------------------------ */

const CONTRACT_SYSTEM = [
  "你是企业法务初筛助手。基于用户提供的合同原文做风险初筛，输出结构化 JSON。",
  "硬性纪律：",
  "1. 只基于原文判断，原文没有的不要臆测；禁止编造法条编号（如「第 X 条」），需要引用依据时写「建议法务核对相关规定」。",
  "2. 结论定位是「AI 初筛，需法务复核」，summary 里必须包含这句定位。",
  "3. 高风险优先：付款条件、违约责任、知识产权、保密、解除/终止、争议管辖，逐项核对。",
  "4. clause 字段写原文片段或章节定位（30 字内），不要整段复制原文。",
  "5. 按用户给定的立场（我方/对方/中立）判断风险对谁不利。",
  "只输出 JSON：",
  '{"score":0-100,"summary":"120字内总评","risks":[{"severity":"高|中|低","clause":"原文定位","title":"风险标题","detail":"80字内说明","suggestion":"80字内修改建议"}],"missingClauses":["缺失的常见条款"],"nextSteps":["下一步动作"]}',
  "score 越高表示风险越少；risks 最多 12 条，按严重度从高到低。",
].join("\n");

/**
 * 合同审查主入口：优先走 askLLM（与任务执行同通道），
 * 模型不可用/解析失败时降级启发式初筛并标注 demo，保证永远有交付物。
 */
export async function reviewContract(input: {
  title: string;
  text: string;
  standpoint: ContractStandpoint;
  signal?: AbortSignal;
}): Promise<ContractReviewResult> {
  const body = clip(String(input.text ?? ""), 12000);
  if (!body) throw new Error("请先粘贴合同文本，审查需要原文。");
  const standpoint = (CONTRACT_STANDPOINTS as readonly string[]).includes(input.standpoint) ? input.standpoint : "中立";

  try {
    const { text } = await askLLM(
      [
        { role: "system", content: CONTRACT_SYSTEM },
        {
          role: "user",
          content: [
            `合同标题：${input.title.trim() || "（未命名）"}`,
            `审查立场：${standpoint}`,
            "",
            "=== 合同原文 ===",
            body,
          ].join("\n"),
        },
      ],
      { json: true, signal: input.signal },
    );
    const parsed = parseJson<Partial<ContractReviewResult>>(text);
    if (!parsed || typeof parsed.score !== "number") throw new Error("审查结果解析失败");
    return normalizeReview({ ...parsed, demo: false });
  } catch {
    // 降级：零 Key / 配额 / 解析失败都走启发式初筛（demo 标注，不冒充模型结论）
    return heuristicReview(body, standpoint);
  }
}

/* ------------------------------ 导出与留档 ------------------------------ */

/** 审查结果导出 Markdown（含免责与演示标注）。 */
export function exportContractMarkdown(result: ContractReviewResult, title: string, standpoint: ContractStandpoint = "中立"): string {
  const lines: string[] = [`# 合同审查报告 · ${title.trim() || "未命名合同"}`, ""];
  lines.push(`审查立场：${standpoint} · 导出时间：${new Date().toLocaleString("zh-CN", { hour12: false })}`);
  lines.push(`> ${CONTRACT_DISCLAIMER}${result.demo ? " 本报告为演示初筛（关键词规则），非模型审查结论。" : ""}`, "");
  lines.push(`## 总评（${result.score} 分）`, "", result.summary || "（无总评）", "");
  lines.push(`## 风险清单（${result.risks.length} 项）`, "");
  if (!result.risks.length) lines.push("未检出风险提示（不代表无风险，请法务复核）。", "");
  result.risks.forEach((risk, index) => {
    lines.push(`### ${index + 1}. [${risk.severity}] ${risk.title}`, "");
    if (risk.clause) lines.push(`- 条款定位：${risk.clause}`);
    lines.push(`- 说明：${risk.detail}`);
    lines.push(`- 建议：${risk.suggestion}`, "");
  });
  lines.push("## 缺失条款", "");
  if (!result.missingClauses.length) lines.push("常见条款均已检出。", "");
  result.missingClauses.forEach((item) => lines.push(`- ${item}`));
  if (result.missingClauses.length) lines.push("");
  lines.push("## 下一步", "");
  result.nextSteps.forEach((item, index) => lines.push(`${index + 1}. ${item}`));
  lines.push("", `---`, CONTRACT_DISCLAIMER);
  return lines.join("\n");
}

const REVIEWS_KEY = "ai-employee:contract-reviews";
export const MAX_CONTRACT_REVIEWS = 20;

export interface ContractReviewRecord {
  id: string;
  title: string;
  standpoint: ContractStandpoint;
  score: number;
  riskCount: number;
  highCount: number;
  demo: boolean;
  /** 毫秒时间戳 */
  at: number;
}

/** 把一次审查结果转成留档记录（只留摘要，不存合同全文）。 */
export function toReviewRecord(result: ContractReviewResult, title: string, standpoint: ContractStandpoint, at = Date.now()): ContractReviewRecord {
  return {
    id: `review-${at.toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    title: String(title ?? "").trim().slice(0, 60) || "未命名合同",
    standpoint,
    score: result.score,
    riskCount: result.risks.length,
    highCount: result.risks.filter((risk) => risk.severity === "高").length,
    demo: result.demo === true,
    at,
  };
}

export function loadContractReviews(): ContractReviewRecord[] {
  try {
    const raw = localStorage.getItem(REVIEWS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return (parsed as ContractReviewRecord[])
      .filter((row) => row && Number.isFinite(row.at) && typeof row.title === "string")
      .slice(0, MAX_CONTRACT_REVIEWS);
  } catch {
    return [];
  }
}

export function saveContractReview(record: ContractReviewRecord): ContractReviewRecord[] {
  const next = [record, ...loadContractReviews()].slice(0, MAX_CONTRACT_REVIEWS);
  try {
    localStorage.setItem(REVIEWS_KEY, JSON.stringify(next));
  } catch {
    /* 节点测试环境无 localStorage / 隐私模式写失败不影响主流程 */
  }
  return next;
}

export function removeContractReview(id: string): ContractReviewRecord[] {
  const next = loadContractReviews().filter((row) => row.id !== id);
  try {
    localStorage.setItem(REVIEWS_KEY, JSON.stringify(next));
  } catch {
    /* 同上 */
  }
  return next;
}
