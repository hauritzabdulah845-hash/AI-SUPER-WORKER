import { estimateTokens } from "./usage";

/**
 * 企业设置能力层（域 12 设置与企业管理）：
 * 成员与权限 / 品牌与业务配置 / 模型目录与价格，全部本机留档（localStorage）。
 *
 * 边界（诚实标注）：
 * - 成员体系目前只是本机名单 + 角色门禁，不等于云端账号体系；
 *   接入云端成员体系后置（见 docs 接入清单），届时以云端为真源。
 * - 模型目录内置的是示例价格，必须按厂商官网核对后再用于真实计费。
 * - tokens 口径与 usage.ts 的 estimateTokens 一致（趋势估算，非计费依据）。
 */

const MEMBERS_KEY = "ai-employee:members";
const BRAND_KEY = "ai-employee:brand-config";
const CATALOG_KEY = "ai-employee:model-catalog";
export const MAX_MEMBERS = 50;

/* ---------------------------------- 成员 ---------------------------------- */

export const MEMBER_ROLES = ["管理员", "运营", "只读"] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

export const MEMBER_STATUSES = ["启用", "停用"] as const;
export type MemberStatus = (typeof MEMBER_STATUSES)[number];

export interface Member {
  id: string;
  name: string;
  role: MemberRole;
  status: MemberStatus;
  note: string;
}

function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export function createMember(name: string): Member {
  return { id: newId("member"), name: name.trim().slice(0, 20), role: "运营", status: "启用", note: "" };
}

/** 归一化一条成员记录（字段限长、枚举白名单）。非法 id/姓名返回 null。 */
export function normalizeMember(input: Partial<Member> | null | undefined): Member | null {
  if (!input) return null;
  const id = String(input.id ?? "").trim();
  const name = String(input.name ?? "").trim().slice(0, 20);
  if (!id || !name) return null;
  const role = (MEMBER_ROLES as readonly string[]).includes(String(input.role)) ? (input.role as MemberRole) : "运营";
  const status = (MEMBER_STATUSES as readonly string[]).includes(String(input.status)) ? (input.status as MemberStatus) : "启用";
  return { id, name, role, status, note: String(input.note ?? "").trim().slice(0, 100) };
}

export interface MemberValidation {
  ok: boolean;
  errors: string[];
}

/** 成员校验：姓名必填、角色/状态白名单、备注限长、同名提示（不阻断，仅提示不计入 errors）。 */
export function validateMember(candidate: Partial<Member>, existing: Member[] = []): MemberValidation {
  const errors: string[] = [];
  const name = String(candidate.name ?? "").trim();
  if (!name) errors.push("姓名不能为空");
  if (name.length > 20) errors.push("姓名不超过 20 字");
  if (!(MEMBER_ROLES as readonly string[]).includes(String(candidate.role ?? ""))) errors.push("角色必须是管理员 / 运营 / 只读");
  if (!(MEMBER_STATUSES as readonly string[]).includes(String(candidate.status ?? "启用"))) errors.push("状态必须是启用 / 停用");
  if (String(candidate.note ?? "").length > 100) errors.push("备注不超过 100 字");
  if (existing.length >= MAX_MEMBERS && !existing.some((row) => row.id === candidate.id)) {
    errors.push(`成员已达上限 ${MAX_MEMBERS} 人`);
  }
  return { ok: errors.length === 0, errors };
}

/** 启用状态的管理员数量。 */
export function countEnabledAdmins(members: Member[]): number {
  return members.filter((row) => row.role === "管理员" && row.status === "启用").length;
}

/** 删除门禁：不能删掉最后一名启用管理员。 */
export function canRemoveMember(members: Member[], id: string): boolean {
  const target = members.find((row) => row.id === id);
  if (!target) return false;
  if (target.role === "管理员" && target.status === "启用" && countEnabledAdmins(members) <= 1) return false;
  return true;
}

/**
 * 保存门禁：把最后一名启用管理员改成非管理员 / 停用，同样拦截（与删除同理）。
 * 新增成员（id 不在现有列表）直接放行。
 */
export function canSaveMember(members: Member[], candidate: Member): boolean {
  const current = members.find((row) => row.id === candidate.id);
  if (!current) return true;
  const wasEnabledAdmin = current.role === "管理员" && current.status === "启用";
  const stillEnabledAdmin = candidate.role === "管理员" && candidate.status === "启用";
  if (wasEnabledAdmin && !stillEnabledAdmin && countEnabledAdmins(members) <= 1) return false;
  return true;
}

