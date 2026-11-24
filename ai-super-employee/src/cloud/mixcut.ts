/**
 * 混剪工坊（域 05 短视频混剪）：素材组 → 分镜级混剪方案 → 可执行产物。
 *
 * 交付三层：
 *   1. 混剪方案：镜头序列（取自哪个素材组 / 转场 / 字幕 / 时长）+ 配音多版本 + BGM 建议
 *   2. 可直接用的字幕 .srt（时间轴按方案时长生成）
 *   3. 可执行的 ffmpeg 脚本（.sh / .bat）——本机装了 ffmpeg 就能出片；
 *      没装也先把「方案 + 字幕 + 脚本」交给剪映/PR，人工完成最后一步
 *
 * LLM 不可用时降级为模板方案（demo 标记），保证永远有交付物。
 */

import { askLLM } from "./runner";
import type { MediaAsset, MediaGroup } from "./media";

export interface MixScene {
  order: number;
  /** 素材组名（必须来自给定组，方案才能落地取材） */
  group: string;
  /** 镜头目的 */
  shot: string;
  /** 素材挑选提示（组内怎么挑画面） */
  visual: string;
  transition: string;
  subtitle: string;
  /** 秒 */
  duration: number;
}

export interface MixPlan {
  title: string;
  totalDuration: number;
  scenes: MixScene[];
  /** 配音文案多版本：同一事实、不同表达，适合矩阵分发防重复 */
  voiceVersions: string[];
  bgm: string;
  notes: string[];
  /** true = LLM 不可用时的模板降级产出 */
  demo: boolean;
}

const PLAN_SYSTEM = [
  "你是短视频混剪编导。根据主题与可用素材组，产出能直接开剪的分镜方案。",
  "纪律：",
  "1. scene.group 只能从给定素材组里选；组内没有对应画面就换组，禁止发明新组。",
  "2. 每个镜头给「镜头目的 / 素材挑选提示 / 转场 / 字幕 / 时长」，字幕 ≤16 字。",
  "3. 各镜头时长之和 ≈ 目标总时长（误差 ±10%），第 1 镜必须是 3 秒内的钩子。",
  "4. voiceVersions 给「版本数」条配音文案：事实一致、表达各异（口播感/场景感/提问式），禁止编造价格与承诺。",
  "只输出 JSON：",
  '{"title":"","scenes":[{"group":"","shot":"","visual":"","transition":"硬切|叠化|推近|甩镜","subtitle":"","duration":3}],"voiceVersions":[""],"bgm":"","notes":[""]}',
].join("\n");

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** 模板降级：模型不可用时也给出结构完整的方案骨架。 */
function fallbackPlan(input: {
  topic: string;
  duration: number;
  groupNames: string[];
  versions: number;
}): MixPlan {
  const names = input.groupNames.length ? input.groupNames : ["开场", "主体", "收尾"];
  const sceneCount = clamp(Math.round(input.duration / 3), 3, 8);
  const per = round1(input.duration / sceneCount);
  const transitions = ["硬切", "叠化", "推近", "甩镜", "硬切"];
  const scenes: MixScene[] = Array.from({ length: sceneCount }, (_, index) => {
    const group = names[index % names.length];
    const isFirst = index === 0;
    const isLast = index === sceneCount - 1;
    return {
      order: index + 1,
      group,
      shot: isFirst ? "开场钩子" : isLast ? "行动收口" : "主体展示",
      visual: isFirst ? `3 秒内出主体：${input.topic.slice(0, 24)}` : isLast ? "品牌露出 + 行动引导" : `围绕主题的${group}画面`,
      transition: transitions[index % transitions.length],
      subtitle: isFirst ? input.topic.slice(0, 16) : isLast ? "关注看后续" : "",
      duration: per,
    };
  });

  const voiceVersions = Array.from({ length: input.versions }, (_, index) => {
    const styles = [
      `【口播版】${input.topic}——先把最抓人的一点讲清楚，30 秒带你看完。`,
      `【场景版】如果你也在关注${input.topic}，这条视频的画面就是答案。`,
      `【提问版】关于${input.topic}，你最想知道哪一点？评论区告诉我，下一条就拍它。`,
    ];
    return styles[index % styles.length];
  });

  return {
    title: `${input.topic.slice(0, 18)} · 混剪方案`,
    totalDuration: input.duration,
    scenes,
    voiceVersions,
    bgm: "节奏轻快的无版权 BGM，副歌对齐产品展示段（-15dB 避让口播）",
    notes: ["模板方案（模型不可用时的降级产出）：接入模型通道后重新生成可获得更贴合素材的取景提示"],
    demo: true,
  };
}

