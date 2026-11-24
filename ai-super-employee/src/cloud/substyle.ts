/**
 * 字幕样式模板（ASS V4+，竞品差距 11.2#9「提示词生成标题显示样式」）。
 * - 预设：经典/高亮/顶部标题卡/底部字幕条/品牌紫，五套完整 ASS Style 参数；
 * - 提示词：启发式解析（大/小、红/紫/黄、上/下、条/框、粗、描边…），零依赖确定性出样式；
 * - buildAss：与 buildSrt 同一时序（跳过无字幕段），输出可直接被 ffmpeg `ass=` 消费的文件。
 * 播放分辨率为 1080×1920（与混剪/数字人配方一致）。
 */

export interface SubStyle {
  id: string;
  label: string;
  desc: string;
  fontname: string;
  fontsize: number;
  /** &HBBGGRR（或 &HAABBGGRR） */
  primaryColour: string;
  outlineColour: string;
  backColour: string;
  /** -1 = 粗体 */
  bold: number;
  /** 1 = 描边+阴影；3 = 不透明底框（用 backColour） */
  borderStyle: number;
  outline: number;
  shadow: number;
  /** ASS 对齐：1=顶部居中，2=底部居中，5=顶部中间(带边距) */
  alignment: number;
  marginV: number;
}

const WHITE = "&H00FFFFFF";
const BLACK = "&H00000000";
const HALF_BLACK = "&H90000000";
/** 品牌紫 (124,77,255) → &HBBGGRR */
const PURPLE = "&HFF4D7C";
const YELLOW = "&H0000FFFF";
const RED = "&H000000FF";

export const SUB_STYLES: SubStyle[] = [
  {
    id: "plain",
    label: "经典字幕",
    desc: "底部居中白字黑边（默认，走 sub.srt 路径）",
    fontname: "Microsoft YaHei",
    fontsize: 18,
    primaryColour: WHITE,
    outlineColour: BLACK,
    backColour: HALF_BLACK,
    bold: 0,
    borderStyle: 1,
    outline: 2,
    shadow: 1,
    alignment: 2,
    marginV: 60,
  },
  {
    id: "pop",
    label: "高亮强调",
    desc: "黄字紫边加粗，重点句跳出来",
    fontname: "Microsoft YaHei",
    fontsize: 20,
    primaryColour: YELLOW,
    outlineColour: PURPLE,
    backColour: HALF_BLACK,
    bold: -1,
    borderStyle: 1,
    outline: 3,
    shadow: 1,
    alignment: 2,
    marginV: 60,
  },
  {
    id: "title",
    label: "顶部标题卡",
    desc: "顶部居中大字 + 半透明底框",
    fontname: "Microsoft YaHei",
    fontsize: 26,
    primaryColour: WHITE,
    outlineColour: BLACK,
    backColour: HALF_BLACK,
    bold: -1,
    borderStyle: 3,
    outline: 4,
    shadow: 0,
    alignment: 1,
    marginV: 140,
  },
  {
    id: "bar",
    label: "底部字幕条",
    desc: "底部白字 + 深色底条",
    fontname: "Microsoft YaHei",
    fontsize: 18,
    primaryColour: WHITE,
    outlineColour: BLACK,
    backColour: "&HA0000000",
    bold: 0,
    borderStyle: 3,
    outline: 4,
    shadow: 0,
    alignment: 2,
    marginV: 40,
  },
  {
    id: "brand",
    label: "品牌紫描边",
    desc: "白字 + 紫色粗描边（与控制台主色一致）",
    fontname: "Microsoft YaHei",
    fontsize: 20,
    primaryColour: WHITE,
    outlineColour: PURPLE,
    backColour: HALF_BLACK,
    bold: -1,
    borderStyle: 1,
    outline: 3,
    shadow: 1,
    alignment: 2,
    marginV: 60,
  },
];

export function findSubStyle(id: string): SubStyle {
  return SUB_STYLES.find((item) => item.id === id) ?? SUB_STYLES[0];
}

/* ------------------------------------------------------------------ */
/* 提示词启发式 → 样式                                                   */
/* ------------------------------------------------------------------ */

