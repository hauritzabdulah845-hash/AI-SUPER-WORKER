import { cloud, getSessionUser } from "./client";
import { friendlyError } from "./friendlyError";
import type { GeoSnapshot } from "./geotrack";
import { MAX_SNAPSHOTS, STORAGE_KEY as SNAPSHOTS_STORAGE_KEY } from "./geomonitor";
import {
  brandStorageKey,
  loadLibrary,
  loadQuestions,
  saveLibrary,
  saveQuestions,
  type GeoQuestionItem,
  type KeywordLibraryEntry,
  type StorageLike,
} from "./keywordLibrary";
import {
  loadBrandAssets,
  saveBrandAssets,
  type BrandAssets,
} from "./brandAssets";
import {
  loadReviewQueue,
  saveReviewQueue,
  type GeoReviewItem,
} from "./geoReview";

/**
 * GEO 数据上云（第三十二批）：本机优先 + 登录后同步。
 *
 * 五组 GEO 数据（监测快照 / 词库 / 问题集 / 品牌素材 / 审核队列）+ 品牌工作区元信息，
 * 原来只存本机 localStorage；本批照仓库既有 WorkBuddy 云通道（client.ts 的
 * createWorkBuddyCloud + api.ts 的 `.from("表名")` + owner_id 双层隔离）加一层同步：
 *   - 读写仍走现有 localStorage 函数（零行为变化保底），未登录时与现在完全一致；
 *   - 登录且云端可达时，保存异步上行、打开工作台下行合并；
 *   - 合并规则：快照按 id 去重并集（上限仍 60，取最新）；其余四组按品牌整表
 *     「更新时间新者胜」，同步时先上行本机较新的组、再下行云端较新的组，
 *     保证本机新数据不被旧云端数据冲掉；
 *   - 未登录 / 云端报错 / 超时一律静默回落本机模式，界面状态条如实标注，
 *     错误经 friendlyError 人话化后只打 console，不弹英文错误。
 *
 * 云端表（建表 SQL 见目标文件目录《AI-SUPER-WORKER-第32批建表SQL-WorkBuddy-2026-11-26.sql》，
 * 属配置后置，表未建时本层自动降级）：geo_snapshots / geo_keyword_library /
 * geo_questions / geo_brand_assets / geo_review_queue / geo_workspace，
 * 业务结构整体存 payload(jsonb)，同步层只搬运现有结构（快照必填字段不动）。
 *
 * 监测周期模板（geoschedule）随 scheduler 计划存储，不纳入本批同步，保持本机。
 */

export const GEO_WORKSPACE_STORAGE_KEY = "ai-employee:geo-workspace";
export const GEO_SYNC_META_STORAGE_KEY = "ai-employee:geo-sync-meta";
export const GEO_SYNC_MAX_SNAPSHOTS = MAX_SNAPSHOTS;
export const GEO_SYNC_TIMEOUT_MS = 8000;

export type GeoSyncGroup =
  | "snapshots"
  | "library"
  | "questions"
  | "brandAssets"
  | "reviewQueue"
  | "workspace";

export type GeoGroupTable =
  | "geo_keyword_library"
  | "geo_questions"
  | "geo_brand_assets"
  | "geo_review_queue"
  | "geo_workspace";

const GROUP_TABLE: Record<Exclude<GeoSyncGroup, "snapshots">, GeoGroupTable> = {
  library: "geo_keyword_library",
  questions: "geo_questions",
  brandAssets: "geo_brand_assets",
  reviewQueue: "geo_review_queue",
  workspace: "geo_workspace",
};

/** 品牌工作区元信息：品牌名 + 目标搜索词 + 企业资料引用（只存引用/备注，不同步资料全文）。 */
export interface GeoWorkspaceMeta {
  brand: string;
  keywords: string;
  materialRef: string;
  updatedAt: string;
}

export type GeoSyncMode = "local" | "syncing" | "synced";

export interface GeoSyncState {
  mode: GeoSyncMode;
  /** 最近一次成功同步时间（ISO），从未同步为空串 */
  lastSyncAt: string;
}

export interface GeoSyncResult {
  mode: GeoSyncMode;
  /** 本次上行成功的组 */
  pushed: GeoSyncGroup[];
  /** 本次下行合并的组 */
  pulled: GeoSyncGroup[];
  lastSyncAt: string;
  /** 给界面的人话说明（降级原因或完成提示），不含英文原始错误 */
  message: string;
}

/* ------------------------------ 云端适配器（可注入，测试用内存假云） ------------------------------ */

