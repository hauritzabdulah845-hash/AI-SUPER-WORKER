/**
 * 素材 AI 分析（竞品差距 11.2#4：画面识别→标签/角色建议→话术自动对位）。
 * - 启发式：文件名/类型/时长/备注 → 标签与角色建议，零依赖可用；
 * - 视觉模型：generic 适配器（配置存本机，Key 到位即接；>2MB 或失败自动回退启发式）；
 * - 话术对位：方案段落与素材组关键词重合度 → brollGroup 建议（只补空位，不覆盖人工绑定）。
 * 角色「采纳」仍走素材角色页授权门禁（canSetRole），本模块只给建议。
 */
import type { MediaAsset, MediaRole } from "./media";

/* ------------------------------------------------------------------ */
/* 标签词典（分析与对位共用）                                            */
/* ------------------------------------------------------------------ */

export const TAG_LEXICON = [
  "门店", "店面", "街景", "环境", "室内", "厨房", "后厨", "前台", "客座", "大厅",
  "产品", "菜品", "菜单", "包装", "特写", "细节", "材质",
  "服务", "流程", "步骤", "操作", "制作", "演示", "对比", "测试",
  "价格", "优惠", "活动", "开业", "促销", "福利",
  "客户", "评价", "案例", "访谈", "采访", "数据", "图表",
  "人物", "口播", "模特", "主播", "出镜", "讲解", "旁白", "配音",
  "全景", "近景", "延时", "转场", "空镜",
  "春季", "夏季", "秋季", "冬季", "早晨", "夜晚", "白天",
];

const AVATAR_WORDS = ["口播", "人物", "模特", "主播", "出镜", "真人", "采访", "讲解", "访谈"];

/* ------------------------------------------------------------------ */
/* 启发式分析                                                           */
/* ------------------------------------------------------------------ */

export interface AssetAnalysis {
  assetId: string;
  analyzedAt: number;
  tags: string[];
  /** 角色建议（仅建议；采纳时仍走授权门禁） */
  suggestedRole: MediaRole | "";
  roleReason: string;
  source: "heuristic" | "vision";
  /** 一句话摘要（启发式拼装 / 视觉模型描述） */
  note: string;
}

const KIND_LABEL: Record<MediaAsset["kind"], string> = { video: "视频", image: "图片", audio: "音频" };

export function heuristicAnalysis(asset: MediaAsset): AssetAnalysis {
  const text = `${asset.name} ${asset.group} ${asset.note}`.toLowerCase();
  const tags: string[] = [];
  for (const word of TAG_LEXICON) {
    if (text.includes(word.toLowerCase())) tags.push(word);
  }
  for (const part of asset.name.split(/[-_()\s]+/)) {
    const clean = part.trim();
    if (clean.length >= 2 && clean.length <= 8 && !tags.includes(clean)) tags.push(clean);
  }
  const finalTags = tags.slice(0, 6);

  let suggestedRole: MediaRole | "" = "";
  let roleReason = "";
  if (asset.kind === "audio") {
    suggestedRole = "voice";
    roleReason = "音频素材，可作声音轨";
  } else if (asset.kind === "video" && AVATAR_WORDS.some((word) => text.includes(word))) {
    suggestedRole = "avatar";
    roleReason = "文件名含出镜类关键词";
  } else {
    suggestedRole = "broll";
    roleReason = "画面素材，建议作分镜";
  }

  const note = [
    `${KIND_LABEL[asset.kind]}${asset.duration ? ` · ${Math.round(asset.duration)}s` : ""}`,
    `组「${asset.group}」`,
    finalTags.length ? `关键词：${finalTags.join("/")}` : "",
  ]
    .filter(Boolean)
    .join(" · ");

  return {
    assetId: asset.id,
    analyzedAt: Date.now(),
    tags: finalTags,
    suggestedRole,
    roleReason,
    source: "heuristic",
    note,
  };
}

/* ------------------------------------------------------------------ */
/* 视觉模型适配器（generic，配置存本机）                                 */
/* ------------------------------------------------------------------ */

export interface VisualConfig {
  provider: "heuristic" | "generic";
  baseUrl: string;
  path: string;
}

export const VISUAL_CONFIG_KEY = "ai-employee:visual-config";
const DEFAULT_VISUAL: VisualConfig = { provider: "heuristic", baseUrl: "", path: "/v1/vision" };
/** 视觉接口请求体上限（dataURL 直传；超出回退启发式） */
export const MAX_VISION_BYTES = 2 * 1024 * 1024;

export function loadVisualConfig(): VisualConfig {
  try {
    const raw = localStorage.getItem(VISUAL_CONFIG_KEY);
    if (raw) return { ...DEFAULT_VISUAL, ...(JSON.parse(raw) as Partial<VisualConfig>) };
  } catch {
    /* 节点测试环境无 localStorage */
  }
  return { ...DEFAULT_VISUAL };
}

export function saveVisualConfig(config: VisualConfig): void {
  try {
    localStorage.setItem(VISUAL_CONFIG_KEY, JSON.stringify(config));
  } catch {
    /* 只读环境忽略 */
  }
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return `data:${blob.type || "application/octet-stream"};base64,${btoa(binary)}`;
}

interface VisionPayload {
  tags?: unknown;
  role?: unknown;
  note?: unknown;
}

