const { createWorkBuddyCloud } = await import('@tencent-ai/workbuddy-cloud-sdk');
const cloud = createWorkBuddyCloud({
  endpoint: 'https://super-agent-os.app.workbuddy.host',
  oauthRelayBaseUrl: 'https://www.workbuddy.cn/v2/as/genie-baas/oauth',
  publishableKey: 'wbpk_r1hMK5Enk0XVGpjJvncolP_XMyHEqD8JajXB1kUh62aV7E8rGgptkwU',
});
const fixes = [
  { id: 8, title: '整理本周新增线索并排序' },
  { id: 7, title: '连锁餐饮7天新品营销计划' },
];
const errText = '全部步骤未执行：模型通道不可用（配额用尽或 Key 未配置），修复后可一键重跑。';
for (const f of fixes) {
  const r = await cloud.database.from('tasks').update({ title: f.title, error: errText }).eq('id', f.id).select('id,title');
  console.log('#' + f.id, r.error ? 'FAIL ' + r.error.message : 'ok -> ' + r.data?.[0]?.title);
}