export interface GeoCloudSnapshotRow {
  snapshot_id: string;
  brand: string;
  payload: GeoSnapshot;
  updated_at: string;
}

export interface GeoCloudGroupRow {
  brand: string;
  payload: unknown;
  updated_at: string;
}

export interface GeoSyncCloud {
  listSnapshots(ownerId: string): Promise<GeoCloudSnapshotRow[]>;
  upsertSnapshot(ownerId: string, snapshot: GeoSnapshot): Promise<void>;
  deleteSnapshot(ownerId: string, snapshotId: string): Promise<void>;
  getGroup(table: GeoGroupTable, ownerId: string, brand: string): Promise<GeoCloudGroupRow | null>;
  upsertGroup(table: GeoGroupTable, ownerId: string, brand: string, payload: unknown, updatedAt: string): Promise<void>;
  listGroups(table: GeoGroupTable, ownerId: string): Promise<GeoCloudGroupRow[]>;
}

export interface GeoSyncDeps {
  storage?: StorageLike;
  cloudClient?: GeoSyncCloud;
  getUser?: () => Promise<{ id: string; name: string } | null>;
  now?: () => string;
  timeoutMs?: number;
}

function cloudFail(error: unknown, fallback: string): never {
  const message =
    error && typeof error === "object" && "message" in error
      ? String((error as { message: unknown }).message)
      : fallback;
  throw new Error(message || fallback);
}

/**
 * WorkBuddy 云端实现：与 api.ts 同一模式——应用层显式带 owner_id 条件，
 * 数据库层靠 RLS（owner_id = auth.uid()）兜底，双层隔离。
 * upsert 用「先查后写」实现，不假设 SDK 有 upsert 接口。
 */
export function createWorkBuddyGeoCloud(): GeoSyncCloud {
  return {
    async listSnapshots(ownerId) {
      const { data, error } = await cloud.database
        .from("geo_snapshots")
        .select("snapshot_id,brand,payload,updated_at")
        .eq("owner_id", ownerId)
        .order("updated_at", { ascending: true })
        .limit(500);
      if (error) cloudFail(error, "云端监测记录读取失败");
      return (data ?? []) as GeoCloudSnapshotRow[];
    },
    async upsertSnapshot(ownerId, snapshot) {
      const found = await cloud.database
        .from("geo_snapshots")
        .select("id")
        .eq("owner_id", ownerId)
        .eq("snapshot_id", snapshot.id)
        .limit(1);
      if (found.error) cloudFail(found.error, "云端监测记录查询失败");
      const existing = (found.data ?? [])[0] as { id: number } | undefined;
      const body = {
        brand: snapshot.brand,
        payload: snapshot,
        updated_at: new Date().toISOString(),
      };
      if (existing) {
        const { error } = await cloud.database
          .from("geo_snapshots")
          .update(body as never)
          .eq("id", existing.id)
          .eq("owner_id", ownerId);
        if (error) cloudFail(error, "云端监测记录更新失败");
      } else {
        const { error } = await cloud.database
          .from("geo_snapshots")
          .insert([{ owner_id: ownerId, snapshot_id: snapshot.id, ...body }] as never);
        if (error) cloudFail(error, "云端监测记录写入失败");
      }
    },
    async deleteSnapshot(ownerId, snapshotId) {
      const { error } = await cloud.database
        .from("geo_snapshots")
        .delete()
        .eq("owner_id", ownerId)
        .eq("snapshot_id", snapshotId);
      if (error) cloudFail(error, "云端监测记录删除失败");
    },
    async getGroup(table, ownerId, brand) {
      const { data, error } = await cloud.database
        .from(table)
        .select("brand,payload,updated_at")
        .eq("owner_id", ownerId)
        .eq("brand", brand)
        .limit(1);
      if (error) cloudFail(error, "云端 GEO 数据读取失败");
      return ((data ?? [])[0] as GeoCloudGroupRow | undefined) ?? null;
    },
    async upsertGroup(table, ownerId, brand, payload, updatedAt) {
      const found = await cloud.database
        .from(table)
        .select("id")
        .eq("owner_id", ownerId)
        .eq("brand", brand)
        .limit(1);
      if (found.error) cloudFail(found.error, "云端 GEO 数据查询失败");
      const existing = (found.data ?? [])[0] as { id: number } | undefined;
      if (existing) {
        const { error } = await cloud.database
          .from(table)
          .update({ payload, updated_at: updatedAt } as never)
          .eq("id", existing.id)
          .eq("owner_id", ownerId);
        if (error) cloudFail(error, "云端 GEO 数据更新失败");
      } else {
        const { error } = await cloud.database
          .from(table)
          .insert([{ owner_id: ownerId, brand, payload, updated_at: updatedAt }] as never);
        if (error) cloudFail(error, "云端 GEO 数据写入失败");
      }
    },
    async listGroups(table, ownerId) {
      const { data, error } = await cloud.database
        .from(table)
        .select("brand,payload,updated_at")
        .eq("owner_id", ownerId)
        .limit(100);
      if (error) cloudFail(error, "云端 GEO 数据列表读取失败");
      return (data ?? []) as GeoCloudGroupRow[];
    },
  };
}

