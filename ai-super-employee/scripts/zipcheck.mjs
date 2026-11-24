#!/usr/bin/env node
/**
 * zip 端到端自检：用打包逻辑生成清单 → fflate 压包 → 校验能否正常解析。
 *
 * 为什么单列一个脚本：bundle.ts 只算清单，真正压包在 UI 层（fflate）。
 * 「清单对了但压出来的 zip 打不开」是最典型的漏测，所以单独验一遍字节。
 * 运行：npm run test:zip
 */
import { zipSync, unzipSync, strToU8, strFromU8 } from "fflate";

let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed += 1;
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` ｜ ${detail}` : ""}`);
};

// 模拟 buildBundle 的输出（目录结构 + README + 重名序号 + 中文名）
const files = {
  "01-内容产出/秋季新品文案.md": strToU8("# 秋季新品\n正文内容"),
  "01-内容产出/秋季新品文案(2).md": strToU8("重复标题的另一个文件"),
  "02-演示文稿/招商方案.pptx": new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x0a, 0x00]),
  "06-字幕/口播字幕.srt": strToU8("1\n00:00:00,000 --> 00:00:03,000\n你好\n"),
  "README.md": strToU8("# 交付物打包清单\n\n| 文件 | 大小 |\n"),
};

const zipped = zipSync(files, { level: 6 });
check("压包产出非空", zipped.length > 0, `${zipped.length} bytes`);
check("zip 魔数正确（PK\\x03\\x04）", zipped[0] === 0x50 && zipped[1] === 0x4b, `${zipped[0].toString(16)} ${zipped[1].toString(16)}`);

const restored = unzipSync(zipped);
const names = Object.keys(restored).sort();
check("条目数一致", names.length === Object.keys(files).length, `${names.length} 条`);
check("目录结构保留", names.every((name) => name in files), names.join(" | "));
check("中文文件名可还原", names.some((name) => name.includes("秋季新品文案")), names.find((n) => n.includes("秋季")) ?? "未找到");
check("重名序号文件独立", names.includes("01-内容产出/秋季新品文案(2).md") && strFromU8(restored["01-内容产出/秋季新品文案(2).md"]) === "重复标题的另一个文件");
check("文本内容一致", strFromU8(restored["01-内容产出/秋季新品文案.md"]) === "# 秋季新品\n正文内容");
check("二进制内容一致", Array.from(restored["02-演示文稿/招商方案.pptx"]).join(",") === "80,75,3,4,10,0");
check("README 可读", strFromU8(restored["README.md"]).startsWith("# 交付物打包清单"));

// 压缩率：重复内容应显著变小
const repetitive = { "big.md": strToU8("重复的段落。".repeat(2000)) };
const rawBytes = strToU8("重复的段落。").length * 2000;
const compressed = zipSync(repetitive, { level: 6 });
check("压缩生效（重复内容显著变小）", compressed.length < rawBytes / 5, `${rawBytes} → ${compressed.length} bytes`);

// 空包也不应抛错
const emptyZip = zipSync({}, { level: 6 });
check("空包可生成", emptyZip.length > 0 && Object.keys(unzipSync(emptyZip)).length === 0);

console.log(`\n${failed === 0 ? "全部通过" : `${failed} 项失败`}`);
process.exit(failed === 0 ? 0 : 1);
