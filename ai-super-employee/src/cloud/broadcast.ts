/**
 * 群发计划（主动激活，对标竞品「主动激活/定时群发」）。
 *
 * - 计划与历史存本机 localStorage（不入库不上传）；
 * - 受众在前端按线索阶段/意向筛选（leads 在业务库）；
 * - 执行走 wecom-kf-service /api/broadcast（MOCK=演示记录；真实=企微官方客户群发，
 *   contactSecret/broadcastSender 由用户后续接入）；未配服务地址时本地演示；
 * - 合规边界：只发给自有线索，已同步企微 external_userid 的才可送达；
 *   不做个人微信 RPA 群发。
 */
import type { LeadRow } from "./api";

export interface BroadcastFilter {
  /** 空数组 = 不限 */
  stages: string[];
  intents: string[];
}

export interface BroadcastHistoryEntry {
  at: number;
  total: number;
  sent: number;
  demo: number;
  skipped: number;
  failed: number;
  detail: string;
}

export type BroadcastApproval = "none" | "pending" | "approved" | "rejected";

export interface BroadcastPlan {
  id: string;
  name: string;
  content: string;
  filter: BroadcastFilter;
  /** ISO 时间；空 = 仅手动发送 */
  scheduleAt: string;
  status: "draft" | "scheduled" | "done";
  createdAt: number;
  history: BroadcastHistoryEntry[];
  /** 风控审批：需要审批的计划 approve=false 时不得发送（定时任务同样受拦） */
  approval?: BroadcastApproval;
  approvalNote?: string;
  approvalAt?: number;
}

const STORAGE_KEY = "ai-employee:broadcasts";
const MAX_PLANS = 100;
const MAX_HISTORY = 10;

export function renderContent(template: string, lead: Pick<LeadRow, "name" | "stage" | "source">): string {
  return String(template ?? "")
    .replaceAll("{{name}}", lead.name?.trim() || "你")
    .replaceAll("{{stage}}", lead.stage?.trim() || "未分级")
    .replaceAll("{{source}}", lead.source?.trim() || "未知来源");
}

/** 按筛选条件取受众；返回可送达（有 external_userid）与全部命中。 */
export function selectRecipients(leads: LeadRow[], filter: BroadcastFilter): {
  matched: LeadRow[];
  deliverable: LeadRow[];
  noExternalId: LeadRow[];
} {
  const stages = filter.stages ?? [];
  const intents = filter.intents ?? [];
  const matched = leads.filter(
    (lead) => (!stages.length || stages.includes(lead.stage)) && (!intents.length || intents.includes(lead.intent)),
  );
  const deliverable = matched.filter((lead) => Boolean(lead.external_userid));
  const noExternalId = matched.filter((lead) => !lead.external_userid);
  return { matched, deliverable, noExternalId };
}

export function isBroadcastDue(plan: BroadcastPlan, now: number): boolean {
  if (plan.status !== "scheduled" || !plan.scheduleAt) return false;
  const at = Date.parse(plan.scheduleAt);
  return Number.isFinite(at) && now >= at;
}

/* ------------------------------------------------------------------ */
/* 本机存储                                                            */
/* ------------------------------------------------------------------ */

export function loadBroadcasts(): BroadcastPlan[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const rows = raw ? (JSON.parse(raw) as BroadcastPlan[]) : [];
    if (!Array.isArray(rows)) return [];
    return rows
      .filter((row) => row && typeof row.id === "string")
      .slice(0, MAX_PLANS)
      .map((row) => ({ ...row, history: Array.isArray(row.history) ? row.history.slice(0, MAX_HISTORY) : [] }));
  } catch {
    return [];
  }
}

export function saveBroadcasts(list: BroadcastPlan[]): void {
  try {
    const rows = list
      .slice(0, MAX_PLANS)
      .map((row) => ({ ...row, history: row.history.slice(0, MAX_HISTORY) }));
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(rows));
  } catch {
    // 隐私模式写入失败不影响本次操作
  }
}

export function upsertBroadcast(plan: BroadcastPlan): BroadcastPlan[] {
  const list = loadBroadcasts();
  const exists = list.some((row) => row.id === plan.id);
  const next = exists ? list.map((row) => (row.id === plan.id ? plan : row)) : [plan, ...list];
  saveBroadcasts(next);
  return next;
}

export function removeBroadcast(id: string): BroadcastPlan[] {
  const next = loadBroadcasts().filter((row) => row.id !== id);
  saveBroadcasts(next);
  return next;
}