/* ------------------------------ 本机存储兜底（与 keywordLibrary 同惯例） ------------------------------ */

const memoryFallback = new Map<string, string>();
const memoryStorage: StorageLike = {
  getItem: (key) => memoryFallback.get(key) ?? null,
  setItem: (key, value) => {
    memoryFallback.set(key, value);
  },
};

function defaultStorage(): StorageLike {
  try {
    if (typeof window !== "undefined" && window.localStorage) return window.localStorage;
  } catch {
    /* 隐私模式访问 localStorage 可能抛错，落到内存兜底 */
  }
  return memoryStorage;
}

function resolveDeps(deps: GeoSyncDeps = {}): Required<GeoSyncDeps> {
  return {
    storage: deps.storage ?? defaultStorage(),
    cloudClient: deps.cloudClient ?? createWorkBuddyGeoCloud(),
    getUser: deps.getUser ?? (() => getSessionUser()),
    now: deps.now ?? (() => new Date().toISOString()),
    timeoutMs: deps.timeoutMs ?? GEO_SYNC_TIMEOUT_MS,
  };
}

/** 单次云调用超时保护：超时即抛错，由上层静默回落本机模式。 */
async function callCloud<T>(fn: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("请求超时")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/* ------------------------------ 纯合并逻辑（单测覆盖） ------------------------------ */

function snapshotTime(snapshot: GeoSnapshot): number {
  const at = Date.parse(snapshot.at);
  return Number.isNaN(at) ? 0 : at;
}

function isValidSnapshot(row: unknown): row is GeoSnapshot {
  if (!row || typeof row !== "object") return false;
  const record = row as Partial<GeoSnapshot>;
  return typeof record.id === "string" && Boolean(record.id) && Array.isArray(record.samples);
}

/**
 * 快照合并：按 id 去重并集，按时间正序，上限取最新。
 * 同一 id 两边都有时保留时间较新的一条（同一监测不会改内容，取新只是兜底）。
 */
export function mergeSnapshots(
  local: GeoSnapshot[],
  remote: GeoSnapshot[],
  max = GEO_SYNC_MAX_SNAPSHOTS,
): GeoSnapshot[] {
  const byId = new Map<string, GeoSnapshot>();
  for (const row of [...local, ...remote]) {
    if (!isValidSnapshot(row)) continue;
    const current = byId.get(row.id);
    if (!current || snapshotTime(row) >= snapshotTime(current)) byId.set(row.id, row);
  }
  return [...byId.values()]
    .sort((a, b) => snapshotTime(a) - snapshotTime(b))
    .slice(-max);
}

export interface PickNewerResult<T> {
  data: T;
  source: "local" | "remote";
  updatedAt: string;
}

/**
 * 整表新者胜：比较更新时间，新的赢；时间相同或本机有时间而云端没有时保本机
 * （本机新数据不丢）；本机无时间戳（老数据/未标记）而云端有时云端赢。
 */
export function pickNewer<T>(
  local: T,
  localUpdatedAt: string,
  remote: T,
  remoteUpdatedAt: string,
): PickNewerResult<T> {
  const localAt = Date.parse(localUpdatedAt);
  const remoteAt = Date.parse(remoteUpdatedAt);
  const hasLocal = !Number.isNaN(localAt);
  const hasRemote = !Number.isNaN(remoteAt);
  if (hasRemote && (!hasLocal || remoteAt > localAt)) {
    return { data: remote, source: "remote", updatedAt: remoteUpdatedAt };
  }
  return { data: local, source: "local", updatedAt: localUpdatedAt };
}

/* ------------------------------ 同步元信息（本机更新时间 + 状态） ------------------------------ */

interface SyncMeta {
  updatedAt: Partial<Record<GeoSyncGroup, Record<string, string>>>;
  lastSyncAt: string;
  mode: GeoSyncMode;
}

function readSyncMeta(storage: StorageLike): SyncMeta {
  try {
    const raw = storage.getItem(GEO_SYNC_META_STORAGE_KEY);
    if (!raw) return { updatedAt: {}, lastSyncAt: "", mode: "local" };
    const parsed = JSON.parse(raw) as Partial<SyncMeta>;
    return {
      updatedAt:
        parsed.updatedAt && typeof parsed.updatedAt === "object" ? parsed.updatedAt : {},
      lastSyncAt: typeof parsed.lastSyncAt === "string" ? parsed.lastSyncAt : "",
      mode: parsed.mode === "synced" || parsed.mode === "syncing" ? parsed.mode : "local",
    };
  } catch {
    return { updatedAt: {}, lastSyncAt: "", mode: "local" };
  }
}

function writeSyncMeta(storage: StorageLike, meta: SyncMeta): void {
  try {
    storage.setItem(GEO_SYNC_META_STORAGE_KEY, JSON.stringify(meta));
  } catch {
    /* 配额满/隐私模式：本次会话内仍可用，只是不落盘 */
  }
}

export function getLocalUpdatedAt(
  group: GeoSyncGroup,
  brand: string,
  storage: StorageLike = defaultStorage(),
): string {
  return readSyncMeta(storage).updatedAt[group]?.[brandStorageKey(brand)] ?? "";
}

/** 标记某组本机数据刚更新（保存动作调用，同步时据此判新者）。 */
export function markLocalUpdated(
  group: GeoSyncGroup,
  brand: string,
  at = new Date().toISOString(),
  storage: StorageLike = defaultStorage(),
): void {
  const meta = readSyncMeta(storage);
  const byBrand = { ...(meta.updatedAt[group] ?? {}) };
  byBrand[brandStorageKey(brand)] = at;
  meta.updatedAt = { ...meta.updatedAt, [group]: byBrand };
  writeSyncMeta(storage, meta);
}

export function loadSyncState(storage: StorageLike = defaultStorage()): GeoSyncState {
  const meta = readSyncMeta(storage);
  // syncing 是瞬时态，刷新后不应卡在「同步中」
  return { mode: meta.mode === "syncing" ? "local" : meta.mode, lastSyncAt: meta.lastSyncAt };
}

function saveSyncState(storage: StorageLike, state: GeoSyncState): void {
  const meta = readSyncMeta(storage);
  meta.mode = state.mode;
  if (state.lastSyncAt) meta.lastSyncAt = state.lastSyncAt;
  writeSyncMeta(storage, meta);
  // 通知外层（如 Console 页头副标题）刷新同步状态文案
  try {
    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("ai-employee:geo-sync-state"));
  } catch {
    /* 无 window 环境忽略 */
  }
}

