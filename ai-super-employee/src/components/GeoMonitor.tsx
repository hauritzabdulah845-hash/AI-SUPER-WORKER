import { useEffect, useMemo, useState } from "react";
import {
  ArrowDownRight,
  ArrowUpRight,
  CalendarClock,
  Database,
  LoaderCircle,
  Minus,
  Play,
  Trash2,
  TrendingUp,
  TriangleAlert,
} from "lucide-react";
import {
  computeTrend,
  mentionRate,
  pct,
  polylineAttr,
  questionDeltas,
  sparklinePoints,
  type GeoSnapshot,
} from "../cloud/geotrack";
import {
  appendSnapshot,
  clearSnapshotsFor,
  loadSnapshotsFor,
  latestComparablePair,
  removeSnapshot,
  runGeoMonitor,
} from "../cloud/geomonitor";

interface GeoMonitorProps {
  brand: string;
  questions: string[];
  /** 监测跑完后把最新快照交给外层，便于一起导出 */
  onSnapshot?: (snapshot: GeoSnapshot) => void;
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
}

/** 趋势线：纯 SVG，不引图表库（一条线不值得加依赖，且这样能单测坐标） */
function Sparkline({ series }: { series: number[] }) {
  if (!series.length) return null;
  const width = 240;
  const height = 56;
  const points = sparklinePoints(series, width, height, 6);
  const last = points[points.length - 1];
  return (
    <svg className="geo-spark" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`提及率趋势，共 ${series.length} 次监测`}>
      <line x1="0" y1={height - 6} x2={width} y2={height - 6} stroke="#e8e5ef" strokeWidth="1" />
      <line x1="0" y1="6" x2={width} y2="6" stroke="#f1eef7" strokeWidth="1" strokeDasharray="3 3" />
      {points.length > 1 && (
        <polyline points={polylineAttr(points)} fill="none" stroke="#7c4dff" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      )}
      <circle cx={last.x} cy={last.y} r="3.5" fill="#7c4dff" />
      <text x="0" y={height - 1} fontSize="9" fill="#a9a3b5">旧</text>
      <text x={width} y={height - 1} fontSize="9" fill="#a9a3b5" textAnchor="end">新</text>
    </svg>
  );
}

/**
 * GEO 持续监测面板。
 *
 * 解决的核心问题：原来的提及率测试只给一个数，用户无法判断
 * 「这次 50%」到底比上次好还是差，也无法证明自己做的优化有没有用。
 */
