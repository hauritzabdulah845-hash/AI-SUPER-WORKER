const { createWorkBuddyCloud } = await import('@tencent-ai/workbuddy-cloud-sdk');
const cloud = createWorkBuddyCloud({
  endpoint: 'https://super-agent-os.app.workbuddy.host',
  oauthRelayBaseUrl: 'https://www.workbuddy.cn/v2/as/genie-baas/oauth',
  publishableKey: 'wbpk_r1hMK5Enk0XVGpjJvncolP_XMyHEqD8JajXB1kUh62aV7E8rGgptkwU',
});
const cases = [
  { tag: "img 无max_tokens", body: { model: 'hunyuan-image-alpha', stream: true, messages: [{ role: 'user', content: '一杯桂花乌龙茶，产品摄影' }] } },
  { tag: "img modalities", body: { model: 'hunyuan-image-alpha', stream: true, modalities: ['text', 'image'], messages: [{ role: 'user', content: '一杯桂花乌龙茶，产品摄影' }] } },
  { tag: "img edit 模型", body: { model: 'hunyuan-image-alpha-edit', stream: true, messages: [{ role: 'user', content: '一杯桂花乌龙茶，产品摄影' }] } },
];
for (const c of cases) {
  try {
    const r = await cloud.llm.chat.completions.create(c.body);
    let n = 0, first = null, imgs = [];
    for await (const chunk of r) {
      n++; if (!first) first = chunk;
      const s = JSON.stringify(chunk);
      const m = s.match(/data:image\/[a-z+]+;base64,[A-Za-z0-9+/=]{40,}/);
      if (m) imgs.push(m[0].slice(0, 50));
    }
    console.log(`[${c.tag}] OK chunks=${n} imgs=${imgs.length} first=${JSON.stringify(first).slice(0, 240)}`);
  } catch (e) {
    console.log(`[${c.tag}] ERR ${String(e?.message).slice(0, 200)}`);
  }
}
// 文本通道是否恢复
for (const model of ['deepseek-v4-flash', 'glm-5.3-flash']) {
  try {
    const r = await cloud.llm.chat.completions.create({ model, stream: true, messages: [{ role: 'user', content: '回复ok' }], max_tokens: 8 });
    let text = '';
    for await (const chunk of r) { const d = chunk?.choices?.[0]?.delta?.content; if (d) text += d; if (text.length > 6) break; }
    console.log(`[text ${model}] OK "${text.slice(0, 20)}"`);
  } catch (e) {
    console.log(`[text ${model}] ERR ${String(e?.message).slice(0, 120)}`);
  }
}
