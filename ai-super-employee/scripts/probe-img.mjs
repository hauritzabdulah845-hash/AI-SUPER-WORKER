const { createWorkBuddyCloud } = await import('@tencent-ai/workbuddy-cloud-sdk');
const cloud = createWorkBuddyCloud({
  endpoint: 'https://super-agent-os.app.workbuddy.host',
  oauthRelayBaseUrl: 'https://www.workbuddy.cn/v2/as/genie-baas/oauth',
  publishableKey: 'wbpk_r1hMK5Enk0XVGpjJvncolP_XMyHEqD8JajXB1kUh62aV7E8rGgptkwU',
});
try {
  const stream = await cloud.llm.chat.completions.create({
    model: 'hunyuan-image-alpha',
    stream: true,
    messages: [{ role: 'user', content: '一只橘猫坐在窗台上，日光，写实摄影风格' }],
  });
  let n = 0;
  const samples = [];
  for await (const chunk of stream) {
    n++;
    if (samples.length < 6) samples.push(JSON.stringify(chunk).slice(0, 400));
  }
  console.log('chunks:', n);
  samples.forEach((s, i) => console.log('[' + i + ']', s));
} catch (e) {
  console.log('ERR', e?.status ?? '', e?.message?.slice(0, 400));
}
