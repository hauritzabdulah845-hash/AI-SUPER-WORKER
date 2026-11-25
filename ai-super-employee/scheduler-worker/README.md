# scheduler-worker · 常驻调度 worker（骨架）

把控制台「定时任务」的计划镜像到一个常驻小服务上：**存计划、算到期、记历史、心跳**。

> ⚠ 边界（先说清）：本服务**不代跑需登录态的 LLM 任务**（与 `im-bot-gateway` 一致，
> 服务端没有账号 session，代跑会破坏多租户隔离）。关页面期间到期计划会积压，
> 页面重开时前端拉 `/api/due` 补跑并回写运行记录。真 7×24 代跑需要云端执行身份，
> 后置，见 `docs/功能差距清单与路线图.md` 第二十九章接入清单——本骨架不冒充已实现。

## 快速开始

```bash
cd scheduler-worker
cp config.example.json config.json   # 填 adminSecret
npm start                            # 默认 http://127.0.0.1:8789
node test/run-test.mjs               # 本地全链路自测
```

然后打开控制台 →「定时任务」→「常驻调度」卡 → 填服务地址 + adminSecret → 点「同步计划」。

## 配置项（config.json）

| 字段 | 必填 | 说明 |
|---|---|---|
| `adminSecret` | ✅ | 保护全部 `/api/*`，也是控制台「常驻调度」卡里要填的密钥 |
| `port` | ⬜ | 默认 8789，可用环境变量 `PORT` 覆盖 |
| `dataDir` | ⬜ | 默认 `./data`（计划与运行历史 JSON，勿入库） |

支持环境变量：`PORT` / `ADMIN_SECRET`。

## 接口

- `GET /health` — 心跳（版本、运行时长、计划/启用/历史计数，无需鉴权）
- `POST /api/schedules` — 整表同步计划 `{ schedules: [...] }`（前端是真源，worker 镜像调度字段并保留已回填的 `lastRunAt`）
- `GET /api/schedules` — 读回已同步计划
- `GET /api/due?now=` — 当前到期计划（`now` 可注入时间戳便于联调，缺省用服务器时间）
- `POST /api/runs` — 前端执行后回写 `{ scheduleId, at, status, durationMs, steps }`
- `GET /api/runs?limit=` — 运行历史（上限 200）

鉴权优先走请求头 `x-admin-secret`（密钥不进 URL），`?secret=` 兼容保留；常数时间比较。

## 与前端的关系

- 前端真源仍是本机 `localStorage` 的 `ai-employee:pipelines`；worker 只是镜像 + 到期计算 + 历史留档。
- 到期语义与前端 `src/cloud/pipeline.ts` 的 `isDue` 完全对齐（每日 HH:MM 补跑一次、间隔满 N 小时、停用/空步骤不触发）。
  服务端在 `src/schedule.mjs` 重写了一份——**双份维护点**：改语义时两边同步改，并跑 `test:pipeline` 与本自测。
- 前端对接代码：`src/cloud/scheduler.ts`（配置存本机 `ai-employee:scheduler`）。

## 部署常驻（后续）

骨架阶段在本机 `npm start` 即可。正式常驻可用 pm2 / systemd / Docker 把本目录跑起来，
再把服务地址换成你的域名（HTTPS 反代后填进控制台）。云端代跑身份未接入前，
常驻的价值是「计划与历史不丢、到期可查」，不是「关页面自动执行」。
