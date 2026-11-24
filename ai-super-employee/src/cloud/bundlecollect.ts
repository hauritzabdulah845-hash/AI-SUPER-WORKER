/**
 * 把各处产出收集成打包清单项（跨模块汇总）。
 *
 * 内容工厂有文本产出，AI 办公有已保存的草稿（能重新渲染成真 pptx/docx），
 * 数字人/混剪有方案与字幕。这里统一收集，避免打包页自己到处翻存储。
 * 二进制渲染是异步的（pptxgenjs / docx 库），所以本函数 async。
 */
import { buildDocxBlob, buildPptxBlob, loadSavedDocs, type DocOutline, type PptOutline } from "./office";
import type { BundleSource } from "../components/BundleCenter";

async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** 已保存的 AI 办公草稿 → 打包项（真实 pptx/docx，base64）。 */
export async function collectOfficeSources(): Promise<BundleSource[]> {
  const saved = loadSavedDocs();
  const rows: BundleSource[] = [];
  for (const item of saved) {
    try {
      if (item.kind === "pptx") {
        const blob = await buildPptxBlob(item.outline as PptOutline);
        rows.push({
          kind: "office-ppt",
          title: item.title,
          ext: ".pptx",
          data: await blobToBase64(blob),
          encoding: "base64",
          source: `AI 办公 · ${new Date(item.savedAt).toLocaleDateString("zh-CN")}`,
        });
      } else {
        const blob = await buildDocxBlob(item.outline as DocOutline);
        rows.push({
          kind: "office-doc",
          title: item.title,
          ext: ".docx",
          data: await blobToBase64(blob),
          encoding: "base64",
          source: `AI 办公 · ${new Date(item.savedAt).toLocaleDateString("zh-CN")}`,
        });
      }
    } catch {
      // 单份渲染失败不影响其它文件打包
    }
  }
  return rows;
}
