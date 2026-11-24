/**
 * 流式实测：模拟 runner 的真实调用方式，验证能否产出内容。
 * 用法：node scripts/probe-stream.mjs
 */
import { createWorkBuddyCloud } from "@tencent-ai/workbuddy-cloud-sdk";

const cloud = createWorkBuddyCloud({
  endpoint: "https://super-agent-os.app.workbuddy.host",
  oauthRelayBaseUrl: "https://www.workbuddy.cn/v2/as/genie-baas/oauth",
  publishableKey: "wbpk_r1hMK5Enk0XVGpjJvncolP_XMyHEqD8JajXB1kUh62aV7E8rGgptkwU",
});

const started = Date.now();
let text = "";
let tokens = 0;
let chunks = 0;

try {
  const stream = await cloud.llm.chat.completions.create({
    model: "auto",
    messages: [
      { role: "system", content: "你是企业 AI 员工。用一句话给出可执行建议。" },
      { role: "user", content: "一家连锁咖啡店本周要提升复购率，给一条最重要的动作。" },
    ],
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: 200,
  });
  for await (const chunk of stream) {
    chunks += 1;
    const delta = chunk?.choices?.[0]?.delta?.content;
    if (delta) text += delta;
    if (chunk?.usage?.total_tokens) tokens = chunk.usage.total_tokens;
    if (Date.now() - started > 60000) {
      console.log("[timeout] 60s 未完成，已中断观察");
      break;
    }
  }
  const ms = Date.now() - started;
  console.log(`[stream] OK ${ms}ms chunks=${chunks} tokens=${tokens}`);
  console.log(`[content] ${text.trim().slice(0, 400)}`);
} catch (e) {
  console.log(`[stream] FAIL ${Date.now() - started}ms status=${e?.status ?? "?"}`);
  console.log(`[error] ${String(e?.message ?? e).slice(0, 400)}`);
}
