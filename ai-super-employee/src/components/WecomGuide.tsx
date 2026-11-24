import { useEffect, useMemo, useState, type ReactNode } from "react";
import { AlertTriangle, Check, ChevronDown, Copy, Download, Plug, RefreshCw, Server, Sparkles } from "lucide-react";

/**
 * 企业微信接入向导。
 *
 * 两条通道：
 *  A 客户联系·欢迎语——客户首次加好友自动发文字 + AI 名片小程序卡片，零开发。
 *  B 微信客服·自动回复——客户发消息由 wecom-kf-service 按规则回内容/名片，需部署服务。
 *
 * 参数与勾选进度保存在本机浏览器（含密钥），不上传云端；生成的 config.json 需放到服务端。
 */

const STORAGE_KEY = "ai-employee:wecom-onboarding-v1";

interface KfFields {
  corpId: string;
  kfSecret: string;
  openKfId: string;
  token: string;
  encodingAesKey: string;
  miniAppId: string;
  miniTitle: string;
  miniPagePath: string;
  callbackHost: string;
  adminSecret: string;
}

const EMPTY_FIELDS: KfFields = {
  corpId: "",
  kfSecret: "",
  openKfId: "",
  token: "",
  encodingAesKey: "",
  miniAppId: "",
  miniTitle: "AI 名片",
  miniPagePath: "pages/card/index",
  callbackHost: "",
  adminSecret: "",
};

interface OnboardState {
  channel: "welcome" | "kf";
  fields: KfFields;
  done: Record<string, boolean>;
}

function loadState(): OnboardState {
  const fallback: OnboardState = { channel: "welcome", fields: EMPTY_FIELDS, done: {} };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<OnboardState>;
    return {
      channel: parsed.channel === "kf" ? "kf" : "welcome",
      fields: { ...EMPTY_FIELDS, ...(parsed.fields ?? {}) },
      done: parsed.done ?? {},
    };
  } catch {
    return fallback;
  }
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    document.execCommand("copy");
    document.body.removeChild(area);
    return true;
  }
}

function randomToken(length = 20) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  const bytes = new Uint32Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (n) => chars[n % chars.length]).join("");
}

interface StepProps {
  index: number;
  title: string;
  where: string;
  open: boolean;
  done: boolean;
  onToggle: () => void;
  onDone: (value: boolean) => void;
  children: ReactNode;
}

function Step({ index, title, where, open, done, onToggle, onDone, children }: StepProps) {
  return (
    <div className={`wo-step${open ? " open" : ""}${done ? " done" : ""}`}>
      <button type="button" className="wo-step-head" onClick={onToggle} aria-expanded={open}>
        <span className="wo-step-no">{done ? <Check size={13} /> : index}</span>
        <span className="wo-step-title">
          <strong>{title}</strong>
          <small>{where}</small>
        </span>
        <span className={`wo-step-state${done ? " done" : ""}`}>{done ? "已完成" : "待完成"}</span>
        <ChevronDown className="wo-step-caret" size={15} />
      </button>
      {open && (
        <div className="wo-step-body">
          {children}
          <label className="wo-check">
            <input type="checkbox" checked={done} onChange={(event) => onDone(event.target.checked)} />
            这一步我已经做完了
          </label>
        </div>
      )}
    </div>
  );
}

function Note({ tone = "info", children }: { tone?: "info" | "warn"; children: ReactNode }) {
  return (
    <p className={`wo-note ${tone}`}>
      {tone === "warn" ? <AlertTriangle size={13} /> : <Sparkles size={13} />}
      <span>{children}</span>
    </p>
  );
}

