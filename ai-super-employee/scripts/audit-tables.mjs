import { createWorkBuddyCloud } from "@tencent-ai/workbuddy-cloud-sdk";
const cloud = createWorkBuddyCloud({
  endpoint: "https://super-agent-os.app.workbuddy.host",
  oauthRelayBaseUrl: "https://www.workbuddy.cn/v2/as/genie-baas/oauth",
  publishableKey: "wbpk_r1hMK5Enk0XVGpjJvncolP_XMyHEqD8JajXB1kUh62aV7E8rGgptkwU",
});
const tables = ["tasks", "task_steps", "leads", "knowledge_docs", "agents", "templates", "wecom_links"];
for (const t of tables) {
  const { data, error, count } = await cloud.database.from(t).select("*", { count: "exact" }).limit(1000);
  if (error) { console.log(`${t}: ERR ${error.message}`); continue; }
  console.log(`${t}: ${data?.length ?? 0}${count != null ? ` (count=${count})` : ""}`);
}
console.log("\n--- knowledge_docs 内容检查 ---");
const kb = await cloud.database.from("knowledge_docs").select("id,title,doc_type,content,chunks,created_at").order("created_at", { ascending: false }).limit(20);
(kb.data ?? []).forEach(d => console.log(`#${d.id} [${d.doc_type}] ${d.title} | content=${(d.content||"").length}字 chunks=${d.chunks}`));
console.log("\n--- tasks 概况 ---");
const tk = await cloud.database.from("tasks").select("id,title,status,progress,created_at").order("created_at", { ascending: false }).limit(12);
(tk.data ?? []).forEach(t => console.log(`#${t.id} ${t.status} ${t.progress}% ${t.title}`));
