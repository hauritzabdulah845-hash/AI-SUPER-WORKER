/**
 * 文档解析自检：纯函数 + txt/docx 真解析 + pdf 最小样本尝试。
 * 运行：npm run test:docparse
 *
 * docx 样本用仓库已有 docx 包现造；pdf 样本为手工最小 PDF，
 * Node 环境 pdfjs 若不可用会明确标注跳过（不冒充通过，浏览器路径与 kb-import 同款）。
 */
import { Document, Packer, Paragraph, TextRun } from "docx";
import {
  clampDocText,
  detectDocKind,
  DOC_MAX_BYTES,
  DOC_MAX_CHARS,
  extractTextFromBytes,
  validateDocFile,
} from "../src/cloud/docparse";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failed += 1;
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` ｜ ${detail}` : ""}`);
};

/** 手工最小 PDF（单页、Helvetica、未压缩文本流），偏移量现算。 */
function buildMinimalPdf(text: string): Uint8Array {
  const objects: string[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    "",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const stream = `BT /F1 24 Tf 72 720 Td (${text}) Tj ET`;
  objects[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefAt = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF`;
  return new TextEncoder().encode(pdf);
}

async function main() {
  console.log("—— 文档解析自检 ——\n");

  // 1. 纯函数：格式判定 / 校验 / 截断
  check("detect txt", detectDocKind("合同.txt") === "text");
  check("detect md", detectDocKind("a.MD") === "text");
  check("detect docx", detectDocKind("简历.docx") === "docx");
  check("detect pdf", detectDocKind("a.pdf") === "pdf");
  check("detect 不支持", detectDocKind("a.doc") === "unsupported" && detectDocKind("a.png") === "unsupported");
  check("校验通过", validateDocFile({ name: "a.docx", size: 1024 }).ok);
  check("校验超 5MB 拒绝", !validateDocFile({ name: "a.pdf", size: DOC_MAX_BYTES + 1 }).ok);
  check("校验空文件拒绝", !validateDocFile({ name: "a.txt", size: 0 }).ok);
  check("校验不支持格式拒绝", !validateDocFile({ name: "a.doc", size: 10 }).ok);
  const clamped = clampDocText("字".repeat(DOC_MAX_CHARS + 10));
  check("截断标注", clamped.truncated && clamped.text.length === DOC_MAX_CHARS && clamped.totalChars === DOC_MAX_CHARS + 10);
  check("未超限不截断", !clampDocText("短文本").truncated);

  // 2. txt 真解析
  const txtBytes = new TextEncoder().encode("第一行\r\n第二行\n\n\n\n第三行");
  const txtOut = await extractTextFromBytes(txtBytes, "text");
  check("txt 解析归一化", txtOut === "第一行\n第二行\n\n第三行", JSON.stringify(txtOut));

  // 3. docx 真解析（docx 包现造样本 → mammoth 提取）
  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({ children: [new TextRun("服务合同正文：付款周期为验收后三十日。")] }),
          new Paragraph({ children: [new TextRun("违约金不超过合同总额的百分之二十。")] }),
        ],
      },
    ],
  });
  const docxBuffer = await Packer.toBuffer(doc);
  const docxOut = await extractTextFromBytes(new Uint8Array(docxBuffer), "docx");
  check("docx 解析含正文", docxOut.includes("付款周期为验收后三十日") && docxOut.includes("违约金"), docxOut.slice(0, 60));

  // 4. pdf 最小样本（Node 环境不可用时明确跳过，不计失败）
  try {
    const pdfOut = await extractTextFromBytes(buildMinimalPdf("Hello Contract 2026"), "pdf");
    check("pdf 解析含文本", pdfOut.includes("Hello Contract 2026"), pdfOut.slice(0, 60));
  } catch (error) {
    console.log(`⚠ pdf 解析在 Node 环境不可用，跳过（浏览器路径与 kb-import 同款，待真机验收）：${error instanceof Error ? error.message.slice(0, 120) : String(error)}`);
  }

  // 5. 不支持格式抛错
  let threw = false;
  try {
    await extractTextFromBytes(new Uint8Array([1, 2, 3]), "unsupported");
  } catch {
    threw = true;
  }
  check("不支持格式抛错", threw);

  console.log(`\n${failed === 0 ? "全部通过" : `${failed} 项失败`}`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
