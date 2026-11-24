/**
 * AI 办公（域：办公自动化）：大纲生成 + 本机渲染 .pptx / .docx。
 *
 * - 大纲：LLM 产出结构化 JSON，模型不可用时降级模板大纲（demo 标注，界面注明）；
 * - 渲染：pptxgenjs / docx 纯前端生成，文件不经过任何外部服务；
 * - 留档：大纲存本机 localStorage（上限 10 份），可重新下载，不入库不上传。
 */
import PptxGenJS from "pptxgenjs";
import { Document, HeadingLevel, Packer, Paragraph, TextRun } from "docx";
import { askLLM } from "./runner";

export interface SlideOutline {
  title: string;
  bullets: string[];
  note?: string;
}

export interface PptOutline {
  title: string;
  subtitle: string;
  slides: SlideOutline[];
  demo: boolean;
}

export interface DocSection {
  heading: string;
  paragraphs: string[];
}

export interface DocOutline {
  title: string;
  subtitle: string;
  sections: DocSection[];
  demo: boolean;
}

export type OfficeKind = "pptx" | "docx";

export interface StoredOfficeDoc {
  savedAt: number;
  kind: OfficeKind;
  title: string;
  outline: PptOutline | DocOutline;
}

const DOC_KEY = "ai-employee:office-docs";
const MAX_DOCS = 10;
const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/* ------------------------------------------------------------------ */
/* 大纲生成                                                            */
/* ------------------------------------------------------------------ */

const PPT_SYSTEM =
  "你是资深商业演示策划。把给定主题整理成一份结构化演示大纲，只输出 JSON，不要任何解释或代码块。" +
  '格式：{"title":"不超过25字的主标题","subtitle":"一句话副标题","slides":[{"title":"页标题(<=18字)","bullets":["要点1","要点2","要点3"],"note":"该页讲稿提示(可选)"}]}' +
  "要求：第一页是结论先行的背景与问题；总页数严格等于要求；每页 bullets 3-5 条、每条不超过 26 字；" +
  "内容必须具体可讲，不写空话；资料缺失的数字不要编，用「待补充」标注。";

const DOC_SYSTEM =
  "你是企业文案负责人。把给定主题整理成一份结构化文档大纲，只输出 JSON，不要任何解释或代码块。" +
  '格式：{"title":"文档标题","subtitle":"一句话说明","sections":[{"heading":"一级标题","paragraphs":["段落1","段落2"]}]}' +
  "要求：章节 4-7 个；每个段落 2-4 句、可直接成文；价格、承诺、案例等资料没有的信息一律写「待补充」，严禁编造。";

function parseJson<T>(raw: string): T | null {
  const trimmed = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]) as T;
    } catch {
      return null;
    }
  }
}

function clipText(value: unknown, max: number, fallback: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  return (text || fallback).slice(0, max);
}

function clipBullets(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean)
    .slice(0, 6)
    .map((item) => item.slice(0, 40));
}

export function fallbackPptOutline(topic: string, slideCount: number): PptOutline {
  const subject = topic.trim() || "业务方案";
  const templates: SlideOutline[] = [
    { title: "背景与问题", bullets: [`当前围绕「${subject}」的核心问题`, "为什么现在必须动手", "不做的代价与机会成本"], note: "用一个具体场景开场" },
    { title: "目标与成功标准", bullets: ["目标一句话说清", "可衡量的 2-3 个指标", "时间边界"], note: "指标必须可验证" },
    { title: "方案总览", bullets: ["整体思路一张图讲完", "与常规做法的差异", "客户/用户得到什么"], note: "先总后分" },
    { title: "关键举措", bullets: ["举措一：具体动作与负责人", "举措二：具体动作与负责人", "举措三：具体动作与负责人"], note: "每条都要能执行" },
    { title: "计划与里程碑", bullets: ["第 1-2 周：准备与试点", "第 3-4 周：铺开与校验", "月底：复盘与调整"], note: "留出缓冲" },
    { title: "资源与预算", bullets: ["人力投入", "费用区间（待补充）", "已有资源盘点"], note: "没有依据的数字标待补充" },
    { title: "风险与应对", bullets: ["主要风险 1 与预案", "主要风险 2 与预案", "升级机制"], note: "讲清触发条件" },
    { title: "下一步行动", bullets: ["本周内确认的事项", "需要拍板的决策", "下次同步时间"], note: "收口在具体动作" },
  ];
  return {
    title: subject,
    subtitle: "演示大纲（模型不可用时的结构参考，可直接改）",
    slides: templates.slice(0, Math.min(8, Math.max(4, slideCount))),
    demo: true,
  };
}

