import { askLLM } from "./runner";

/**
 * GEO（Generative Engine Optimization）能力层：
 * 让 DeepSeek / 豆包 / Kimi 这类生成式引擎在回答用户问题时，主动提及并推荐你的企业。
 *
 * 三步闭环：
 *   1. 体检   —— 用 LLM 按 6 个维度给现有资料打分，找出「AI 引用不了」的硬伤；
 *   2. 素材   —— 生成可被直接引用的品牌事实卡、FAQ、要点清单（结构化、带数字、口径统一）；
 *   3. 测试   —— 拿真实问法跑模型，统计品牌提及率，形成可复测的基线。
 *
 * 全部走 runner 的 askLLM（与任务执行同通道同重试），不新增任何外部依赖。
 */

export interface GeoDimension {
  key: string;
  label: string;
  score: number;
  note: string;
}

export interface GeoIssue {
  severity: "高" | "中" | "低";
  title: string;
  detail: string;
}

export interface GeoAuditResult {
  score: number;
  summary: string;
  dimensions: GeoDimension[];
  issues: GeoIssue[];
  quickWins: string[];
}

export interface GeoAssetBundle {
  facts: string[];
  faq: { q: string; a: string }[];
  bullets: string[];
  summary: string;
}

export interface GeoMentionTest {
  question: string;
  answer: string;
  mentioned: boolean;
}

