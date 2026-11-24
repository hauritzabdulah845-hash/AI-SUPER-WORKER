import { cloud, getSessionUser, requireOwner } from "./client";
import { OFFICIAL_PROMPTS } from "./prompts";

export interface AgentTemplate {
  id: number;
  code: string;
  name: string;
  domain: string;
  summary: string;
  role_prompt: string;
  capabilities: string[];
  knowledge: string[];
  tools: string[];
  workflow: string[];
  approvals: string[];
  metrics: string[];
  outputs: string[];
  is_official: boolean;
}

export interface AgentRow {
  id: number;
  name: string;
  role: string;
  domain: string;
  template_code: string;
  template_name: string;
  status: string;
  capabilities: string[];
  knowledge: string[];
  tools: string[];
  config: Record<string, unknown>;
}

export interface TaskRow {
  id: number;
  title: string | null;
  goal: string;
  domain: string | null;
  template_code: string | null;
  status: string;
  progress: number;
  result: Record<string, unknown>;
  error: string | null;
  created_at: string;
}

export interface TaskStepRow {
  id: number;
  task_id: number;
  seq: number;
  agent_name: string;
  action: string;
  output: string | null;
  status: string;
}

export interface LeadRow {
  id: number;
  name: string;
  source: string;
  intent: string;
  need: string;
  owner: string;
  stage: string;
  channel: string;
  external_userid?: string | null;
  created_at: string;
}

export interface KnowledgeRow {
  id: number;
  title: string;
  doc_type: string;
  source: string;
  chunks: number;
  content?: string;
  created_at: string;
}

export interface WecomLinkRow {
  id: number;
  kind: string;
  title: string;
  url: string;
  entity_type: string;
  summary: string;
  created_at: string;
}

export interface DemoTaskRow {
  id: number;
  title: string | null;
  goal: string;
  domain: string | null;
  template_code: string | null;
  status: string;
  progress: number;
  steps: { agent: string; action: string; output?: string; status: string }[];
  result: Record<string, unknown>;
  tokens: number;
  error: string | null;
  created_at: string;
}

function fail(error: unknown, fallback: string): never {
  const message =
    error && typeof error === "object" && "message" in error
      ? String((error as { message: unknown }).message)
      : fallback;
  throw new Error(message || fallback);
}

/**
 * 多租户隔离约定
 * ---------------------------------------------------------------
 * 每张业务表都有 owner_id（归属账号）。本项目所有读写都必须带两个条件：
 *   1. 应用层：查询显式 .eq("owner_id", 当前用户)，写入显式带 owner_id；
 *   2. 数据库层：表开启 RLS，策略为 owner_id = auth.uid()（见 scripts/rls-isolation.sql）。
 * 只做第 1 层，恶意调用方仍可直接用公开密钥读全表；两层都做才是真隔离。
 */

/* ---------------------------------- 模板 ---------------------------------- */

/**
 * 官方模板是产品自带的公共资产（is_official=true），未登录的落地页演示也要能读；
 * 用户自建的模板只返回自己的。
 */
export async function listTemplates(): Promise<AgentTemplate[]> {
  const { data, error } = await cloud.database
    .from("agent_templates")
    .select("*")
    .eq("is_official", true)
    .order("domain", { ascending: true })
    .order("id", { ascending: true });
  if (error) fail(error, "模板目录读取失败");
  // 官方模板的提示词以代码内置版为准（数据库写入被云端拦截，见 prompts.ts 头注释）。
  const official = ((data ?? []) as AgentTemplate[]).map((item) => {
    const bundled = OFFICIAL_PROMPTS[item.code];
    return bundled ? { ...item, role_prompt: bundled } : item;
  });

  const user = await getSessionUser();
  if (!user) return official;

  const { data: mine, error: mineError } = await cloud.database
    .from("agent_templates")
    .select("*")
    .eq("owner_id", user.id)
    .order("id", { ascending: true });
  if (mineError) return official;

  const seen = new Set(official.map((item) => item.id));
  return [...official, ...((mine ?? []) as AgentTemplate[]).filter((item) => !seen.has(item.id))];
}

export async function listAgents(): Promise<AgentRow[]> {
  const owner = await requireOwner();
  const { data, error } = await cloud.database
    .from("agents")
    .select("*")
    .eq("owner_id", owner.id)
    .order("id", { ascending: true });
  if (error) fail(error, "智能体列表读取失败");
  return (data ?? []) as AgentRow[];
}

