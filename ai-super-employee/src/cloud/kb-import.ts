import { insertKnowledgeDoc } from "./api";

/**
 * 知识库文件夹导入。
 *
 * 使用 File System Access API（showDirectoryPicker）让用户直接选择本地文件夹，
 * 目录句柄持久化在 IndexedDB，下次可「重新扫描」增量同步，无需重复选目录。
 *
 * 支持的格式：txt/md/csv/tsv/json/yaml/html/xml/日志/常见代码
 *            docx（mammoth）、pdf（pdfjs）、xlsx/xls（SheetJS）
 * 解析库全部动态加载，不影响首屏体积。
 */

export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_CONTENT_CHARS = 30000;

const TEXT_EXT = new Set([
  "txt", "md", "markdown", "csv", "tsv", "json", "yaml", "yml", "html", "htm",
  "xml", "log", "sql", "ini", "conf", "js", "ts", "jsx", "tsx", "py", "java",
  "go", "rb", "php", "sh", "css", "scss", "srt", "vtt",
]);
const DOC_EXT = new Set(["docx", "pdf", "xlsx", "xls"]);

export const SUPPORTED_EXT = new Set([...TEXT_EXT, ...DOC_EXT]);

/** 明确不解析的格式，避免用户困惑。 */
const BLOCKED_EXT = new Set([
  "doc", "ppt", "pptx", "pages", "key", "numbers", "zip", "rar", "7z",
  "png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "heic",
  "mp4", "mov", "mp3", "wav", "exe", "dmg", "dll",
]);

const DOC_TYPE_RULES: { type: string; keys: string[] }[] = [
  { type: "价格体系", keys: ["价格", "报价", "费用", "收费", "价目", "price", "pricing"] },
  { type: "产品手册", keys: ["手册", "产品", "说明书", "规格", "产品介绍", "manual", "spec"] },
  { type: "流程制度", keys: ["制度", "流程", "规范", "sop", "政策", "管理办法", "标准"] },
  { type: "培训资料", keys: ["培训", "教程", "课件", "新人", "学习", "guide", "tutorial"] },
  { type: "客户案例", keys: ["案例", "客户", "复盘", "见证", "case", "story"] },
  { type: "常见问答", keys: ["faq", "问答", "常见问题", "答疑", "q&a"] },
];

export interface KbFileItem {
  id: string;
  path: string;
  name: string;
  dir: string;
  ext: string;
  size: number;
  title: string;
  supported: boolean;
  reason?: string;
  content?: string;
  chars?: number;
  error?: string;
}

export interface FolderBinding {
  name: string;
  updatedAt: string;
}

type DirPickerWindow = Window & {
  showDirectoryPicker?: (options?: { mode?: "read" | "readwrite"; id?: string }) => Promise<FileSystemDirectoryHandle>;
};

/**
 * TS 内置的 FileSystemDirectoryHandle 尚未包含 values() / queryPermission()
 * 等较新规范成员，这里补一层运行时已有、类型缺失的能力。
 */
export type FsDir = FileSystemDirectoryHandle & {
  values(): AsyncIterableIterator<FileSystemHandle>;
  queryPermission(descriptor: { mode: "read" | "readwrite" }): Promise<PermissionState>;
  requestPermission(descriptor: { mode: "read" | "readwrite" }): Promise<PermissionState>;
  getDirectoryHandle(name: string): Promise<FsDir>;
  getFileHandle(name: string): Promise<FileSystemFileHandle>;
};

const DB_NAME = "supe-kb";
const STORE = "handles";
const HANDLE_KEY = "dir";
const META_KEY = "supe-kb-folder";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB 打开失败"));
  });
}

export function supportsFolderPicker(): boolean {
  return typeof (window as DirPickerWindow).showDirectoryPicker === "function";
}

export function loadFolderBinding(): FolderBinding | null {
  try {
    const raw = window.localStorage.getItem(META_KEY);
    return raw ? (JSON.parse(raw) as FolderBinding) : null;
  } catch {
    return null;
  }
}

function saveFolderBinding(binding: FolderBinding | null) {
  if (binding) window.localStorage.setItem(META_KEY, JSON.stringify(binding));
  else window.localStorage.removeItem(META_KEY);
}

async function putHandle(handle: FileSystemDirectoryHandle) {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(handle, HANDLE_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("句柄保存失败"));
  });
  db.close();
}

export async function loadHandle(): Promise<FsDir | null> {
  try {
    const db = await openDb();
    const handle = await new Promise<FsDir | null>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const request = tx.objectStore(STORE).get(HANDLE_KEY);
      request.onsuccess = () => resolve((request.result as FsDir) ?? null);
      request.onerror = () => reject(request.error ?? new Error("句柄读取失败"));
    });
    db.close();
    return handle;
  } catch {
    return null;
  }
}

