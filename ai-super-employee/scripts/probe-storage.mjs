const { createWorkBuddyCloud } = await import('@tencent-ai/workbuddy-cloud-sdk');
const cloud = createWorkBuddyCloud({
  endpoint: 'https://super-agent-os.app.workbuddy.host',
  oauthRelayBaseUrl: 'https://www.workbuddy.cn/v2/as/genie-baas/oauth',
  publishableKey: 'wbpk_r1hMK5Enk0XVGpjJvncolP_XMyHEqD8JajXB1kUh62aV7E8rGgptkwU',
});
// 1x1 透明 PNG
const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const buf = Buffer.from(b64, 'base64');
const up = await cloud.storage.upload('creative/probe.png', buf, { contentType: 'image/png' });
console.log('upload:', up.error ? 'FAIL ' + up.error.message : 'OK ' + JSON.stringify(up.data).slice(0, 200));
const list = await cloud.storage.list('creative');
console.log('list:', list.error ? 'FAIL ' + list.error.message : 'OK ' + JSON.stringify(list.data).slice(0, 300));
const url = await cloud.storage.createSignedUrl('creative/probe.png', 600);
console.log('signed:', url.error ? 'FAIL ' + url.error.message : 'OK ' + JSON.stringify(url.data).slice(0, 200));
const rm = await cloud.storage.remove(['creative/probe.png']);
console.log('remove:', rm.error ? 'FAIL ' + rm.error.message : 'OK');