export interface MemberFilter {
  keyword?: string;
  role?: string;
  status?: string;
}

/** 成员过滤：关键词命中姓名/备注，角色/状态精确匹配，空条件=全部。 */
export function filterMembers(members: Member[], filter: MemberFilter = {}): Member[] {
  const keyword = String(filter.keyword ?? "").trim().toLowerCase();
  return members.filter((row) => {
    if (filter.role && row.role !== filter.role) return false;
    if (filter.status && row.status !== filter.status) return false;
    if (keyword && !`${row.name} ${row.note}`.toLowerCase().includes(keyword)) return false;
    return true;
  });
}

export function loadMembers(): Member[] {
  try {
    const raw = localStorage.getItem(MEMBERS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map((row) => normalizeMember(row as Partial<Member>)).filter((row): row is Member => Boolean(row)).slice(0, MAX_MEMBERS);
  } catch {
    return [];
  }
}

export function saveMembers(members: Member[]): Member[] {
  const next = members.map((row) => normalizeMember(row)).filter((row): row is Member => Boolean(row)).slice(0, MAX_MEMBERS);
  try {
    localStorage.setItem(MEMBERS_KEY, JSON.stringify(next));
  } catch {
    /* 节点测试环境无 localStorage / 隐私模式写失败不影响主流程 */
  }
  return next;
}

/* ---------------------------------- 品牌 ---------------------------------- */

export interface BrandConfig {
  brandName: string;
  industry: string;
  slogan: string;
  /** 话术红线：生成内容时禁止出现的表述（每条一条） */
  redlines: string[];
  /** 语气风格，如「专业克制」「亲切口语」 */
  tone: string;
}

export const EMPTY_BRAND: BrandConfig = { brandName: "", industry: "", slogan: "", redlines: [], tone: "" };

/** 品牌配置归一化：去空、限长、红线去重封顶 20 条。 */
export function normalizeBrandConfig(input: Partial<BrandConfig> | null | undefined): BrandConfig {
  const redlines = [...new Set((input?.redlines ?? []).map((item) => String(item).trim().slice(0, 60)).filter(Boolean))].slice(0, 20);
  return {
    brandName: String(input?.brandName ?? "").trim().slice(0, 30),
    industry: String(input?.industry ?? "").trim().slice(0, 30),
    slogan: String(input?.slogan ?? "").trim().slice(0, 60),
    redlines,
    tone: String(input?.tone ?? "").trim().slice(0, 30),
  };
}

export function loadBrandConfig(): BrandConfig {
  try {
    const raw = localStorage.getItem(BRAND_KEY);
    if (!raw) return { ...EMPTY_BRAND };
    return normalizeBrandConfig(JSON.parse(raw) as Partial<BrandConfig>);
  } catch {
    return { ...EMPTY_BRAND };
  }
}

export function saveBrandConfig(config: BrandConfig): BrandConfig {
  const next = normalizeBrandConfig(config);
  try {
    localStorage.setItem(BRAND_KEY, JSON.stringify(next));
  } catch {
    /* 同上 */
  }
  return next;
}

/**
 * 生成可注入提示词的品牌上下文片段（供任务编排引用）。
 * 本批只提供函数 + 设置页预览，不强行改 runner；全空配置返回空串。
 */
export function buildBrandContext(config: BrandConfig): string {
  const brand = normalizeBrandConfig(config);
  const lines: string[] = [];
  if (brand.brandName) lines.push(`品牌名称：${brand.brandName}`);
  if (brand.industry) lines.push(`所属行业：${brand.industry}`);
  if (brand.slogan) lines.push(`品牌口号：${brand.slogan}`);
  if (brand.tone) lines.push(`表达语气：${brand.tone}`);
  if (brand.redlines.length) lines.push(`话术红线（禁止出现）：${brand.redlines.join("；")}`);
  return lines.join("\n");
}

/* -------------------------------- 模型目录 -------------------------------- */

export interface ModelCatalogEntry {
  id: string;
  provider: string;
  model: string;
  /** 每 1k 输入 tokens 价格 */
  inputPricePer1k: number;
  /** 每 1k 输出 tokens 价格 */
  outputPricePer1k: number;
  currency: string;
  enabled: boolean;
  note: string;
}

/**
 * 内置示例目录：价格为示例值（量级参考），正式使用前必须按厂商官网核对。
 * 结构与 provider.ts 的服务商预设对齐，方便对照「模型接入」配置。
 */
export function defaultModelCatalog(): ModelCatalogEntry[] {
  return [
    { id: "deepseek-chat", provider: "DeepSeek", model: "deepseek-chat", inputPricePer1k: 0.001, outputPricePer1k: 0.002, currency: "CNY", enabled: true, note: "示例价格，需按厂商官网核对" },
    { id: "deepseek-reasoner", provider: "DeepSeek", model: "deepseek-reasoner", inputPricePer1k: 0.004, outputPricePer1k: 0.016, currency: "CNY", enabled: true, note: "示例价格，需按厂商官网核对" },
    { id: "qwen-plus", provider: "通义千问", model: "qwen-plus", inputPricePer1k: 0.0008, outputPricePer1k: 0.002, currency: "CNY", enabled: true, note: "示例价格，需按厂商官网核对" },
    { id: "moonshot-v1-8k", provider: "Kimi", model: "moonshot-v1-8k", inputPricePer1k: 0.012, outputPricePer1k: 0.012, currency: "CNY", enabled: false, note: "示例价格，需按厂商官网核对" },
    { id: "platform-default", provider: "平台通道", model: "平台默认模型", inputPricePer1k: 0, outputPricePer1k: 0, currency: "CNY", enabled: true, note: "平台配额计费，单价以平台账单为准" },
  ];
}

function clampPrice(value: unknown): number {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) return 0;
  return Math.min(num, 1000);
}