/** 单素材分析：heuristic 直出；generic 调视觉端点，任何失败回退启发式并注明。 */
export async function analyzeAsset(asset: MediaAsset, config: VisualConfig): Promise<AssetAnalysis> {
  const base = heuristicAnalysis(asset);
  if (config.provider === "heuristic" || !config.baseUrl.trim()) return base;

  if (asset.size > MAX_VISION_BYTES) {
    return { ...base, note: `${base.note}（超 2MB，视觉分析跳过）` };
  }

  try {
    const response = await fetch(config.baseUrl.replace(/\/$/, "") + config.path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        image: await blobToDataUrl(asset.blob),
        name: asset.name,
        kind: asset.kind,
        hint: "识别画面主体/场景，返回 JSON：{tags:[...], role:\"avatar|voice|broll\", note:\"一句话描述\"}",
      }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = (await response.json()) as VisionPayload;
    const tags = Array.isArray(payload.tags)
      ? payload.tags.map((item) => String(item).trim()).filter(Boolean).slice(0, 6)
      : base.tags;
    const role = typeof payload.role === "string" && ["avatar", "voice", "broll"].includes(payload.role)
      ? (payload.role as MediaRole)
      : base.suggestedRole;
    const note = typeof payload.note === "string" && payload.note.trim() ? payload.note.trim() : base.note;
    return {
      ...base,
      tags: tags.length ? tags : base.tags,
      suggestedRole: role,
      roleReason: typeof payload.note === "string" && payload.note.trim() ? "视觉模型识别" : base.roleReason,
      source: "vision",
      note,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ...base, note: `${base.note}（视觉服务失败：${message}，已用启发式）` };
  }
}

/** 批量分析（顺序执行，避免打爆自配端点）。 */
export async function analyzeAll(assets: MediaAsset[], config: VisualConfig): Promise<AssetAnalysis[]> {
  const rows: AssetAnalysis[] = [];
  for (const asset of assets) rows.push(await analyzeAsset(asset, config));
  return rows;
}

/* ------------------------------------------------------------------ */
/* 分析结果留档（本机，cap 100）                                         */
/* ------------------------------------------------------------------ */

export const MEDIA_ANALYSES_KEY = "ai-employee:media-analyses";
const ANALYSIS_CAP = 100;

export function loadAnalyses(): AssetAnalysis[] {
  try {
    const raw = localStorage.getItem(MEDIA_ANALYSES_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as AssetAnalysis[]) : [];
  } catch {
    return [];
  }
}

export function saveAnalyses(rows: AssetAnalysis[]): AssetAnalysis[] {
  const next = rows.slice(-ANALYSIS_CAP);
  try {
    localStorage.setItem(MEDIA_ANALYSES_KEY, JSON.stringify(next));
  } catch {
    /* 只读环境忽略 */
  }
  return next;
}

/* ------------------------------------------------------------------ */
/* 话术自动对位（段落 ↔ 素材组）                                         */
/* ------------------------------------------------------------------ */

export interface BindingSuggestion {
  order: number;
  segmentText: string;
  group: string;
  score: number;
  reason: string;
}

export interface BindableSegment {
  order: number;
  script: string;
  subtitle: string;
  brollGroup?: string;
}

export interface BindableGroup {
  name: string;
  assets: { name: string; note?: string }[];
}

/**
 * 段落与素材组的关键词重合打分：
 * - 段落直提组名 +3；
 * - 词典共同词每个 +2；
 * - 得分 ≥2 才出建议；每段只取最高分组。
 */
export function suggestBindings(segments: BindableSegment[], groups: BindableGroup[]): BindingSuggestion[] {
  const suggestions: BindingSuggestion[] = [];
  for (const segment of segments) {
    const segmentText = `${segment.script} ${segment.subtitle}`;
    let best: BindingSuggestion | null = null;
    for (const group of groups) {
      const groupText = `${group.name} ${group.assets.map((asset) => `${asset.name} ${asset.note ?? ""}`).join(" ")}`;
      let score = 0;
      const reasons: string[] = [];
      if (group.name.length >= 2 && segmentText.includes(group.name)) {
        score += 3;
        reasons.push("段落直提组名");
      }
      for (const word of TAG_LEXICON) {
        if (segmentText.includes(word) && groupText.includes(word)) {
          score += 2;
          reasons.push(`共同词「${word}」`);
        }
      }
      if (score >= 2 && (!best || score > best.score)) {
        best = {
          order: segment.order,
          segmentText: (segment.subtitle || segment.script).slice(0, 16),
          group: group.name,
          score,
          reason: reasons.slice(0, 2).join("，"),
        };
      }
    }
    if (best) suggestions.push(best);
  }
  return suggestions;
}

/** 按建议补 brollGroup：**只补空位**，人工/LLM 已绑定的一律保留。 */
export function autoBindSegments<T extends BindableSegment>(
  segments: T[],
  suggestions: BindingSuggestion[],
): { segments: T[]; applied: number; kept: number } {
  const byOrder = new Map(suggestions.map((item) => [item.order, item]));
  let applied = 0;
  let kept = 0;
  const next = segments.map((segment) => {
    if (segment.brollGroup) {
      kept += 1;
      return segment;
    }
    const suggestion = byOrder.get(segment.order);
    if (suggestion) {
      applied += 1;
      return { ...segment, brollGroup: suggestion.group };
    }
    return segment;
  });
  return { segments: next, applied, kept };
}
