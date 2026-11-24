const res = await fetch('https://super-agent-os.app.workbuddy.host/.cloud/llm/chat/completions', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    authorization: 'Bearer wbpk_r1hMK5Enk0XVGpjJvncolP_XMyHEqD8JajXB1kUh62aV7E8rGgptkwU',
    'x-app-id': 'wbapp_r1hMK5Enk0XVGpjJvncolP',
  },
  body: JSON.stringify({ model: 'deepseek-v4-flash', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
});
console.log('status', res.status);
for (const [k, v] of res.headers) console.log(' ', k + ':', v);
console.log('body', (await res.text()).slice(0, 400));
