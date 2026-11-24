import { useCallback, useEffect, useState } from "react";
import { Activity, AlertTriangle, BarChart3, RefreshCw, Trash2 } from "lucide-react";
import {
  clearUsage,
  hourlyBuckets,
  loadUsage,
  startOfToday,
  summarizeUsage,
  usageAlerts,
  type UsageRecord,
  type UsageSummary,
} from "../cloud/usage";

const CHANNEL_LABEL: Record<string, string> = {
  platform: "平台通道",
  custom: "自带 Key",
  demo: "演示降级",
};

function fmtTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

/**
 * 模型配额与消耗统计：近 24h / 今日调用量、tokens、失败率、按模型分布，
 * 以及配额预警。数据来自 `runner.collect` 的埋点（本机留档，不上传）。
 */
export function UsagePanel() {
  const [records, setRecords] = useState<UsageRecord[]>([]);
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [today, setToday] = useState<UsageSummary | null>(null);
  const [buckets, setBuckets] = useState<number[]>([]);

  const refresh = useCallback(() => {
    const now = Date.now();
    const rows = loadUsage();
    setRecords(rows);
    setSummary(summarizeUsage(rows, now - 86_400_000, "近 24 小时"));
    setToday(summarizeUsage(rows, startOfToday(now), "今日"));
    setBuckets(hourlyBuckets(rows, 12, now));
  }, []);

  useEffect(() => {
    // 放到微任务里首刷：避免在 effect 同步阶段 setState（react-hooks 规则）
    const first = window.setTimeout(refresh, 0);
    // 页面停留时每 30 秒刷新，任务跑起来能看到数字动
    const timer = window.setInterval(refresh, 30_000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, [refresh]);

  const alerts = usageAlerts(records);
  const top = alerts.filter((alert) => alert.level !== "ok");

  return (
    <div className="console-card usage-panel">
      <div className="console-card-header">
        <div>
          <h2>
            <BarChart3 size={15} /> 配额与消耗
          </h2>
          <p>每次模型调用的记录（本机留档，不上传）· 用于提前发现限流与额度耗尽</p>
        </div>
        <div className="service-actions">
          <button type="button" className="text-link" onClick={refresh}>
            <RefreshCw size={13} />刷新
          </button>
          <button
            type="button"
            className="text-link"
            onClick={() => {
              clearUsage();
              refresh();
            }}
          >
            <Trash2 size={13} />清空
          </button>
        </div>
      </div>

      {top.length > 0 && (
        <ul className="usage-alerts">
          {top.map((alert) => (
            <li key={alert.message} className={alert.level}>
              <AlertTriangle size={14} />
              {alert.message}
            </li>
          ))}
        </ul>
      )}

      {summary && today && (
        <>
          <div className="usage-metrics">
            <div>
              <strong>{today.calls}</strong>
              <span>今日调用</span>
            </div>
            <div>
              <strong>{fmtTokens(today.tokens)}</strong>
              <span>今日 tokens</span>
            </div>
            <div className={today.failRate >= 0.3 ? "warn" : ""}>
              <strong>{Math.round(today.failRate * 100)}%</strong>
              <span>今日失败率</span>
            </div>
            <div>
              <strong>{fmtMs(today.avgMs)}</strong>
              <span>平均耗时</span>
            </div>
          </div>

          <div className="usage-trend">
            <span>近 12 小时调用</span>
            <div className="usage-bars">
              {buckets.map((count, index) => (
                <i
                  key={index}
                  className={count ? "has" : ""}
                  style={{ height: `${Math.min(100, count * 18 + (count ? 20 : 6))}%` }}
                  title={`${11 - index} 小时前：${count} 次`}
                />
              ))}
            </div>
          </div>

          <ul className="usage-models">
            {summary.byModel.length === 0 && <li className="usage-empty">近 24 小时还没有模型调用</li>}
            {summary.byModel.map((model) => (
              <li key={model.model}>
                <span className="usage-model-name">{model.model}</span>
                <span>{model.calls} 次</span>
                <span>{fmtTokens(model.tokens)} tokens</span>
                {model.failed > 0 && <em>{model.failed} 次失败</em>}
              </li>
            ))}
          </ul>

          {summary.byModel.length > 0 && (
            <p className="usage-channels">
              <Activity size={12} />
              {Object.entries(summary.byChannel)
                .map(([channel, row]) => `${CHANNEL_LABEL[channel] ?? channel} ${row.calls} 次 / ${fmtTokens(row.tokens)}`)
                .join(" · ")}
            </p>
          )}
        </>
      )}

      <p className="service-sim-note">tokens 为估算值（中文 1 字≈1 token、英文 4 字符≈1），用于趋势判断，不作计费依据。</p>
    </div>
  );
}

export default UsagePanel;