/** 按中文关键词把自由提示词映射成样式（确定性、零依赖；不满意可继续补词表）。 */
export function styleFromPrompt(prompt: string): SubStyle {
  const text = prompt.trim();
  const base: SubStyle = {
    ...SUB_STYLES[0],
    id: "custom",
    label: (text.slice(0, 12) || "自定义样式"),
    desc: `由提示词生成：${text.slice(0, 40)}`,
  };

  // 位置
  if (/顶|上|上方|标题/.test(text)) {
    base.alignment = 1;
    base.marginV = 140;
  } else if (/底|下|下方|字幕条/.test(text)) {
    base.alignment = 2;
    base.marginV = 40;
  }
  // 底框
  if (/条|框|底板|色块|背景/.test(text)) {
    base.borderStyle = 3;
    base.outline = 4;
    base.shadow = 0;
  }
  // 字号
  if (/大字|大标题|超大|醒目|放大/.test(text)) base.fontsize = Math.round(base.fontsize * 1.4);
  if (/小字|迷你|缩小/.test(text)) base.fontsize = Math.max(12, Math.round(base.fontsize * 0.8));
  // 颜色（主色/描边）
  if (/红/.test(text)) base.primaryColour = RED;
  if (/黄/.test(text)) base.primaryColour = YELLOW;
  if (/紫/.test(text)) {
    base.outlineColour = PURPLE;
    if (!/白/.test(text) && !/红|黄/.test(text)) base.primaryColour = WHITE;
  }
  if (/黑字|黑色/.test(text)) base.primaryColour = BLACK;
  if (/白/.test(text)) base.primaryColour = WHITE;
  // 粗细与描边
  if (/粗|加粗|醒目|bold/i.test(text)) base.bold = -1;
  if (/描边|黑边|边框/.test(text)) base.outline = Math.max(base.outline, 3);
  if (/无边|去边|干净/.test(text)) {
    base.outline = 0;
    base.shadow = 0;
    base.borderStyle = 1;
  }

  return base;
}

/* ------------------------------------------------------------------ */
/* ASS 生成                                                             */
/* ------------------------------------------------------------------ */

function tsToAss(seconds: number): string {
  const cs = Math.max(0, Math.round(seconds * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const rest = cs % 100;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(rest).padStart(2, "0")}`;
}

/** 抬头文本：去大括号覆盖块、换行转 \N（ASS 语义）。 */
export function escapeAssText(text: string): string {
  return text
    .replace(/\r?\n/g, "\\N")
    .replace(/\{[^}]*\}/g, "") // 整块移除 ASS 覆盖码，避免残留 \b1 之类
    .trim();
}

const ASS_FORMAT =
  "Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding";

function styleLine(style: SubStyle): string {
  return [
    "Default",
    style.fontname,
    String(style.fontsize),
    style.primaryColour,
    WHITE,
    style.outlineColour,
    style.backColour,
    String(style.bold),
    "0",
    "0",
    "0",
    "100",
    "100",
    "0",
    "0",
    String(style.borderStyle),
    String(style.outline),
    String(style.shadow),
    String(style.alignment),
    "30",
    "30",
    String(style.marginV),
    "1",
  ].join(",");
}

/**
 * 生成 .ass 文件（时序与 buildSrt 一致：按序累计时长，无字幕段跳过但时间轴继续走）。
 * ffmpeg 用法：`-vf ass=sub.ass`（需 libass，官方完整包自带）。
 */
export function buildAss(
  scenes: { order: number; subtitle?: string; duration: number }[],
  style: SubStyle,
): string {
  const events: string[] = [];
  let cursor = 0;
  for (const scene of scenes) {
    const start = cursor;
    const end = cursor + scene.duration;
    cursor = end;
    if (!scene.subtitle) continue;
    events.push(`Dialogue: 0,${tsToAss(start)},${tsToAss(end)},Default,,0,0,0,,${escapeAssText(scene.subtitle)}`);
  }

  return [
    "[Script Info]",
    "; 由 AI-SUPER-WORKER 数字人工坊/混剪工坊生成",
    "ScriptType: v4.00+",
    "PlayResX: 1080",
    "PlayResY: 1920",
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    `Format: ${ASS_FORMAT}`,
    `Style: ${styleLine(style)}`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...events,
    "",
  ].join("\n");
}
