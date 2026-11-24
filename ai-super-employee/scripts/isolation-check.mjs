/**
 * 数据隔离自检
 *
 * 判断标准：在「未登录」状态下，如果还能读到业务表的数据，说明这台环境
 * 只做了应用层过滤、没做数据库层 RLS —— 谁拿到公开密钥都能直接读走全表。
 *
 * 用法：node scripts/isolation-check.mjs
 */
import { createWorkBuddyCloud } from "@tencent-ai/workbuddy-cloud-sdk";

const cloud = createWorkBuddyCloud({
  endpoint: "https://super-agent-os.app.workbuddy.host",
  oauthRelayBaseUrl: "https://www.workbuddy.cn/v2/as/genie-baas/oauth",
  publishableKey: "wbpk_r1hMK5Enk0XVGpjJvncolP_XMyHEqD8JajXB1kUh62aV7E8rGgptkwU",
});

const PRIVATE_TABLES = [
  "tasks",
  "task_steps",
  "leads",
  "knowledge_docs",
  "agents",
  "wecom_links",
  "messages",
];

let leaked = 0;
let blocked = 0;

console.log("未登录状态下逐个尝试读取业务表：\n");

for (const table of PRIVATE_TABLES) {
  const { data, error } = await cloud.database.from(table).select("*").limit(200);
  if (error) {
    blocked += 1;
    console.log(`  ${table.padEnd(16)} 已阻断  (${error.message.slice(0, 60)})`);
    continue;
  }
  const rows = data ?? [];
  if (rows.length === 0) {
    blocked += 1;
    console.log(`  ${table.padEnd(16)} 无数据可读（视为已阻断）`);
  } else {
    leaked += 1;
    console.log(`  ${table.padEnd(16)} ⚠ 可读 ${rows.length} 行  ← 未隔离`);
  }
}

console.log("");
if (leaked === 0) {
  console.log("结论：数据库层已隔离，未登录无法读取任何业务数据。");
  process.exit(0);
}

console.log(`结论：${leaked}/${PRIVATE_TABLES.length} 张表可被未登录调用方直接读取。`);
console.log("      应用内不会串号（前端已按 owner_id 过滤），但绕开前端直接调接口仍能拿到数据。");
console.log("      需要在数据库层开启 RLS：执行 scripts/rls-isolation.sql。");
process.exit(1);
