const { createWorkBuddyCloud } = await import('@tencent-ai/workbuddy-cloud-sdk');
const cloud = createWorkBuddyCloud({
  endpoint: 'https://super-agent-os.app.workbuddy.host',
  oauthRelayBaseUrl: 'https://www.workbuddy.cn/v2/as/genie-baas/oauth',
  publishableKey: 'wbpk_r1hMK5Enk0XVGpjJvncolP_XMyHEqD8JajXB1kUh62aV7E8rGgptkwU',
});
const { data } = await cloud.database.from('leads').select('id,name,stage,need,created_at').order('id', { ascending: false }).limit(4);
data.forEach((x) => console.log('#' + x.id, '|', x.name, '|', x.stage, '|', (x.need || '').slice(0, 20), '|', x.created_at));