export function fallbackDocOutline(topic: string): DocOutline {
  const subject = topic.trim() || "工作文档";
  return {
    title: subject,
    subtitle: "演示大纲（模型不可用时的结构参考，可直接改）",
    sections: [
      { heading: "一、背景与目的", paragraphs: [`围绕「${subject}」说明为什么现在要做这件事。`, "本文档的目标读者与预期决策（待补充）。"] },
      { heading: "二、现状与问题", paragraphs: ["当前做法与痛点逐条列出。", "关键数据与事实：资料缺失处标注「待补充」，不编造。"] },
      { heading: "三、方案内容", paragraphs: ["总体思路与关键动作。", "分工、节奏与交付物。"] },
      { heading: "四、计划与里程碑", paragraphs: ["阶段划分与时间节点。", "验收标准与复盘时点。"] },
      { heading: "五、风险与应对", paragraphs: ["主要风险、触发条件与预案。", "升级路径与决策人。"] },
      { heading: "六、下一步", paragraphs: ["需要确认的事项清单。", "下次同步时间与形式。"] },
    ],
    demo: true,
  };
}

export async function generatePptOutline(input: {
  topic: string;
  audience: string;
  style: string;
  slideCount: number;
}): Promise<PptOutline> {
  const topic = input.topic.trim();
  if (!topic) throw new Error("先填写演示主题");
  try {
    const { text } = await askLLM(
      [
        { role: "system", content: PPT_SYSTEM },
        {
          role: "user",
          content: [
            `主题：${topic}`,
            `受众：${input.audience || "通用"}`,
            `风格：${input.style || "通用汇报"}`,
            `页数：${input.slideCount}（不含封面）`,
          ].join("\n"),
        },
      ],
      { json: true },
    );
    const parsed = parseJson<Partial<PptOutline>>(text);
    const slides = (parsed?.slides ?? [])
      .map((slide) => ({
        title: clipText(slide?.title, 20, "未命名页"),
        bullets: clipBullets(slide?.bullets),
        note: typeof slide?.note === "string" ? slide.note.slice(0, 120) : undefined,
      }))
      .filter((slide) => slide.bullets.length > 0)
      .slice(0, input.slideCount);
    if (!slides.length) throw new Error("模型未返回有效大纲");
    return {
      title: clipText(parsed?.title, 30, topic),
      subtitle: clipText(parsed?.subtitle, 60, `${input.style || "汇报"} · ${input.audience || "通用"}`),
      slides,
      demo: false,
    };
  } catch {
    return fallbackPptOutline(topic, input.slideCount);
  }
}

export async function generateDocOutline(input: {
  topic: string;
  docType: string;
  points: string;
}): Promise<DocOutline> {
  const topic = input.topic.trim();
  if (!topic) throw new Error("先填写文档主题");
  try {
    const { text } = await askLLM(
      [
        { role: "system", content: DOC_SYSTEM },
        {
          role: "user",
          content: [`类型：${input.docType || "方案"}`, `主题：${topic}`, `补充要点：${input.points || "无"}`].join("\n"),
        },
      ],
      { json: true },
    );
    const parsed = parseJson<Partial<DocOutline>>(text);
    const sections = (parsed?.sections ?? [])
      .map((section) => ({
        heading: clipText(section?.heading, 30, "未命名章节"),
        paragraphs: (Array.isArray(section?.paragraphs) ? section.paragraphs : [])
          .map((item) => (typeof item === "string" ? item.trim() : ""))
          .filter(Boolean)
          .slice(0, 5)
          .map((item) => item.slice(0, 300)),
      }))
      .filter((section) => section.paragraphs.length > 0)
      .slice(0, 7);
    if (!sections.length) throw new Error("模型未返回有效大纲");
    return {
      title: clipText(parsed?.title, 40, topic),
      subtitle: clipText(parsed?.subtitle, 80, `${input.docType || "文档"} · AI 生成`),
      sections,
      demo: false,
    };
  } catch {
    return fallbackDocOutline(topic);
  }
}

/* ------------------------------------------------------------------ */
/* 渲染：.pptx / .docx（本机生成，不经过外部服务）                        */
/* ------------------------------------------------------------------ */

function pptxInstance(): PptxGenJS {
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_16x9";
  pptx.theme = { headFontFace: "Microsoft YaHei", bodyFontFace: "Microsoft YaHei" };
  return pptx;
}

function toBlob(data: ArrayBuffer | Uint8Array | Buffer, mime: string): Blob {
  return new Blob([data as BlobPart], { type: mime });
}

