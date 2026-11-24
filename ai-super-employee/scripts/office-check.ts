/**
 * AI 办公 + 地图获客 自检：
 * - 大纲降级结构、Markdown 导出；
 * - 真实渲染 .pptx / .docx（PK 魔数 + OOXML 部件名）；
 * - 演示商家确定性、去重、线索字段映射。
 * 运行：npm run test:office
 * 设 OFFICE_SAMPLES=1 时把样例文件写到 /tmp/office-check-samples 供外部工具校验。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import {
  buildDocxBlob,
  buildPptxBlob,
  docMarkdown,
  fallbackDocOutline,
  fallbackPptOutline,
} from "../src/cloud/office";
import { demoMerchants, dedupeMerchants, merchantToLeadInput } from "../src/cloud/mapleads";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failed += 1;
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` ｜ ${detail}` : ""}`);
};

async function magic(blob: Blob): Promise<Buffer> {
  return Buffer.from(await blob.arrayBuffer());
}

const isZip = (buf: Buffer) => buf[0] === 0x50 && buf[1] === 0x4b;

(async () => {
  // 1. PPT 降级大纲
  const ppt = fallbackPptOutline("新店开业方案", 6);
  check("PPT 降级大纲 demo 标注", ppt.demo === true);
  check("PPT 页数不超过请求", ppt.slides.length <= 6 && ppt.slides.length >= 4, `slides=${ppt.slides.length}`);
  check(
    "PPT 每页有标题与要点",
    ppt.slides.every((slide) => slide.title && slide.bullets.length >= 3),
  );
  check("PPT 要点长度受控", ppt.slides.every((slide) => slide.bullets.every((bullet) => bullet.length <= 40)));

  // 2. 文档降级大纲 + Markdown
  const doc = fallbackDocOutline("门店服务制度");
  check("文档降级大纲 demo 标注", doc.demo === true && doc.sections.length >= 5);
  const md = docMarkdown(doc);
  check("Markdown 含标题与章节", md.startsWith("# 门店服务制度") && md.includes("## 一、背景与目的"));
  check("Markdown 含演示标注", md.includes("演示大纲"));

  // 3. 真实渲染 .pptx
  const pptxBlob = await buildPptxBlob(ppt);
  const pptxBuf = await magic(pptxBlob);
  check("PPTX 是合法 ZIP", isZip(pptxBuf), `size=${pptxBlob.size}`);
  check("PPTX MIME 正确", pptxBlob.type.includes("presentationml"));
  const slideParts = new Set(pptxBuf.toString("latin1").match(/ppt\/slides\/slide\d+\.xml/g) ?? []).size;
  check("PPTX 含封面+内容页部件", slideParts === ppt.slides.length + 1, `parts=${slideParts} expect=${ppt.slides.length + 1}`);
  check(
    "PPTX 含必需部件",
    pptxBuf.includes("[Content_Types].xml") && pptxBuf.includes("ppt/presentation.xml") && pptxBuf.includes("ppt/slideMasters/slideMaster1.xml"),
  );

  // 4. 真实渲染 .docx
  const docxBlob = await buildDocxBlob(doc);
  const docxBuf = await magic(docxBlob);
  check("DOCX 是合法 ZIP", isZip(docxBuf), `size=${docxBlob.size}`);
  check("DOCX MIME 正确", docxBlob.type.includes("wordprocessingml"));
  check("DOCX 含 document.xml 部件", docxBuf.includes("word/document.xml"));

  // 5. 地图演示数据
  const merchants = demoMerchants({ city: "杭州", keyword: "茶饮", radius: 1000 });
  check("演示商家 8 家", merchants.length === 8);
  check("演示商家含关键词与城市", merchants[0].name.includes("茶饮") && merchants[0].name.includes("杭州"));
  check("演示商家距离随序号递增", (merchants[0].distance ?? 0) < (merchants[7].distance ?? 0));
  check(
    "演示商家字段齐全",
    merchants.every((item) => item.name && item.address && item.tel && item.category && item.lng && item.lat),
  );
  const again = demoMerchants({ city: "杭州", keyword: "茶饮", radius: 1000 });
  check("演示数据确定性（两次一致）", JSON.stringify(merchants) === JSON.stringify(again));

  // 6. 去重与线索映射
  const dup = dedupeMerchants([...merchants, { ...merchants[0] }, { ...merchants[1], id: "x2" }]);
  check("去重保留 8 家", dup.length === 8, `got=${dup.length}`);
  const lead = merchantToLeadInput(merchants[0], "张三");
  check(
    "线索字段口径",
    lead.source === "地图获客" && lead.channel === "地图" && lead.intent === "中意向" && lead.owner === "张三",
    JSON.stringify(lead),
  );

  // 7. 可选样例输出（供 python zipfile / LibreOffice 校验）
  if (process.env.OFFICE_SAMPLES === "1") {
    const dir = "/tmp/office-check-samples";
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/sample.pptx`, pptxBuf);
    writeFileSync(`${dir}/sample.docx`, docxBuf);
    writeFileSync(`${dir}/sample.md`, md);
    console.log(`样例已写入 ${dir}`);
  }

  console.log(`\n${failed === 0 ? "全部通过" : `${failed} 项失败`}`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
