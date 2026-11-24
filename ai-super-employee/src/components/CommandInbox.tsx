import { useCallback, useEffect, useState } from "react";
import {
  Check,
  ChevronRight,
  Inbox,
  LoaderCircle,
  Play,
  Plus,
  RefreshCw,
  Send,
  Terminal,
  X,
} from "lucide-react";

interface ImCommand {
  id: number;
  text: string;
  source: string;
  from: string;
  status: "pending" | "done" | "dismissed";
  createdAt: string;
  updatedAt: string;
}

interface ImConfig {
  baseUrl: string;
  secret: string;
}

const STORAGE_KEY = "ai-employee:im-inbox";

function loadConfig(): ImConfig {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) return { baseUrl: "", secret: "", ...(JSON.parse(raw) as Partial<ImConfig>) };
  } catch {
    // 配置损坏按未配置处理
  }
  return { baseUrl: "", secret: "" };
}

async function copyText(text: string): Promise<boolean> {
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
    const ok = document.execCommand("copy");
    document.body.removeChild(area);
    return ok;
  }
}

interface CommandInboxProps {
  /** 点「在控制台执行」：把指令文本喂给任务编排弹窗（由用户确认后用登录身份执行）。 */
  onExecute: (goal: string) => void;
}

/**
 * 远程指令收件箱：飞书 / HTTP 进来的指令在这里排队，
 * 由用户点「在控制台执行」进入任务编排——网关永远不代替账号执行任务。
 */
