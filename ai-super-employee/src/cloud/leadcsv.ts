/**
 * 线索 CSV 导入 / 去重（纯函数，无 DOM 依赖，便于自检脚本直接跑）。
 *
 * 支持的列名（大小写、空格、中英文逗号不敏感）：
 *   客户/姓名/name、来源/source、意向/intent、需求/need、跟进人/owner、阶段/stage、企微ID/external_userid
 * 也接受「导出 CSV」的原样表头（客户,来源,意向等级,最新需求,跟进人,阶段,创建时间）。
 */

export interface LeadImportRow {
  name: string;
  source: string;
  intent: string;
  need: string;
  owner: string;
  stage: string;
  external_userid: string;
}

export interface LeadImportResult {
  rows: LeadImportRow[];
  /** 文件内重复（同名同电话/企微ID）被合并的行数 */
  duplicatesInFile: number;
  /** 与已有线索重复的行数 */
  duplicatesExisting: number;
  /** 缺客户名 / 全空行的行数 */
  skipped: number;
  /** 解析出的表头映射便于 UI 展示 */
  headers: Record<string, string>;
}

export interface LeadDedupeResult<T> {
  kept: T[];
  removed: T[];
}

const HEADER_MAP: Record<string, keyof LeadImportRow> = {
  客户: "name",
  姓名: "name",
  客户名称: "name",
  name: "name",
  来源: "source",
  来源渠道: "source",
  source: "source",
  意向: "intent",
  意向等级: "intent",
  intent: "intent",
  需求: "need",
  最新需求: "need",
  need: "need",
  跟进人: "owner",
  owner: "owner",
  阶段: "stage",
  stage: "stage",
  企微id: "external_userid",
  企微ID: "external_userid",
  external_userid: "external_userid",
  externaluserid: "external_userid",
};

/** 去除 BOM、统一换行、按 CSV 规则切分（支持双引号包裹与内嵌逗号/换行）。 */
export function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quoted) {
      if (char === '"') {
        if (line[index + 1] === '"') {
          current += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        current += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      cells.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current.trim());
  return cells;
}

function parseCsvRecords(text: string): string[][] {
  const normalized = String(text ?? "").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const records: string[] = [];
  let buffer = "";
  let quoted = false;
  for (const char of normalized) {
    if (char === '"') {
      quoted = !quoted;
      buffer += char;
      continue;
    }
    if (char === "\n" && !quoted) {
      records.push(buffer);
      buffer = "";
      continue;
    }
    buffer += char;
  }
  if (buffer.trim()) records.push(buffer);
  return records.filter((line) => line.trim() !== "").map((line) => splitCsvLine(line));
}

function normalizeIntent(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "中意向";
  if (["高", "高意向", "hot", "high"].includes(trimmed.toLowerCase())) return "高意向";
  if (["低", "低意向", "cold", "low"].includes(trimmed.toLowerCase())) return "低意向";
  return trimmed;
}

const STAGES = ["新建", "跟进中", "已预约", "已成交"];

function normalizeStage(value: string): string {
  const trimmed = value.trim();
  if (STAGES.includes(trimmed)) return trimmed;
  const mapped: Record<string, string> = { 新: "新建", 跟进: "跟进中", 预约: "已预约", 成交: "已成交" };
  return mapped[trimmed] ?? "新建";
}

/** 去重键：优先企微 ID，其次「姓名 + 需求」避免同名不同客户被误合并。 */
export function leadKey(row: { name: string; need: string; external_userid?: string | null }): string {
  const id = (row.external_userid ?? "").trim();
  if (id) return `id:${id.toLowerCase()}`;
  return `name:${row.name.trim().toLowerCase()}|${row.need.trim().toLowerCase()}`;
}

/**
 * 解析 CSV：第一行是表头（无法识别时按导出顺序缺省映射）。
 * existing 用于标记与已有线索重复的行（不进入 rows）。
 */
export function parseLeadsCsv(text: string, existing: { name: string; need: string; external_userid?: string | null }[] = []): LeadImportResult {
  const records = parseCsvRecords(text);
  const empty: LeadImportResult = { rows: [], duplicatesInFile: 0, duplicatesExisting: 0, skipped: 0, headers: {} };
  if (!records.length) return empty;

  const rawHeader = records[0];
  const headers: Record<string, string> = {};
  const indexToField: (keyof LeadImportRow | null)[] = rawHeader.map((cell) => {
    const key = cell.trim().toLowerCase().replace(/\s+/g, "");
    const field = HEADER_MAP[key] ?? HEADER_MAP[cell.trim()] ?? null;
    if (field) headers[field] = cell.trim();
    return field;
  });

  // 无法识别任何表头：视为无表头，按导出顺序（客户,来源,意向,需求,跟进人,阶段）
  const hasRecognized = indexToField.some((field) => field !== null);
  const order: (keyof LeadImportRow)[] = ["name", "source", "intent", "need", "owner", "stage", "external_userid"];
  const startIndex = hasRecognized ? 1 : 0;
  const fields: (keyof LeadImportRow | null)[] = hasRecognized ? indexToField : order;
  if (!hasRecognized) {
    for (const field of order) headers[field] = field;
  }

  const seen = new Set(existing.map((row) => leadKey({ name: row.name, need: row.need ?? "", external_userid: row.external_userid ?? "" })));
  const rows: LeadImportRow[] = [];
  let duplicatesInFile = 0;
  let duplicatesExisting = 0;
  let skipped = 0;

  for (const record of records.slice(startIndex)) {
    const row: LeadImportRow = {
      name: "",
      source: "",
      intent: "",
      need: "",
      owner: "",
      stage: "",
      external_userid: "",
    };
    fields.forEach((field, index) => {
      if (!field) return;
      row[field] = record[index] ?? "";
    });
    row.name = row.name.trim().slice(0, 20);
    row.need = row.need.trim().slice(0, 200);
    if (!row.name) {
      skipped += 1;
      continue;
    }
    const normalized: LeadImportRow = {
      name: row.name,
      source: row.source.trim() || "CSV 导入",
      intent: normalizeIntent(row.intent),
      need: row.need || "（导入时未填写需求）",
      owner: row.owner.trim(),
      stage: normalizeStage(row.stage),
      external_userid: row.external_userid.trim(),
    };
    const key = leadKey(normalized);
    if (seen.has(key)) {
      if (existing.some((item) => leadKey({ name: item.name, need: item.need ?? "", external_userid: item.external_userid ?? "" }) === key)) {
        duplicatesExisting += 1;
      } else {
        duplicatesInFile += 1;
      }
      continue;
    }
    seen.add(key);
    rows.push(normalized);
  }

  return { rows, duplicatesInFile, duplicatesExisting, skipped, headers };
}

/** 已有线索内部去重（同名同电话/企微ID 合并，保留最早一条）。 */
export function dedupeLeads<T extends { name: string; need: string; external_userid?: string | null }>(rows: T[]): LeadDedupeResult<T> {
  const seen = new Set<string>();
  const kept: T[] = [];
  const removed: T[] = [];
  for (const row of rows) {
    const key = leadKey(row);
    if (seen.has(key)) {
      removed.push(row);
      continue;
    }
    seen.add(key);
    kept.push(row);
  }
  return { kept, removed };
}
