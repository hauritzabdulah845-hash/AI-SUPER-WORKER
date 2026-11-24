const { createWorkBuddyCloud } = await import('@tencent-ai/workbuddy-cloud-sdk');
const cloud = createWorkBuddyCloud({
  endpoint: 'https://super-agent-os.app.workbuddy.host',
  oauthRelayBaseUrl: 'https://www.workbuddy.cn/v2/as/genie-baas/oauth',
  publishableKey: 'wbpk_r1hMK5Enk0XVGpjJvncolP_XMyHEqD8JajXB1kUh62aV7E8rGgptkwU',
});
const r = await cloud.database.from('leads').delete().eq('name', '测试客户甲').select('id');
console.log('清理测试线索:', r.error ? 'FAIL ' + r.error.message : '删除 ' + (r.data?.length ?? 0) + ' 条');
