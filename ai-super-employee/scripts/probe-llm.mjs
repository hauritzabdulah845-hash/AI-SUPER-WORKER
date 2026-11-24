/**
 * 实测平台 LLM 是否可用（只读，不写数据库）。
 * 用法：node scripts/probe-llm.mjs
 * 依次尝试：列出模型 -> 3 次最小对话调用，输出每次耗时与错误码。
 */
import { createWorkBuddyCloud } from "@tencent-ai/workbuddy-cloud-sdk";

const cloud = createWorkBuddyCloud({
  endpoint: "https://super-agent-os.app.workbuddy.host",
  oauthRelayBaseUrl: "https://www.workbuddy.cn/v2/as/genie-baas/oauth",
  publishableKey: "wbpk_r1hMK5Enk0XVGpjJvncolP_XMyHEqD8JajXB1kUh62aV7E8rGgptkwU",
});

const t0 = Date.now();
try {
  const models = await cloud.llm.models.list();
  const list = models?.data ?? models ?? [];
  console.log(`[models] OK ${Date.now() - t0}ms ->`, JSON.stringify(list).slice(0, 300));
} catch (e) {
  console.log(`[models] FAIL ${Date.now() - t0}ms ->`, e?.status ?? "", e?.message ?? e);
}

for (let i = 1; i <= 3; i++) {
  const s = Date.now();
  try {
    const res = await cloud.llm.chat.completions.create({
      messages: [
        { role: "system", content: "只回答一个词。" },
        { role: "user", content: "用一个词回答：你好" },
      ],
      max_tokens: 16,
      temperature: 0,
    });
    const text = res?.choices?.[0]?.message?.content;
    console.log(`[call#${i}] OK ${Date.now() - s}ms ->`, JSON.stringify(text));
  } catch (e) {
    console.log(`[call#${i}] FAIL ${Date.now() - s}ms -> status=${e?.status ?? "?"} ${String(e?.message ?? e).slice(0, 200)}`);
  }
  if (i < 3) await new Promise((r) => setTimeout(r, 3000));
}
