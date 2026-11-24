/**
 * 素材库（域 06）：视频 / 图片 / 音频素材的本地资产管理。
 *
 * 设计：
 *   - 素材本体（Blob）存 IndexedDB，跨会话保留，不上传云端（视频体积大，也不该进业务库）；
 *   - group = 场景 / 镜头组（竞品的「按镜头、场景自定义上传并归类」），混剪方案按组取材；
 *   - 导入时尽力探测视频/音频时长（混剪裁剪要用），探测失败不阻塞导入。
 */

export type MediaKind = "video" | "image" | "audio";

/** 素材角色（横切标注，与场景组正交）：形象/声音用于数字人工坊，broll=分镜副画面。 */
export type MediaRole = "avatar" | "voice" | "broll";

export const MEDIA_ROLES: { value: MediaRole; label: string }[] = [
  { value: "avatar", label: "形象" },
  { value: "voice", label: "声音" },
  { value: "broll", label: "分镜素材" },
];

export interface MediaAsset {
  id: string;
  /** 文件名（不含扩展名） */
  name: string;
  /** 场景/镜头组，未归类时为「未分组」 */
  group: string;
  kind: MediaKind;
  /** 数字人工坊角色标注；老数据无此字段 = 普通分镜素材 */
  role?: MediaRole;
  mime: string;
  size: number;
  blob: Blob;
  /** 秒；图片与探测失败时为 undefined */
  duration?: number;
  /** 镜头备注（人工补充，方案生成时会参考） */
  note: string;
  createdAt: number;
}

export const MEDIA_KINDS: { value: MediaKind; label: string }[] = [
  { value: "video", label: "视频" },
  { value: "image", label: "图片" },
  { value: "audio", label: "音频" },
];

export function kindOf(file: File): MediaKind | null {
  if (file.type.startsWith("video/")) return "video";
  if (file.type.startsWith("image/")) return "image";
  if (file.type.startsWith("audio/")) return "audio";
  // 类型缺失时按扩展名兜底
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (["mp4", "mov", "webm", "mkv", "avi"].includes(ext)) return "video";
  if (["jpg", "jpeg", "png", "webp", "gif"].includes(ext)) return "image";
  if (["mp3", "wav", "aac", "m4a", "ogg"].includes(ext)) return "audio";
  return null;
}

function stripExt(name: string): string {
  const index = name.lastIndexOf(".");
  return index > 0 ? name.slice(0, index) : name;
}

/** 尽力读取音视频时长（2.5s 超时即放弃），图片返回 undefined。 */
function probeDuration(file: File, kind: MediaKind): Promise<number | undefined> {
  if (kind === "image") return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const el = document.createElement(kind === "video" ? "video" : "audio");
    const finish = (value: number | undefined) => {
      URL.revokeObjectURL(url);
      el.removeAttribute("src");
      resolve(value);
    };
    const timer = window.setTimeout(() => finish(undefined), 2500);
    el.preload = "metadata";
    el.onloadedmetadata = () => {
      window.clearTimeout(timer);
      const value = Number.isFinite(el.duration) && el.duration > 0 ? Math.round(el.duration * 10) / 10 : undefined;
      finish(value);
    };
    el.onerror = () => {
      window.clearTimeout(timer);
      finish(undefined);
    };
    el.src = url;
  });
}

const DB_NAME = "supe-media";
const DB_STORE = "assets";
const MAX_FILE_BYTES = 300 * 1024 * 1024;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("本地素材库不可用"));
  });
}

export async function listMedia(): Promise<MediaAsset[]> {
  try {
    const db = await openDb();
    return await new Promise<MediaAsset[]>((resolve, reject) => {
      const tx = db.transaction(DB_STORE, "readonly");
      const request = tx.objectStore(DB_STORE).getAll();
      request.onsuccess = () => {
        const rows = (request.result ?? []) as MediaAsset[];
        resolve(rows.sort((a, b) => a.group.localeCompare(b.group, "zh-CN") || a.createdAt - b.createdAt));
      };
      request.onerror = () => reject(request.error ?? new Error("读取素材失败"));
    });
  } catch {
    return [];
  }
}

/** 批量导入：逐个探测时长后写入，返回成功与跳过的文件名。 */
export async function importMedia(
  files: File[],
  group: string,
): Promise<{ added: MediaAsset[]; skipped: string[] }> {
  const targetGroup = group.trim() || "未分组";
  const added: MediaAsset[] = [];
  const skipped: string[] = [];

  const prepared = await Promise.all(
    files.map(async (file) => {
      const kind = kindOf(file);
      if (!kind) {
        skipped.push(file.name);
        return null;
      }
      if (file.size > MAX_FILE_BYTES) {
        skipped.push(`${file.name}（超过 300MB）`);
        return null;
      }
      const duration = await probeDuration(file, kind);
      const asset: MediaAsset = {
        id: `media-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
        name: stripExt(file.name),
        group: targetGroup,
        kind,
        mime: file.type || "application/octet-stream",
        size: file.size,
        blob: file,
        duration,
        note: "",
        createdAt: Date.now(),
      };
      return asset;
    }),
  );

  const valid = prepared.filter((item): item is MediaAsset => Boolean(item));
  if (valid.length) {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(DB_STORE, "readwrite");
      const store = tx.objectStore(DB_STORE);
      valid.forEach((item) => store.put(item));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("素材写入失败"));
    });
    added.push(...valid);
  }
  return { added, skipped };
}

export async function removeMedia(id: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readwrite");
    tx.objectStore(DB_STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("删除素材失败"));
  });
}

/** 改分组 / 改备注（合并到一次写入）。 */
export async function updateMedia(id: string, patch: Partial<Pick<MediaAsset, "group" | "note" | "name" | "role">>): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readwrite");
    const store = tx.objectStore(DB_STORE);
    const get = store.get(id);
    get.onsuccess = () => {
      const current = get.result as MediaAsset | undefined;
      if (!current) {
        resolve();
        return;
      }
      store.put({ ...current, ...patch });
    };
    get.onerror = () => reject(get.error ?? new Error("素材更新失败"));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("素材更新失败"));
  });
}

export interface MediaGroup {
  name: string;
  assets: MediaAsset[];
}

/** 按场景组归类（混剪取材的输入）。 */
export function groupMedia(assets: MediaAsset[]): MediaGroup[] {
  const map = new Map<string, MediaAsset[]>();
  for (const asset of assets) {
    const list = map.get(asset.group) ?? [];
    list.push(asset);
    map.set(asset.group, list);
  }
  return [...map.entries()]
    .map(([name, list]) => ({ name, assets: list }))
    .sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
}

export function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  return `${Math.max(1, Math.round(bytes / 1024))}KB`;
}

/* ------------------------------------------------------------------ */
/* 角色标注（数字人工坊）                                                */
/* ------------------------------------------------------------------ */

export function listByRole(assets: MediaAsset[], role: MediaRole): MediaAsset[] {
  return assets.filter((asset) => asset.role === role);
}

/**
 * 角色门禁：形象/声音必须先勾选肖像与音色授权才能设置；
 * broll（分镜素材）不需要授权确认。
 */
export function canSetRole(role: MediaRole | "", licenseConfirmed: boolean): boolean {
  if (!role) return true;
  if (role === "avatar" || role === "voice") return licenseConfirmed;
  return true;
}
