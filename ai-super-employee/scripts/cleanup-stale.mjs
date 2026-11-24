import { createWorkBuddyCloud } from "@tencent-ai/workbuddy-cloud-sdk";
const cloud = createWorkBuddyCloud({
  endpoint: "https://super-agent-os.app.workbuddy.host",
  oauthRelayBaseUrl: "https://www.workbuddy.cn/v2/as/genie-baas/oauth",
  publishableKey: "wbpk_r1hMK5Enk0XVGpjJvncolP_XMyHEqD8JajXB1kUh62aV7E8rGgptkwU",
});
const { data } = await cloud.database.from("tasks").select("id,status,progress").eq("status", "running");
for (const row of data ?? []) {
  const { error } = await cloud.database.from("tasks").update({
    status: "failed",
    progress: 100,
    error: "任务执行被中断（页面刷新或关闭），点「重跑任务」即可重新执行。",
    finished_at: new Date().toISOString(),
  }).eq("id", row.id);
  console.log(`#${row.id} -> ${error ? "ERR " + error.message : "已标记中断"}`);
}
if (!(data ?? []).length) console.log("没有僵尸任务");