export function GeoMonitor({ brand, questions, onSnapshot }: GeoMonitorProps) {
  const [history, setHistory] = useState<GeoSnapshot[]>([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [expanded, setExpanded] = useState(false);

  // 首刷放到 setTimeout：effect 内同步 setState 会触发 react-hooks 规则
  useEffect(() => {
    const timer = setTimeout(() => setHistory(loadSnapshotsFor(brand)), 0);
    return () => clearTimeout(timer);
  }, [brand]);

  const trend = useMemo(() => computeTrend(history), [history]);
  const series = useMemo(() => history.map(mentionRate), [history]);
  const pair = useMemo(() => latestComparablePair(history), [history]);
  const deltas = useMemo(
    () => (pair.current ? questionDeltas(pair.previous, pair.current) : []),
    [pair],
  );

  const runNow = async () => {
    if (!brand.trim()) { setError("请先填写品牌/企业名称。"); return; }
    if (!questions.length) { setError("请先填写至少 1 条测试问题（可先在下方生成默认问题）。"); return; }
    setBusy(true);
    setError("");
    setNotice("");
    setProgress("");
    try {
      const { snapshot, skipped } = await runGeoMonitor({
        brand,
        questions,
        onProgress: (done, total, question) => setProgress(`第 ${done + 1}/${total} 条：${question.slice(0, 22)}`),
      });
      // 必须先落盘再更新 UI：只改 state 的话刷新页面记录就没了（典型漏写）
      appendSnapshot(snapshot);
      setHistory(loadSnapshotsFor(brand));
      onSnapshot?.(snapshot);
      setNotice(
        `本次提及率 ${pct(mentionRate(snapshot))}（${snapshot.samples.filter((s) => s.mentioned).length}/${snapshot.samples.length}）` +
        (skipped.length ? `，${skipped.length} 条因报错跳过未计入` : ""),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "监测失败");
    } finally {
      setBusy(false);
      setProgress("");
    }
  };

  const remove = (id: string) => {
    setHistory(removeSnapshot(id).filter((row) => row.brand === brand));
    setNotice("已删除该次记录");
  };

  const clearAll = () => {
    setHistory(clearSnapshotsFor(brand));
    setNotice("已清空该品牌的全部监测记录");
  };

  const TrendIcon = trend.direction === "up" ? ArrowUpRight : trend.direction === "down" ? ArrowDownRight : Minus;
  const gained = deltas.filter((d) => d.change === "gained");
  const lost = deltas.filter((d) => d.change === "lost");

  return (
    <div className="console-card geo-monitor">
      <div className="console-card-header">
        <div>
          <h2><TrendingUp size={16} /> 持续监测与趋势</h2>
          <p>每跑一次就存一条基线。只有连续多次，才能看出优化是否真起作用。</p>
        </div>
        <button type="button" className="button button-primary" onClick={() => void runNow()} disabled={busy}>
          {busy ? <LoaderCircle size={15} className="spin" /> : <Play size={15} />}
          {busy ? "监测中" : "跑一次监测"}
        </button>
      </div>

      {busy && progress && <p className="geo-notice">{progress}</p>}
      {error && <p className="geo-error">{error}</p>}
      {notice && <p className="geo-notice">{notice}</p>}

      {history.length === 0 ? (
        <div className="geo-empty">
          <CalendarClock size={22} />
          <strong>还没有监测记录</strong>
          <p>点「跑一次监测」建立基线。建议每周固定跑一次，问题集保持不变，趋势才有意义。</p>
        </div>
      ) : (
        <>
          <div className="geo-trend-row">
            <Sparkline series={series} />
            <div className="geo-trend-facts">
              <div className={`geo-trend-badge ${trend.direction}`}>
                <TrendIcon size={14} />
                <span>{trend.direction === "up" ? "上升" : trend.direction === "down" ? "下降" : trend.direction === "flat" ? "持平" : "数据不足"}</span>
              </div>
              <strong className="geo-trend-rate">{pct(trend.current)}</strong>
              <small>当前提及率 · 共 {trend.points} 次记录</small>
            </div>
          </div>

          <p className="geo-trend-summary">{trend.summary}</p>

          {trend.direction === "insufficient" && (
            <p className="geo-hint">再跑一次即可形成趋势对比。单次结果无法判断涨跌。</p>
          )}

          {pair.current && !pair.previous && history.length >= 2 && (
            <p className="geo-hint">
              <TriangleAlert size={13} /> 最近几次的口径不一致（通道或问题集变了），无法直接比较。
              保持问题集不变、用同一通道，趋势才有参考价值。
            </p>
          )}

          {(gained.length > 0 || lost.length > 0) && (
            <div className="geo-deltas">
              {gained.length > 0 && (
                <div className="geo-delta-block gained">
                  <span>新获得提及 {gained.length} 条</span>
                  <ul>{gained.slice(0, 4).map((d) => <li key={d.question}>{d.question}</li>)}</ul>
                </div>
              )}
              {lost.length > 0 && (
                <div className="geo-delta-block lost">
                  <span>丢了提及 {lost.length} 条</span>
                  <ul>{lost.slice(0, 4).map((d) => <li key={d.question}>{d.question}</li>)}</ul>
                </div>
              )}
            </div>
          )}

          <div className="geo-history-head">
            <button type="button" className="text-link" onClick={() => setExpanded((v) => !v)}>
              {expanded ? "收起" : `查看全部 ${history.length} 次记录`}
            </button>
            <button type="button" className="text-link danger" onClick={clearAll}>
              <Trash2 size={12} />清空该品牌记录
            </button>
          </div>

          {expanded && (
            <ul className="geo-history">
              {[...history].reverse().map((row) => {
                const rate = mentionRate(row);
                const hit = row.samples.filter((s) => s.mentioned).length;
                return (
                  <li key={row.id}>
                    <span className="geo-history-time">{formatTime(row.at)}</span>
                    <strong>{pct(rate)}</strong>
                    <small>{hit}/{row.samples.length} 条命中 · {row.channel} · {row.questions.length} 问</small>
                    <button type="button" className="icon-button" onClick={() => remove(row.id)} aria-label="删除该次记录">
                      <Trash2 size={13} />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}

      <p className="geo-storage-note">
        <Database size={12} /> 记录只存在本机浏览器（不上传、不入库），最多保留 60 次。换设备或清缓存会丢失。
      </p>
    </div>
  );
}