export function CommandInbox({ onExecute }: CommandInboxProps) {
  const [config, setConfig] = useState<ImConfig>(loadConfig);
  const [configOpen, setConfigOpen] = useState(false);
  const [commands, setCommands] = useState<ImCommand[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const configured = Boolean(config.baseUrl.trim() && config.secret.trim());

  const saveConfig = (next: ImConfig) => {
    setConfig(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // 隐私模式写失败不影响本次会话
    }
  };

  const refresh = useCallback(async () => {
    if (!configured) return;
    setBusy(true);
    setError("");
    try {
      const base = config.baseUrl.trim().replace(/\/+$/, "");
      const res = await fetch(
        `${base}/api/commands?secret=${encodeURIComponent(config.secret.trim())}&since=0`,
        { headers: { accept: "application/json" } },
      );
      if (res.status === 403) throw new Error("密钥不对，请核对网关 config.json 的 adminSecret");
      if (!res.ok) throw new Error(`网关返回 ${res.status}，检查地址与服务是否在运行`);
      const payload = (await res.json()) as { ok: boolean; commands?: ImCommand[] };
      if (!payload.ok) throw new Error("网关返回异常");
      const order = { pending: 0, done: 1, dismissed: 2 } as const;
      setCommands(
        (payload.commands ?? [])
          .slice()
          .sort((a, b) => order[a.status] - order[b.status] || b.id - a.id)
          .slice(0, 50),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "指令拉取失败");
    } finally {
      setBusy(false);
    }
  }, [config.baseUrl, config.secret, configured]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const updateStatus = async (id: number, status: ImCommand["status"]) => {
    try {
      const base = config.baseUrl.trim().replace(/\/+$/, "");
      const res = await fetch(`${base}/api/commands/update?secret=${encodeURIComponent(config.secret.trim())}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, status }),
      });
      if (!res.ok) throw new Error(`状态回写失败（${res.status}）`);
      setCommands((current) => current.map((item) => (item.id === id ? { ...item, status } : item)));
      setNotice(status === "done" ? `指令 #${id} 已标记完成` : `指令 #${id} 已忽略`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "状态回写失败");
    }
  };

  const pending = commands.filter((item) => item.status === "pending");
  const settled = commands.filter((item) => item.status !== "pending").slice(0, 8);

  return (
    <section className="im-layout">
      <div className="console-card im-setup">
        <div className="console-card-header">
          <div>
            <h2><Inbox size={16} /> 远程指令</h2>
            <p>
              在飞书或任意 IM 里一句话下达指令，网关排队，这里收件——
              <b>点执行后进入任务编排，用你的登录身份运行</b>（网关本身不执行任务，账号数据不会越权）。
            </p>
          </div>
          <div className="im-setup-actions">
            <button type="button" className="button button-secondary" onClick={() => void refresh()} disabled={!configured || busy}>
              {busy ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />}刷新
            </button>
            <button type="button" className="button button-secondary" onClick={() => setConfigOpen((value) => !value)}>
              {configOpen ? <X size={14} /> : <Plus size={14} />}{configOpen ? "收起" : "网关配置"}
            </button>
          </div>
        </div>

        {configOpen && (
          <div className="im-config">
            <label>
              网关服务地址
              <input
                value={config.baseUrl}
                onChange={(event) => setConfig({ ...config, baseUrl: event.target.value })}
                placeholder="http://127.0.0.1:8788"
              />
            </label>
            <label>
              管理密钥（adminSecret）
              <input
                type="password"
                value={config.secret}
                onChange={(event) => setConfig({ ...config, secret: event.target.value })}
                placeholder="服务端 config.json 的 adminSecret"
                autoComplete="off"
              />
            </label>
            <div className="im-config-actions">
              <button type="button" className="button button-primary" onClick={() => { saveConfig(config); setNotice("配置已保存，正在拉取指令…"); }}>
                <Check size={14} />保存并连接
              </button>
              <small className="geo-hint">配置只存本机浏览器。网关启动：cd im-bot-gateway && npm start</small>
            </div>
          </div>
        )}

        {!configured && (
          <div className="im-guide">
            <div className="im-guide-step">
              <Terminal size={15} />
              <span>
                <strong>1. 启动网关（零依赖，Node 18+）</strong>
                <code>cd ai-super-employee/im-bot-gateway && cp config.example.json config.json && npm start</code>
              </span>
            </div>
            <div className="im-guide-step">
              <Send size={15} />
              <span>
                <strong>2. 现在就能用 HTTP 入口下发指令（任何 IM 桥 / 脚本均可）</strong>
                <code>curl -X POST "http://127.0.0.1:8788/api/command?secret=你的adminSecret" -H "Content-Type: application/json" -d {'{"text":"帮我生成本周内容排期"}'}</code>
                <button
                  type="button"
                  className="text-link"
                  onClick={() => void copyText('curl -X POST "http://127.0.0.1:8788/api/command?secret=你的adminSecret" -H "Content-Type: application/json" -d \'{"text":"帮我生成本周内容排期"}\'')}
                >
                  复制示例
                </button>
              </span>
            </div>
            <div className="im-guide-step">
              <Inbox size={15} />
              <span>
                <strong>3. 飞书接入（凭据到位后）</strong>
                飞书开放平台创建自建应用 → 事件订阅填 <code>https://你的域名/feishu/event</code>
                → 把 Verification Token / Encrypt Key 填进网关 config.json → 订阅 im.message.receive_v1。
                建议先用明文模式打通，再切加密。
              </span>
            </div>
          </div>
        )}

        {error && <p className="geo-error" style={{ padding: "0 19px 14px" }}>{error}</p>}
        {notice && <p className="geo-notice" style={{ padding: "0 19px 14px" }}>{notice}</p>}
      </div>

      <div className="console-card im-queue">
        <div className="console-card-header">
          <div>
            <h2>待处理指令（{pending.length}）</h2>
            <p>执行 = 打开任务编排并预填目标，发送前你仍可修改</p>
          </div>
        </div>

        {configured && pending.length === 0 && (
          <div className="empty-search im-empty">
            <Inbox size={24} />
            <strong>暂无远程指令</strong>
            <span>用上面的 curl 示例发一条，或接入飞书后在 IM 里 @ 机器人下达</span>
          </div>
        )}

        <div className="im-list">
          {pending.map((item) => (
            <article className="im-item" key={item.id}>
              <div className="im-item-head">
                <span className={`im-source source-${item.source}`}>{item.source === "feishu" ? "飞书" : "HTTP"}</span>
                <em>#{item.id} · {new Date(item.createdAt).toLocaleString("zh-CN", { hour12: false })}</em>
                {item.from && <small>{item.from}</small>}
              </div>
              <p>{item.text}</p>
              <div className="im-item-actions">
                <button type="button" className="button button-primary" onClick={() => onExecute(item.text)}>
                  <Play size={14} />在控制台执行
                </button>
                <button type="button" className="button button-secondary" onClick={() => void updateStatus(item.id, "done")}>
                  <Check size={14} />标记完成
                </button>
                <button type="button" className="button button-ghost" onClick={() => void updateStatus(item.id, "dismissed")}>
                  <X size={14} />忽略
                </button>
                <span className="im-run-hint">执行后记得回来标记状态 <ChevronRight size={12} /></span>
              </div>
            </article>
          ))}
        </div>
      </div>

      {settled.length > 0 && (
        <div className="console-card im-history">
          <div className="console-card-header">
            <div><h2>最近处理</h2><p>已完成与忽略的指令</p></div>
          </div>
          <div className="im-list">
            {settled.map((item) => (
              <article className="im-item settled" key={item.id}>
                <div className="im-item-head">
                  <span className={`im-status ${item.status}`}>{item.status === "done" ? "已完成" : "已忽略"}</span>
                  <em>#{item.id} · {new Date(item.updatedAt).toLocaleString("zh-CN", { hour12: false })}</em>
                </div>
                <p>{item.text}</p>
                <div className="im-item-actions">
                  <button type="button" className="button button-ghost" onClick={() => void updateStatus(item.id, "pending")}>
                    <RefreshCw size={13} />恢复待处理
                  </button>
                </div>
              </article>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
