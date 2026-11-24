/**
 * 交付物打包（纯函数层）。
 *
 * 解决的问题：所有产出只能一条一条复制/下载，交付给客户或存档时手工拼，容易漏。
 * 做法：把内容工厂产出、Office 文档、数字人方案、混剪方案等收拢成一份「打包清单」，
 * 统一命名、去重、按分类落目录，再由 UI 用 fflate 压成 zip 下载。
 * 本模块不碰浏览器 API（zip 编码在 UI 层），便于自检。
 */

export type BundleKind = "content" | "office-ppt" | "office-doc" | "digital-plan" | "mixcut-plan" | "srt" | "csv" | "other";

export interface BundleItem {
  /** 分类（同时作为 zip 内的目录名） */
  kind: BundleKind;
  title: string;
  /** 文件扩展名（含点），如 .md / .srt / .pptx */
  ext: string;
  /** 正文（文本类）或 base64（二进制类） */
  data: string;
  encoding?: "utf8" | "base64";
  /** 来源标注，写进清单 */
  source?: string;
}

export interface BundleEntry {
  kind: BundleKind;
  title: string;
  fileName: string;
  path: string;
  ext: string;
  data: string;
  encoding: "utf8" | "base64";
  source: string;
  /** 字节数（按 data 估算） */
  bytes: number;
}

export interface BundleResult {
  entries: BundleEntry[];
  /** README.md 内容：清单 + 生成时间 */
  readme: string;
  totalBytes: number;
  /** 因内容为空被跳过的条数（README 里会写明） */
  skipped: number;
  byKind: { kind: BundleKind; count: number; bytes: number }[];
}

const KIND_DIR: Record<BundleKind, string> = {
  content: "01-内容产出",
  "office-ppt": "02-演示文稿",
  "office-doc": "03-文档",
  "digital-plan": "04-数字人方案",
  "mixcut-plan": "05-混剪方案",
  srt: "06-字幕",
  csv: "07-数据",
  other: "08-其他",
};

const KIND_LABEL: Record<BundleKind, string> = {
  content: "内容产出",
  "office-ppt": "演示文稿",
  "office-doc": "文档",
  "digital-plan": "数字人方案",
  "mixcut-plan": "混剪方案",
  srt: "字幕",
  csv: "数据",
  other: "其他",
};

/** Windows/macOS 都不接受的文件名字符，统一替换为下划线；并截断防超长。 */
export function safeFileName(raw: string, maxLength = 60): string {
  const cleaned = String(raw ?? "")
    .replace(/[\\/:*?"<>|\n\r\t]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "");
  const sliced = cleaned.slice(0, maxLength).trim() || "未命名";
  return sliced;
}

function byteLength(data: string, encoding: "utf8" | "base64"): number {
  if (encoding === "base64") {
    const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
    return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
  }
  // UTF-8 字节数：ASCII 1、其余按 2~3 粗算（清单只需量级）
  let bytes = 0;
  for (const char of data) {
    const code = char.codePointAt(0) ?? 0;
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
  }
  return bytes;
}

/**
 * 构建打包清单：按分类落目录、同名自动加序号、跳过空内容。
 * 顺序稳定（同分类内保持入参顺序），便于测试与人工核对。
 */
export function buildBundle(items: BundleItem[], now = Date.now()): BundleResult {
  const used = new Map<string, Set<string>>();
  const entries: BundleEntry[] = [];
  let skipped = 0;

  for (const item of items) {
    const data = item.data ?? "";
    if (!data.trim()) {
      skipped += 1;
      continue;
    }
    const ext = item.ext.startsWith(".") ? item.ext : `.${item.ext}`;
    const dir = KIND_DIR[item.kind] ?? KIND_DIR.other;
    const set = used.get(dir) ?? new Set<string>();
    used.set(dir, set);

    const base = safeFileName(item.title);
    let fileName = `${base}${ext}`;
    let counter = 2;
    while (set.has(fileName.toLowerCase())) {
      fileName = `${base}(${counter})${ext}`;
      counter += 1;
    }
    set.add(fileName.toLowerCase());

    const encoding = item.encoding ?? "utf8";
    entries.push({
      kind: item.kind,
      title: item.title,
      fileName,
      path: `${dir}/${fileName}`,
      ext,
      data,
      encoding,
      source: item.source ?? "",
      bytes: byteLength(data, encoding),
    });
  }

  const byKindMap = new Map<BundleKind, { kind: BundleKind; count: number; bytes: number }>();
  for (const entry of entries) {
    const row = byKindMap.get(entry.kind) ?? { kind: entry.kind, count: 0, bytes: 0 };
    row.count += 1;
    row.bytes += entry.bytes;
    byKindMap.set(entry.kind, row);
  }

  const totalBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  return {
    entries,
    readme: bundleReadme(entries, { totalBytes, skipped, now }),
    totalBytes,
    skipped,
    byKind: [...byKindMap.values()].sort((a, b) => b.count - a.count),
  };
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function bundleReadme(
  entries: BundleEntry[],
  meta: { totalBytes: number; skipped: number; now: number },
): string {
  const lines: string[] = [];
  lines.push("# 交付物打包清单");
  lines.push("");
  lines.push(`生成时间：${new Date(meta.now).toLocaleString("zh-CN", { hour12: false })}`);
  lines.push(`文件数：${entries.length} ｜ 合计：${formatBytes(meta.totalBytes)}`);
  if (meta.skipped > 0) lines.push(`跳过空内容：${meta.skipped} 项`);
  lines.push("");
  lines.push("## 目录说明");
  lines.push("");
  const dirs = [...new Set(entries.map((entry) => entry.path.split("/")[0]))].sort();
  for (const dir of dirs) {
    lines.push(`- \`${dir}/\` —— ${dir.split("-").slice(1).join("-")}`);
  }
  lines.push("");
  lines.push("## 文件清单");
  lines.push("");
  lines.push("| 文件 | 大小 | 来源 |");
  lines.push("|---|---|---|");
  for (const entry of entries) {
    lines.push(`| \`${entry.path}\` | ${formatBytes(entry.bytes)} | ${entry.source || "—"} |`);
  }
  lines.push("");
  lines.push("> 本清单由「AI 超级员工」自动生成；文件按类型分目录，可直接交付客户或归档。");
  return lines.join("\n");
}

export const BUNDLE_KIND_META: { kind: BundleKind; label: string; dir: string }[] = (
  Object.keys(KIND_DIR) as BundleKind[]
).map((kind) => ({ kind, label: KIND_LABEL[kind], dir: KIND_DIR[kind] }));