/* ------------------------------ 品牌工作区元信息（本机存一份，刷新恢复） ------------------------------ */

export function loadGeoWorkspace(
  storage: StorageLike = defaultStorage(),
): GeoWorkspaceMeta | null {
  try {
    const raw = storage.getItem(GEO_WORKSPACE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<GeoWorkspaceMeta>;
    const brand = String(parsed.brand ?? "").trim();
    if (!brand) return null;
    return {
      brand,
      keywords: String(parsed.keywords ?? ""),
      materialRef: String(parsed.materialRef ?? ""),
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
    };
  } catch {
    return null;
  }
}

export function saveGeoWorkspace(
  meta: Omit<GeoWorkspaceMeta, "updatedAt"> & { updatedAt?: string },
  storage: StorageLike = defaultStorage(),
): GeoWorkspaceMeta {
  const next: GeoWorkspaceMeta = {
    brand: meta.brand.trim(),
    keywords: meta.keywords ?? "",
    materialRef: (meta.materialRef ?? "").slice(0, 200),
    updatedAt: meta.updatedAt ?? new Date().toISOString(),
  };
  try {
    storage.setItem(GEO_WORKSPACE_STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* 配额满/隐私模式：本次会话内仍可用，只是不落盘 */
  }
  markLocalUpdated("workspace", next.brand, next.updatedAt, storage);
  return next;
}

/* ------------------------------ 快照本机批量存取（与 geomonitor 同 key/同口径） ------------------------------ */

export function loadSnapshotsLocal(storage: StorageLike = defaultStorage()): GeoSnapshot[] {
  try {
    const raw = storage.getItem(SNAPSHOTS_STORAGE_KEY);
    if (!raw) return [];
    const rows = JSON.parse(raw) as unknown;
    if (!Array.isArray(rows)) return [];
    return rows
      .filter(isValidSnapshot)
      .sort((a, b) => snapshotTime(a) - snapshotTime(b))
      .slice(-GEO_SYNC_MAX_SNAPSHOTS);
  } catch {
    return [];
  }
}

export function saveSnapshotsLocal(
  snapshots: GeoSnapshot[],
  storage: StorageLike = defaultStorage(),
): void {
  const next = [...snapshots]
    .filter(isValidSnapshot)
    .sort((a, b) => snapshotTime(a) - snapshotTime(b))
    .slice(-GEO_SYNC_MAX_SNAPSHOTS);
  try {
    storage.setItem(SNAPSHOTS_STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* 配额满/隐私模式：本次展示仍可用，只是不落盘 */
  }
}

/* ------------------------------ 分组数据本机存取 ------------------------------ */

type GroupData =
  | KeywordLibraryEntry[]
  | GeoQuestionItem[]
  | BrandAssets
  | GeoReviewItem[]
  | GeoWorkspaceMeta
  | null;

function loadGroupLocal(
  group: Exclude<GeoSyncGroup, "snapshots">,
  brand: string,
  storage: StorageLike,
): GroupData {
  switch (group) {
    case "library":
      return loadLibrary(brand, storage);
    case "questions":
      return loadQuestions(brand, storage);
    case "brandAssets":
      return loadBrandAssets(brand, storage);
    case "reviewQueue":
      return loadReviewQueue(brand, storage);
    case "workspace": {
      const meta = loadGeoWorkspace(storage);
      return meta && brandStorageKey(meta.brand) === brandStorageKey(brand) ? meta : null;
    }
  }
}

function saveGroupLocal(
  group: Exclude<GeoSyncGroup, "snapshots">,
  brand: string,
  data: GroupData,
  storage: StorageLike,
): void {
  switch (group) {
    case "library":
      saveLibrary(brand, (data ?? []) as KeywordLibraryEntry[], storage);
      break;
    case "questions":
      saveQuestions(brand, (data ?? []) as GeoQuestionItem[], storage);
      break;
    case "brandAssets":
      saveBrandAssets(brand, data as BrandAssets, storage);
      break;
    case "reviewQueue":
      saveReviewQueue(brand, (data ?? []) as GeoReviewItem[], storage);
      break;
    case "workspace": {
      const meta = data as GeoWorkspaceMeta | null;
      if (meta) saveGeoWorkspace(meta, storage);
      break;
    }
  }
}

/** 组数据是否为空（空组不做首次上行，避免把云端已有数据冲成空）。 */
function isGroupEmpty(group: Exclude<GeoSyncGroup, "snapshots">, data: GroupData): boolean {
  if (data === null) return true;
  if (Array.isArray(data)) return data.length === 0;
  if (group === "brandAssets") {
    const assets = data as BrandAssets;
    const cardEmpty =
      !assets.card.intro &&
      !assets.card.sellingPoints.length &&
      !assets.card.audience &&
      !assets.card.priceBand &&
      !assets.card.coverage &&
      !assets.card.contact &&
      !assets.card.honors.length;
    const rulesEmpty =
      !assets.rules.bannedWords.length &&
      !assets.rules.requiredWords.length &&
      !assets.rules.tone &&
      !assets.rules.sentenceStyle &&
      !assets.rules.numberRule &&
      !assets.rules.disclaimer;
    return cardEmpty && rulesEmpty && assets.samples.length === 0;
  }
  if (group === "workspace") return !(data as GeoWorkspaceMeta).brand;
  return false;
}

interface GroupEnvelope {
  data: GroupData;
  updatedAt: string;
}

function unwrapGroupRow(row: GeoCloudGroupRow | null): GroupEnvelope | null {
  if (!row) return null;
  const payload = row.payload as Partial<GroupEnvelope> | null;
  if (payload && typeof payload === "object" && "data" in payload) {
    return {
      data: (payload.data ?? null) as GroupData,
      updatedAt:
        typeof payload.updatedAt === "string" && payload.updatedAt
          ? payload.updatedAt
          : row.updated_at,
    };
  }
  // 兼容裸 payload（无信封）：数据本体 + 行更新时间
  return { data: (row.payload ?? null) as GroupData, updatedAt: row.updated_at };
}

const SYNC_GROUPS: Exclude<GeoSyncGroup, "snapshots">[] = [
  "library",
  "questions",
  "brandAssets",
  "reviewQueue",
  "workspace",
];

function localResult(message: string, storage: StorageLike): GeoSyncResult {
  const state = loadSyncState(storage);
  saveSyncState(storage, { mode: "local", lastSyncAt: state.lastSyncAt });
  return { mode: "local", pushed: [], pulled: [], lastSyncAt: state.lastSyncAt, message };
}

/* ------------------------------ 同步主流程 ------------------------------ */

/**
 * 同步一个品牌的全部 GEO 数据（先上行本机较新的组，再下行云端较新的组；
 * 快照走并集）。未登录/报错/超时静默回落本机模式，永不抛错。
 */
export async function syncGeoData(brand: string, deps: GeoSyncDeps = {}): Promise<GeoSyncResult> {
  const { storage, cloudClient, getUser, now, timeoutMs } = resolveDeps(deps);
  const brandKey = brandStorageKey(brand);
  let user: { id: string; name: string } | null = null;
  try {
    user = await callCloud(() => getUser(), timeoutMs);
  } catch (err) {
    friendlyError(err);
    return localResult("本机模式（登录后自动同步）", storage);
  }
  if (!user?.id) return localResult("本机模式（登录后自动同步）", storage);

  saveSyncState(storage, { mode: "syncing", lastSyncAt: loadSyncState(storage).lastSyncAt });
  const pushed: GeoSyncGroup[] = [];
  const pulled: GeoSyncGroup[] = [];
  try {
    // 快照：并集去重后双向补齐
    const remoteRows = await callCloud(() => cloudClient.listSnapshots(user.id), timeoutMs);
    const remoteSnapshots = remoteRows.map((row) => row.payload).filter(isValidSnapshot);
    const localSnapshots = loadSnapshotsLocal(storage);
    const merged = mergeSnapshots(localSnapshots, remoteSnapshots);
    const remoteIds = new Set(remoteSnapshots.map((row) => row.id));
    const localIds = new Set(localSnapshots.map((row) => row.id));
    if (merged.some((row) => !localIds.has(row.id))) pulled.push("snapshots");
    saveSnapshotsLocal(merged, storage);
    let snapshotPushed = false;
    for (const snapshot of merged) {
      if (!remoteIds.has(snapshot.id)) {
        await callCloud(() => cloudClient.upsertSnapshot(user.id, snapshot), timeoutMs);
        snapshotPushed = true;
      }
    }
    if (snapshotPushed) pushed.push("snapshots");

    // 其余四组 + 工作区：先取云端行，再分两遍处理（先上行、后下行）
    const remoteByGroup = new Map<Exclude<GeoSyncGroup, "snapshots">, GroupEnvelope | null>();
    for (const group of SYNC_GROUPS) {
      const row = await callCloud(
        () => cloudClient.getGroup(GROUP_TABLE[group], user.id, brandKey),
        timeoutMs,
      );
      remoteByGroup.set(group, unwrapGroupRow(row));
    }

    // 第一遍：本机较新（或云端还没有且本机非空）→ 上行，保本机新数据不丢
    for (const group of SYNC_GROUPS) {
      const localData = loadGroupLocal(group, brand, storage);
      const localAt = getLocalUpdatedAt(group, brand, storage);
      const remote = remoteByGroup.get(group) ?? null;
      if (!remote) {
        if (!isGroupEmpty(group, localData)) {
          const at = localAt || now();
          await callCloud(
            () => cloudClient.upsertGroup(GROUP_TABLE[group], user.id, brandKey, { data: localData, updatedAt: at }, at),
            timeoutMs,
          );
          markLocalUpdated(group, brand, at, storage);
          pushed.push(group);
        }
        continue;
      }
      const picked = pickNewer(localData, localAt, remote.data, remote.updatedAt);
      if (picked.source === "local" && localAt && localAt !== remote.updatedAt) {
        await callCloud(
          () => cloudClient.upsertGroup(GROUP_TABLE[group], user.id, brandKey, { data: localData, updatedAt: localAt }, localAt),
          timeoutMs,
        );
        pushed.push(group);
      }
    }

    // 第二遍：云端较新 → 下行合并到本机
    for (const group of SYNC_GROUPS) {
      if (pushed.includes(group)) continue;
      const localData = loadGroupLocal(group, brand, storage);
      const localAt = getLocalUpdatedAt(group, brand, storage);
      const remote = remoteByGroup.get(group) ?? null;
      if (!remote) continue;
      const picked = pickNewer(localData, localAt, remote.data, remote.updatedAt);
      if (picked.source === "remote") {
        saveGroupLocal(group, brand, remote.data, storage);
        markLocalUpdated(group, brand, remote.updatedAt, storage);
        pulled.push(group);
      }
    }

    const lastSyncAt = now();
    saveSyncState(storage, { mode: "synced", lastSyncAt });
    return { mode: "synced", pushed, pulled, lastSyncAt, message: "已同步" };
  } catch (err) {
    // 云端不可达/表未建/超时：静默回落本机模式，原始错误只进 console
    friendlyError(err);
    return localResult("本机模式（云端暂不可达，数据保存在本机）", storage);
  }
}

/** 只上行（保存后异步调用）：把本机当前数据推到云端；未登录/失败静默。 */
export async function pushGeoData(brand: string, deps: GeoSyncDeps = {}): Promise<GeoSyncResult> {
  const { storage, cloudClient, getUser, now, timeoutMs } = resolveDeps(deps);
  const brandKey = brandStorageKey(brand);
  let user: { id: string; name: string } | null = null;
  try {
    user = await callCloud(() => getUser(), timeoutMs);
  } catch (err) {
    friendlyError(err);
    return localResult("本机模式（登录后自动同步）", storage);
  }
  if (!user?.id) return localResult("本机模式（登录后自动同步）", storage);

  const pushed: GeoSyncGroup[] = [];
  try {
    const remoteRows = await callCloud(() => cloudClient.listSnapshots(user.id), timeoutMs);
    const remoteIds = new Set(remoteRows.map((row) => row.snapshot_id));
    let snapshotPushed = false;
    for (const snapshot of loadSnapshotsLocal(storage)) {
      if (!remoteIds.has(snapshot.id)) {
        await callCloud(() => cloudClient.upsertSnapshot(user.id, snapshot), timeoutMs);
        snapshotPushed = true;
      }
    }
    if (snapshotPushed) pushed.push("snapshots");

    for (const group of SYNC_GROUPS) {
      const localData = loadGroupLocal(group, brand, storage);
      if (isGroupEmpty(group, localData)) continue;
      const at = getLocalUpdatedAt(group, brand, storage) || now();
      await callCloud(
        () => cloudClient.upsertGroup(GROUP_TABLE[group], user.id, brandKey, { data: localData, updatedAt: at }, at),
        timeoutMs,
      );
      markLocalUpdated(group, brand, at, storage);
      pushed.push(group);
    }

    const lastSyncAt = now();
    saveSyncState(storage, { mode: "synced", lastSyncAt });
    return { mode: "synced", pushed, pulled: [], lastSyncAt, message: "已同步" };
  } catch (err) {
    friendlyError(err);
    return localResult("本机模式（云端暂不可达，数据保存在本机）", storage);
  }
}

/** 只下行（打开工作台时调用）：云端较新的组合并到本机，不冲掉本机新数据。 */
export async function pullGeoData(brand: string, deps: GeoSyncDeps = {}): Promise<GeoSyncResult> {
  const { storage, cloudClient, getUser, now, timeoutMs } = resolveDeps(deps);
  const brandKey = brandStorageKey(brand);
  let user: { id: string; name: string } | null = null;
  try {
    user = await callCloud(() => getUser(), timeoutMs);
  } catch (err) {
    friendlyError(err);
    return localResult("本机模式（登录后自动同步）", storage);
  }
  if (!user?.id) return localResult("本机模式（登录后自动同步）", storage);

  const pulled: GeoSyncGroup[] = [];
  try {
    const remoteRows = await callCloud(() => cloudClient.listSnapshots(user.id), timeoutMs);
    const remoteSnapshots = remoteRows.map((row) => row.payload).filter(isValidSnapshot);
    const localSnapshots = loadSnapshotsLocal(storage);
    const merged = mergeSnapshots(localSnapshots, remoteSnapshots);
    if (merged.length !== localSnapshots.length) pulled.push("snapshots");
    saveSnapshotsLocal(merged, storage);

    for (const group of SYNC_GROUPS) {
      const row = await callCloud(
        () => cloudClient.getGroup(GROUP_TABLE[group], user.id, brandKey),
        timeoutMs,
      );
      const remote = unwrapGroupRow(row);
      if (!remote) continue;
      const localData = loadGroupLocal(group, brand, storage);
      const localAt = getLocalUpdatedAt(group, brand, storage);
      const picked = pickNewer(localData, localAt, remote.data, remote.updatedAt);
      if (picked.source === "remote") {
        saveGroupLocal(group, brand, remote.data, storage);
        markLocalUpdated(group, brand, remote.updatedAt, storage);
        pulled.push(group);
      }
    }

    const lastSyncAt = now();
    saveSyncState(storage, { mode: "synced", lastSyncAt });
    return { mode: "synced", pushed: [], pulled, lastSyncAt, message: "已同步" };
  } catch (err) {
    friendlyError(err);
    return localResult("本机模式（云端暂不可达，数据保存在本机）", storage);
  }
}

/** 本机出现过的品牌键（词库/问题集/品牌素材/审核队列/工作区/快照并集）。 */
export function listLocalGeoBrands(storage: StorageLike = defaultStorage()): string[] {
  const brands = new Set<string>();
  const workspace = loadGeoWorkspace(storage);
  if (workspace?.brand) brands.add(workspace.brand);
  for (const snapshot of loadSnapshotsLocal(storage)) {
    if (snapshot.brand) brands.add(snapshot.brand);
  }
  const meta = readSyncMeta(storage);
  for (const byBrand of Object.values(meta.updatedAt)) {
    for (const key of Object.keys(byBrand ?? {})) brands.add(key);
  }
  return [...brands];
}

/** 同步全部品牌（手动「立即同步」在未填品牌时用；换设备恢复也走这里）。 */
export async function syncAllGeoData(deps: GeoSyncDeps = {}): Promise<GeoSyncResult> {
  const { storage, cloudClient, getUser, timeoutMs } = resolveDeps(deps);
  const brands = new Set(listLocalGeoBrands(storage));
  try {
    const user = await callCloud(() => getUser(), timeoutMs);
    if (user?.id) {
      const rows = await callCloud(
        () => cloudClient.listGroups("geo_workspace", user.id),
        timeoutMs,
      );
      for (const row of rows) {
        const envelope = unwrapGroupRow(row);
        const meta = envelope?.data as GeoWorkspaceMeta | null;
        brands.add(meta?.brand || row.brand);
      }
    }
  } catch (err) {
    friendlyError(err);
    return localResult("本机模式（登录后自动同步）", storage);
  }
  if (!brands.size) brands.add("");

  let last: GeoSyncResult | null = null;
  const pushed = new Set<GeoSyncGroup>();
  const pulled = new Set<GeoSyncGroup>();
  for (const brand of brands) {
    last = await syncGeoData(brand, deps);
    last.pushed.forEach((group) => pushed.add(group));
    last.pulled.forEach((group) => pulled.add(group));
    if (last.mode === "local") break;
  }
  if (!last) return localResult("本机模式（登录后自动同步）", storage);
  return { ...last, pushed: [...pushed], pulled: [...pulled] };
}

/** 本机删除快照后同步删云端（在线时防下次同步把删掉的记录并回来）；失败静默。 */
export async function removeGeoSnapshotRemote(
  snapshotId: string,
  deps: GeoSyncDeps = {},
): Promise<void> {
  const { cloudClient, getUser, timeoutMs } = resolveDeps(deps);
  try {
    const user = await callCloud(() => getUser(), timeoutMs);
    if (!user?.id) return;
    await callCloud(() => cloudClient.deleteSnapshot(user.id, snapshotId), timeoutMs);
  } catch (err) {
    friendlyError(err);
  }
}

const pushTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** 保存后防抖上行（1.5 秒内多次保存只推一次）；未登录/失败静默回落本机。 */
export function scheduleGeoPush(brand: string, deps: GeoSyncDeps = {}): void {
  const key = brandStorageKey(brand);
  const existing = pushTimers.get(key);
  if (existing) clearTimeout(existing);
  pushTimers.set(
    key,
    setTimeout(() => {
      pushTimers.delete(key);
      void pushGeoData(brand, deps);
    }, 1500),
  );
}

/* ------------------------------ 界面文案 ------------------------------ */

export function formatSyncTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/** 状态条文案：本机模式 / 同步中 / 已同步 · 时间。 */
export function geoSyncStatusLabel(state: GeoSyncState, loggedIn: boolean): string {
  if (state.mode === "syncing") return "同步中…";
  if (state.mode === "synced" && state.lastSyncAt) {
    return `已同步 · ${formatSyncTime(state.lastSyncAt)}`;
  }
  if (state.lastSyncAt) {
    return `本机模式 · 上次同步 ${formatSyncTime(state.lastSyncAt)}`;
  }
  if (loggedIn) return "已登录，打开工作台后自动同步";
  return "本机模式（登录后自动同步）";
}
