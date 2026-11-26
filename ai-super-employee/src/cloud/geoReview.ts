import { brandStorageKey, type StorageLike } from "./keywordLibrary";
import {
  normalizeBrandAssets,
  type BrandAssets,
  type StyleRules,
} from "./brandAssets";

/**
 * GEO 稿件审核门禁（第二十九批，借鉴抓词 GEO「所有产出只是底稿，必须人工审核才能分发」）：
 * GEO 素材稿 / 平台稿先送审（自动检查 + 人工通过/驳回），通过后才放行分发入口。
 *
 * 与群发审批（broadcast.ts）的关系：复用同一套「待审 → 通过/驳回、未放行拦截」语义，
 * 但 GEO 稿件是内容资产而非发送计划，单独建队列，避免和群发计划混表。
 * 存储策略与词库一致：**只存本机 localStorage，不上传**，按品牌名分键。
 */

export type GeoDraftStatus = "draft" | "pending" | "approved" | "rejected";
export type GeoDraftKind = "assets" | "platform" | "manual";
export type GeoReviewAction = "submit" | "approve" | "reject" | "reopen";

export interface DraftCheck {
  key: "banned" | "required" | "brand" | "length" | "disclaimer";
  label: string;
  pass: boolean;
  detail: string;
}

export interface GeoReviewItem {
  id: string;
  brand: string;
  title: string;
  /** 稿件正文（素材稿存拼接文本，平台稿存标题+正文+标签） */
  body: string;
  kind: GeoDraftKind;
  status: GeoDraftStatus;
  /** 送审时的自动检查结果（送审后固定，改稿需重新送审） */
  checks: DraftCheck[];
  createdAt: string;
  decidedAt?: string;
  /** 驳回理由（驳回时必填一句） */
  rejectReason?: string;
}

export const REVIEW_QUEUE_STORAGE_KEY = "ai-employee:geo-review-queue";
/** 每品牌待审队列上限，防 localStorage 膨胀 */
export const MAX_REVIEW_ITEMS = 50;
/** 稿件正文字数区间（自动检查）：太短引用价值低，太长多半是未压缩的堆料 */
export const DRAFT_MIN_CHARS = 30;
export const DRAFT_MAX_CHARS = 3000;

export const DRAFT_STATUS_LABEL: Record<GeoDraftStatus, string> = {
  draft: "草稿",
  pending: "待审核",
  approved: "已通过",
  rejected: "已驳回",
};

/* ------------------------------ 状态机 ------------------------------ */

/**
 * 状态流转表：
 * - submit：draft → pending（送审）；rejected → pending（改后重送）
 * - approve：pending → approved
 * - reject：pending → rejected
 * - reopen：rejected → draft（退回草稿改稿）；approved → draft（撤回重审，防止已通过稿被偷改）
 */
const TRANSITIONS: Record<
  GeoReviewAction,
  Partial<Record<GeoDraftStatus, GeoDraftStatus>>
> = {
  submit: { draft: "pending", rejected: "pending" },
  approve: { pending: "approved" },
  reject: { pending: "rejected" },
  reopen: { rejected: "draft", approved: "draft" },
};

export function canTransition(
  status: GeoDraftStatus,
  action: GeoReviewAction,
): boolean {
  return Boolean(TRANSITIONS[action][status]);
}

/** 执行一次状态流转；非法流转抛中文错误（调用方用 friendlyError 透传展示）。 */
export function applyTransition(
  item: GeoReviewItem,
  action: GeoReviewAction,
  options: { note?: string; now?: string } = {},
): GeoReviewItem {
  const next = TRANSITIONS[action][item.status];
  if (!next) {
    throw new Error(
      `「${item.title}」当前是${DRAFT_STATUS_LABEL[item.status]}状态，不能执行该操作。`,
    );
  }
  const now = options.now ?? new Date().toISOString();
  if (action === "reject") {
    const reason = (options.note ?? "").trim();
    if (!reason) throw new Error("驳回时请填一句理由，方便改稿。");
    return {
      ...item,
      status: next,
      decidedAt: now,
      rejectReason: reason.slice(0, 200),
    };
  }
  if (action === "approve") {
    return { ...item, status: next, decidedAt: now, rejectReason: undefined };
  }
  if (action === "reopen") {
    return {
      ...item,
      status: next,
      decidedAt: undefined,
      rejectReason: undefined,
    };
  }
  // submit：清掉上次驳回理由与裁决时间，进入待审
  return {
    ...item,
    status: next,
    decidedAt: undefined,
    rejectReason: undefined,
  };
}

