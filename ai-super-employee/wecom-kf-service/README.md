# wecom-kf-service · 微信客服自动回复服务

客户在微信里给「微信客服」发消息 → 本服务按规则回复指定内容，或推送 AI 名片小程序页面。

完整接入说明见 `../docs/企微AI名片自动回复-接入指南.md`。

## 快速开始

```bash
cp config.example.json config.json   # 填入企业的 corpid / 微信客服 Secret / Token / AESKey / 小程序 appid
npm start                            # 默认 http://127.0.0.1:8787
node test/run-test.mjs               # 本地全链路自测（mock，不真发消息）
```

## 配置项（config.json）

| 字段 | 必填 | 说明 |
|---|---|---|
| `corpId` | ✅ | 企业微信企业 ID |
| `kfSecret` | ✅ | 微信客服 Secret（应用管理 → 微信客服） |
| `token` | ✅ | 回调 Token，与企微后台一致 |
| `encodingAesKey` | ✅ | 43 位 EncodingAESKey |
| `miniAppId` | ✅ | AI 名片小程序 AppID |
| `miniTitle` / `miniPagePath` | ✅ | 小程序卡片标题与页面路径 |
| `miniThumbMediaId` | ⬜ | 小程序消息封面图 media_id（企微要求时再配） |
| `deepseekKey` + `aiFallback` | ⬜ | 规则未命中时用 AI 判断意图，默认关闭 |
| `adminSecret` | ✅ | 保护 `/api/sync` 与 `/admin/rules`，同时是控制台「企微客户同步」里要填的密钥 |
| `alertWebhook` | ⬜ | 企微群机器人 webhook 地址：客户阶段跃迁到「报价 / 成交 / 试用」时推送提醒（留空不启用） |

## 接口

- `GET /wecom/callback` — 企微回调 URL 验证（解密 echostr 回显）
- `POST /wecom/callback` — 消息事件：先回 success，再异步 `sync_msg` → 规则匹配 → `send_msg`
- `GET /health` — 健康检查
- `GET /admin/rules` — 查看当前规则与最近 20 条发送记录
- `GET /api/sync?since=N` — 客户档案 + 对话事件增量拉取（控制台用它做身份打通）

两个管理接口都用 `adminSecret` 鉴权，**推荐走请求头**（密钥不进 URL，避免落到浏览器历史与网关访问日志）：

```bash
curl -H "x-admin-secret: 你的adminSecret" "https://你的域名/api/sync?since=0"
```

为兼容旧调用方式，`?secret=xxx` 查询参数仍然有效。

## 客户档案（身份打通）

服务端在 `data/` 下维护两份文件：

- `customers.json` — 以 `external_userid` 为键的客户档案：首次/最近出现时间、消息数、最新一句、粗判阶段
- `events.json` — 对话事件流（`in` 客户发来 / `out` 我们回复），带自增 `seq`，最多保留 2000 条

控制台登录后调 `/api/sync?since=<游标>` 拉增量，用当前用户身份写入云端：客户落成 `leads`（`source=企业微信`、`external_userid` 建档），对话写成 `messages`（`role=kf_msg`、`task_id=线索id`），按 `seq` 去重，重复同步不会产生重复记录。

> 为什么不让服务端直接写云端：云端按登录身份隔离，服务端没有用户 session，写入只能落到 `owner_id="anon"`，用户在控制台看不到。所以服务端只管企微通道，落库由登录态的前端完成。

规则话术支持 `{{name}}` 变量：客户档案里有名字时替换为名字，否则用「你」。

## 规则（rules.json）

```json
[
  { "id": "card", "keywords": ["名片", "介绍", "你是谁"], "reply": { "type": "miniprogram" } },
  { "id": "price", "keywords": ["价格", "多少钱"], "reply": { "type": "text", "content": "…" } },
  { "id": "fallback", "isDefault": true, "reply": { "type": "text", "content": "…" } }
]
```

匹配规则：完全相等或包含关键词即命中，按数组顺序优先；都没命中走 `isDefault`。

## 部署

要求 Node 18+（依赖内置 fetch，无第三方包）。

```bash
PORT=8787 node src/server.mjs
```

- 需要公网 HTTPS 地址：把 `https://你的域名/wecom/callback` 填到企微「微信客服 → 接收消息服务器配置」
- 状态文件在 `data/state.json`（cursor 与消息去重集合），**部署时挂载持久化目录**，否则重启会重复回复
- 反代需透传原始 query（`msg_signature/timestamp/nonce/echostr`），不要改写路径

## 已知限制

- 只处理客户发送的文本消息（image/voice 等暂不回复）
- 群发主动推送不在本服务范围（企微限制每客户每月 4 条，需员工确认）
- 会话存档（读客户私聊内容）需要额外付费开通，未接入
