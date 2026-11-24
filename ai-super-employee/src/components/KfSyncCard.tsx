import { LoaderCircle, RefreshCw } from "lucide-react";

export interface KfSyncConfig {
  baseUrl: string;
  secret: string;
  lastSeq: number;
  lastAt: string;
}

/**
 * 企微客户同步卡片：配置回复服务地址与同步密钥，一键把客户档案与对话拉进系统。
 * 只负责展示与输入，真正落库在 Console 的 syncKfCustomers 里（需要登录身份）。
 */
export function KfSyncCard({
  config,
  syncing,
  summary,
  onChange,
  onSync,
}: {
  config: KfSyncConfig;
  syncing: boolean;
  summary: string;
  onChange: (patch: Partial<KfSyncConfig>) => void;
  onSync: () => void;
}) {
  const configured = Boolean(config.baseUrl.trim() && config.secret.trim());
  return (
    <div className="console-card kf-sync">
      <div className="console-card-header">
        <div>
          <h2>企微客户同步</h2>
          <p>把微信客服里的客户身份与对话拉进系统：自动建线索、对话进跟进记录，漏斗随之后续更新。</p>
        </div>
        <span className={`kf-sync-state${configured ? " ready" : ""}`}>
          <i />
          {configured ? "已配置" : "未配置"}
        </span>
      </div>
      <div className="kf-sync-body">
        <label>
          回复服务地址
          <input
            value={config.baseUrl}
            placeholder="https://kf.yourdomain.com"
            onChange={(event) => onChange({ baseUrl: event.target.value })}
          />
        </label>
        <label>
          同步密钥
          <input
            type="password"
            value={config.secret}
            placeholder="服务端 config.json 的 adminSecret"
            onChange={(event) => onChange({ secret: event.target.value })}
          />
        </label>
        <button type="button" className="button button-primary kf-sync-run" onClick={onSync} disabled={syncing}>
          {syncing ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />}
          {syncing ? "同步中…" : "立即同步"}
        </button>
      </div>
      <div className="kf-sync-foot">
        <span>
          游标 {config.lastSeq}
          {config.lastAt ? ` · 上次同步 ${new Date(config.lastAt).toLocaleString("zh-CN", { hour12: false })}` : " · 尚未同步"}
        </span>
        {summary && <strong>{summary}</strong>}
      </div>
    </div>
  );
}