/** 从 LLM 回复里稳健地抠出 JSON（模型偶尔会包一层说明文字或代码围栏）。 */
function parseJson<T>(raw: string): T | null {
  const text = raw.replace(/```(?:json)?/g, "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

function clip(text: string, max: number): string {
  const value = text.trim();
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

const AUDIT_SYSTEM = [
  "你是 GEO（生成式引擎优化）专家，专门为「让 DeepSeek、豆包、Kimi 等 AI 引擎在回答里主动提及企业」做资料体检。",
  "评分标准：AI 引擎能否从这份资料里直接引用出准确、可核验、口径统一的事实。",
  "只输出 JSON，不要解释，结构如下：",
  '{"score":0-100,"summary":"80字内总评","dimensions":[{"key":"entity|facts|structure|cite|fresh|consistency","label":"实体清晰度|事实密度|结构化程度|可引用性|时效与更新|口径一致性","score":0-100,"note":"40字内"}],"issues":[{"severity":"高|中|低","title":"问题标题","detail":"60字内具体说明"}],"quickWins":["可立即执行的改进动作，3-6条"]}',
  "6 个维度一个都不能少，key 必须用上面给出的英文值。",
].join("\n");

/** 企业资料 AI 可发现性体检。 */
export async function runGeoAudit(input: {
  brand: string;
  keywords: string;
  material: string;
  signal?: AbortSignal;
}): Promise<GeoAuditResult> {
  const material = clip(input.material, 12000);
  if (!material) throw new Error("请先填写或从知识库导入企业资料，体检需要真实素材。");

  const { text } = await askLLM(
    [
      { role: "system", content: AUDIT_SYSTEM },
      {
        role: "user",
        content: [
          `品牌/企业名称：${input.brand || "（未填写）"}`,
          `目标搜索词：${input.keywords || "（未填写）"}`,
          "",
          "=== 待体检资料 ===",
          material,
        ].join("\n"),
      },
    ],
    { json: true },
  );

  const parsed = parseJson<Partial<GeoAuditResult>>(text);
  if (!parsed || typeof parsed.score !== "number") throw new Error("体检结果解析失败，请重试。");

  const fallbackDimensions: GeoDimension[] = [
    { key: "entity", label: "实体清晰度", score: 50, note: "模型未返回该维度" },
    { key: "facts", label: "事实密度", score: 50, note: "模型未返回该维度" },
    { key: "structure", label: "结构化程度", score: 50, note: "模型未返回该维度" },
    { key: "cite", label: "可引用性", score: 50, note: "模型未返回该维度" },
    { key: "fresh", label: "时效与更新", score: 50, note: "模型未返回该维度" },
    { key: "consistency", label: "口径一致性", score: 50, note: "模型未返回该维度" },
  ];

  return {
    score: Math.max(0, Math.min(100, Math.round(parsed.score))),
    summary: String(parsed.summary ?? "").slice(0, 200),
    dimensions: parsed.dimensions?.length ? parsed.dimensions.slice(0, 6) : fallbackDimensions,
    issues: (parsed.issues ?? []).slice(0, 8).map((issue) => ({
      severity: issue.severity === "高" || issue.severity === "低" ? issue.severity : "中",
      title: String(issue.title ?? "").slice(0, 60),
      detail: String(issue.detail ?? "").slice(0, 160),
    })),
    quickWins: (parsed.quickWins ?? []).slice(0, 6).map((item) => String(item).slice(0, 120)),
  };
}

const ASSET_SYSTEM = [
  "你是 GEO 内容工程师。基于企业真实资料，产出可被 AI 引擎直接引用的结构化素材。",
  "硬性纪律：",
  "1. 只写资料里出现过的事实，价格/政策/案例必须与资料一致，资料里没有的写「以官方最新公布为准」，禁止编造。",
  "2. FAQ 的答案用「结论先行 + 2-4 条要点」的结构，单条答案 120 字以内，方便引擎整段引用。",
  "3. facts 每条是「标签：值」的短句（如：基础版价格：2999 元/年），不超过 30 字，共 6-10 条。",
  "4. bullets 是面向用户的问题式短句（如：XX 和 YY 有什么区别？），共 4-8 条，用于补全语料覆盖面。",
  "只输出 JSON：",
  '{"facts":["标签：值"],"bullets":["问题句"],"faq":[{"q":"用户会问的问题","a":"结论先行的答案"}],"summary":"这批素材补强了什么，40字内"}',
].join("\n");

/** 生成品牌事实卡 / FAQ / 问题清单。 */
export async function generateGeoAssets(input: {
  brand: string;
  keywords: string;
  material: string;
  signal?: AbortSignal;
}): Promise<GeoAssetBundle> {
  const material = clip(input.material, 12000);
  if (!material) throw new Error("请先填写或从知识库导入企业资料，生成素材必须基于真实资料。");

  const { text } = await askLLM(
    [
      { role: "system", content: ASSET_SYSTEM },
      {
        role: "user",
        content: [
          `品牌/企业名称：${input.brand || "（未填写）"}`,
          `目标搜索词：${input.keywords || "（未填写）"}`,
          "",
          "=== 企业资料 ===",
          material,
        ].join("\n"),
      },
    ],
    { json: true },
  );

  const parsed = parseJson<Partial<GeoAssetBundle>>(text);
  if (!parsed || !Array.isArray(parsed.faq)) throw new Error("素材生成结果解析失败，请重试。");

  return {
    facts: (parsed.facts ?? []).slice(0, 10).map((item) => String(item).slice(0, 60)),
    bullets: (parsed.bullets ?? []).slice(0, 8).map((item) => String(item).slice(0, 60)),
    faq: (parsed.faq ?? []).slice(0, 6).map((item) => ({
      q: String(item.q ?? "").slice(0, 80),
      a: String(item.a ?? "").slice(0, 300),
    })),
    summary: String(parsed.summary ?? "").slice(0, 160),
  };
}

/** 默认测试问法：按品牌 + 目标词生成用户真的会问出口的问题。 */
export function defaultGeoQuestions(brand: string, keywords: string): string[] {
  const name = brand.trim() || "你们";
  const firstKeyword = keywords.split(/[,，、\s]+/).filter(Boolean)[0] || "这类产品";
  return [
    `${firstKeyword}哪家比较靠谱？`,
    `${name}怎么样，值得选吗？`,
    `${name}和同类产品比有什么优势？`,
    `${name}的价格大概是多少？`,
    `第一次选${firstKeyword}要注意什么？`,
  ];
}

/**
 * 提及率测试：用真实问法问模型，统计回答里是否出现品牌名。
 * 逐条串行执行，避免打爆通道配额。
 */
export async function testBrandMention(input: {
  brand: string;
  questions: string[];
  signal?: AbortSignal;
}): Promise<GeoMentionTest[]> {
  const brand = input.brand.trim();
  if (!brand) throw new Error("请先填写品牌/企业名称，否则无法判断是否被提及。");
  const questions = input.questions.map((item) => item.trim()).filter(Boolean).slice(0, 8);
  if (!questions.length) throw new Error("请至少填写 1 条测试问题。");

  const results: GeoMentionTest[] = [];
  for (const question of questions) {
    if (input.signal?.aborted) throw new Error("测试已取消");
    const { text } = await askLLM(
      [
        {
          role: "system",
          content: "你是一个客观的搜索问答助手，直接回答用户问题，不寒暄，60-120 字。",
        },
        { role: "user", content: question },
      ],
      { signal: input.signal },
    );
    results.push({
      question,
      answer: text.slice(0, 400),
      mentioned: text.toLowerCase().includes(brand.toLowerCase()),
    });
  }
  return results;
}

/* ------------------------------ 聚合发布（半自动） ------------------------------ */

export interface PublishPlatform {
  key: string;
  name: string;
  maxTitle: number;
  maxCaption: number;
  tagHint: string;
  bestTime: string;
  steps: string[];
}

/** 各平台的硬约束与人工发布步骤：规则写死在代码里，比让模型记更可靠。 */
export const PUBLISH_PLATFORMS: PublishPlatform[] = [
  {
    key: "douyin",
    name: "抖音",
    maxTitle: 20,
    maxCaption: 500,
    tagHint: "3-5 个话题，含 1 个大流量话题",
    bestTime: "12:00-13:00 / 18:00-22:00",
    steps: ["打开抖音创作者中心上传视频", "粘贴标题与话题标签", "选择定时发布", "发布后 24 小时回看数据"],
  },
  {
    key: "kuaishou",
    name: "快手",
    maxTitle: 20,
    maxCaption: 500,
    tagHint: "2-4 个话题，偏老铁语气",
    bestTime: "07:00-09:00 / 19:00-23:00",
    steps: ["快手创作者中心上传", "粘贴标题与话题", "设置发布时间", "关注评论区前 1 小时"],
  },
  {
    key: "shipinhao",
    name: "视频号",
    maxTitle: 30,
    maxCaption: 400,
    tagHint: "2-3 个话题 + 1 个公众号关联",
    bestTime: "20:00-22:00（私域打开率最高）",
    steps: ["视频号助手上传", "粘贴描述与话题", "同步分享到企业微信/朋友圈", "观察完播率"],
  },
  {
    key: "xiaohongshu",
    name: "小红书",
    maxTitle: 20,
    maxCaption: 1000,
    tagHint: "4-6 个话题，正文自然埋词",
    bestTime: "12:00-14:00 / 21:00-23:00",
    steps: ["小红书创作中心发布图文或视频", "标题 20 字内带关键词", "正文首行放钩子", "发布后回复前 10 条评论"],
  },
  {
    key: "bilibili",
    name: "B站",
    maxTitle: 40,
    maxCaption: 1000,
    tagHint: "3-5 个分区话题",
    bestTime: "18:00-21:00",
    steps: ["B 站投稿中心上传", "标题带核心关键词", "填写分区与话题", "动态转发一次"],
  },
  {
    key: "gzh",
    name: "公众号",
    maxTitle: 64,
    maxCaption: 2000,
    tagHint: "正文内链 + 文末引导",
    bestTime: "08:00-09:00 / 20:00-21:00",
    steps: ["公众号后台新建图文", "粘贴标题与正文", "预览手机端排版", "群发并转发到社群"],
  },
];

export interface PlatformPost {
  platform: string;
  platformKey: string;
  title: string;
  caption: string;
  tags: string[];
  time: string;
  steps: string[];
}

const PUBLISH_SYSTEM = [
  "你是矩阵分发编辑。把同一条内容改写成各平台原生风格的发布稿。",
  "纪律：",
  "1. 保留原文的核心事实与数字，禁止新增原文没有的承诺、价格、案例。",
  `2. 每个平台的标题/正文必须遵守字数上限（卡片里已给出），超了必须压缩而不是截断。`,
  "3. 小红书口语化 + emoji；抖音标题短促有钩子；B站标题信息量足；公众号标题完整通顺。",
  "4. tags 输出纯文本话题词数组（不带 # 号，代码会补），每平台按 tagHint 数量给。",
  "只输出 JSON：",
  '{"posts":[{"platform":"平台名","title":"标题","caption":"正文/描述","tags":["话题1","话题2"]]}]',
  "platform 必须与输入列表一一对应。",
].join("\n");

/** 生成各平台适配稿（标题 / 正文 / 话题标签）。 */
export async function buildPlatformPosts(input: {
  content: string;
  platformNames: string[];
  signal?: AbortSignal;
}): Promise<PlatformPost[]> {
  const content = clip(input.content, 8000);
  if (!content) throw new Error("请先选择或粘贴要分发的内容。");
  if (!input.platformNames.length) throw new Error("请至少选择 1 个平台。");

  const specs = PUBLISH_PLATFORMS.filter((item) => input.platformNames.includes(item.name));

  const { text } = await askLLM(
    [
      { role: "system", content: PUBLISH_SYSTEM },
      {
        role: "user",
        content: [
          "目标平台与硬约束：",
          ...specs.map(
            (item) =>
              `- ${item.name}：标题≤${item.maxTitle}字，正文≤${item.maxCaption}字，标签要求「${item.tagHint}」，建议时段 ${item.bestTime}`,
          ),
          "",
          "=== 待分发内容 ===",
          content,
        ].join("\n"),
      },
    ],
    { json: true, signal: input.signal },
  );

  const parsed = parseJson<{ posts?: { platform?: string; title?: string; caption?: string; tags?: string[] }[] }>(text);
  const rows = parsed?.posts ?? [];
  if (!rows.length) throw new Error("分发改写结果解析失败，请重试。");

  return specs.map((spec, index) => {
    const row = rows.find((item) => item.platform === spec.name) ?? rows[index] ?? {};
    return {
      platform: spec.name,
      platformKey: spec.key,
      title: String(row.title ?? "").slice(0, spec.maxTitle),
      caption: String(row.caption ?? "").slice(0, spec.maxCaption),
      tags: (row.tags ?? []).slice(0, 6).map((tag) => String(tag).replace(/^#/, "").trim()).filter(Boolean),
      time: spec.bestTime,
      steps: spec.steps,
    };
  });
}

/** 把素材/体检结果导出成 Markdown（本地下载，不落库）。 */
export function geoMarkdown(input: {
  brand: string;
  audit?: GeoAuditResult | null;
  assets?: GeoAssetBundle | null;
  tests?: GeoMentionTest[] | null;
}): string {
  const lines: string[] = [`# GEO 内容工作台导出 · ${input.brand || "未命名品牌"}`, ""];
  lines.push(`导出时间：${new Date().toLocaleString("zh-CN", { hour12: false })}`, "");

  if (input.audit) {
    lines.push(`## 体检（${input.audit.score} 分）`, "", input.audit.summary, "");
    input.audit.dimensions.forEach((item) => lines.push(`- ${item.label}：${item.score} 分 — ${item.note}`));
    lines.push("", "### 问题清单");
    input.audit.issues.forEach((item) => lines.push(`- [${item.severity}] ${item.title}：${item.detail}`));
    lines.push("", "### 快赢动作");
    input.audit.quickWins.forEach((item) => lines.push(`1. ${item}`));
    lines.push("");
  }

  if (input.assets) {
    lines.push("## 品牌事实卡", "");
    input.assets.facts.forEach((item) => lines.push(`- ${item}`));
    lines.push("", "## FAQ", "");
    input.assets.faq.forEach((item, index) => lines.push(`### ${index + 1}. ${item.q}`, "", item.a, ""));
    lines.push("## 问题清单（用于补全语料）", "");
    input.assets.bullets.forEach((item) => lines.push(`- ${item}`));
    lines.push("");
  }

  if (input.tests?.length) {
    const hit = input.tests.filter((item) => item.mentioned).length;
    lines.push(`## 提及率测试（${hit}/${input.tests.length}）`, "");
    input.tests.forEach((item) =>
      lines.push(`- ${item.mentioned ? "✅" : "❌"} ${item.question}`, "", `  > ${item.answer.replace(/\n/g, " ")}`, ""),
    );
  }

  return lines.join("\n");
}