/** 从模板实例化一个专属智能体（写入当前登录用户的私有数据）。 */
export async function instantiateAgent(template: AgentTemplate, name?: string): Promise<AgentRow> {
  const owner = await requireOwner();
  const { data, error } = await cloud.database
    .from("agents")
    .insert([
      {
        owner_id: owner.id,
        owner_name: owner.name,
        name: name?.trim() || template.name,
        role: template.summary,
        domain: template.domain,
        template_code: template.code,
        template_name: template.name,
        status: "idle",
        capabilities: template.capabilities,
        knowledge: template.knowledge,
        tools: template.tools,
        config: { approvals: template.approvals, metrics: template.metrics, outputs: template.outputs },
      },
    ] as never)
    .select();
  if (error) fail(error, "智能体创建失败");
  return (data ?? [])[0] as AgentRow;
}

export async function updateAgent(agentId: number, patch: Record<string, unknown>): Promise<AgentRow> {
  const owner = await requireOwner();
  const { data, error } = await cloud.database
    .from("agents")
    .update(patch as never)
    .eq("id", agentId)
    .eq("owner_id", owner.id)
    .select();
  if (error) fail(error, "智能体更新失败");
  const row = (data ?? [])[0] as AgentRow | undefined;
  if (!row) throw new Error("该智能体不属于当前账号，无法修改");
  return row;
}

/**
 * 保存用户自定义的岗位人设（提示词）。
 * 存在 agents.config.prompt 而不是改官方模板：模板是公共资产，客户的调教不能污染其他人。
 * prompt 为空串表示清除自定义，回落到官方默认人设。
 */
export async function saveAgentPersona(agentId: number, prompt: string): Promise<AgentRow> {
  const owner = await requireOwner();
  const { data, error } = await cloud.database
    .from("agents")
    .select("config")
    .eq("id", agentId)
    .eq("owner_id", owner.id)
    .limit(1);
  if (error) fail(error, "人设读取失败");
  const current = ((data ?? [])[0] as { config?: Record<string, unknown> } | undefined)?.config ?? {};
  const next: Record<string, unknown> = { ...current };
  const trimmed = prompt.trim();
  if (trimmed) next.prompt = trimmed;
  else delete next.prompt;
  return updateAgent(agentId, { config: next });
}

export async function deleteAgent(agentId: number) {
  const owner = await requireOwner();
  const { data, error } = await cloud.database
    .from("agents")
    .delete()
    .eq("id", agentId)
    .eq("owner_id", owner.id)
    .select();
  if (error) fail(error, "智能体删除失败");
  if (!(data ?? []).length) throw new Error("该智能体不属于当前账号，无法删除");
}

/* ---------------------------------- 任务 ---------------------------------- */

export async function listPrivateTasks(): Promise<TaskRow[]> {
  const owner = await requireOwner();
  const { data, error } = await cloud.database
    .from("tasks")
    .select("*")
    .eq("owner_id", owner.id)
    .order("created_at", { ascending: false })
    .limit(30);
  if (error) fail(error, "任务列表读取失败");
  return (data ?? []) as TaskRow[];
}

export async function listTaskSteps(taskId: number): Promise<TaskStepRow[]> {
  const owner = await requireOwner();
  const { data, error } = await cloud.database
    .from("task_steps")
    .select("*")
    .eq("task_id", taskId)
    .eq("owner_id", owner.id)
    .order("seq", { ascending: true });
  if (error) fail(error, "执行过程读取失败");
  return (data ?? []) as TaskStepRow[];
}

export async function insertTask(input: {
  title: string;
  goal: string;
  domain: string;
  templateCode: string;
  ownerName?: string | null;
}): Promise<TaskRow> {
  const owner = await requireOwner();
  const { data, error } = await cloud.database
    .from("tasks")
    .insert([
      {
        owner_id: owner.id,
        owner_name: owner.name,
        title: input.title,
        goal: input.goal,
        domain: input.domain,
        template_code: input.templateCode,
        status: "running",
        progress: 0,
      },
    ] as never)
    .select();
  if (error) fail(error, "任务创建失败");
  return (data ?? [])[0] as TaskRow;
}

export async function updateTask(taskId: number, patch: Record<string, unknown>) {
  const owner = await requireOwner();
  const { data, error } = await cloud.database
    .from("tasks")
    .update(patch as never)
    .eq("id", taskId)
    .eq("owner_id", owner.id)
    .select();
  if (error) fail(error, "任务更新失败");
  return (data ?? [])[0] as TaskRow;
}