export async function forgetHandle() {
  try {
    const db = await openDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(HANDLE_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
    db.close();
  } catch {
    // 忽略清理失败
  }
  saveFolderBinding(null);
}

/** 选择文件夹并记住句柄。已绑定过时先请求权限，避免重复弹窗。 */
export async function pickFolder(): Promise<FsDir | null> {
  const picker = (window as DirPickerWindow).showDirectoryPicker;
  if (!picker) throw new Error("当前浏览器不支持直接选择文件夹，请使用 Chrome / Edge");
  const handle = (await picker({ mode: "read", id: "supe-kb" })) as FsDir;
  await putHandle(handle);
  saveFolderBinding({ name: handle.name, updatedAt: new Date().toISOString() });
  return handle;
}

/** 校验并（必要时）申请读取权限。 */
export async function ensurePermission(handle: FsDir): Promise<boolean> {
  const descriptor = { mode: "read" as const };
  const current = await handle.queryPermission(descriptor);
  if (current === "granted") return true;
  const next = await handle.requestPermission(descriptor);
  return next === "granted";
}

function inferDocType(name: string, dir: string): string {
  const haystack = `${dir} ${name}`.toLowerCase();
  for (const rule of DOC_TYPE_RULES) {
    if (rule.keys.some((key) => haystack.includes(key.toLowerCase()))) return rule.type;
  }
  return "其他资料";
}

function stripExt(name: string): string {
  const index = name.lastIndexOf(".");
  return index > 0 ? name.slice(0, index) : name;
}

function extOf(name: string): string {
  const index = name.lastIndexOf(".");
  return index >= 0 ? name.slice(index + 1).toLowerCase() : "";
}

/** 递归扫描目录，返回可导入清单（不读取内容）。 */
export async function scanFolder(
  handle: FsDir,
  onProgress?: (count: number, current: string) => void,
): Promise<KbFileItem[]> {
  const items: KbFileItem[] = [];
  let counter = 0;

  async function walk(dir: FsDir, prefix: string) {
    for await (const entry of dir.values()) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      if (entry.kind === "directory") {
        await walk(entry as FsDir, prefix ? `${prefix}/${entry.name}` : entry.name);
        continue;
      }
      const fileHandle = entry as FileSystemFileHandle;
      const file = await fileHandle.getFile().catch(() => null);
      if (!file) continue;
      const ext = extOf(file.name);
      counter += 1;
      onProgress?.(counter, file.name);
      const supported = SUPPORTED_EXT.has(ext) && file.size <= MAX_FILE_BYTES;
      let reason = "";
      if (BLOCKED_EXT.has(ext)) reason = "格式暂不支持自动解析";
      else if (!SUPPORTED_EXT.has(ext)) reason = "未识别的文件类型";
      else if (file.size > MAX_FILE_BYTES) reason = "文件超过 20MB";
      items.push({
        id: `${prefix}/${file.name}`,
        path: prefix ? `${prefix}/${file.name}` : file.name,
        name: file.name,
        dir: prefix,
        ext,
        size: file.size,
        title: stripExt(file.name),
        supported,
        reason: reason || undefined,
      });
    }
  }

  await walk(handle, "");
  items.sort((a, b) => Number(b.supported) - Number(a.supported) || a.path.localeCompare(b.path, "zh-CN"));
  return items;
}

function htmlToText(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("script, style, noscript").forEach((node) => node.remove());
  return (doc.body?.textContent ?? "").replace(/\n{3,}/g, "\n\n").trim();
}

/** 按扩展名解析单个文件为纯文本。 */
export async function extractText(file: File, ext: string): Promise<string> {
  if (TEXT_EXT.has(ext)) {
    const raw = await file.text();
    const text = ext === "html" || ext === "htm" ? htmlToText(raw) : raw;
    return text.replace(/\r\n/g, "\n").trim();
  }

  if (ext === "docx") {
    const mammoth = await import("mammoth");
    const buffer = await file.arrayBuffer();
    const result = await mammoth.extractRawText({ arrayBuffer: buffer });
    return (result.value ?? "").replace(/\n{3,}/g, "\n\n").trim();
  }

  if (ext === "xlsx" || ext === "xls") {
    const XLSX = await import("xlsx");
    const buffer = await file.arrayBuffer();
    const book = XLSX.read(buffer, { type: "array" });
    const parts: string[] = [];
    for (const sheetName of book.SheetNames.slice(0, 10)) {
      const sheet = book.Sheets[sheetName];
      if (!sheet) continue;
      const csv = XLSX.utils.sheet_to_csv(sheet, { blankrows: false });
      if (csv.trim()) parts.push(`【工作表：${sheetName}】\n${csv.trim()}`);
    }
    return parts.join("\n\n").slice(0, MAX_CONTENT_CHARS);
  }

  if (ext === "pdf") {
    const pdfjs = await import("pdfjs-dist");
    const workerUrl = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
    const buffer = await file.arrayBuffer();
    const pdf = await pdfjs.getDocument({ data: new Uint8Array(buffer) }).promise;
    const pages: string[] = [];
    const maxPages = Math.min(pdf.numPages, 60);
    for (let pageNo = 1; pageNo <= maxPages; pageNo += 1) {
      const page = await pdf.getPage(pageNo);
      const content = await page.getTextContent();
      const line = content.items
        .map((item) => ("str" in item ? item.str : ""))
        .join(" ")
        .replace(/\s{2,}/g, " ")
        .trim();
      if (line) pages.push(line);
      if (pages.join("\n").length > MAX_CONTENT_CHARS) break;
    }
    return pages.join("\n\n").trim();
  }

  throw new Error("该格式暂不支持解析");
}

