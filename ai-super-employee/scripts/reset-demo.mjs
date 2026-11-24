/**
 * 清空 demo_tasks 全部记录（慎用）。
 * 用法：node scripts/reset-demo.mjs
 */
import { createWorkBuddyCloud } from "@tencent-ai/workbuddy-cloud-sdk";

const cloud = createWorkBuddyCloud({
  endpoint: "https://super-agent-os.app.workbuddy.host",
  oauthRelayBaseUrl: "https://www.workbuddy.cn/v2/as/genie-baas/oauth",
  publishableKey: "wbpk_r1hMK5Enk0XVGpjJvncolP_XMyHEqD8JajXB1kUh62aV7E8rGgptkwU",
});

const { data, error } = await cloud.database.from("demo_tasks").select("id,title");
if (error) {
  console.error("读取失败：", error.message);
  process.exit(1);
}
for (const row of data ?? []) {
  const { error: delError } = await cloud.database.from("demo_tasks").delete().eq("id", row.id);
  console.log(delError ? `删除 #${row.id} 失败：${delError.message}` : `已删除 #${row.id} ${row.title}`);
}
console.log(`共清理 ${data?.length ?? 0} 条。`);