/**
 * 清理僵尸任务：任务在浏览器里跑，一旦页面刷新 / 关闭 / 断网，记录会永远停在「执行中」。
 * 这里在进入工作台时做一次自愈，把明显不会再有进展的任务标记为失败并给出原因，用户可直接重跑。
 */
export async function reapStaleTasks(): Promise<number> {
  try {
    const owner = await requireOwner();
    const { data, error } = await cloud.database
      .from("tasks")
      .select("id,status,progress,created_at")
      .eq("owner_id", owner.id)
      .eq("status", "running")
      .limit(50);
    if (error) return 0;
    const now = Date.now();
    const stale = ((data ?? []) as { id: number; progress?: number; created_at?: string }[]).filter((row) => {
      const started = row.created_at ? new Date(row.created_at).getTime() : 0;
      if (!started) return false;
      const minutes = (now - started) / 60000;
      // 还没开始产出且超过 10 分钟 = 页面已离开；已有进度则给到 40 分钟
      return (row.progress ?? 0) === 0 ? minutes > 10 : minutes > 40;
    });
    for (const row of stale) {
      await updateTask(row.id, {
        status: "failed",
        progress: 100,
        error: "任务执行被中断（页面刷新、关闭或网络中断），点「重跑任务」即可重新执行。",
        finished_at: new Date().toISOString(),
      });
    }
    return stale.length;
  } catch {
    return 0;
  }
}

export async function insertTaskStep(input: {
  taskId: number;
  seq: number;
  agentName: string;
  action: string;
  status: string;
}) {
  const owner = await requireOwner();
  const { data, error } = await cloud.database
    .from("task_steps")
    .insert([
      {
        owner_id: owner.id,
        task_id: input.taskId,
        seq: input.seq,
        agent_name: input.agentName,
        action: input.action,
        status: input.status,
      },
    ] as never)
    .select();
  if (error) fail(error, "执行步骤写入失败");
  return (data ?? [])[0] as TaskStepRow;
}

export async function updateTaskStep(stepId: number, patch: Record<string, unknown>) {
  const owner = await requireOwner();
  const { data, error } = await cloud.database
    .from("task_steps")
    .update(patch as never)
    .eq("id", stepId)
    .eq("owner_id", owner.id)
    .select();
  if (error) fail(error, "执行步骤更新失败");
  return (data ?? [])[0] as TaskStepRow;
}

/* ---------------------------------- 删除 ---------------------------------- */

export async function deleteTask(taskId: number) {
  const owner = await requireOwner();
  await cloud.database.from("task_steps").delete().eq("task_id", taskId).eq("owner_id", owner.id);
  const { error } = await cloud.database.from("tasks").delete().eq("id", taskId).eq("owner_id", owner.id);
  if (error) fail(error, "任务删除失败");
}

/* ---------------------------------- 线索 ---------------------------------- */

export async function listLeads(): Promise<LeadRow[]> {
  const owner = await requireOwner();
  const { data, error } = await cloud.database
    .from("leads")
    .select("*")
    .eq("owner_id", owner.id)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) fail(error, "线索读取失败");
  return (data ?? []) as LeadRow[];
}

export async function insertLead(input: {
  name: string;
  source: string;
  intent: string;
  need: string;
  owner: string;
  stage?: string;
  channel?: string;
}): Promise<LeadRow> {
  const owner = await requireOwner();
  const { data, error } = await cloud.database
    .from("leads")
    .insert([
      {
        owner_id: owner.id,
        owner_name: owner.name,
        name: input.name,
        source: input.source,
        intent: input.intent,
        need: input.need,
        owner: input.owner,
        stage: input.stage ?? "新建",
        channel: input.channel ?? "手动录入",
      },
    ] as never)
    .select();
  if (error) fail(error, "线索创建失败");
  return (data ?? [])[0] as LeadRow;
}

export async function updateLead(leadId: number, patch: Record<string, unknown>): Promise<LeadRow> {
  const owner = await requireOwner();
  const { data, error } = await cloud.database
    .from("leads")
    .update(patch as never)
    .eq("id", leadId)
    .eq("owner_id", owner.id)
    .select();
  if (error) fail(error, "线索更新失败");
  return (data ?? [])[0] as LeadRow;
}