/** 是否可分发：只有已通过的稿件放行（与 broadcast 的 canSend 同语义）。 */
export function canDistribute(item: GeoReviewItem): boolean {
  return item.status === "approved";
}

/** 分发拦截提示（未通过时给用户的人话说明）。 */
export function distributeBlockReason(item: GeoReviewItem): string {
  if (item.status === "approved") return "";
  if (item.status === "pending") return "稿件正在待审核，通过后才能分发。";
  if (item.status === "rejected")
    return `稿件已被驳回（${item.rejectReason || "未填理由"}），改后重新送审。`;
  return "稿件还没送审，请先送审并通过后再分发。";
}

/* ------------------------------ 自动检查 ------------------------------ */

function includesWord(text: string, word: string): boolean {
  return text.toLowerCase().includes(word.trim().toLowerCase());
}

/**
 * 审核自动检查（纯函数）：按表达规范逐项 pass/fail。
 * - 禁用词：命中任一即 fail，列出命中词
 * - 必用词：缺任一即 fail，列出缺失词；未设置必用词直接 pass
 * - 品牌名：标题+正文须出现品牌名（品牌为空时 fail 并说明）
 * - 字数：正文长度须在 [DRAFT_MIN_CHARS, DRAFT_MAX_CHARS]
 * - 免责声明：规范里设了免责声明则正文须包含其全文（去空白比较）；未设置直接 pass
 */
export function checkDraft(
  draft: { title: string; body: string },
  rules: StyleRules,
  brand: string,
): DraftCheck[] {
  const title = draft.title ?? "";
  const body = draft.body ?? "";
  const full = `${title}\n${body}`;
  const checks: DraftCheck[] = [];

  const bannedHits = (rules.bannedWords ?? []).filter(
    (word) => word.trim() && includesWord(full, word),
  );
  checks.push({
    key: "banned",
    label: "禁用词",
    pass: bannedHits.length === 0,
    detail: bannedHits.length
      ? `命中禁用词：${bannedHits.join("、")}`
      : "未命中禁用词",
  });

  const required = (rules.requiredWords ?? []).filter((word) => word.trim());
  const missingRequired = required.filter((word) => !includesWord(full, word));
  checks.push({
    key: "required",
    label: "必用词",
    pass: missingRequired.length === 0,
    detail: !required.length
      ? "未设置必用词"
      : missingRequired.length
        ? `缺失必用词：${missingRequired.join("、")}`
        : `必用词齐全（${required.length} 个）`,
  });

  const brandName = brand.trim();
  checks.push({
    key: "brand",
    label: "品牌名出现",
    pass: Boolean(brandName) && includesWord(full, brandName),
    detail: !brandName
      ? "未填写品牌名，无法校验"
      : includesWord(full, brandName)
        ? `已出现「${brandName}」`
        : `未出现品牌名「${brandName}」`,
  });

  const length = body.trim().length;
  checks.push({
    key: "length",
    label: "字数区间",
    pass: length >= DRAFT_MIN_CHARS && length <= DRAFT_MAX_CHARS,
    detail: `正文 ${length} 字（要求 ${DRAFT_MIN_CHARS}-${DRAFT_MAX_CHARS} 字）`,
  });

  const disclaimer = (rules.disclaimer ?? "").trim();
  const compact = (text: string) => text.replace(/\s+/g, "");
  checks.push({
    key: "disclaimer",
    label: "免责声明",
    pass: !disclaimer || compact(body).includes(compact(disclaimer)),
    detail: !disclaimer
      ? "未设置免责声明"
      : compact(body).includes(compact(disclaimer))
        ? "已带免责声明"
        : "未带规范里的免责声明",
  });

  return checks;
}

/** 自动检查是否全部通过。 */
export function checksAllPass(checks: DraftCheck[]): boolean {
  return checks.length > 0 && checks.every((check) => check.pass);
}

/* ------------------------------ 队列条目与存取 ------------------------------ */

