/**
 * 多模型探测：判断 429 是账号级还是模型级。
 * 用法：node scripts/probe-models.mjs [model1 model2 ...]
 */
import { createWorkBuddyCloud } from "@tencent-ai/workbuddy-cloud-sdk";

const cloud = createWorkBuddyCloud({
  endpoint: "https://super-agent-os.app.workbuddy.host",
  oauthRelayBaseUrl: "https://www.workbuddy.cn/v2/as/genie-baas/oauth",
  publishableKey: "wbpk_r1hMK5Enk0XVGpjJvncolP_XMyHEqD8JajXB1kUh62aV7E8rGgptkwU",
});

const targets = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["deepseek-v4-flash", "hunyuan-chat", "minimax-m3.1-flash", "auto"];

for (const model of targets) {
  const started = Date.now();
  let text = "";
  try {
    const stream = await cloud.llm.chat.completions.create({
      model,
      messages: [{ role: "user", content: "用一句话说明你能为门店做什么。" }],
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 120,
    });
    for await (const chunk of stream) {
      const delta = chunk?.choices?.[0]?.delta?.content;
      if (delta) text += delta;
      if (Date.now() - started > 45000) break;
    }
    console.log(`[${model}] OK ${Date.now() - started}ms -> ${text.trim().slice(0, 90) || "(空回复)"}`);
  } catch (e) {
    console.log(`[${model}] FAIL ${Date.now() - started}ms status=${e?.status ?? "?"} -> ${String(e?.message ?? e).slice(0, 120)}`);
  }
  await new Promise((r) => setTimeout(r, 2500));
}
