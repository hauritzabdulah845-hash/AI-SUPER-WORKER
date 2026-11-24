import { createWorkBuddyCloud } from "@tencent-ai/workbuddy-cloud-sdk";
const cloud = createWorkBuddyCloud({
  endpoint: "https://super-agent-os.app.workbuddy.host",
  oauthRelayBaseUrl: "https://www.workbuddy.cn/v2/as/genie-baas/oauth",
  publishableKey: "wbpk_r1hMK5Enk0XVGpjJvncolP_XMyHEqD8JajXB1kUh62aV7E8rGgptkwU",
});
const { data, error } = await cloud.database.from("demo_tasks").select("*").order("created_at", { ascending: false }).limit(3);
if (error) console.log("ERR", error.message);
(data ?? []).forEach((d) => {
  console.log("=".repeat(60));
  console.log(`#${d.id} ${d.title} | status=${d.status} progress=${d.progress} tokens=${d.tokens}`);
  console.log("error:", d.error);
  console.log("result:", JSON.stringify(d.result)?.slice(0, 500));
  console.log("steps:", JSON.stringify(d.steps)?.slice(0, 800));
});
