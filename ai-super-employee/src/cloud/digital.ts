/**
 * 数字人/爆款复刻 · L1 文案工坊 + L2 口播方案与本机合成脚本（前置设计 §3-§4）。
 *
 * - L1：文案三来源（行业模板 / 爆款改写 / IP大脑）批量口播稿，LLM 降级演示稿；
 * - L2：DigitalPlan（口播段↔副画面组绑定）→ Markdown / SRT / ffmpeg 脚本，
 *       沙箱无 ffmpeg，转码一律留本机（与混剪工坊同边界）；
 * - L3 TTS（火山/豆包，已定）与 L4 数字人 API（generic 形状，已定）为适配器后置，
 *   本模块不引用其端点，只保证方案与脚本结构可直接对接。
 *
 * 合规红线：形象素材需授权确认（media.canSetRole）；音色只用平台官方音色；
 * 改写只复用结构不照搬原句；事实一致禁编价格/承诺。
 */
import type { MediaAsset, MediaRole } from "./media";
import { groupMedia, listByRole } from "./media";
import { askLLM } from "./runner";

/* ------------------------------------------------------------------ */
/* L1：文案三来源                                                      */
/* ------------------------------------------------------------------ */

export type CopySource = "industry" | "rewrite" | "ipbrain";

export const COPY_SOURCES: { value: CopySource; label: string; hint: string; fieldLabel: string; placeholder: string }[] = [
  {
    value: "industry",
    label: "行业模板",
    hint: "选行业与定位，AI 按该行业营销逻辑批量生成原创口播稿",
    fieldLabel: "补充定位（可选）",
    placeholder: "例：社区老店，主打现做现卖",
  },
  {
    value: "rewrite",
    label: "爆款改写",
    hint: "粘贴爆款文案，AI 拆结构后换题材重写——结构可复用、内容全新，不照搬原句",
    fieldLabel: "粘贴爆款文案",
    placeholder: "把看到的口播原文整段粘进来",
  },
  {
    value: "ipbrain",
    label: "IP大脑",
    hint: "粘贴账号简介与作品标题，AI 分析风格后批量出适配选题口播稿（链接抓取需自建代理，后置）",
    fieldLabel: "账号简介 + 作品标题（一行一个）",
    placeholder: "简介：…\n作品：《…》《…》《…》",
  },
];

const COPY_SYSTEM = [
  "你是短视频口播文案专家。按要求生成口播稿，只输出 JSON：{\"drafts\":[\"稿件1\",\"稿件2\"]}",
  "每条 60-120 字（约 30 秒口播）：钩子（前 15 字）→ 痛点/场景 → 一个证据或事实 → 行动指令。",
  "一句不超过 20 字，说人话；禁止编造销量、价格、疗效、用户评价；缺的信息写「待补充」。",
  "若来源是既有文案：只复用结构，不照搬原句，换题材重写，必须加入原稿没有的新元素。",
].join("\n");

function parseDrafts(raw: string, count: number): string[] {
  const trimmed = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        parsed = JSON.parse(match[0]);
      } catch {
        parsed = null;
      }
    }
  }
  const drafts = Array.isArray((parsed as { drafts?: unknown })?.drafts)
    ? ((parsed as { drafts: unknown[] }).drafts ?? [])
    : [];
  return drafts
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length >= 20)
    .slice(0, count)
    .map((item) => item.slice(0, 300));
}

export function fallbackDrafts(topic: string, count: number): string[] {
  const subject = topic.trim() || "这件事";
  const templates = [
    `还在为${subject}发愁？很多人第一步就走错了。今天三句话讲清楚：先看人群，再定卖点，最后算清账。想聊细节的评论区扣「1」。`,
    `你可能不知道，${subject}最容易踩的坑是照搬别人的打法。店不同、人群不同，结果完全不同。先把三个事实理清楚再动手，需要清单的私信我。`,
    `${subject}怎么做才不踩坑？记住三步：先小范围试、再看复购、最后才扩规模。数字说话，不凭感觉。要试跑清单的回复「清单」。`,
    `说个实话，${subject}没捷径，但有顺序。顺序对了省一半钱：先验证需求，再补交付，最后放量。顺序反了，投多少亏多少。`,
    `一条视频讲清${subject}：钩子别讲产品，讲后果；中段给一个可验证的事实；结尾只留一个动作。做到这三点，完播率不会差。`,
  ];
  return templates.slice(0, Math.max(1, Math.min(count, templates.length)));
}

