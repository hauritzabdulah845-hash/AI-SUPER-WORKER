/**
 * 现状检查：只读统计各表数据量与最近记录，不写任何数据。
 * 用法：node scripts/check-state.mjs
 */
import { createWorkBuddyCloud } from "@tencent-ai/workbuddy-cloud-sdk";

const cloud = createWorkBuddyCloud({
  endpoint: "https://super-agent-os.app.workbuddy.host",
  oauthRelayBaseUrl: "https://www.workbuddy.cn/v2/as/genie-baas/oauth",
  publishableKey: "wbpk_r1hMK5Enk0XVGpjJvncolP_XMyHEqD8JajXB1kUh62aV7E8rGgptkwU",
});

const tables = ["agent_templates", "agents", "tasks", "task_steps", "demo_tasks", "leads", "knowledge_docs", "wecom_links", "messages"];

for (const table of tables) {
  const { data, error, count } = await cloud.database.from(table).select("*", { count: "exact", head: true });
  if (error) {
    console.log(`${table.padEnd(16)} ERROR ${error.message}`);
    continue;
  }
  console.log(`${table.padEnd(16)} rows=${count ?? (data ? data.length : "?")}`);
}

const { data: templates } = await cloud.database.from("agent_templates").select("code,name,domain").order("id");
console.log("\ntemplates:", templates?.length, (templates ?? []).map((t) => t.name).join(" / "));

const { data: demos } = await cloud.database.from("demo_tasks").select("id,title,status,progress,tokens,created_at").order("created_at", { ascending: false }).limit(5);
console.log("\nlatest demo_tasks:");
(demos ?? []).forEach((d) => console.log(`  #${d.id} ${d.status} ${d.progress}% ${d.tokens ?? 0}t ${d.created_at} ${d.title}`));

const { data: leads } = await cloud.database.from("leads").select("name,intent,stage").limit(5);
console.log("\nleads sample:", JSON.stringify(leads));
