/**
 * 从 scripts/official-prompts.mjs（单一来源）生成 src/cloud/prompts.ts。
 * 用法：node scripts/gen-prompts-ts.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { PROMPTS } from "./official-prompts.mjs";

const codes = Object.keys(PROMPTS);
const body = codes.map((code) => "  " + JSON.stringify(code) + ": " + JSON.stringify(PROMPTS[code]) + ",").join("\n");
const ts =
  "/**\n * 18 个官方岗位的 v2 提示词（内置基准版）。\n *\n * 为什么放代码里：匿名调用方对 agent_templates 的 UPDATE 会被云端静默拦截\n * （写入显示成功、复读却是旧值），数据库里的提示词永远回不到新版本。\n * 官方模板的提示词本质上是产品的一部分，随代码走最可靠；\n * 用户的自定义人设仍存数据库（agents.config.prompt），优先级高于这里。\n *\n * 单一来源：scripts/official-prompts.mjs（重新生成：node scripts/gen-prompts-ts.mjs）。\n */\nexport const OFFICIAL_PROMPTS: Record<string, string> = {\n" +
  body +
  "\n};\n";

const out = path.join(process.cwd(), "src", "cloud", "prompts.ts");
fs.writeFileSync(out, ts, "utf8");
console.log(`生成 ${out}，${codes.length} 个岗位，平均 ${Math.round(codes.reduce((a, c) => a + PROMPTS[c].length, 0) / codes.length)} 字`);