export function WecomGuide({ onToast }: { onToast: (message: string) => void }) {
  const [state, setState] = useState<OnboardState>(() => loadState());
  const [open, setOpen] = useState(1);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // 隐私模式下写入失败不影响使用
    }
  }, [state]);

  const { channel, fields, done } = state;

  const setField = (key: keyof KfFields, value: string) =>
    setState((current) => ({ ...current, fields: { ...current.fields, [key]: value } }));

  const mark = (key: string, value: boolean) =>
    setState((current) => ({ ...current, done: { ...current.done, [key]: value } }));

  const welcomeKeys = ["w1", "w2", "w3", "w4"];
  const kfKeys = ["k1", "k2", "k3", "k4", "k5", "k6"];
  const keys = channel === "welcome" ? welcomeKeys : kfKeys;
  const finished = keys.filter((key) => done[key]).length;
  const percent = Math.round((finished / keys.length) * 100);

  const callbackUrl = useMemo(() => {
    const host = fields.callbackHost.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    return host ? `https://${host}/wecom/callback` : "https://你的域名/wecom/callback";
  }, [fields.callbackHost]);

  const missing = useMemo(() => {
    const list: string[] = [];
    if (!fields.corpId.trim()) list.push("企业 ID");
    if (!fields.kfSecret.trim()) list.push("微信客服 Secret");
    if (!fields.openKfId.trim()) list.push("客服账号 ID");
    if (fields.encodingAesKey.trim().length !== 43) list.push("43 位 EncodingAESKey");
    if (!fields.token.trim()) list.push("回调 Token");
    if (!fields.miniAppId.trim()) list.push("小程序 AppID");
    if (!fields.adminSecret.trim()) list.push("同步密钥");
    return list;
  }, [fields]);

  const downloadConfig = () => {
    if (missing.length > 0) {
      onToast(`还缺：${missing.join("、")}`);
      return;
    }
    const config = {
      port: 8787,
      corpId: fields.corpId.trim(),
      kfSecret: fields.kfSecret.trim(),
      token: fields.token.trim(),
      encodingAesKey: fields.encodingAesKey.trim(),
      miniAppId: fields.miniAppId.trim(),
      miniTitle: fields.miniTitle.trim() || "AI 名片",
      miniPagePath: fields.miniPagePath.trim() || "pages/card/index",
      adminSecret: fields.adminSecret.trim(),
      miniThumbMediaId: "",
      deepseekKey: "",
      aiFallback: false,
      mock: false,
    };
    const blob = new Blob([JSON.stringify(config, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "config.json";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    onToast("config.json 已下载，放到 wecom-kf-service/config.json");
  };

  const copyCommand = async () => {
    await copyText("cd wecom-kf-service\nnode src/server.mjs");
    onToast("启动命令已复制");
  };

  const copyValue = async (value: string, label: string) => {
    if (!value.trim()) {
      onToast(`${label}还没填`);
      return;
    }
    await copyText(value.trim());
    onToast(`${label}已复制`);
  };

  const stepProps = (key: string, index: number, title: string, where: string) => ({
    index,
    title,
    where,
    open: open === index,
    done: Boolean(done[key]),
    onToggle: () => setOpen(open === index ? -1 : index),
    onDone: (value: boolean) => mark(key, value),
  });

  return (
    <section className="console-card wo-card">
      <div className="wo-head">
        <span className="wo-head-icon"><Plug size={20} /></span>
        <div>
          <h2>接入企业微信</h2>
          <p>按步骤走完就能真正跑通：A 通道零开发今天生效，B 通道需部署本项目自带的回复服务。</p>
        </div>
        <div className="wo-progress">
          <span>{finished}/{keys.length} 步</span>
          <div className="wo-progress-bar"><i style={{ width: `${percent}%` }} /></div>
        </div>
      </div>

      <div className="wo-channels">
        <button
          type="button"
          className={`wo-channel${channel === "welcome" ? " active" : ""}`}
          onClick={() => { setState((current) => ({ ...current, channel: "welcome" })); setOpen(1); }}
        >
          <span className="wo-channel-tag">通道 A · 零开发</span>
          <strong>客户联系 · 欢迎语</strong>
          <p>客户首次加好友，自动收到文字介绍 + AI 名片小程序卡片。不用服务器，在企微后台点几下就行。</p>
          <span className="wo-channel-meta">4 步 · 约 10 分钟 · {welcomeKeys.filter((k) => done[k]).length}/4 已完成</span>
        </button>
        <button
          type="button"
          className={`wo-channel${channel === "kf" ? " active" : ""}`}
          onClick={() => { setState((current) => ({ ...current, channel: "kf" })); setOpen(1); }}
        >
          <span className="wo-channel-tag alt">通道 B · 需服务器</span>
          <strong>微信客服 · 自动回复</strong>
          <p>客户发消息后按关键词自动回指定内容或 AI 名片，可开 AI 意图兜底。回复服务已随项目提供。</p>
          <span className="wo-channel-meta">6 步 · 约 40 分钟 · {kfKeys.filter((k) => done[k]).length}/6 已完成</span>
        </button>
      </div>

      {channel === "welcome" && (
        <div className="wo-steps">
          <Step {...stepProps("w1", 1, "确认小程序与企微能关联", "微信公众平台 + 企微后台 · 一次性检查")}>
            <ol className="wo-list">
              <li>小程序已在微信公众平台<strong>发布上线</strong>（体验版 / 开发版发不出卡片）。路径：mp.weixin.qq.com → 管理 → 版本管理。</li>
              <li>小程序与企微<strong>同主体</strong>，或已在小程序后台「设置 → 关联设置」关联到该企业微信。</li>
              <li>操作人拥有企微「客户联系」权限（超级管理员，或已被授权的业务负责人）。</li>
            </ol>
            <Note>自检办法：下面第 3 步在企微后台选小程序时，能在列表里搜到你的 AI 名片，说明前置条件已满足。</Note>
          </Step>

          <Step {...stepProps("w2", 2, "配置文字欢迎语", "work.weixin.qq.com → 客户与上下游 → 客户联系 → 欢迎语")}>
            <ol className="wo-list">
              <li>进入「欢迎语」→ 点「配置欢迎语」→ 选择使用范围（全员 / 指定成员）。</li>
              <li>点「添加文字」，粘一段自我介绍 + 引导语，参考下面这段：</li>
            </ol>
            <div className="wo-snippet">
              <pre>你好，我是（姓名），负责（业务）。点开下面的名片，可以看到我们能帮你做的具体事项和过往案例；有想了解的直接在这里说，我随时回。</pre>
              <button type="button" className="wo-copy" onClick={async () => { await copyText("你好，我是…，负责…。点开下面的名片，可以看到我们能帮你做的具体事项和过往案例；有想了解的直接在这里说，我随时回。"); onToast("欢迎语文案已复制"); }}><Copy size={13} />复制</button>
            </div>
            <Note tone="warn">欢迎语只在客户<strong>首次添加</strong>成员时触发；已在好友列表里的老客户不会再收到，别用它做日常推送。</Note>
          </Step>

          <Step {...stepProps("w3", 3, "加入 AI 名片小程序卡片", "同一配置页 → 添加内容 → 小程序")}>
            <ol className="wo-list">
              <li>点「添加内容」→ 选「小程序」→ 在列表中选中你的 AI 名片小程序。</li>
              <li>标题填「我的 AI 名片」（建议 ≤ 14 字，长了会被截断）。</li>
              <li>页面路径填名片页，例如 <code>pages/card/index</code>，必须是小程序里真实存在的页面，否则点击白屏。</li>
              <li>上传封面图（建议 520×416），保存并确认使用范围。</li>
            </ol>
            {fields.miniPagePath.trim() && (
              <Note>当前登记的名片页路径：<code>{fields.miniPagePath}</code>（在通道 B 的参数里可改）</Note>
            )}
          </Step>

          <Step {...stepProps("w4", 4, "用真实微信号验证一次", "手机微信 · 5 分钟")}>
            <ol className="wo-list">
              <li>用另一个微信号扫成员的企微「联系我」活码加好友。</li>
              <li>应立刻收到文字欢迎语 + 小程序卡片；点卡片能打开名片页。</li>
              <li>没收到：确认这个号是首次添加该成员；卡片点不开：回第 3 步检查页面路径与发布状态。</li>
            </ol>
            <Note>这一步验证通过，客户加好友那一刻就自动拿到你的 AI 名片了，无需任何开发。</Note>
          </Step>
        </div>
      )}

      {channel === "kf" && (
        <div className="wo-steps">
          <Step {...stepProps("k1", 1, "确认前置条件", "企微后台 + 服务器 · 缺一项都跑不通")}>
            <ol className="wo-list">
              <li>企业微信已完成<strong>企业认证</strong>（未认证拿不到微信客服的开发者接口）。</li>
              <li>已创建「微信客服」账号：应用管理 → 微信客服 → 账号管理，记下 <code>wk</code> 开头的客服账号 ID。</li>
              <li>有一个<strong>公网 HTTPS 域名</strong>指向这台服务器（企微只接受 https 回调）。联调阶段可用内网穿透，正式上线要用自己的域名。</li>
              <li>服务器已装 <strong>Node 18+</strong>，本项目的 <code>wecom-kf-service/</code> 零第三方依赖，拷过去就能跑。</li>
            </ol>
            <Note tone="warn">没有 HTTPS 域名是最常见的卡点。企微保存回调地址时会立刻发一次验证请求，服务没起来 / 域名不通就会保存失败。</Note>
          </Step>

          <Step {...stepProps("k2", 2, "填 6 个参数", "按提示位置逐个复制，密钥只存在你本机浏览器")}>
            <div className="wo-fields">
              <label>
                企业 ID（corpid）
                <input value={fields.corpId} placeholder="ww 开头，我的企业 → 企业信息最底部" onChange={(event) => setField("corpId", event.target.value)} />
                <small>企微后台 → 我的企业 → 企业信息 → 底部「企业 ID」</small>
              </label>
              <label>
                微信客服 Secret
                <input type="password" value={fields.kfSecret} placeholder="点「查看」会发到你的企微" onChange={(event) => setField("kfSecret", event.target.value)} />
                <small>应用管理 → 微信客服 → 开发配置 → Secret</small>
              </label>
              <label>
                客服账号 ID（open_kfid）
                <input value={fields.openKfId} placeholder="wk 开头" onChange={(event) => setField("openKfId", event.target.value)} />
                <small>微信客服 → 账号管理 → 账号 ID</small>
              </label>
              <label>
                回调 Token
                <span className="wo-inline">
                  <input value={fields.token} placeholder="20 位随机串，与企微后台填的一致" onChange={(event) => setField("token", event.target.value)} />
                  <button type="button" className="wo-mini" onClick={() => setField("token", randomToken())}><RefreshCw size={12} />生成</button>
                </span>
                <small>自己定，服务端与企微后台必须完全一致</small>
              </label>
              <label>
                EncodingAESKey
                <input value={fields.encodingAesKey} maxLength={43} placeholder="43 位，企微后台随机生成" onChange={(event) => setField("encodingAesKey", event.target.value.trim())} />
                <small>当前 {fields.encodingAesKey.trim().length}/43 位 · 少一位回调就验签失败</small>
              </label>
              <label>
                小程序 AppID
                <input value={fields.miniAppId} placeholder="wx 开头" onChange={(event) => setField("miniAppId", event.target.value)} />
                <small>AI 名片所在小程序，需与企微同主体或已关联</small>
              </label>
              <label>
                名片页面路径
                <input value={fields.miniPagePath} placeholder="pages/card/index" onChange={(event) => setField("miniPagePath", event.target.value)} />
                <small>客户点卡片后打开的小程序页面</small>
              </label>
              <label>
                回调域名
                <input value={fields.callbackHost} placeholder="kf.yourdomain.com（不要带 https:// 和路径）" onChange={(event) => setField("callbackHost", event.target.value)} />
                <small>生成的回调地址：{callbackUrl}</small>
              </label>
              <label>
                同步密钥（adminSecret）
                <span className="wo-inline">
                  <input value={fields.adminSecret} placeholder="自己定一串，控制台同步时要用" onChange={(event) => setField("adminSecret", event.target.value)} />
                  <button type="button" className="wo-mini" onClick={() => setField("adminSecret", randomToken(24))}><RefreshCw size={12} />生成</button>
                </span>
                <small>保护 /api/sync 与 /admin/rules，也是控制台「企微客户同步」里要填的密钥</small>
              </label>
            </div>
          </Step>

          <Step {...stepProps("k3", 3, "生成配置并启动服务", "本地下载 config.json → 拷到服务器 → 起服务")}>
            <div className="wo-actions">
              <button type="button" className="button button-primary" onClick={downloadConfig}><Download size={14} />下载 config.json</button>
              <button type="button" className="button button-secondary" onClick={copyCommand}><Copy size={14} />复制启动命令</button>
            </div>
            <div className="wo-snippet">
              <pre>{`# 1) 把下载的 config.json 放到服务目录
# 2) 启动（默认 8787 端口）
cd wecom-kf-service
node src/server.mjs

# 3) 检查存活
curl http://127.0.0.1:8787/health   # 期望返回 ok

# 4) 常驻运行（二选一）
npm i -g pm2 && pm2 start src/server.mjs --name wecom-kf
# 或 nginx 反代到 127.0.0.1:8787，对外暴露 https://${fields.callbackHost.trim() || "你的域名"}/wecom/callback`}</pre>
              <button type="button" className="wo-copy" onClick={copyCommand}><Copy size={13} />复制</button>
            </div>
            <Note tone="warn">config.json 里有 Secret 和 AESKey，不要提交到代码仓库，也不要发到群里。本页填的参数只保存在你这台浏览器。</Note>
          </Step>

          <Step {...stepProps("k4", 4, "在企微后台登记回调地址", "应用管理 → 微信客服 → 开发配置 → 回调地址")}>
            <ol className="wo-list">
              <li>回调 URL 填：<code>{callbackUrl}</code> <button type="button" className="wo-mini" onClick={() => copyValue(callbackUrl, "回调地址")}><Copy size={12} />复制</button></li>
              <li>Token、EncodingAESKey 填成与 config.json <strong>一模一样</strong>的值。</li>
              <li>点保存。企微会立刻向你的服务发一次验证请求，服务必须已在运行。</li>
            </ol>
            <Note tone="warn">保存失败对照：报「签名错误」→ Token 或 AESKey 不一致；报「请求超时」→ 服务没起或域名没通；报「非企业微信请求」→ 反向代理把 query 参数吃掉了。</Note>
          </Step>

          <Step {...stepProps("k5", 5, "按业务改回复规则", "wecom-kf-service/rules.json · 改完重启服务")}>
            <ol className="wo-list">
              <li>默认已内置两条：客户说「了解 / 介绍 / 名片」→ 发 AI 名片；说「收费 / 价格 / 多少钱」→ 发报价话术。</li>
              <li>结构：每条规则 <code>keywords</code> 关键词数组（命中条件为「全等或包含」，按数组顺序取第一条，所以把最具体的放前面）、<code>reply</code> 为 <code>{"{"}"type":"text","content":"…"{"}"}</code> 或 <code>{"{"}"type":"miniprogram"{"}"}</code>、<code>isDefault</code> 标记兜底、<code>enabled:false</code> 可临时停用。</li>
              <li>要更聪明就打开 AI 意图兜底：config.json 里填 <code>deepseekKey</code>、把 <code>aiFallback</code> 设为 true，模型只能在已有规则里挑一条，不会自由乱答。</li>
            </ol>
            <div className="wo-snippet">
              <pre>{`[
  { "id": "card", "description": "想了解 → 发名片",
    "keywords": ["了解", "介绍", "名片", "你是谁"],
    "reply": { "type": "miniprogram" } },
  { "id": "price", "description": "问价格",
    "keywords": ["收费", "价格", "多少钱", "报价"],
    "reply": { "type": "text", "content": "我们按项目报价，你把需求发我，我半小时内给方案和价格区间。" } },
  { "id": "fallback", "description": "兜底", "isDefault": true,
    "reply": { "type": "text", "content": "收到，我看一下，稍后回复你。想先了解的话可以发「了解」。" } }
]`}</pre>
              <button type="button" className="wo-copy" onClick={async () => { await copyText(`[\n  { "id": "card", "description": "想了解 → 发名片", "keywords": ["了解", "介绍", "名片", "你是谁"], "reply": { "type": "miniprogram" } },\n  { "id": "price", "description": "问价格", "keywords": ["收费", "价格", "多少钱", "报价"], "reply": { "type": "text", "content": "我们按项目报价，你把需求发我，我半小时内给方案和价格区间。" } },\n  { "id": "fallback", "description": "兜底", "isDefault": true, "reply": { "type": "text", "content": "收到，我看一下，稍后回复你。想先了解的话可以发「了解」。" } }\n]`); onToast("rules.json 示例已复制"); }}><Copy size={13} />复制</button>
            </div>
          </Step>

          <Step {...stepProps("k6", 6, "真实客户消息联调", "手机微信 · 10 分钟")}>
            <ol className="wo-list">
              <li>用另一个微信进入你的微信客服会话（从欢迎语卡片、客服链接或公众号菜单进入）。</li>
              <li>发「了解」→ 应收到 AI 名片卡片；点开能进名片页。</li>
              <li>发「收费」→ 应收到报价话术；发一句规则外的话 → 收到兜底回复。</li>
              <li>同一条消息不会重复回复（服务端做了 msgid 去重）；服务日志能看到消息处理记录。</li>
              <li>回到控制台「企微客户同步」填服务地址 + 同步密钥，点「立即同步」：这位客户会以「企业微信」来源出现在线索里，对话进跟进弹窗。</li>
            </ol>
            <Note>全部通过后，这条通道就是真的自动运行了：客户随时发消息，AI 名片和话术即时回，不用人盯。</Note>
          </Step>
        </div>
      )}

      <div className="wo-foot">
        <span><Server size={13} />通道 B 的服务代码在项目 <code>wecom-kf-service/</code>，含加解密、消息拉取、规则引擎与去重持久化，本地自测 7 项已通过。</span>
        <button type="button" className="wo-reset" onClick={() => { setState({ channel, fields: EMPTY_FIELDS, done: {} }); onToast("已清空本页记录的参数与进度"); }}>清空本页记录</button>
      </div>
    </section>
  );
}