/** 读取单个文件内容并写入结果对象。 */
export async function readItem(handle: FsDir, item: KbFileItem): Promise<KbFileItem> {
  try {
    const segments = item.path.split("/");
    let dir: FsDir = handle;
    for (const segment of segments.slice(0, -1)) {
      dir = (await dir.getDirectoryHandle(segment)) as FsDir;
    }
    const fileHandle = await dir.getFileHandle(segments[segments.length - 1]);
    const file = await fileHandle.getFile();
    const text = await extractText(file, item.ext);
    const trimmed = text.slice(0, MAX_CONTENT_CHARS);
    if (!trimmed) return { ...item, error: "未提取到文本（可能是扫描件或空文件）" };
    return { ...item, content: trimmed, chars: trimmed.length };
  } catch (error) {
    return { ...item, error: error instanceof Error ? error.message : "读取失败" };
  }
}

export interface ImportOutcome {
  imported: number;
  failed: number;
  errors: string[];
}

/** 批量写入云端知识库，串行 + 小并发，避免触发接口限流。 */
export async function importItems(
  handle: FsDir,
  items: KbFileItem[],
  options: { folderName: string; ownerName?: string | null; onProgress?: (done: number, total: number, name: string) => void },
): Promise<ImportOutcome> {
  let imported = 0;
  let failed = 0;
  const errors: string[] = [];

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    options.onProgress?.(index, items.length, item.name);
    const prepared = item.content ? item : await readItem(handle, item);
    if (prepared.error || !prepared.content) {
      failed += 1;
      errors.push(`${item.name}：${prepared.error ?? "无内容"}`);
      continue;
    }
    try {
      await insertKnowledgeDoc({
        title: prepared.title.slice(0, 120),
        docType: inferDocType(prepared.name, prepared.dir),
        content: prepared.content,
        source: `${options.folderName}/${prepared.path}`.slice(0, 200),
        ownerName: options.ownerName ?? null,
      });
      imported += 1;
    } catch (error) {
      failed += 1;
      errors.push(`${item.name}：${error instanceof Error ? error.message : "写入失败"}`);
    }
  }

  options.onProgress?.(items.length, items.length, "");
  saveFolderBinding({ name: options.folderName, updatedAt: new Date().toISOString() });
  return { imported, failed, errors };
}

/** 降级方案：<input webkitdirectory> 选中的文件列表。 */
export async function filesFromInput(fileList: FileList): Promise<{ items: KbFileItem[]; contents: Map<string, File> }> {
  const items: KbFileItem[] = [];
  const contents = new Map<string, File>();
  for (const file of Array.from(fileList)) {
    const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
    if (relative.split("/").some((segment) => segment.startsWith("."))) continue;
    const ext = extOf(file.name);
    const dir = relative.includes("/") ? relative.split("/").slice(0, -1).join("/") : "";
    const supported = SUPPORTED_EXT.has(ext) && file.size <= MAX_FILE_BYTES;
    items.push({
      id: relative,
      path: relative,
      name: file.name,
      dir,
      ext,
      size: file.size,
      title: stripExt(file.name),
      supported,
      reason: supported ? undefined : BLOCKED_EXT.has(ext) ? "格式暂不支持自动解析" : "未识别的文件类型",
    });
    contents.set(relative, file);
  }
  items.sort((a, b) => Number(b.supported) - Number(a.supported) || a.path.localeCompare(b.path, "zh-CN"));
  return { items, contents };
}

export { inferDocType };

/** 降级通道：直接从内存中的 File 对象导入（不支持目录 API 的浏览器）。 */
export async function importFromFileMap(
  map: Map<string, File>,
  items: KbFileItem[],
  options: { folderName: string; ownerName?: string | null; onProgress?: (done: number, total: number, name: string) => void },
): Promise<ImportOutcome> {
  let imported = 0;
  let failed = 0;
  const errors: string[] = [];

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    options.onProgress?.(index, items.length, item.name);
    const file = map.get(item.id);
    if (!file) {
      failed += 1;
      errors.push(`${item.name}：文件已失效`);
      continue;
    }
    try {
      const text = (await extractText(file, item.ext)).slice(0, MAX_CONTENT_CHARS);
      if (!text) {
        failed += 1;
        errors.push(`${item.name}：未提取到文本`);
        continue;
      }
      await insertKnowledgeDoc({
        title: item.title.slice(0, 120),
        docType: inferDocType(item.name, item.dir),
        content: text,
        source: `${options.folderName}/${item.path}`.slice(0, 200),
        ownerName: options.ownerName ?? null,
      });
      imported += 1;
    } catch (error) {
      failed += 1;
      errors.push(`${item.name}：${error instanceof Error ? error.message : "导入失败"}`);
    }
  }

  options.onProgress?.(items.length, items.length, "");
  return { imported, failed, errors };
}