export function createBroadcast(name: string): BroadcastPlan {
  return {
    id: `bc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: name.trim() || "未命名群发",
    content: "",
    filter: { stages: [], intents: [] },
    scheduleAt: "",
    status: "draft",
    createdAt: Date.now(),
    history: [],
    approval: "none",
  };
}

/* ------------------------------------------------------------------ */
/* 风控审批（群发前人工确认）                                            */
/* ------------------------------------------------------------------ */

export function approvalLabel(plan: BroadcastPlan): string {
  switch (plan.approval ?? "none") {
    case "pending":
      return "待审批";
    case "approved":
      return "已审批";
    case "rejected":
      return "已驳回";
    default:
      return "免审批";
  }
}

/** 计划是否可发送：免审批 / 已审批放行；待审批与已驳回一律拦截。 */
export function isBroadcastSendable(plan: BroadcastPlan): boolean {
  const approval = plan.approval ?? "none";
  return approval === "none" || approval === "approved";
}

/** 拦截原因（可发送时为空串），供 UI 提示与调度跳过统计共用。 */
export function broadcastBlockReason(plan: BroadcastPlan): string {
  const approval = plan.approval ?? "none";
  if (approval === "pending") return "群发前风控：等待审批，未发送";
  if (approval === "rejected") return `群发已驳回${plan.approvalNote ? `：${plan.approvalNote}` : ""}，未发送`;
  return "";
}

/** 提交审批：草稿 → 待审批。 */
export function requestApproval(plan: BroadcastPlan): BroadcastPlan {
  if (plan.approval === "approved") return plan;
  return { ...plan, approval: "pending", approvalNote: "", approvalAt: undefined };
}

export function decideApproval(plan: BroadcastPlan, approved: boolean, note = ""): BroadcastPlan {
  return { ...plan, approval: approved ? "approved" : "rejected", approvalNote: approved ? "" : note.trim(), approvalAt: Date.now() };
}

/**
 * 风险预检（不阻断，仅提示）：给审批人一个「这条内容像不像群发风险」的参考。
 * 规则保守、只提醒不拦截，避免把正常营销话术当违规。
 */
export function broadcastRiskHints(plan: BroadcastPlan, audienceSize: number, now = Date.now()): string[] {
  const hints: string[] = [];
  const content = plan.content ?? "";
  if (!content.trim()) hints.push("内容为空");
  if (audienceSize > 200) hints.push(`受众 ${audienceSize} 人（>200，建议分批）`);
  const risky = ["最便宜", "全网最低", "包治", "稳赚", "保证收益", "第一", "国家级", "绝对"];
  const hits = risky.filter((word) => content.includes(word));
  if (hits.length) hints.push(`疑似违禁表述：${hits.join("、")}`);
  if ((content.match(/\{\{/g) ?? []).length > 0 && audienceSize === 0) hints.push("含变量但无受众");
  if (plan.scheduleAt && Date.parse(plan.scheduleAt) < now) hints.push("排期时间已过");
  return hints;
}

/* ------------------------------------------------------------------ */
/* 执行                                                                */
/* ------------------------------------------------------------------ */

export interface ExecuteResult {
  total: number;
  sent: number;
  demo: number;
  skipped: number;
  failed: number;
  detail: string;
}

function localDemoExecution(matched: LeadRow[], deliverable: LeadRow[], noExternalId: LeadRow[]): ExecuteResult {
  return {
    total: matched.length,
    sent: 0,
    demo: deliverable.length,
    skipped: noExternalId.length,
    failed: 0,
    detail: "未配置企微服务地址：本地演示发送（记录不外发）",
  };
}

/**
 * 执行一次群发：有服务地址走 /api/broadcast，否则本地演示。
 * 单次请求把全部收件人打包（服务端逐条发送并返回明细）。
 */
export async function executeBroadcast(
  plan: BroadcastPlan,
  leads: LeadRow[],
  kf: { baseUrl: string; secret: string },
): Promise<{ result: ExecuteResult; entry: BroadcastHistoryEntry }> {
  const { matched, deliverable, noExternalId } = selectRecipients(leads, plan.filter);
  const now = Date.now();

  if (!matched.length) {
    const result: ExecuteResult = { total: 0, sent: 0, demo: 0, skipped: 0, failed: 0, detail: "筛选条件下没有线索" };
    return { result, entry: { at: now, ...result } };
  }

  if (!kf.baseUrl.trim()) {
    const result = localDemoExecution(matched, deliverable, noExternalId);
    return { result, entry: { at: now, ...result } };
  }

  const baseUrl = kf.baseUrl.trim().replace(/\/+$/, "");
  try {
    const response = await fetch(`${baseUrl}/api/broadcast`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-admin-secret": kf.secret },
      body: JSON.stringify({
        content: plan.content,
        recipients: matched.map((lead) => ({ name: lead.name, external_userid: lead.external_userid ?? "" })),
      }),
    });
    const data = (await response.json()) as {
      ok?: boolean;
      error?: string;
      summary?: { total: number; sent: number; demo: number; skipped: number; failed: number };
      results?: { name: string; status: string; detail: string }[];
    };
    if (!response.ok || !data.ok || !data.summary) {
      throw new Error(data.error || `群发接口 HTTP ${response.status}`);
    }
    const failedNames = (data.results ?? [])
      .filter((item) => item.status === "failed")
      .slice(0, 3)
      .map((item) => item.name);
    const result: ExecuteResult = {
      total: data.summary.total,
      sent: data.summary.sent,
      demo: data.summary.demo,
      skipped: data.summary.skipped,
      failed: data.summary.failed,
      detail:
        (data.summary.sent
          ? `真实发送 ${data.summary.sent} 条`
          : data.summary.demo
            ? `演示发送 ${data.summary.demo} 条（MOCK 模式）`
            : "没有可送达的收件人") +
        (data.summary.skipped ? ` · 跳过 ${data.summary.skipped}（无企微ID）` : "") +
        (failedNames.length ? ` · 失败：${failedNames.join("、")}` : ""),
    };
    return { result, entry: { at: now, ...result } };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const result: ExecuteResult = {
      total: matched.length,
      sent: 0,
      demo: 0,
      skipped: noExternalId.length,
      failed: deliverable.length,
      detail: `发送失败：${message}`,
    };
    return { result, entry: { at: now, ...result } };
  }
}

/** 到点检查：返回应执行的计划（纯判定，供调度与测试共用）。需审批未放行的一律不进入队列。 */
export function dueBroadcasts(list: BroadcastPlan[], now: number): BroadcastPlan[] {
  return list.filter((plan) => isBroadcastDue(plan, now) && isBroadcastSendable(plan));
}
