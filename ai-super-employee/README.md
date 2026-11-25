# AI 超级员工 · SUPER AGENT OS

把目标交给 AI，把结果带回企业。不是又一个聊天工具，而是一支懂业务、会协作、能交付的 AI 团队：
从内容、获客到成交与复盘，一个指令驱动完整工作流，关键动作可审批、执行过程可追溯。

技术形态：**Web 控制台 + WorkBuddy 云端 + 本机侧车服务**，无桌面安装负担；
所有第三方能力走适配器，**无 Key 时演示/降级可用，填上 Key 同一表单直接出真结果**（先开发功能，接入后续）。

## 控制台模块（26 个，深链 `#/console/<slug>`）

| 分组 | 模块（slug） |
|---|---|
| 工作台 | AI 总控 `overview` · 远程指令 `im` · 智能体团队 `agents` · 任务中心 `tasks` · 定时任务 `pipeline` · 模板中心 `templates` · AI 会议 `meeting` |
| 销售 | 线索与客户 `leads` · 地图获客 `mapleads` · 企微私域 `wecom` · 群发计划 `broadcast` · 客服渠道 `service` · GEO 工作台 `geo` · 数据洞察 `insights` |
| 内容 | 内容工厂 `content` · 聚合发布 `publish` · 企业知识库 `knowledge` · AI 创作 `studio` · 视频创作 `video` · 混剪工坊 `mixcut` · 数字人工坊 `digital` · AI 办公 `office` |
| 设置 | 模型接入 `channels` · 企业设置 `settings` · 合同审查 `contract` · AI 人事 `hr` |

模块与 slug 的映射在 `src/nav.ts`，侧栏分组在 `src/components/Console.tsx`。

## 架构

```
浏览器控制台（React 19 + TypeScript + Vite）
  ├─ src/cloud/        能力层：任务编排 / 知识库 / 线索 / 视频 / 数字人 / GEO / 会议 / 人事 …
  ├─ src/components/   界面：Console 总控台 + 各模块 Studio/Center
  └─ 本机存储          localStorage（配置/计划）+ IndexedDB（素材/作品），密钥不上云
        │
        ├─ WorkBuddy 云端（@tencent-ai/workbuddy-cloud-sdk）：账号隔离、任务/线索/知识库落库、平台模型通道
        ├─ wecom-kf-service/  企微客服与群发（零依赖 Node，官方 API）
        ├─ im-bot-gateway/    飞书/HTTP 远程指令网关（零依赖 Node，只收排不执行）
        └─ scheduler-worker/  常驻调度骨架（零依赖 Node，只存计划/算到期/记历史，不代跑）
```

安全边界：服务端永远没有账号 session，**不代替账号执行任务**；执行只发生在登录态控制台，
高风险动作（群发等）需人工审批。详见各侧车 README 与 `docs/功能差距清单与路线图.md`。

## 快速开始

```bash
cd ai-super-employee
npm install
npm run dev        # 开发（Vite，默认 http://localhost:5173）
npm run build      # 生产构建（tsc + vite，产物在 dist/）
npm run preview    # 预览生产构建
npm run lint       # ESLint（应为 0 error）
```

侧车服务（按需启动，各自目录有 README）：

```bash
cd wecom-kf-service  && cp config.example.json config.json && npm start
cd im-bot-gateway    && cp config.example.json config.json && npm start
cd scheduler-worker  && cp config.example.json config.json && npm start
```

## 目录结构

```
ai-super-employee/
├── src/
│   ├── App.tsx / main.tsx     官网 + 路由（hash 深链）
│   ├── nav.ts                 模块 ↔ slug 映射
│   ├── cloud/                 能力层（纯逻辑 + 适配器 + 本机存储）
│   └── components/            Console 总控台 + 各模块界面（ui/ 为 shadcn 组件）
├── scripts/                   自测与验收脚本（tsx/node 直跑，无测试框架）
├── docs/                      差距清单与路线图、接入指南、验收清单
├── wecom-kf-service/          企微客服/群发/名单服务
├── im-bot-gateway/            IM 远程指令网关
└── scheduler-worker/          常驻调度 worker（骨架）
```

## 测试

全部是可执行自测脚本（断言计数 + 退出码），改完对应模块跑对应套件，提交前至少跑 lint + build：

| 命令 | 覆盖 |
|---|---|
| `npm run test:pipeline` | 定时流水线到期判定/补跑/报表分桶 |
| `npm run test:scheduler` | 常驻调度 worker 全链路（鉴权/同步/到期/回写/上限） |
| `npm run test:settings` / `test:contract` | 企业设置 / 合同审查 |
| `npm run test:meeting` / `test:hr` | AI 会议 / AI 人事 |
| `npm run test:digital` / `test:mixcut` / `test:style` / `test:analysis` | 数字人 / 混剪 / 字幕样式 / 素材分析 |
| `npm run test:office` / `test:zip` | PPT/文档真实渲染 / 交付物打包字节校验 |
| `npm run test:kf` / `test:ops` / `test:ops2` / `test:ops3` | 客服规则与名单 / 审批与导入 / 检索与用量 / 打包与排序 |
| `npm run test:geotrack` / `test:geomstore` | GEO 提及率趋势 / 监测存储 |
| `npm run test:font` / `test:sidebar` / `test:modal` / `test:modallayout` | 字号地板 / 侧栏 / 弹窗行为与布局 |

## 接入清单（配置后置）

真实 Key、平台授权、云端执行身份等「拿到才能接」的事，统一收在
[`docs/功能差距清单与路线图.md`](docs/功能差距清单与路线图.md) 每批的「接入清单」小节里，
逐项销账，不阻塞功能开发。当前大项：视频/TTS/数字人厂商 Key、企微真环境参数、
抖音企业号授权、会议转写与招聘平台授权、常驻调度云端代跑身份。

## 合规边界（明确不做）

- 不做个人微信 RPA / 协议加好友 / 批量私信 / 朋友圈自动化（封号 + 违反平台协议）；
  只走企业微信官方 API 与「留资 → 线索 → 官方触达」合规路径。
- 聚合发布为半自动：AI 写稿、人工上传，不调用任何平台非官方接口。
- 声音/形象只用官方音色与授权自录素材，不克隆他人；合同/简历结论为 AI 初筛，需人工复核。
- 密钥与客户数据只存本机（localStorage / 侧车 `config.json` + `data/`，均已 gitignore），绝不入库。
