# im-bot-gateway · IM 远程指令网关

在飞书或任意 IM 里一句话下达指令 → 网关排队 → 控制台「远程指令」收件 → **用户确认后用登录身份执行**。

> 设计约束：网关**不执行任务**。任务、线索、知识库都必须归属到登录账号，
> 服务端没有账号 session，代执行会破坏多租户隔离。网关只做「收、排、回状态」。

## 快速开始（现在就能用，无需飞书凭据）

```bash
cd im-bot-gateway
cp config.example.json config.json   # 填 adminSecret
npm start                            # 默认 http://127.0.0.1:8788
node test/run-test.mjs               # 本地全链路自测（16 项）
```

下发一条指令（任何 IM 桥、脚本、curl 都可以走这个入口）：

```bash
curl -X POST "http://127.0.0.1:8788/api/command?secret=你的adminSecret" \
  -H "Content-Type: application/json" \
  -d '{"text":"帮我生成本周内容排期"}'
```

然后打开控制台 →「远程指令」→ 点「在控制台执行」。

## 配置项（config.json）

| 字段 | 必填 | 说明 |
|---|---|---|
| `adminSecret` | ✅ | 保护 `/api/command`、`/api/commands`、`/api/commands/update`，也是控制台「网关配置」里要填的密钥 |
| `feishuVerificationToken` | 飞书接入时必填 | 飞书事件订阅的 Verification Token（明文模式校验用） |
| `feishuEncryptKey` | 可选 | 填了就走加密回调（AES-256-CBC）+ 签名校验；不填则明文模式 |
| `port` | ⬜ | 默认 8788，可用环境变量 `PORT` 覆盖 |

支持环境变量：`PORT` / `ADMIN_SECRET` / `FEISHU_VERIFICATION_TOKEN` / `FEISHU_ENCRYPT_KEY`。

## 接口

- `GET /health` — 健康检查（返回待处理数量）
- `POST /api/command?secret=xxx` — 通用 HTTP 指令入口：`{text, source?, from?, eventId?}`；`eventId` 用于幂等
- `GET /api/commands?secret=xxx&since=0&status=pending` — 拉取队列（`since` 为已见最大 id）
- `POST /api/commands/update?secret=xxx` — 回写状态 `{id, status: pending|done|dismissed}`
- `POST /feishu/event` — 飞书事件订阅回调（`url_verification` 挑战 + `im.message.receive_v1` 文本消息）

鉴权优先走请求头 `x-admin-secret`（密钥不进 URL），`?secret=` 兼容保留。

## 飞书接入步骤（凭据到位后，预计 15 分钟）

1. [飞书开放平台](https://open.feishu.cn/) 创建**企业自建应用**
2. 「事件与回调 → 回调配置」填：`https://你的域名/feishu/event`
   - **先用明文模式**打通（把 Verification Token 填进 config.json），成功后再开 Encrypt Key 切加密模式
3. 「事件订阅」添加 `im.message.receive_v1`（接收消息）
4. 应用需要 `im:message` 相关权限并发布版本
5. 在群里 @ 机器人 发文字指令 → 控制台「远程指令」刷新即可看到

### 已实现的协议细节（按飞书公开文档，接入时如不符以最新文档为准）

- 明文挑战：`{type:"url_verification", challenge, token}` → 回 `{challenge}`，token 必须匹配
- 加密报文：`{encrypt:"<base64>"}`，AES-256-CBC，key = SHA256(encryptKey) 原始 32 字节，iv = 前 16 字节，PKCS7
- 签名：`X-Lark-Signature = SHA1(timestamp + nonce + encryptKey + 原始body)` 十六进制
- 文本抽取：去掉 `@_user_N` 占位；非文本消息入队为「暂不支持」占位，不猜测内容

## 与控制台的关系

「远程指令」模块（`src/components/CommandInbox.tsx`）把网关地址与密钥存本机
（localStorage key `ai-employee:im-inbox`），拉队列、回状态都由登录态前端完成——
与企微客户同步（KfSyncCard）同一套架构：**服务端只存事实，落库与执行归账号**。