export async function deleteLead(leadId: number) {
  const owner = await requireOwner();
  const { error } = await cloud.database.from("leads").delete().eq("id", leadId).eq("owner_id", owner.id);
  if (error) fail(error, "线索删除失败");
}

/* -------------------------------- 知识与企微 -------------------------------- */

export async function listKnowledgeDocs(): Promise<KnowledgeRow[]> {
  const owner = await requireOwner();
  const { data, error } = await cloud.database
    .from("knowledge_docs")
    .select("id,owner_id,owner_name,title,doc_type,source,chunks,created_at")
    .eq("owner_id", owner.id)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) fail(error, "知识库读取失败");
  return (data ?? []) as KnowledgeRow[];
}

export async function insertKnowledgeDoc(input: {
  title: string;
  docType: string;
  content: string;
  source?: string;
  ownerName?: string | null;
}): Promise<KnowledgeRow> {
  const owner = await requireOwner();
  const chunks = Math.max(1, Math.ceil(input.content.replace(/\s/g, "").length / 300));
  const { data, error } = await cloud.database
    .from("knowledge_docs")
    .insert([
      {
        owner_id: owner.id,
        owner_name: owner.name,
        title: input.title,
        doc_type: input.docType,
        source: input.source ?? "手动录入",
        content: input.content,
        chunks,
      },
    ] as never)
    .select();
  if (error) fail(error, "知识录入失败");
  return (data ?? [])[0] as KnowledgeRow;
}

export async function getKnowledgeDoc(docId: number): Promise<KnowledgeRow> {
  const owner = await requireOwner();
  const { data, error } = await cloud.database
    .from("knowledge_docs")
    .select("*")
    .eq("id", docId)
    .eq("owner_id", owner.id);
  if (error) fail(error, "知识内容读取失败");
  return (data ?? [])[0] as KnowledgeRow;
}

/**
 * 导入前建一次 source 索引（一次查询，不是每文件一查）。
 * 同一个文件重复导入时走「更新」而不是「再插一条」，否则每次重新扫描
 * 都会把资料翻倍，知识库越用越脏。查询失败时返回空表，导入退回旧行为。
 */
export async function loadKnowledgeSourceIndex(): Promise<Map<string, number>> {
  const owner = await requireOwner();
  const { data, error } = await cloud.database
    .from("knowledge_docs")
    .select("id,source")
    .eq("owner_id", owner.id)
    .order("created_at", { ascending: false })
    .limit(500);
  if (error) fail(error, "知识库索引读取失败");
  const index = new Map<string, number>();
  for (const row of (data ?? []) as { id: number; source: string | null }[]) {
    // 手动录入的 source 都是「手动录入」，不能当唯一键，跳过。
    if (row.source && row.source !== "手动录入" && !index.has(row.source)) {
      index.set(row.source, row.id);
    }
  }
  return index;
}

/** 覆盖已有资料的正文与元信息（用于同源文件的重新导入）。 */
export async function updateKnowledgeDoc(
  docId: number,
  patch: { title: string; docType: string; content: string; chunks: number },
): Promise<void> {
  const owner = await requireOwner();
  const { error } = await cloud.database
    .from("knowledge_docs")
    .update({
      title: patch.title,
      doc_type: patch.docType,
      content: patch.content,
      chunks: patch.chunks,
    } as never)
    .eq("id", docId)
    .eq("owner_id", owner.id);
  if (error) fail(error, "知识更新失败");
}

export interface KnowledgeSnippet {
  title: string;
  docType: string;
  content: string;
}

/** 目标拆词：中文按 2-gram + 英文按词，用于给企业资料打相关性分。 */
function extractTerms(goal: string): string[] {
  const parts = goal.replace(/[，。、；：！？,.;:!?（）()[\]"'“”‘’\-—/\\]/g, " ").split(/\s+/).filter(Boolean);
  const terms = new Set<string>();
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower.length >= 2) terms.add(lower);
    if (/[\u4e00-\u9fa5]/.test(part)) {
      for (let i = 0; i < part.length - 1; i += 1) terms.add(part.slice(i, i + 2));
    }
  }
  return [...terms].slice(0, 48);
}

/**
 * 取企业知识胶囊给任务提示词用。
 * 之前任务执行根本没读知识库正文，AI 只能靠通用常识编——这是产出「像样但没用」的根因。
 * 这里按目标关键词相关度排序，并做字数预算截断，避免把 3 万字全塞进上下文。
 * 注意：必须限定在当前账号的资料内检索，否则会给客户 A 的任务喂客户 B 的资料。
 */