export async function buildPptxBlob(outline: PptOutline): Promise<Blob> {
  const pptx = pptxInstance();
  const subtitle = outline.demo ? `${outline.subtitle}（演示大纲）` : outline.subtitle;

  const cover = pptx.addSlide();
  cover.background = { color: "FFFFFF" };
  cover.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 0.18, h: 5.63, fill: { color: "6D5DFC" } });
  cover.addText(outline.title, { x: 0.6, y: 1.7, w: 8.8, h: 1.2, fontSize: 32, bold: true, color: "18172B", fontFace: "Microsoft YaHei" });
  cover.addText(subtitle, { x: 0.6, y: 3.0, w: 8.8, h: 0.6, fontSize: 15, color: "66657A", fontFace: "Microsoft YaHei" });
  cover.addText(`AI 超级员工 · ${new Date().toLocaleDateString("zh-CN")}`, {
    x: 0.6, y: 4.9, w: 5, h: 0.4, fontSize: 11, color: "9A99AE", fontFace: "Microsoft YaHei",
  });

  outline.slides.forEach((item, index) => {
    const slide = pptx.addSlide();
    slide.background = { color: "FFFFFF" };
    slide.addText(`${index + 1}`, { x: 0.4, y: 0.3, w: 0.5, h: 0.4, fontSize: 13, bold: true, color: "6D5DFC", fontFace: "Microsoft YaHei" });
    slide.addText(item.title, { x: 0.9, y: 0.28, w: 8.6, h: 0.5, fontSize: 22, bold: true, color: "18172B", fontFace: "Microsoft YaHei" });
    slide.addShape(pptx.ShapeType.rect, { x: 0.9, y: 0.86, w: 1.2, h: 0.05, fill: { color: "6D5DFC" } });
    slide.addText(
      item.bullets.map((bullet) => ({ text: bullet, options: { bullet: { code: "2022" }, breakLine: true, paraSpaceAfter: 10 } })),
      { x: 0.9, y: 1.2, w: 8.6, h: 3.8, fontSize: 16, color: "2D2C3F", fontFace: "Microsoft YaHei", valign: "top" },
    );
    slide.addText(`${index + 2} / ${outline.slides.length + 1}`, { x: 8.6, y: 5.15, w: 1, h: 0.3, fontSize: 10, color: "9A99AE", align: "right", fontFace: "Microsoft YaHei" });
    if (item.note) slide.addNotes(item.note);
  });

  const buffer = (await pptx.write({ outputType: "arraybuffer" })) as ArrayBuffer;
  return toBlob(buffer, PPTX_MIME);
}

export async function buildDocxBlob(outline: DocOutline): Promise<Blob> {
  const children: Paragraph[] = [
    new Paragraph({ text: outline.title, heading: HeadingLevel.TITLE, spacing: { after: 120 } }),
    new Paragraph({
      children: [new TextRun({ text: outline.demo ? `${outline.subtitle}（演示大纲）` : outline.subtitle, color: "66657A", italics: true, size: 22 })],
      spacing: { after: 240 },
    }),
  ];
  for (const section of outline.sections) {
    children.push(new Paragraph({ text: section.heading, heading: HeadingLevel.HEADING_1, spacing: { before: 240, after: 120 } }));
    for (const paragraph of section.paragraphs) {
      children.push(
        new Paragraph({
          children: [new TextRun({ text: paragraph, size: 22 })],
          spacing: { after: 120, line: 360 },
        }),
      );
    }
  }
  children.push(
    new Paragraph({
      children: [new TextRun({ text: "——本文档由 AI 超级员工本机生成，未经过任何外部办公服务。", color: "9A99AE", size: 18 })],
      spacing: { before: 360 },
    }),
  );

  const doc = new Document({
    creator: "AI 超级员工",
    title: outline.title,
    description: outline.subtitle,
    sections: [{ properties: {}, children }],
  });
  const blob = await Packer.toBlob(doc);
  return blob.type ? blob : toBlob(await Packer.toBuffer(doc), DOCX_MIME);
}

/** 文档大纲转 Markdown（.md 导出，零依赖降级格式）。 */
export function docMarkdown(outline: DocOutline): string {
  const lines: string[] = [`# ${outline.title}`, "", `> ${outline.demo ? `${outline.subtitle}（演示大纲）` : outline.subtitle}`, ""];
  for (const section of outline.sections) {
    lines.push(`## ${section.heading}`, "");
    for (const paragraph of section.paragraphs) lines.push(paragraph, "");
  }
  lines.push("---", "", "*由 AI 超级员工本机生成*");
  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/* 留档                                                                */
/* ------------------------------------------------------------------ */

export function loadSavedDocs(): StoredOfficeDoc[] {
  try {
    const raw = window.localStorage.getItem(DOC_KEY);
    const rows = raw ? (JSON.parse(raw) as StoredOfficeDoc[]) : [];
    if (!Array.isArray(rows)) return [];
    return rows.filter((row) => row && row.outline && typeof row.title === "string").slice(0, MAX_DOCS);
  } catch {
    return [];
  }
}

export function saveOfficeDoc(input: { kind: OfficeKind; title: string; outline: PptOutline | DocOutline }): StoredOfficeDoc {
  const row: StoredOfficeDoc = { savedAt: Date.now(), kind: input.kind, title: input.title, outline: input.outline };
  const rows = [row, ...loadSavedDocs()].slice(0, MAX_DOCS);
  window.localStorage.setItem(DOC_KEY, JSON.stringify(rows));
  return row;
}

export function removeSavedDoc(savedAt: number): void {
  const rows = loadSavedDocs().filter((row) => row.savedAt !== savedAt);
  window.localStorage.setItem(DOC_KEY, JSON.stringify(rows));
}