/** 归一化一条目录记录（价格夹紧 ≥0、字段限长）。缺 id/provider/model 返回 null。 */
export function normalizeCatalogEntry(input: Partial<ModelCatalogEntry> | null | undefined): ModelCatalogEntry | null {
  if (!input) return null;
  const id = String(input.id ?? "").trim().slice(0, 60);
  const provider = String(input.provider ?? "").trim().slice(0, 30);
  const model = String(input.model ?? "").trim().slice(0, 60);
  if (!id || !provider || !model) return null;
  return {
    id,
    provider,
    model,
    inputPricePer1k: clampPrice(input.inputPricePer1k),
    outputPricePer1k: clampPrice(input.outputPricePer1k),
    currency: String(input.currency ?? "CNY").trim().slice(0, 8) || "CNY",
    enabled: input.enabled !== false,
    note: String(input.note ?? "").trim().slice(0, 80),
  };
}

export function loadModelCatalog(): ModelCatalogEntry[] {
  try {
    const raw = localStorage.getItem(CATALOG_KEY);
    if (!raw) return defaultModelCatalog();
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return defaultModelCatalog();
    const rows = parsed.map((row) => normalizeCatalogEntry(row as Partial<ModelCatalogEntry>)).filter((row): row is ModelCatalogEntry => Boolean(row));
    return rows.length ? rows : defaultModelCatalog();
  } catch {
    return defaultModelCatalog();
  }
}

export function saveModelCatalog(entries: ModelCatalogEntry[]): ModelCatalogEntry[] {
  const next = entries.map((row) => normalizeCatalogEntry(row)).filter((row): row is ModelCatalogEntry => Boolean(row));
  try {
    localStorage.setItem(CATALOG_KEY, JSON.stringify(next));
  } catch {
    /* 同上 */
  }
  return next;
}

/** 只取启用的目录条目（费用试算/下拉选项用）。 */
export function filterEnabledCatalog(entries: ModelCatalogEntry[]): ModelCatalogEntry[] {
  return entries.filter((row) => row.enabled);
}

/**
 * 费用估算：按每 1k tokens 单价计价，负数/非有限值夹紧为 0。
 * 结果保留 6 位小数（小额不被舍成 0）。tokens 口径与 usage.estimateTokens 一致。
 */
export function estimateCost(entry: ModelCatalogEntry, inputTokens: number, outputTokens: number): number {
  const input = Number.isFinite(inputTokens) ? Math.max(0, inputTokens) : 0;
  const output = Number.isFinite(outputTokens) ? Math.max(0, outputTokens) : 0;
  const cost = (input / 1000) * clampPrice(entry.inputPricePer1k) + (output / 1000) * clampPrice(entry.outputPricePer1k);
  return Math.round(cost * 1_000_000) / 1_000_000;
}

/** 按文本估算费用（先用 usage 的 token 口径换算，再走 estimateCost）。 */
export function estimateTextCost(entry: ModelCatalogEntry, inputText: string, outputText: string): number {
  return estimateCost(entry, estimateTokens(inputText), estimateTokens(outputText));
}