/** 批量口播稿（L1）。LLM 失败降级演示稿并标注 demo。 */
export async function generateCopyDrafts(input: {
  source: CopySource;
  industry: string;
  topic: string;
  raw: string;
  count: number;
}): Promise<{ drafts: string[]; demo: boolean }> {
  const topic = input.topic.trim();
  const raw = input.raw.trim();
  if (input.source === "rewrite" && !raw) throw new Error("先粘贴要改写的爆款文案");
  if (input.source === "ipbrain" && !raw) throw new Error("先粘贴账号简介与作品标题");
  if (input.source === "industry" && !topic && !input.industry) throw new Error("先选择行业或填写主题");

  const count = Math.max(1, Math.min(8, input.count || 3));
  const sourceLabel = COPY_SOURCES.find((item) => item.value === input.source)?.label ?? "行业模板";
  try {
    const { text } = await askLLM(
      [
        { role: "system", content: COPY_SYSTEM },
        {
          role: "user",
          content: [
            `来源：${sourceLabel}`,
            `行业：${input.industry || "通用"}`,
            `主题/产品：${topic || "（按来源材料判断）"}`,
            `数量：${count} 条，互相之间角度不同`,
            input.source === "rewrite" ? `=== 爆款原文（只拆结构，禁止照搬）===\n${raw.slice(0, 4000)}` : "",
            input.source === "ipbrain" ? `=== 账号材料（分析风格后出稿）===\n${raw.slice(0, 4000)}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
        },
      ],
      { json: true },
    );
    const drafts = parseDrafts(text, count);
    if (!drafts.length) throw new Error("模型未返回有效稿件");
    return { drafts, demo: false };
  } catch {
    return { drafts: fallbackDrafts(topic || raw.slice(0, 12), Math.min(count, 3)), demo: true };
  }
}

/* ------------------------------------------------------------------ */
/* L1 留档                                                             */
/* ------------------------------------------------------------------ */

export interface CopyDraftSet {
  savedAt: number;
  source: CopySource;
  industry: string;
  topic: string;
  drafts: string[];
  demo: boolean;
}

const COPY_KEY = "ai-employee:copy-drafts";
const MAX_COPY_SETS = 20;

export function loadCopyDrafts(): CopyDraftSet[] {
  try {
    const raw = window.localStorage.getItem(COPY_KEY);
    const rows = raw ? (JSON.parse(raw) as CopyDraftSet[]) : [];
    if (!Array.isArray(rows)) return [];
    return rows.filter((row) => row && Array.isArray(row.drafts)).slice(0, MAX_COPY_SETS);
  } catch {
    return [];
  }
}

export function saveCopyDrafts(row: CopyDraftSet): CopyDraftSet[] {
  const rows = [row, ...loadCopyDrafts()].slice(0, MAX_COPY_SETS);
  window.localStorage.setItem(COPY_KEY, JSON.stringify(rows));
  return rows;
}

export function removeCopyDraftSet(savedAt: number): CopyDraftSet[] {
  const rows = loadCopyDrafts().filter((row) => row.savedAt !== savedAt);
  window.localStorage.setItem(COPY_KEY, JSON.stringify(rows));
  return rows;
}

/* ------------------------------------------------------------------ */
/* L2：口播方案 DigitalPlan                                             */
/* ------------------------------------------------------------------ */

export interface DigitalSegment {
  order: number;
  script: string;
  duration: number;
  /** 绑定的副画面素材组（竞品"讲到即弹出"）；只能来自给定组名 */
  brollGroup?: string;
  subtitle: string;
}

/** 启发式长文降维（无模型通道）：按句切分→按字数均衡装进 3~6 段→时长归一。 */
export function heuristicPlanFromArticle(article: string, targetDuration: number, allowedGroups: string[]): DigitalPlan {
  const sentences = article
    .split(/[。！？；\n]+/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 6);
  const segCount = Math.min(6, Math.max(3, Math.round(article.length / 150)));

  // 按字数贪心装袋：目标每袋字数 = 总字数 / 段数
  const bags: string[][] = Array.from({ length: Math.min(segCount, Math.max(1, sentences.length)) }, () => []);
  for (const sentence of sentences) {
    const bag = bags.reduce((best, current) =>
      current.reduce((sum, s) => sum + s.length, 0) < best.reduce((sum, s) => sum + s.length, 0) ? current : best,
    bags[0]);
    bag.push(sentence);
  }
  const segments = bags
    .filter((bag) => bag.length > 0)
    .map((bag) => {
      const script = bag.join("。").slice(0, 100);
      return { script, duration: 0, subtitle: script.slice(0, 14) };
    });

  if (segments.length === 0) return fallbackDigitalPlan("长文降维", targetDuration);
  return {
    title: article.trim().slice(0, 24) || "长文口播",
    segments: normalizeSegments(segments, targetDuration, allowedGroups),
    totalDuration: targetDuration,
    voiceVersions: ["原声中速", "活力加速", "沉稳降速"],
    assetHints: ["按段落主题补分镜图", "结尾段配 CTA 字卡"],
    demo: true,
  };
}

/** 长文转口播方案：有模型通道走结构化提取，失败降级启发式切分（demo 标注）。 */
export async function planFromArticle(input: {
  article: string;
  duration: number;
  brollGroups: string[];
  industry: string;
}): Promise<DigitalPlan> {
  const article = input.article.trim();
  const targetDuration = Math.min(300, Math.max(10, input.duration));
  const fallback = () => heuristicPlanFromArticle(article, targetDuration, input.brollGroups);
  if (!article || article.length < 40) {
    return { ...fallbackDigitalPlan("长文太短，先贴 40 字以上正文", targetDuration) };
  }
  try {
    const { text } = await askLLM(
      [
        {
          role: "system",
          content: [
            "把长文降维成口播分镜，只输出 JSON：",
            '{"title":"不超过25字","segments":[{"script":"口播台词≤80字","duration":秒数,"subtitle":"≤14字","brollGroup":"可选，只能用给定组名"}],"voiceVersions":["风格一","风格二"],"assetHints":["素材建议"]}',
            `目标总时长 ${targetDuration} 秒，3~6 段，duration 合计等于目标；保留原文事实，禁止编造价格与承诺。`,
          ].join("\n"),
        },
        {
          role: "user",
          content: [
            `行业：${input.industry || "通用"}`,
            `可用副画面组：${input.brollGroups.join("、") || "（无，省略 brollGroup）"}`,
            `=== 原文 ===\n${article.slice(0, 6000)}`,
          ].join("\n"),
        },
      ],
      { json: true },
    );
    const parsed = JSON.parse(text.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim()) as {
      title?: unknown;
      segments?: unknown;
      voiceVersions?: unknown;
      assetHints?: unknown;
    };
    const segments = normalizeSegments(parsed.segments, targetDuration, input.brollGroups);
    if (segments.length < 2) return fallback();
    const voiceVersions = (Array.isArray(parsed.voiceVersions) ? parsed.voiceVersions : [])
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter(Boolean)
      .slice(0, 3);
    const assetHints = (Array.isArray(parsed.assetHints) ? parsed.assetHints : [])
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter(Boolean)
      .slice(0, 6);
    return {
      title: (typeof parsed.title === "string" && parsed.title.trim() ? parsed.title : article.slice(0, 24)).slice(0, 30),
      totalDuration: segments.reduce((total, segment) => total + segment.duration, 0),
      segments,
      voiceVersions: voiceVersions.length ? voiceVersions : ["原声中速"],
      assetHints: assetHints.length ? assetHints : ["按段落补图"],
      demo: false,
    };
  } catch {
    return fallback();
  }
}

export interface DigitalPlan {
  title: string;
  totalDuration: number;
  segments: DigitalSegment[];
  /** 同一事实的多版本口播全文（矩阵分发防重复） */
  voiceVersions: string[];
  assetHints: string[];
  demo: boolean;
}

const DIGITAL_PLAN_SYSTEM = [
  "你是数字人口播视频导演。把主题整理成口播分镜方案，只输出 JSON：",
  '{"title":"不超过25字","segments":[{"script":"该段口播台词30-60字","duration":秒数,"subtitle":"不超过16字的字幕","brollGroup":"可选，只能填给定组名"}],"voiceVersions":["版本一全文","版本二全文"],"assetHints":["建议补充的素材"]}',
  "要求：所有 duration 合计严格等于目标时长；首段前 15 字是钩子；每段一个信息点；",
  "brollGroup 只能来自给定列表，不需要就省略该字段；subtitle 是台词压缩，不逐字抄；",
  "voiceVersions 是同一事实的两种表达（2-3 版）；事实一致，禁编价格、承诺、销量。",
].join("\n");

/** 段落归一：组名非法即丢弃、时长按比例缩到目标总长（导出供测试）。 */
export function normalizeSegments(raw: unknown, targetDuration: number, allowedGroups: string[]): DigitalSegment[] {
  if (!Array.isArray(raw)) return [];
  const segments = raw
    .map((item, index) => {
      const row = item as { script?: unknown; duration?: unknown; subtitle?: unknown; brollGroup?: unknown };
      const script = typeof row.script === "string" ? row.script.trim().slice(0, 240) : "";
      const duration = Number(row.duration);
      const subtitle = typeof row.subtitle === "string" ? row.subtitle.trim().slice(0, 20) : "";
      const group = typeof row.brollGroup === "string" ? row.brollGroup.trim() : "";
      return {
        order: index + 1,
        script,
        duration: Number.isFinite(duration) ? Math.min(30, Math.max(2, Math.round(duration))) : 0,
        subtitle: subtitle || script.slice(0, 16),
        // 组名非法直接丢弃：取不到材的副画面不进方案（与混剪纪律一致）
        brollGroup: group && allowedGroups.includes(group) ? group : undefined,
      } satisfies DigitalSegment;
    })
    .filter((segment) => segment.script && segment.duration > 0);

  if (!segments.length) return [];
  // 时长归一：按比例缩放到目标总长，每段至少 2 秒，余数补给最后一段
  const sum = segments.reduce((total, segment) => total + segment.duration, 0);
  const scale = targetDuration / sum;
  let acc = 0;
  segments.forEach((segment, index) => {
    if (index === segments.length - 1) {
      segment.duration = Math.max(2, targetDuration - acc);
    } else {
      segment.duration = Math.max(2, Math.round(segment.duration * scale));
      acc += segment.duration;
    }
  });
  // 末段修正后仍可能溢出，从最长段往回扣
  let total = segments.reduce((value, segment) => value + segment.duration, 0);
  let guard = 0;
  while (total !== targetDuration && guard < 200) {
    guard += 1;
    const offender = segments.reduce((a, b) => (a.duration >= b.duration ? a : b));
    if (total > targetDuration && offender.duration > 2) {
      offender.duration -= 1;
      total -= 1;
    } else if (total < targetDuration) {
      offender.duration += 1;
      total += 1;
    } else break;
  }
  return segments.map((segment, index) => ({ ...segment, order: index + 1 }));
}

export function fallbackDigitalPlan(topic: string, duration: number): DigitalPlan {
  const subject = topic.trim() || "口播主题";
  const ratios = [0.16, 0.28, 0.3, 0.26];
  const templates = [
    { script: `你是不是也遇到过${subject}做起来没效果？问题多半出在第一步。`, subtitle: `${subject}的三个坑` },
    { script: `先说结论：${subject}要先验证需求，再补交付，最后才放量。顺序对了，省一半力气。`, subtitle: "先验证再放量" },
    { script: `具体怎么做？第一步小范围试跑，第二步盯住复购和反馈，第三步才加投入。每一步都有数字说话。`, subtitle: "三步走，数字说话" },
    { script: `需要完整清单的，评论区回复「清单」，我发你一份可直接用的模板。`, subtitle: "回复「清单」领取" },
  ];
  const total = Math.max(10, duration);
  let acc = 0;
  const segments = templates.map((item, index) => {
    const share = index === templates.length - 1 ? total - acc : Math.max(2, Math.round(total * ratios[index]));
    acc += share;
    return { order: index + 1, script: item.script, duration: share, subtitle: item.subtitle } satisfies DigitalSegment;
  });
  return {
    title: `${subject}口播方案`,
    totalDuration: total,
    segments,
    voiceVersions: [
      `${segments.map((segment) => segment.script).join(" ")}`,
      `${subject}这事，顺序比努力重要：先验证、再交付、后放量。想看清单的扣「1」。`,
    ],
    assetHints: ["建议标注 1 个形象素材（自录口播视频）", "建议补充 2-3 张分镜图绑定到关键段落"],
    demo: true,
  };
}

/** 生成口播方案（L2）。组名只允许来自给定列表；LLM 失败降级模板方案。 */
export async function generateDigitalPlan(input: {
  topic: string;
  industry: string;
  duration: number;
  brollGroups: string[];
  signal?: AbortSignal;
}): Promise<DigitalPlan> {
  const topic = input.topic.trim();
  if (!topic) throw new Error("先填写口播主题");
  const duration = Math.min(60, Math.max(15, Math.round(input.duration) || 30));
  try {
    const { text } = await askLLM(
      [
        { role: "system", content: DIGITAL_PLAN_SYSTEM },
        {
          role: "user",
          content: [
            `主题：${topic}`,
            `行业：${input.industry || "通用"}`,
            `目标时长：${duration} 秒`,
            `可用副画面素材组：${input.brollGroups.length ? input.brollGroups.join("、") : "（无，省略 brollGroup）"}`,
          ].join("\n"),
        },
      ],
      { json: true, signal: input.signal },
    );
    const parsed = JSON.parse(text.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim()) as {
      title?: unknown;
      segments?: unknown;
      voiceVersions?: unknown;
      assetHints?: unknown;
    };
    const segments = normalizeSegments(parsed.segments, duration, input.brollGroups);
    if (!segments.length) throw new Error("模型未返回有效分段");
    const voiceVersions = (Array.isArray(parsed.voiceVersions) ? parsed.voiceVersions : [])
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter(Boolean)
      .slice(0, 3);
    const assetHints = (Array.isArray(parsed.assetHints) ? parsed.assetHints : [])
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter(Boolean)
      .slice(0, 6);
    return {
      title: (typeof parsed.title === "string" && parsed.title.trim() ? parsed.title : topic).slice(0, 30),
      totalDuration: segments.reduce((total, segment) => total + segment.duration, 0),
      segments,
      voiceVersions: voiceVersions.length ? voiceVersions : [segments.map((segment) => segment.script).join(" ")],
      assetHints,
      demo: false,
    };
  } catch {
    return fallbackDigitalPlan(topic, duration);
  }
}

/* ------------------------------------------------------------------ */
/* L2 留档                                                             */
/* ------------------------------------------------------------------ */

export interface StoredDigitalPlan {
  savedAt: number;
  topic: string;
  industry: string;
  plan: DigitalPlan;
}

const PLAN_KEY = "ai-employee:digital-plans";
const MAX_PLANS = 20;

export function loadSavedDigitalPlans(): StoredDigitalPlan[] {
  try {
    const raw = window.localStorage.getItem(PLAN_KEY);
    const rows = raw ? (JSON.parse(raw) as StoredDigitalPlan[]) : [];
    if (!Array.isArray(rows)) return [];
    return rows.filter((row) => row && row.plan && Array.isArray(row.plan.segments)).slice(0, MAX_PLANS);
  } catch {
    return [];
  }
}

export function saveDigitalPlan(row: { topic: string; industry: string; plan: DigitalPlan }): StoredDigitalPlan {
  const stored: StoredDigitalPlan = { savedAt: Date.now(), topic: row.topic, industry: row.industry, plan: row.plan };
  const rows = [stored, ...loadSavedDigitalPlans()].slice(0, MAX_PLANS);
  window.localStorage.setItem(PLAN_KEY, JSON.stringify(rows));
  return stored;
}

export function removeSavedDigitalPlan(savedAt: number): StoredDigitalPlan[] {
  const rows = loadSavedDigitalPlans().filter((row) => row.savedAt !== savedAt);
  window.localStorage.setItem(PLAN_KEY, JSON.stringify(rows));
  return rows;
}

/* ------------------------------------------------------------------ */
/* L2 导出：Markdown                                                   */
/* ------------------------------------------------------------------ */

export function digitalPlanMarkdown(plan: DigitalPlan, input?: { topic?: string; industry?: string }): string {
  const lines: string[] = [`# ${plan.title}`, ""];
  lines.push(`生成时间：${new Date().toLocaleString("zh-CN", { hour12: false })}`);
  if (input?.topic) lines.push(`主题：${input.topic}`);
  if (input?.industry) lines.push(`行业：${input.industry}`);
  lines.push(`目标时长：${plan.totalDuration} 秒`);
  if (plan.demo) lines.push("> 模板降级产出（模型不可用），接入模型通道后可重新生成");
  lines.push("", "## 分镜（口播段 ↔ 副画面）", "", "| # | 时长 | 口播台词 | 字幕 | 副画面组 |", "|---|---|---|---|---|");
  plan.segments.forEach((segment) => {
    lines.push(
      `| ${segment.order} | ${segment.duration}s | ${segment.script.replace(/\|/g, "｜")} | ${segment.subtitle.replace(/\|/g, "｜")} | ${segment.brollGroup ?? "—"} |`,
    );
  });
  if (plan.voiceVersions.length) {
    lines.push("", "## 配音多版本（事实一致、表达各异）", "");
    plan.voiceVersions.forEach((version, index) => lines.push(`### 版本 ${index + 1}`, "", version, ""));
  }
  if (plan.assetHints.length) {
    lines.push("## 素材提示", "");
    plan.assetHints.forEach((hint) => lines.push(`- ${hint}`));
    lines.push("");
  }
  lines.push("---", "", "*由 AI 超级员工生成 · 合成脚本见同目录 make-digital 脚本*");
  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/* L2 导出：ffmpeg 合成脚本                                            */
/* ------------------------------------------------------------------ */

export type DigitalRecipeMode = "avatar+audio" | "avatar" | "footage+audio" | "footage";

export interface DigitalRecipe {
  mode: DigitalRecipeMode;
  script: string;
  avatar?: string;
  audio?: string;
  /** 成功绑定的副画面覆盖层数 */
  overlays: number;
  /** 有绑定但组内无图片（或无组）的段数 */
  skipped: number;
}

const SRT_STYLE = "FontName=Microsoft YaHei,FontSize=18,PrimaryColour=&H00FFFFFF,OutlineColour=&H80000000,BorderStyle=1";

function pickRoleAsset(assets: MediaAsset[], role: MediaRole, kind: MediaAsset["kind"]): MediaAsset | null {
  return listByRole(assets, role).find((asset) => asset.kind === kind) ?? null;
}

/**
 * 生成本机合成脚本（L2）：
 * - 形象(role=avatar 视频) + 声音(role=voice 音频)：循环形象盖满配音，字幕烧录，副画面按段切入；
 * - 有形象无配音：形象循环到方案时长；
 * - 无形象：分镜视频 concat 粗拼（+可选配音），要求编码参数一致；
 * - 副画面只接受图片（视频 overlay 时长控制复杂，记入 skipped 并提示）。
 * 脚本与 sub.srt、素材放同一目录执行；沙箱不转码，出片在用户本机。
 */
export function buildDigitalRecipe(
  plan: DigitalPlan,
  assets: MediaAsset[],
  options: { shell: "sh" | "bat"; subFormat?: "srt" | "ass" } = { shell: "sh" },
): DigitalRecipe {
  const subFormat = options.subFormat ?? "srt";
  const avatar = pickRoleAsset(assets, "avatar", "video");
  const audio = pickRoleAsset(assets, "voice", "audio");
  const groups = groupMedia(assets);
  const footage = assets.filter((asset) => asset.kind === "video" && asset.id !== avatar?.id);

  if (!avatar && !footage.length) {
    throw new Error("缺少形象视频或分镜视频：先到素材库上传，并在「素材角色」标注形象");
  }

  // 副画面：段绑定 → 组内第一张图片；无图/视频记 skipped
  const overlays: { file: string; from: number; to: number }[] = [];
  let skipped = 0;
  let cursor = 0;
  for (const segment of plan.segments) {
    const from = cursor;
    cursor += segment.duration;
    if (!segment.brollGroup) continue;
    const group = groups.find((item) => item.name === segment.brollGroup);
    const image = group?.assets.find((asset) => asset.kind === "image") ?? null;
    if (!image) {
      skipped += 1;
      continue;
    }
    overlays.push({ file: image.name.replace(/"/g, ""), from, to: cursor });
  }

  const mode: DigitalRecipeMode = avatar
    ? audio
      ? "avatar+audio"
      : "avatar"
    : audio
      ? "footage+audio"
      : "footage";

  const isBat = options.shell === "bat";
  const cont = isBat ? " ^" : " \\";
  const lines: string[] = [];

  if (isBat) {
    lines.push("@echo off");
    lines.push("rem 由「数字人工坊」生成 · 需要本机安装 ffmpeg（winget install ffmpeg）");
    lines.push("setlocal");
    lines.push('cd /d "%~dp0"');
  } else {
    lines.push("#!/usr/bin/env bash");
    lines.push("# 由「数字人工坊」生成 · 需要本机安装 ffmpeg（macOS: brew install ffmpeg / Windows: winget install ffmpeg）");
    lines.push("set -euo pipefail");
    lines.push('cd "$(dirname "$0")"');
  }
  const subFile = subFormat === "ass" ? "sub.ass" : "sub.srt";
  lines.push(isBat ? `rem 请把本脚本、${subFile} 与素材放同一目录` : `# 请把本脚本、${subFile} 与素材放同一目录`);
  lines.push(
    isBat
      ? `rem 用法：先从「数字人工坊」导出字幕为 ${subFile}，再双击或 cmd 运行本脚本`
      : `# 用法：先从「数字人工坊」导出字幕为 ${subFile}，再执行 bash make-digital.sh`,
  );
  lines.push("");

  // 输入序号约定：0=主画面（形象或 concat 列表），配音（若有）=1，副画面图片从 next 开始
  const inputs: string[] = [];
  let nextIndex = 0;
  const mainIndex = nextIndex;
  nextIndex += 1;
  let audioIndex = -1;
  if (audio) {
    audioIndex = nextIndex;
    nextIndex += 1;
  }
  const overlayStartIndex = nextIndex;

  if (mode === "avatar" || mode === "avatar+audio") {
    const file = (avatar as MediaAsset).name.replace(/"/g, "");
    inputs.push(`-stream_loop -1 -i "${file}"`);
    lines.push(`${isBat ? "rem" : "#"} 主画面（形象）：${file} 循环${audio ? "，配音盖满" : `，时长 ${plan.totalDuration}s`}`);
  } else {
    // footage 模式：concat demuxer
    const listFile = "concat-list.txt";
    lines.push(isBat ? "rem 分镜粗拼模式（要求编码参数一致）" : "# 分镜粗拼模式（要求编码参数一致）");
    lines.push(isBat ? `type nul > ${listFile}` : `: > ${listFile}`);
    footage.forEach((asset) => {
      lines.push(isBat ? `echo file "${asset.name.replace(/"/g, "")}" >> ${listFile}` : `echo 'file "${asset.name.replace(/"/g, "")}"' >> ${listFile}`);
    });
    inputs.push(`-f concat -safe 0 -i ${listFile}`);
    lines.push(`${isBat ? "rem" : "#"} 主画面：${footage.length} 段分镜视频`);
  }
  if (audio) {
    inputs.push(`-i "${(audio as MediaAsset).name.replace(/"/g, "")}"`);
    lines.push(`${isBat ? "rem" : "#"} 配音：${(audio as MediaAsset).name}`);
  }
  overlays.forEach((overlay) => {
    inputs.push(`-loop 1 -i "${overlay.file}"`);
  });
  if (overlays.length) {
    lines.push(`${isBat ? "rem" : "#"} 副画面（按段切入）：${overlays.map((item) => `${item.from.toFixed(1)}s-${item.to.toFixed(1)}s ${item.file}`).join("；")}`);
  }
  if (skipped) {
    lines.push(isBat ? `rem 注意：${skipped} 个绑定段的素材组没有图片，已跳过副画面` : `# 注意：${skipped} 个绑定段的素材组没有图片，已跳过副画面`);
  }

  // filter 链：[主画面处理] → overlay* → subtitles → [vout]
  const parts: string[] = [];
  let cur: string;
  if (avatar) {
    parts.push(`[${mainIndex}:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920[bg]`);
    cur = "[bg]";
  } else {
    cur = `[${mainIndex}:v]`;
  }
  overlays.forEach((overlay, index) => {
    const out = `[o${index + 1}]`;
    parts.push(`${cur}[${overlayStartIndex + index}:v]overlay=enable='between(t,${overlay.from.toFixed(2)},${overlay.to.toFixed(2)})'${out}`);
    cur = out;
  });
  parts.push(
    subFormat === "ass"
      ? `${cur}ass=sub.ass[vout]`
      : `${cur}subtitles=sub.srt:force_style='${SRT_STYLE}'[vout]`,
  );

  lines.push(`ffmpeg -y${cont}`);
  // 每个输入行都必须续行：后面紧跟 -filter_complex，末项不加 cont 会把命令截断成两条
  inputs.forEach((input) => {
    lines.push(`  ${input}${cont}`);
  });
  lines.push(`  -filter_complex "${parts.join(";")}"${cont}`);
  if (audio) {
    lines.push(`  -map "[vout]" -map ${audioIndex}:a -c:a copy -shortest "digital-out.mp4"`);
  } else if (avatar) {
    lines.push(`  -map "[vout]" -t ${plan.totalDuration} -c:v libx264 -pix_fmt yuv420p -movflags +faststart "digital-out.mp4"`);
  } else {
    lines.push(`  -map "[vout]" -t ${plan.totalDuration} -c:v libx264 -pix_fmt yuv420p -movflags +faststart "digital-out.mp4"`);
  }
  lines.push("");
  lines.push(
    isBat
      ? subFormat === "ass"
        ? "rem 输出：digital-out.mp4；样式在 sub.ass（样式模板导出），字体/字号改 sub.ass 的 Style 行"
        : "rem 输出：digital-out.mp4；如缺字幕样式字体，改 sub.srt 同名字体名"
      : subFormat === "ass"
        ? "# 输出：digital-out.mp4；样式在 sub.ass（样式模板导出），字体/字号改 sub.ass 的 Style 行"
        : "# 输出：digital-out.mp4；如缺字幕样式字体，改 SRT_STYLE 里的字体名",
  );
  if (isBat) lines.push("endlocal");

  return {
    mode,
    script: lines.join("\n"),
    avatar: avatar?.name,
    audio: audio?.name,
    overlays: overlays.length,
    skipped,
  };
}