export function createReviewItem(input: {
  brand: string;
  title: string;
  body: string;
  kind: GeoDraftKind;
  assets: BrandAssets;
  now?: string;
}): GeoReviewItem {
  const assets = normalizeBrandAssets(input.assets);
  return {
    id: `rev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    brand: input.brand.trim(),
    title: input.title.trim().slice(0, 80) || "未命名稿件",
    body: input.body.slice(0, 6000),
    kind: input.kind,
    status: "draft",
    checks: checkDraft(
      { title: input.title, body: input.body },
      assets.rules,
      input.brand,
    ),
    createdAt: input.now ?? new Date().toISOString(),
  };
}

function normalizeReviewItem(
  raw: Partial<GeoReviewItem>,
): GeoReviewItem | null {
  if (!raw || typeof raw.id !== "string" || !raw.id) return null;
  const status: GeoDraftStatus = (
    ["draft", "pending", "approved", "rejected"] as const
  ).includes(raw.status as GeoDraftStatus)
    ? (raw.status as GeoDraftStatus)
    : "draft";
  const kind: GeoDraftKind = (
    ["assets", "platform", "manual"] as const
  ).includes(raw.kind as GeoDraftKind)
    ? (raw.kind as GeoDraftKind)
    : "manual";
  return {
    id: raw.id,
    brand: String(raw.brand ?? ""),
    title: String(raw.title ?? "未命名稿件").slice(0, 80),
    body: String(raw.body ?? "").slice(0, 6000),
    kind,
    status,
    checks: Array.isArray(raw.checks) ? raw.checks : [],
    createdAt:
      typeof raw.createdAt === "string"
        ? raw.createdAt
        : new Date().toISOString(),
    ...(raw.decidedAt ? { decidedAt: String(raw.decidedAt) } : {}),
    ...(raw.rejectReason
      ? { rejectReason: String(raw.rejectReason).slice(0, 200) }
      : {}),
  };
}

/** 无 localStorage 环境（Node 测试/隐私模式）下的内存兜底，保证存取往返可测。 */
const memoryFallback = new Map<string, string>();
const memoryStorage: StorageLike = {
  getItem: (key) => memoryFallback.get(key) ?? null,
  setItem: (key, value) => {
    memoryFallback.set(key, value);
  },
};

function defaultStorage(): StorageLike {
  try {
    if (typeof window !== "undefined" && window.localStorage)
      return window.localStorage;
  } catch {
    /* 隐私模式访问 localStorage 可能抛错，落到内存兜底 */
  }
  return memoryStorage;
}

function readQueueMap(storage: StorageLike): Record<string, GeoReviewItem[]> {
  try {
    const raw = storage.getItem(REVIEW_QUEUE_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, GeoReviewItem[]>;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

export function loadReviewQueue(
  brand: string,
  storage: StorageLike = defaultStorage(),
): GeoReviewItem[] {
  const rows = readQueueMap(storage)[brandStorageKey(brand)];
  if (!Array.isArray(rows)) return [];
  return rows
    .flatMap((row) => {
      const item = normalizeReviewItem((row ?? {}) as Partial<GeoReviewItem>);
      return item ? [item] : [];
    })
    .slice(0, MAX_REVIEW_ITEMS);
}

export function saveReviewQueue(
  brand: string,
  items: GeoReviewItem[],
  storage: StorageLike = defaultStorage(),
): void {
  try {
    const map = readQueueMap(storage);
    map[brandStorageKey(brand)] = items.slice(0, MAX_REVIEW_ITEMS);
    storage.setItem(REVIEW_QUEUE_STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* 配额满/隐私模式：本次会话内仍可用，只是不落盘 */
  }
}

/** 送审入队：新建条目并直接流转到 pending（草稿态只在「退回改稿」后出现）。 */
export function enqueueForReview(
  brand: string,
  input: {
    title: string;
    body: string;
    kind: GeoDraftKind;
    assets: BrandAssets;
  },
  storage: StorageLike = defaultStorage(),
): GeoReviewItem {
  const item = applyTransition(createReviewItem({ brand, ...input }), "submit");
  const queue = loadReviewQueue(brand, storage);
  saveReviewQueue(brand, [item, ...queue], storage);
  return item;
}

/** 更新队列中一条（流转后回存），返回更新后的队列。 */
export function updateReviewItem(
  brand: string,
  id: string,
  action: GeoReviewAction,
  options: { note?: string } = {},
  storage: StorageLike = defaultStorage(),
): GeoReviewItem[] {
  const queue = loadReviewQueue(brand, storage);
  const next = queue.map((item) =>
    item.id === id ? applyTransition(item, action, options) : item,
  );
  saveReviewQueue(brand, next, storage);
  return next;
}

/** 删除队列中一条，返回更新后的队列。 */
export function removeReviewItem(
  brand: string,
  id: string,
  storage: StorageLike = defaultStorage(),
): GeoReviewItem[] {
  const next = loadReviewQueue(brand, storage).filter((item) => item.id !== id);
  saveReviewQueue(brand, next, storage);
  return next;
}

/** 当前品牌是否有已通过的稿件（GEO 侧分发入口门禁用）。 */
export function hasApprovedDraft(
  brand: string,
  storage: StorageLike = defaultStorage(),
): boolean {
  return loadReviewQueue(brand, storage).some(
    (item) => item.status === "approved",
  );
}