export async function generateMixPlan(input: {
  topic: string;
  style: string;
  duration: number;
  versions: number;
  groups: { name: string; count: number; hints: string[] }[];
  script?: string;
  signal?: AbortSignal;
}): Promise<MixPlan> {
  const topic = input.topic.trim();
  if (!topic) throw new Error("先填写混剪主题或配音脚本");
  if (!input.groups.length) throw new Error("先到素材库上传并归类素材（或至少建一个组）");

  try {
    const { text } = await askLLM(
      [
        { role: "system", content: PLAN_SYSTEM },
        {
          role: "user",
          content: [
            `主题：${topic}`,
            `风格：${input.style}`,
            `目标总时长：${input.duration} 秒`,
            `配音版本数：${input.versions}`,
            "",
            "可用素材组（group 只能用这些名字）：",
            ...input.groups.map((item) => `- ${item.name}（${item.count} 个素材）${item.hints.length ? `，现有镜头：${item.hints.slice(0, 5).join("、")}` : ""}`),
            input.script ? `\n=== 原始配音文案（改写成多版本，事实不得改动）===\n${input.script.slice(0, 2000)}` : "",
          ].join("\n"),
        },
      ],
      { json: true, signal: input.signal },
    );

    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start !== -1 && end > start) {
      const parsed = JSON.parse(text.slice(start, end + 1)) as Partial<MixPlan>;
      const groupNames = new Set(input.groups.map((item) => item.name));
      const scenes = (parsed.scenes ?? [])
        .filter((item) => item && item.group)
        .map((item, index) => ({
          order: index + 1,
          group: String(item.group),
          shot: String(item.shot ?? "").slice(0, 30),
          visual: String(item.visual ?? "").slice(0, 120),
          transition: String(item.transition ?? "硬切").slice(0, 12),
          subtitle: String(item.subtitle ?? "").slice(0, 20),
          duration: clamp(Number(item.duration) || 3, 1, 20),
        }))
        // 组名不合法的镜头丢弃——取不到材的镜头进了方案就是空镜头
        .filter((item) => groupNames.has(item.group))
        .map((item, index) => ({ ...item, order: index + 1 }));

      if (scenes.length >= 2) {
        const total = round1(scenes.reduce((sum, item) => sum + item.duration, 0));
        const voiceVersions = (parsed.voiceVersions ?? [])
          .map((item) => String(item).slice(0, 300))
          .filter(Boolean)
          .slice(0, Math.max(1, input.versions));
        return {
          title: String(parsed.title ?? `${topic.slice(0, 18)} · 混剪方案`).slice(0, 40),
          totalDuration: total,
          scenes,
          voiceVersions: voiceVersions.length ? voiceVersions : fallbackPlan({ ...input, groupNames: input.groups.map((g) => g.name) }).voiceVersions,
          bgm: String(parsed.bgm ?? "").slice(0, 160),
          notes: (parsed.notes ?? []).slice(0, 6).map((item) => String(item).slice(0, 140)),
          demo: false,
        };
      }
    }
  } catch {
    // 配额 / 网络问题：降级模板，不让混剪整体失败
  }
  return fallbackPlan({ topic, duration: input.duration, groupNames: input.groups.map((item) => item.name), versions: input.versions });
}

/* ------------------------------------------------------------------ */
/* 可执行产物：SRT 字幕 + ffmpeg 脚本                                    */
/* ------------------------------------------------------------------ */

