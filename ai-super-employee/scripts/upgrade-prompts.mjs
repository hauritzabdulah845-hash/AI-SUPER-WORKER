/**
 * 把 v2 提示词写回 agent_templates。
 *
 * - 先备份旧提示词到 scripts/prompt-backup.json，可随时回退
 * - 再逐条更新，失败的会列出来
 *
 * 用法：node scripts/upgrade-prompts.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { createWorkBuddyCloud } from "@tencent-ai/workbuddy-cloud-sdk";
import { PROMPTS } from "./official-prompts.mjs";

const cloud = createWorkBuddyCloud({
  endpoint: "https://super-agent-os.app.workbuddy.host",
  oauthRelayBaseUrl: "https://www.workbuddy.cn/v2/as/genie-baas/oauth",
  publishableKey: "wbpk_r1hMK5Enk0XVGpjJvncolP_XMyHEqD8JajXB1kUh62aV7E8rGgptkwU",
});

const { data: rows, error: readError } = await cloud.database
  .from("agent_templates")
  .select("id,code,name,role_prompt")
  .eq("is_official", true)
  .order("id");

if (readError) {
  console.error("读取模板失败：", readError.message);
  process.exit(1);
}

const backupFile = path.join(process.cwd(), "scripts", "prompt-backup.json");
if (!fs.existsSync(backupFile)) {
  fs.writeFileSync(backupFile, JSON.stringify(rows, null, 2), "utf8");
  console.log(`已备份旧提示词 → ${backupFile}`);
} else {
  console.log("备份已存在，跳过覆盖（避免用新版覆盖掉真正的旧版）");
}

let ok = 0;
const missing = [];
const failed = [];

for (const row of rows) {
  const next = PROMPTS[row.code];
  if (!next) {
    missing.push(`${row.name}(${row.code})`);
    continue;
  }
  const { error } = await cloud.database
    .from("agent_templates")
    .update({ role_prompt: next })
    .eq("id", row.id);
  if (error) {
    failed.push(`${row.code}: ${error.message}`);
    continue;
  }
  ok += 1;
  console.log(`✓ ${row.name.padEnd(10)} ${String((row.role_prompt ?? "").length).padStart(3)} 字 → ${next.length} 字`);
}

console.log(`\n完成：更新 ${ok}/${rows.length} 个模板`);
if (missing.length) console.log("没有对应新提示词（保持原样）：", missing.join("、"));
if (failed.length) {
  console.log("失败：");
  failed.forEach((item) => console.log("  -", item));
  process.exit(1);
}