export async function loadKnowledgeContext(goal: string, budget = 6000): Promise<KnowledgeSnippet[]> {
  try {
    const owner = await requireOwner();
    const { data, error } = await cloud.database
      .from("knowledge_docs")
      .select("title,doc_type,content,created_at")
      .eq("owner_id", owner.id)
      .order("created_at", { ascending: false })
      // 30 份的上限在文件夹批量导入后立刻失效（一次就能导上百份）：
      // 旧资料哪怕关键词最相关也永远进不了上下文。放宽到 100 份，
      // 单份正文仍受下方 1600 字/总预算 6000 字约束，提示词不会爆。
      .limit(100);
    if (error) return [];

    const rows = (data ?? []) as { title?: string; doc_type?: string; content?: string }[];
    const terms = extractTerms(goal);
    const scored = rows
      .filter((row) => typeof row.content === "string" && (row.content ?? "").trim().length >= 30)
      .map((row) => {
        const title = (row.title ?? "未命名资料").toLowerCase();
        const body = (row.content ?? "").toLowerCase();
        let score = 0;
        for (const term of terms) {
          if (title.includes(term)) score += 3;
          else if (body.includes(term)) score += 1;
        }
        return { row, score };
      })
      .sort((a, b) => b.score - a.score);

    const picked: KnowledgeSnippet[] = [];
    let used = 0;
    for (const { row, score } of scored) {
      // 一条都不相关时，至少带上最新的资料，保证 AI 知道企业大概在做什么
      if (score === 0 && picked.length > 0) continue;
      const text = (row.content ?? "").trim();
      const room = budget - used;
      if (room < 200) break;
      const slice = text.slice(0, Math.min(1600, room));
      picked.push({ title: row.title ?? "未命名资料", docType: row.doc_type ?? "资料", content: slice });
      used += slice.length;
      if (used >= budget) break;
    }
    return picked;
  } catch {
    // 知识库不可用不能阻断任务执行
    return [];
  }
}

export async function deleteKnowledgeDoc(docId: number) {
  const owner = await requireOwner();
  const { error } = await cloud.database
    .from("knowledge_docs")
    .delete()
    .eq("id", docId)
    .eq("owner_id", owner.id);
  if (error) fail(error, "知识删除失败");
}

export async function listWecomLinks(): Promise<WecomLinkRow[]> {
  const owner = await requireOwner();
  const { data, error } = await cloud.database
    .from("wecom_links")
    .select("*")
    .eq("owner_id", owner.id)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) fail(error, "企微链接读取失败");
  return (data ?? []) as WecomLinkRow[];
}

/** 登记一条已分发到企业微信的资产（智能表格 / 文档 / 待办链接）。 */
export async function insertWecomLink(input: {
  kind: string;
  title: string;
  summary: string;
  url: string;
}): Promise<WecomLinkRow> {
  const owner = await requireOwner();
  const { data, error } = await cloud.database
    .from("wecom_links")
    .insert([
      {
        owner_id: owner.id,
        owner_name: owner.name,
        kind: input.kind,
        title: input.title.trim(),
        summary: input.summary.trim(),
        url: input.url.trim(),
      },
    ] as never)
    .select();
  if (error) fail(error, "企微资产登记失败");
  return (data ?? [])[0] as WecomLinkRow;
}

export async function deleteWecomLink(linkId: number) {
  const owner = await requireOwner();
  const { error } = await cloud.database
    .from("wecom_links")
    .delete()
    .eq("id", linkId)
    .eq("owner_id", owner.id);
  if (error) fail(error, "企微资产删除失败");
}

/* ------------------------------ 跟进记录（回流闭环） ------------------------------ */

export interface FollowUpRow {
  id: number;
  channel: string;
  result: string;
  next_step: string;
  note: string;
  created_at: string;
}

interface FollowUpMessageRaw {
  id: number;
  content: string | null;
  created_at: string;
}

/**
 * 跟进记录复用 messages 表存储：role="follow_up"，task_id 存线索 id。
 * 不新建表（匿名/受限账号建表会被云端拦截），role 字段保证与普通会话消息互不干扰。
 */