function tsToSrt(seconds: number): string {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const rest = ms % 1000;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(rest).padStart(3, "0")}`;
}

/** 按方案时长生成 SRT（有字幕的镜头才进时间轴）。 */
export function buildSrt(scenes: MixScene[]): string {
  const blocks: string[] = [];
  let cursor = 0;
  let index = 1;
  for (const scene of scenes) {
    const start = cursor;
    const end = cursor + scene.duration;
    cursor = end;
    if (!scene.subtitle) continue;
    blocks.push(`${index}\n${tsToSrt(start)} --> ${tsToSrt(end)}\n${scene.subtitle}\n`);
    index += 1;
  }
  return blocks.join("\n");
}

export interface RecipeResult {
  script: string;
  usedAssets: MediaAsset[];
  /** 组内无素材而被跳过的镜头数 */
  skipped: number;
  /** trim = 精确裁剪；concat = 时长未知时的粗拼 */
  mode: "trim" | "concat";
}

/**
 * 生成 ffmpeg 脚本。
 * - 组内素材齐全且时长已知：filter_complex 逐镜 trim + concat（精确到方案时长）
 * - 否则降级 concat demuxer 粗拼（同编码参数才能 -c copy，脚本里写明）
 * 每个镜头按组内顺序轮取素材，跳过无素材的镜头。
 */
export function buildFfmpegRecipe(
  scenes: MixScene[],
  groups: MediaGroup[],
  options: { shell: "sh" | "bat" } = { shell: "sh" },
): RecipeResult {
  const pool = new Map<string, MediaAsset[]>();
  groups.forEach((group) => pool.set(group.name, group.assets.filter((item) => item.kind === "video")));

  const cursors = new Map<string, number>();
  const picks: { scene: MixScene; asset?: MediaAsset }[] = [];
  let skipped = 0;

  for (const scene of scenes) {
    const list = pool.get(scene.group) ?? [];
    const cursor = cursors.get(scene.group) ?? 0;
    if (!list.length) {
      skipped += 1;
      picks.push({ scene });
      continue;
    }
    const asset = list[cursor % list.length];
    cursors.set(scene.group, cursor + 1);
    picks.push({ scene, asset });
  }

  const resolved = picks.filter((item) => item.asset) as { scene: MixScene; asset: MediaAsset }[];
  const usable = resolved.filter((item) => item.asset.duration && (item.asset.duration as number) > 0);
  const mode: RecipeResult["mode"] = usable.length === resolved.length && resolved.length > 0 ? "trim" : "concat";
  const usedAssets = (mode === "trim" ? usable : resolved).map((item) => item.asset);

  const isBat = options.shell === "bat";
  const cont = isBat ? " ^" : " \\";
  const lines: string[] = [];

  if (isBat) {
    lines.push("@echo off");
    lines.push("rem 由「混剪工坊」生成 · 需要本机安装 ffmpeg（winget install ffmpeg）");
    lines.push("setlocal");
  } else {
    lines.push("#!/usr/bin/env bash");
    lines.push("# 由「混剪工坊」生成 · 需要本机安装 ffmpeg（macOS: brew install ffmpeg / Windows: winget install ffmpeg）");
    lines.push("set -euo pipefail");
  }

  if (mode === "trim" && usable.length) {
    lines.push(isBat ? "rem 精确裁剪模式：按方案时长逐镜裁切后拼接" : "# 精确裁剪模式：按方案时长逐镜裁切后拼接");
    lines.push(isBat ? "rem 请把本脚本放到素材所在目录运行" : "# 请把本脚本放到素材所在目录运行");
    usable.forEach((item, index) => {
      lines.push(`${isBat ? "rem" : "#"} 镜头${index + 1} ← ${item.asset.group}/${item.asset.name}`);
    });
    lines.push(`ffmpeg -y${cont}`);
    usable.forEach((item, index) => {
      const input = item.asset.name.replace(/"/g, "");
      lines.push(`  -i "${input}"${index === usable.length - 1 ? "" : cont}`);
    });

    const filterParts: string[] = [];
    usable.forEach((item, index) => {
      const cap = Math.min(item.scene.duration, item.asset.duration as number);
      filterParts.push(`[${index}:v]trim=0:${cap.toFixed(2)},setpts=PTS-STARTPTS[v${index}]`);
    });
    filterParts.push(`${usable.map((_, index) => `[v${index}]`).join("")}concat=n=${usable.length}:v=1:a=0[outv]`);
    // 单行 filter_complex：分号分隔即可，反斜杠转义在 shell 双引号里反而会被当成字面量
    lines.push(`  -filter_complex "${filterParts.join(";")}"${cont}`);
    lines.push(`  -map "[outv]" -c:v libx264 -pix_fmt yuv420p -movflags +faststart "混剪成片.mp4"`);
    lines.push("");
    lines.push(isBat ? "rem 需要原声/BGM：另加 -i bgm.mp3 与 amix 混流；字幕：-vf subtitles=方案.srt" : "# 需要原声/BGM：另加 -i bgm.mp3 与 amix 混流；字幕：-vf subtitles=方案.srt");
  } else if (resolved.length) {
    lines.push(isBat ? "rem 降级粗拼：部分素材时长未知，使用 concat（要求编码参数一致）" : "# 降级粗拼：部分素材时长未知，使用 concat（要求编码参数一致）");
    const listFile = isBat ? "concat-list.txt" : "concat-list.txt";
    lines.push(isBat ? `type nul > ${listFile}` : `: > ${listFile}`);
    lines.push(isBat ? "rem 请把本脚本放到素材所在目录运行" : "# 请把本脚本放到素材所在目录运行");
    resolved.forEach((item) => {
      const file = item.asset.name.replace(/"/g, "");
      lines.push(isBat ? `echo file "${file}" >> ${listFile}` : `echo 'file "${file}"' >> ${listFile}`);
    });
    lines.push(`ffmpeg -y -f concat -safe 0 -i ${listFile} -c copy "混剪成片.mp4"`);
  } else {
    lines.push(isBat ? "rem 没有可用视频素材：请先在素材库上传视频并归组" : "# 没有可用视频素材：请先在素材库上传视频并归组");
  }

  if (isBat) lines.push("endlocal");
  return { script: lines.join("\n"), usedAssets, skipped, mode };
}

/** 混剪方案导出 Markdown。 */
export function planMarkdown(plan: MixPlan, input?: { topic?: string; style?: string }): string {
  const lines: string[] = [`# ${plan.title}`, ""];
  lines.push(`生成时间：${new Date().toLocaleString("zh-CN", { hour12: false })}`);
  if (input?.topic) lines.push(`主题：${input.topic}`);
  if (input?.style) lines.push(`风格：${input.style}`);
  lines.push(`目标时长：${plan.totalDuration} 秒`, plan.demo ? "> 模板降级产出（模型不可用），接入模型通道后可重新生成" : "", "");

  lines.push("## 分镜序列", "");
  lines.push("| # | 素材组 | 镜头 | 素材挑选 | 转场 | 字幕 | 时长 |");
  lines.push("|---|---|---|---|---|---|---|");
  plan.scenes.forEach((scene) =>
    lines.push(`| ${scene.order} | ${scene.group} | ${scene.shot} | ${scene.visual} | ${scene.transition} | ${scene.subtitle || "—"} | ${scene.duration}s |`),
  );
  lines.push("");

  lines.push("## 配音多版本（事实一致、表达各异）", "");
  plan.voiceVersions.forEach((item, index) => lines.push(`${index + 1}. ${item}`, ""));
  if (plan.bgm) lines.push("## BGM", "", plan.bgm, "");
  if (plan.notes.length) lines.push("## 注意", "", ...plan.notes.map((item) => `- ${item}`), "");
  lines.push("## 字幕时间轴", "", "见同名 .srt 文件；ffmpeg 脚本已生成（本机有 ffmpeg 可直接出片）。", "");
  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/* 方案留档：流水线或手动产出的方案落本机，供工坊回看（不入库不上传）        */
