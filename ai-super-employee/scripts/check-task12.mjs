import { createWorkBuddyCloud } from "@tencent-ai/workbuddy-cloud-sdk";
const cloud = createWorkBuddyCloud({
  endpoint: "https://super-agent-os.app.workbuddy.host",
  oauthRelayBaseUrl: "https://www.workbuddy.cn/v2/as/genie-baas/oauth",
  publishableKey: "wbpk_r1hMK5Enk0XVGpjJvncolP_XMyHEqD8JajXB1kUh62aV7E8rGgptkwU",
});
const { data, error } = await cloud.database.from("tasks").select("*").eq("id", 12).limit(1);
if (error) { console.log("tasks ERR", error.message); process.exit(0); }
const d = data?.[0];
if (!d) { console.log("tasks 表无 #12"); } else {
  console.log(`#${d.id} ${d.title} | status=${d.status} progress=${d.progress} tokens=${d.tokens}`);
}
const steps = await cloud.database.from("task_steps").select("*").eq("task_id", 12).order("seq");
(steps.data ?? []).forEach(s => console.log(`  step${s.seq} [${s.agent}] ${s.status} 输出${(s.output||'').length}字 :: ${(s.output||'').slice(0,50).replace(/\n/g,' ')}`));