export async function listFollowUps(leadId: number): Promise<FollowUpRow[]> {
  const owner = await requireOwner();
  const { data, error } = await cloud.database
    .from("messages")
    .select("id, content, created_at")
    .eq("owner_id", owner.id)
    .eq("task_id", leadId)
    .eq("role", "follow_up")
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) fail(error, "跟进记录读取失败");
  return ((data ?? []) as FollowUpMessageRaw[]).map((row) => {
    let parsed: { channel?: string; result?: string; next?: string; note?: string } = {};
    try {
      parsed = JSON.parse(row.content ?? "{}") as typeof parsed;
    } catch {
      // 兼容手写的纯文本记录
    }
    return {
      id: row.id,
      channel: parsed.channel ?? "企微",
      result: parsed.result ?? "已联系",
      next_step: parsed.next ?? "",
      note: parsed.note ?? "",
      created_at: row.created_at,
    };
  });
}

export async function insertFollowUp(input: {
  leadId: number;
  channel: string;
  result: string;
  nextStep: string;
  note: string;
}): Promise<FollowUpRow> {
  const owner = await requireOwner();
  const { data, error } = await cloud.database
    .from("messages")
    .insert([
      {
        owner_id: owner.id,
        owner_name: owner.name,
        agent_name: "跟进回填",
        role: "follow_up",
        task_id: input.leadId,
        content: JSON.stringify({
          channel: input.channel,
          result: input.result,
          next: input.nextStep,
          note: input.note,
        }),
      },
    ] as never)
    .select();
  if (error) fail(error, "跟进记录写入失败");
  const row = (data ?? [])[0] as { id: number; created_at: string };
  return {
    id: row.id,
    channel: input.channel,
    result: input.result,
    next_step: input.nextStep,
    note: input.note,
    created_at: row.created_at,
  };
}

/* --------------------------- 企微客户同步（身份打通） --------------------------- */

export interface KfCustomerPayload {
  externalUserId: string;
  name: string;
  stage: string;
  lastText: string;
  firstSeen: string;
  lastSeen: string;
  msgCount: number;
}

export interface KfEventPayload {
  seq: number;
  externalUserId: string;
  direction: "in" | "out";
  type?: string;
  text: string;
  ruleId?: string;
  at: string;
}

export interface KfMessageRow {
  id: number;
  direction: "in" | "out";
  text: string;
  created_at: string;
}

/** 高意向阶段：命中时线索意向自动升为「高意向」（人工仍可改）。 */
function isHighIntentStage(stage: string) {
  return stage === "成交" || stage === "报价" || stage === "试用" || stage === "已预约";
}

/** 企微侧粗判的阶段映射成线索意向等级，人工可在线索里再改。 */
function intentOfStage(stage: string) {
  if (isHighIntentStage(stage)) return "高意向";
  if (stage === "培育") return "中意向";
  return "中意向";
}

/**
 * 按 external_userid 认领客户：
 * 已有线索就更新「最新需求」，没有就建一条来源=企业微信的线索。
 * 身份打通的落点在这里——企微里的客户从这里开始拥有系统内的线索 id。
 *
 * touchNeed：只有本次同步带来新对话的客户才覆盖 need。否则每次全量同步都会
 * 用企微侧的 lastText 把销售手工编辑过的「最新需求」冲掉（数据被静默覆盖）。
 */
export async function upsertLeadByExternalId(
  customer: KfCustomerPayload,
  options: { touchNeed?: boolean } = {},
): Promise<{ leadId: number; created: boolean }> {
  const owner = await requireOwner();
  const { data, error } = await cloud.database
    .from("leads")
    .select("id")
    .eq("owner_id", owner.id)
    .eq("external_userid", customer.externalUserId)
    .limit(1);
  if (error) fail(error, "企微客户查询失败");

  const existing = (data ?? [])[0] as { id: number } | undefined;
  if (existing) {
    if (options.touchNeed !== false) {
      const patchBody: Record<string, unknown> = {};
      if (customer.lastText) patchBody.need = customer.lastText.slice(0, 200);
      // 高意向实时提醒的落点：客户一旦进入报价/成交/试用阶段，标签自动升级，
      // 销售在列表里一眼能看到该重点跟进谁（仍可手工改回）。
      if (isHighIntentStage(customer.stage)) patchBody.intent = "高意向";
      if (Object.keys(patchBody).length > 0) {
        const patch = await cloud.database
          .from("leads")
          .update(patchBody as never)
          .eq("id", existing.id)
          .eq("owner_id", owner.id);
        if (patch.error) fail(patch.error, "企微客户需求更新失败");
      }
    }
    return { leadId: existing.id, created: false };
  }

  const inserted = await cloud.database
    .from("leads")
    .insert([
      {
        owner_id: owner.id,
        owner_name: owner.name,
        name: customer.name || `企微客户 ${customer.externalUserId.slice(-4)}`,
        source: "企业微信",
        channel: "微信客服",
        intent: intentOfStage(customer.stage),
        need: (customer.lastText || "企微首次咨询，需求待补").slice(0, 200),
        owner: "AI 客服",
        stage: customer.stage || "新建",
        external_userid: customer.externalUserId,
      },
    ] as never)
    .select();
  if (inserted.error) fail(inserted.error, "企微客户建档失败");
  return { leadId: ((inserted.data ?? [])[0] as { id: number }).id, created: true };
}