/* ------------------------------------------------------------------ */

export interface StoredMixPlan {
  savedAt: number;
  topic: string;
  style: string;
  plan: MixPlan;
}

const PLAN_KEY = "ai-employee:mixcut-plans";

export function loadSavedPlans(): StoredMixPlan[] {
  try {
    const raw = window.localStorage.getItem(PLAN_KEY);
    const rows = raw ? (JSON.parse(raw) as StoredMixPlan[]) : [];
    return Array.isArray(rows) ? rows.filter((row) => row && row.plan && Array.isArray(row.plan.scenes)) : [];
  } catch {
    return [];
  }
}

/** 留档一份方案（最新在前，最多 20 份）。 */
export function savePlan(input: { topic: string; style: string; plan: MixPlan }): StoredMixPlan {
  const row: StoredMixPlan = { savedAt: Date.now(), topic: input.topic, style: input.style, plan: input.plan };
  const rows = [row, ...loadSavedPlans()].slice(0, 20);
  window.localStorage.setItem(PLAN_KEY, JSON.stringify(rows));
  return row;
}

export function removeSavedPlan(savedAt: number): void {
  const rows = loadSavedPlans().filter((row) => row.savedAt !== savedAt);
  window.localStorage.setItem(PLAN_KEY, JSON.stringify(rows));
}
