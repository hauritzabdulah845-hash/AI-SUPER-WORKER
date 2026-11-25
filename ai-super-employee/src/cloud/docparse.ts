/**
 * 文档解析（合同审查 / AI 人事共用）：把 .txt/.md/.docx/.pdf 提取为纯文本。
 *
 * 复用仓库已有依赖与知识库导入的解析路径（kb-import.ts 同款）：
 * docx 走 mammoth、pdf 走 pdfjs-dist，全部动态加载，不新增依赖包。
 *
 * 纪律：
 * - 解析文本只进内存流程，合同/简历全文不留档（沿用 contract.ts / hr.ts 原则）。
 * - 解析失败如实抛错，调用方回退到粘贴文本，不静默吞掉。
 * - 文件上限 5MB、文本上限 60000 字，超限截断并明确标注。
 */

export const DOC_MAX_BYTES = 5 * 1024 * 1024;
export const DOC_MAX_CHARS = 60000;
/** 文件选择框 accept（与 detectDocKind 支持集一致） */
export const DOC_ACCEPT = ".txt,.md,.docx,.pdf,text/plain,text/markdown,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/pdf";

export type DocKind = "text" | "docx" | "pdf" | "unsupported";

/** 按扩展名判断解析路径（纯函数）。 */
export function detectDocKind(name: string): DocKind {
  const ext = String(name ?? "").split(".").pop()?.toLowerCase() ?? "";
  if (ext === "txt" || ext === "md" || ext === "markdown") return "text";
  if (ext === "docx") return "docx";
  if (ext === "pdf") return "pdf";
  return "unsupported";
}

export interface DocValidation {
  ok: boolean;
  kind: DocKind;
  error?: string;
}

/** 文件校验（纯函数）：格式白名单 + 5MB 上限。 */
export function validateDocFile(meta: { name: string; size: number }): DocValidation {
  const kind = detectDocKind(meta.name);
  if (kind === "unsupported") {
    return { ok: false, kind, error: "暂只支持 .txt / .md / .docx / .pdf 文件，其他格式请改用粘贴文本" };
  }
  if (!Number.isFinite(meta.size) || meta.size <= 0) {
    return { ok: false, kind, error: "文件为空，请重新选择" };
  }
  if (meta.size > DOC_MAX_BYTES) {
    return { ok: false, kind, error: `文件超过 ${Math.round(DOC_MAX_BYTES / 1024 / 1024)}MB 上限，请拆分后重试或改用粘贴文本` };
  }
  return { ok: true, kind };
}

export interface ClampedText {
  text: string;
  truncated: boolean;
  totalChars: number;
}

/** 文本截断（纯函数）：超上限取前 N 字并标注，供界面提示。 */
export function clampDocText(text: string, max: number = DOC_MAX_CHARS): ClampedText {
  const value = String(text ?? "");
  if (value.length <= max) return { text: value, truncated: false, totalChars: value.length };
  return { text: value.slice(0, max), truncated: true, totalChars: value.length };
}

function normalizeExtracted(raw: string): string {
  return raw.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

async function extractDocx(bytes: Uint8Array): Promise<string> {
  const mammoth = await import("mammoth");
  const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  try {
    const result = await mammoth.extractRawText({ arrayBuffer });
    return normalizeExtracted(result.value ?? "");
  } catch {
    // Node 环境 mammoth 走 { buffer } 入参（浏览器走 arrayBuffer），兜底再试一次
    const extract = mammoth.extractRawText as unknown as (options: Record<string, unknown>) => Promise<{ value: string }>;
    const buffer = typeof Buffer !== "undefined" ? Buffer.from(bytes) : bytes;
    const result = await extract({ buffer });
    return normalizeExtracted(result.value ?? "");
  }
}

async function extractPdf(bytes: Uint8Array): Promise<string> {
  // 浏览器走主构建 + worker（与 kb-import 同款）；Node（自检脚本）走 legacy 构建。
  // legacy 路径用拼接写法，避免被 Vite 打进浏览器包（浏览器永远走不到该分支）。
  const legacySpec = ["pdfjs-dist", "legacy", "build", "pdf.mjs"].join("/");
  const pdfjs =
    typeof window !== "undefined"
      ? await import("pdfjs-dist")
      : ((await import(legacySpec)) as typeof import("pdfjs-dist"));
  if (typeof window !== "undefined") {
    const workerUrl = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  }
  const pdf = await pdfjs.getDocument({ data: bytes }).promise;
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
    if (pages.join("\n").length > DOC_MAX_CHARS) break;
  }
  return normalizeExtracted(pages.join("\n\n"));
}

/** 字节级解析入口（File 与测试共用）。不支持的格式抛错。 */
export async function extractTextFromBytes(bytes: Uint8Array, kind: DocKind): Promise<string> {
  if (kind === "text") return normalizeExtracted(new TextDecoder("utf-8").decode(bytes));
  if (kind === "docx") return extractDocx(bytes);
  if (kind === "pdf") return extractPdf(bytes);
  throw new Error("暂只支持 .txt / .md / .docx / .pdf 文件，其他格式请改用粘贴文本");
}

export interface ExtractedDocument extends ClampedText {
  kind: DocKind;
  fileName: string;
}

/**
 * 解析一个用户选择的文件为文本：校验 → 解析 → 截断标注。
 * 解析出空文本（扫描件 PDF 等）抛错，调用方提示改用粘贴文本。
 */
export async function extractDocumentText(file: File): Promise<ExtractedDocument> {
  const validation = validateDocFile({ name: file.name, size: file.size });
  if (!validation.ok) throw new Error(validation.error ?? "文件不可用");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const raw = await extractTextFromBytes(bytes, validation.kind);
  if (!raw) throw new Error("未提取到文本（可能是扫描件或空文件），请改用粘贴文本");
  return { ...clampDocText(raw), kind: validation.kind, fileName: file.name };
}
