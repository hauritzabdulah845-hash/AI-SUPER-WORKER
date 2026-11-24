const { createWorkBuddyCloud } = await import('@tencent-ai/workbuddy-cloud-sdk');
const cloud = createWorkBuddyCloud({
  endpoint: 'https://super-agent-os.app.workbuddy.host',
  oauthRelayBaseUrl: 'https://www.workbuddy.cn/v2/as/genie-baas/oauth',
  publishableKey: 'wbpk_r1hMK5Enk0XVGpjJvncolP_XMyHEqD8JajXB1kUh62aV7E8rGgptkwU',
});
const models = await cloud.llm.models.list();
console.log("可用模型:", (models||[]).map(m => m.id + (m.disabled ? "(disabled)" : "")).join(", "));

const cases = [
  { tag: "A stream+max_tokens", body: { model: 'hunyuan-image-alpha', stream: true, max_tokens: 1024, messages: [{ role: 'user', content: '一杯桂花乌龙茶' }] } },
  { tag: "B 非流式", body: { model: 'hunyuan-image-alpha', stream: false, messages: [{ role: 'user', content: '一杯桂花乌龙茶' }] } },
  { tag: "C 无 stream 字段", body: { model: 'hunyuan-image-alpha', messages: [{ role: 'user', content: '一杯桂花乌龙茶' }] } },
];
for (const c of cases) {
  try {
    const r = await cloud.llm.chat.completions.create(c.body);
    if (c.body.stream) {
      let n = 0, first = null;
      for await (const chunk of r) { n++; if (!first) first = chunk; }
      console.log(`[${c.tag}] OK chunks=${n} first=${JSON.stringify(first).slice(0, 300)}`);
    } else {
      console.log(`[${c.tag}] OK ${JSON.stringify(r).slice(0, 300)}`);
    }
  } catch (e) {
    console.log(`[${c.tag}] ERR status=${e?.status ?? ''} ${String(e?.message).slice(0, 220)}`);
  }
}
