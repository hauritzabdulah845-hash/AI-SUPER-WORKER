const { createWorkBuddyCloud } = await import('@tencent-ai/workbuddy-cloud-sdk');
const cloud = createWorkBuddyCloud({
  endpoint: 'https://super-agent-os.app.workbuddy.host',
  oauthRelayBaseUrl: 'https://www.workbuddy.cn/v2/as/genie-baas/oauth',
  publishableKey: 'wbpk_r1hMK5Enk0XVGpjJvncolP_XMyHEqD8JajXB1kUh62aV7E8rGgptkwU',
});
const { data } = await cloud.database.from('tasks').select('id,title,goal,status,error,created_at').order('id', { ascending: false }).limit(2);
data.forEach((x) => console.log('#' + x.id, '| title:', x.title, '| status:', x.status, '| error:', (x.error || '无').slice(0, 40), '|', x.created_at));