/**
 * 把事件流里的对话写成 kf_msg 消息（task_id = 线索 id），按 seq 去重，
 * 所以同一个游标重拉或清空浏览器存储后重同步都不会产生重复记录。
 */
export async function importKfMessages(leadId: number, events: KfEventPayload[]): Promise<number> {
  if (events.length === 0) return 0;
  const owner = await requireOwner();
  const existing = await cloud.database
    .from("messages")
    .select("content")
    .eq("owner_id", owner.id)
    .eq("task_id", leadId)
    .eq("role", "kf_msg")
    .limit(500);
  if (existing.error) fail(existing.error, "企微对话查重失败");

  const seen = new Set<number>();
  for (const row of (existing.data ?? []) as { content: string }[]) {
    try {
      const parsed = JSON.parse(row.content ?? "{}") as { seq?: number };
      if (typeof parsed.seq === "number") seen.add(parsed.seq);
    } catch {
      // 老数据不是 JSON，忽略即可
    }
  }

  const rows = events
    .filter((event) => !seen.has(event.seq))
    .map((event) => ({
      owner_id: owner.id,
      owner_name: owner.name,
      agent_name: event.direction === "in" ? "客户" : "AI 客服",
      role: "kf_msg",
      task_id: leadId,
      content: JSON.stringify({
        seq: event.seq,
        direction: event.direction,
        text: event.text,
        at: event.at,
        ruleId: event.ruleId ?? "",
      }),
    }));
  if (rows.length === 0) return 0;

  const { error } = await cloud.database.from("messages").insert(rows as never);
  if (error) fail(error, "企微对话导入失败");
  return rows.length;
}

/** 读取某个客户的企微对话，按时间正序，供跟进弹窗里看上下文。 */
export async function listKfMessages(leadId: number, limit = 12): Promise<KfMessageRow[]> {
  const owner = await requireOwner();
  const { data, error } = await cloud.database
    .from("messages")
    .select("id, content, created_at")
    .eq("owner_id", owner.id)
    .eq("task_id", leadId)
    .eq("role", "kf_msg")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) fail(error, "企微对话读取失败");
  return ((data ?? []) as { id: number; content: string; created_at: string }[])
    .map((row) => {
      try {
        const parsed = JSON.parse(row.content ?? "{}") as { direction?: "in" | "out"; text?: string };
        return { id: row.id, direction: parsed.direction ?? "in", text: parsed.text ?? "", created_at: row.created_at };
      } catch {
        return { id: row.id, direction: "in" as const, text: row.content ?? "", created_at: row.created_at };
      }
    })
    .reverse();
}

export async function listMessages(taskId?: number) {
  const owner = await requireOwner();
  let query = cloud.database
    .from("messages")
    .select("*")
    .eq("owner_id", owner.id)
    .order("created_at", { ascending: true })
    .limit(100);
  if (taskId) query = query.eq("task_id", taskId);
  const { data, error } = await query;
  if (error) fail(error, "会话读取失败");
  return (data ?? []) as { id: number; agent_name: string; role: string; content: string; created_at: string }[];
}

export async function insertMessage(input: {
  agentName: string;
  role: string;
  content: string;
  taskId?: number | null;
  ownerName?: string | null;
}) {
  const owner = await requireOwner();
  const { data, error } = await cloud.database
    .from("messages")
    .insert([
      {
        owner_id: owner.id,
        owner_name: owner.name,
        agent_name: input.agentName,
        role: input.role,
        content: input.content,
        task_id: input.taskId ?? null,
      },
    ] as never)
    .select();
  if (error) fail(error, "消息写入失败");
  return (data ?? [])[0];
}
