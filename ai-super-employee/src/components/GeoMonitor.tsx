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
  competitorComparison,
  computeTrend,
  mentionRate,
  pct,
  polylineAttr,
  questionDeltas,
  sourceRanking,
  sparklinePoints,
  type CompetitorRow,
  type GeoSnapshot,
  type SourceRankRow,
} from "../cloud/geotrack";
import { loadReviewQueue } from "../cloud/geoReview";
import {
  CITATION_WAY_LABEL,
  matchDraftCitations,
  reviewItemToCitationDraft,
  type DraftCitationStatus,
} from "../cloud/geoCitation";
import { GEO_SAMPLE_SNAPSHOTS } from "../cloud/geoSample";
import {
  appendSnapshot,
  clearSnapshotsFor,
  loadSnapshotsFor,
  latestComparablePair,
  removeSnapshot,
  runGeoMonitor,
} from "../cloud/geomonitor";
import { friendlyError } from "../cloud/friendlyError";
import { removeGeoSnapshotRemote, scheduleGeoPush } from "../cloud/geosync";
import {
  GEO_MONITOR_FREQUENCIES,
  buildGeoMonitorPipeline,
  findGeoMonitorPipeline,
  type GeoMonitorFrequency,
} from "../cloud/geoschedule";
import { loadPipelines, nextRunLabel, savePipelines } from "../cloud/pipeline";
import { navToSlug } from "../nav";

interface GeoMonitorProps {
  brand: string;
  questions: string[];
  /** 监测跑完后把最新快照交给外层，便于一起导出 */
  onSnapshot?: (snapshot: GeoSnapshot) => void;
  /** 第 32 批：云端同步状态文案（本机模式/同步中/已同步·时间），由工作台统一维护 */
  syncLabel?: string;
  syncing?: boolean;
  onSyncNow?: () => void;
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

/** 竞品对比表（真实报表与示例报告共用同一渲染，保证示例不走样） */
function ComparisonTable({ rows }: { rows: CompetitorRow[] }) {
  return (
    <table>
      <thead><tr><th>品牌</th><th>提及率</th><th>平均首位</th><th>与本品牌差</th><th>名次</th></tr></thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.brand} className={row.isSelf ? "self" : ""}>
            <td>{row.brand}{row.isSelf ? "（本品牌）" : ""}</td>
            <td>{pct(row.mentionRate)}</td>
            <td>{row.firstPos === null ? "—" : Math.round(row.firstPos)}</td>
            <td>
              {row.isSelf ? "—" : (
                <span className={row.deltaRate > 0 ? "geo-delta-up" : row.deltaRate < 0 ? "geo-delta-down" : ""}>
                  {row.deltaRate > 0 ? "▲" : row.deltaRate < 0 ? "▼" : "—"} {Math.abs(row.deltaRate * 100).toFixed(0)} 个百分点
                </span>
              )}
            </td>
            <td>第 {row.rank} 名</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** 被引用信源 TOP 列表（真实报表与示例报告共用） */
function SourcesList({ rows }: { rows: SourceRankRow[] }) {
  return (
    <ol>
      {rows.map((row) => (
        <li key={row.source}><span>{row.source}</span><small>{row.count} 次</small></li>
      ))}
    </ol>
  );
}

const DELTA_LABEL: Record<string, string> = {
  gained: "新获得提及",
  lost: "丢了提及",
  "stable-hit": "持续命中",
  "stable-miss": "持续未命中",
  new: "新问题",
};

/**
 * 示例报告（第 30 批）：内置脱敏数据渲染完整报表样子。
 * 数据来自 geoSample 常量，不落盘、不与真实快照混算；
 * 虚线框 + 多处「示例数据」标注，一眼可辨不是用户自己的数据。
 */
function SampleReport() {
  const snapshots = GEO_SAMPLE_SNAPSHOTS;
  const trend = computeTrend(snapshots);
  const latest = snapshots[snapshots.length - 1];
  const previous = snapshots[snapshots.length - 2] ?? null;
  const deltas = questionDeltas(previous, latest);
  const comparison = competitorComparison(latest);
  const topSources = sourceRanking(snapshots);
  return (
    <div className="geo-sample-report" aria-label="示例报告（示例数据，非真实监测结果）">
      <div className="geo-sample-head">
        <span className="geo-sample-badge">示例数据</span>
        <strong>示例报告（脱敏演示）</strong>
        <small>以下数字为内置示例，非真实监测结果；跑一次监测后这里会换成你的真实报表。</small>
      </div>
      <div className="geo-trend-row">
        <Sparkline series={snapshots.map(mentionRate)} />
        <div className="geo-trend-facts">
          <strong className="geo-trend-rate">{pct(trend.current)}</strong>
          <small>示例当前提及率 · 共 {trend.points} 次示例记录</small>
        </div>
      </div>
      <p className="geo-trend-summary">{trend.summary}（示例）</p>
      <div className="geo-sample-questions">
        <h3>问题级明细（最新一次 · 示例）</h3>
        <table>
          <thead><tr><th>问题</th><th>是否提及</th><th>变化</th><th>来源</th></tr></thead>
          <tbody>
            {latest.samples.map((item, index) => (
              <tr key={item.question}>
                <td>{item.question}</td>
                <td>{item.mentioned ? `已提及（${item.hits} 次）` : "未提及"}</td>
                <td>{DELTA_LABEL[deltas[index]?.change ?? "new"]}</td>
                <td>{item.sources?.length ? item.sources.join("、") : "模型未给出处"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {comparison.length > 1 && (
        <div className="geo-compare">
          <h3>竞品对比（最新一次 · 示例）</h3>
          <ComparisonTable rows={comparison} />
        </div>
      )}
      {topSources.length > 0 && (
        <div className="geo-sources">
          <h3>被引用信源 TOP（示例）</h3>
          <SourcesList rows={topSources} />
        </div>
      )}
      <p className="geo-sample-foot">示例数据结束 —— 以上均为演示数字，不会计入你的监测记录。</p>
    </div>
  );
}

/** 稿件引用状态区（第 30 批）：已通过稿件 × 快照来源的启发式匹配结果 */
function CitationSection({ statuses, hasSnapshots }: { statuses: DraftCitationStatus[]; hasSnapshots: boolean }) {
  return (
    <div className="geo-citations">
      <h3>稿件引用状态</h3>
      <p className="geo-hint">按标题/链接启发式匹配，仅供参考：把已通过审核的稿件与监测时模型给出的来源比对，判断哪篇稿可能被引用。</p>
      {statuses.length === 0 ? (
        <p className="geo-hint">还没有已通过审核的稿件。先在第 1 步生成素材并送审通过，或在聚合发布页把平台稿送审，这里会显示每篇稿的引用状态。</p>
      ) : (
        <ul className="geo-citation-list">
          {statuses.map((row) => (
            <li className="geo-citation-row" key={row.draftId}>
              <div className="geo-citation-main">
                <strong>{row.title}</strong>
                {row.platform && <span className="geo-citation-platform">{row.platform}</span>}
                <span className={row.cited ? "geo-citation-badge cited" : "geo-citation-badge"}>
                  {row.cited ? `已被引用 ×${row.citationCount}` : "未被引用"}
                </span>
              </div>
              {row.cited ? (
                <small>
                  最近引用 {row.lastCitedAt ? formatTime(row.lastCitedAt) : "—"}
                  {row.matchedSources.length > 0 && <> · 命中信源：{row.matchedSources.join("、")}</>}
                  {row.matchWays.length > 0 && <> · 匹配方式：{row.matchWays.map((way) => CITATION_WAY_LABEL[way]).join("/")}</>}
                </small>
              ) : (
                <small>
                  {hasSnapshots
                    ? "建议：检查标题是否含目标问题、稿件是否已实际发布；发布后等下一轮监测再看。"
                    : "还没有监测记录，跑一次监测后这里会更新引用状态。"}
                </small>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * GEO 持续监测面板。
 *
 * 解决的核心问题：原来的提及率测试只给一个数，用户无法判断
 * 「这次 50%」到底比上次好还是差，也无法证明自己做的优化有没有用。
 */
export function GeoMonitor({ brand, questions, onSnapshot, syncLabel, syncing, onSyncNow }: GeoMonitorProps) {
  const [history, setHistory] = useState<GeoSnapshot[]>([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [expanded, setExpanded] = useState(false);
  // 第 30 批：示例报告开关 + 已通过稿件（稿件引用状态用，按品牌从审核队列读）
  const [showSample, setShowSample] = useState(false);
  const [approvedDrafts, setApprovedDrafts] = useState<DraftCitationStatus[]>([]);
  const [competitorText, setCompetitorText] = useState("");
  const competitorList = competitorText.split(/[,，、\s]+/).map((item) => item.trim()).filter(Boolean).slice(0, 3);
  // 第 29 批：周期监测模板（复用 pipeline 定时任务，运行时读当前问题集）。
  const [scheduleFreq, setScheduleFreq] = useState<GeoMonitorFrequency>("weekly");
  const [pipelinesVersion, setPipelinesVersion] = useState(0);
  const geoSchedule = useMemo(() => {
    void pipelinesVersion;
    return findGeoMonitorPipeline(loadPipelines(), brand);
  }, [brand, pipelinesVersion]);

  const createGeoSchedule = () => {
    if (!brand.trim()) { setError("请先填写品牌/企业名称，再创建周期监测。"); return; }
    if (geoSchedule) { setNotice("该品牌已有周期监测任务，可在下方启停，或去定时任务页管理。"); return; }
    const pipeline = buildGeoMonitorPipeline({ brand, competitors: competitorList, frequency: scheduleFreq });
    savePipelines([...loadPipelines(), pipeline]);
    setPipelinesVersion((v) => v + 1);
    setError("");
    setNotice(`周期监测已创建（${GEO_MONITOR_FREQUENCIES.find((f) => f.key === scheduleFreq)?.label}），下次运行：${nextRunLabel(pipeline, Date.now())}。运行时用当前问题集，问题集变更后趋势可比性以本页校验为准。`);
  };

  const toggleGeoSchedule = () => {
    if (!geoSchedule) return;
    const next = loadPipelines().map((row) => (row.id === geoSchedule.id ? { ...row, enabled: !row.enabled } : row));
    savePipelines(next);
    setPipelinesVersion((v) => v + 1);
    setNotice(geoSchedule.enabled ? "周期监测已停用" : "周期监测已启用");
  };

  // 首刷放到 setTimeout：effect 内同步 setState 会触发 react-hooks 规则
  useEffect(() => {
    const timer = setTimeout(() => setHistory(loadSnapshotsFor(brand)), 0);
    return () => clearTimeout(timer);
  }, [brand]);

  // 稿件引用状态：已通过稿件随品牌/快照变化重算（匹配是纯函数，成本低）
  useEffect(() => {
    const timer = setTimeout(() => {
      const approved = loadReviewQueue(brand)
        .filter((item) => item.status === "approved")
        .map(reviewItemToCitationDraft);
      setApprovedDrafts(matchDraftCitations(approved, loadSnapshotsFor(brand)));
    }, 0);
    return () => clearTimeout(timer);
  }, [brand, history]);

  const trend = useMemo(() => computeTrend(history), [history]);
  const series = useMemo(() => history.map(mentionRate), [history]);
  const pair = useMemo(() => latestComparablePair(history), [history]);
  const deltas = useMemo(
    () => (pair.current ? questionDeltas(pair.previous, pair.current) : []),
    [pair],
  );
  const latest = history.length ? history[history.length - 1] : null;
  const comparison = useMemo(() => (latest ? competitorComparison(latest) : []), [latest]);
  const topSources = useMemo(() => sourceRanking(history), [history]);

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
        competitors: competitorList,
        onProgress: (done, total, question) => setProgress(`第 ${done + 1}/${total} 条：${question.slice(0, 22)}`),
      });
      // 必须先落盘再更新 UI：只改 state 的话刷新页面记录就没了（典型漏写）
      appendSnapshot(snapshot);
      scheduleGeoPush(brand);
      setHistory(loadSnapshotsFor(brand));
      onSnapshot?.(snapshot);
      setNotice(
        `本次提及率 ${pct(mentionRate(snapshot))}（${snapshot.samples.filter((s) => s.mentioned).length}/${snapshot.samples.length}）` +
        (skipped.length ? `，${skipped.length} 条因报错跳过未计入` : ""),
      );
    } catch (err) {
      // 「全部 N 条都失败」保留上下文，原始技术错误翻译成人话
      const raw = err instanceof Error ? err.message : "";
      setError(raw.startsWith("全部")
        ? `全部问题都失败了，本次不计入趋势。${friendlyError(err)}`
        : friendlyError(err));
    } finally {
      setBusy(false);
      setProgress("");
    }
  };

  const remove = (id: string) => {
    setHistory(removeSnapshot(id).filter((row) => row.brand === brand));
    void removeGeoSnapshotRemote(id);
    setNotice("已删除该次记录");
  };

  const clearAll = () => {
    history.forEach((row) => { void removeGeoSnapshotRemote(row.id); });
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

      <label className="geo-competitors">
        竞品品牌（可选，最多 3 个，逗号分隔；同一批问题同时测竞品提及）
        <input value={competitorText} onChange={(event) => setCompetitorText(event.target.value)} placeholder="例如：竞品甲, 竞品乙" />
      </label>

      {/* 第 29 批：周期监测模板（一键创建定时任务，运行时用当前问题集） */}
      <div className="geo-schedule">
        <span className="geo-schedule-title"><CalendarClock size={14} /> 周期监测</span>
        {geoSchedule ? (
          <div className="geo-schedule-row">
            <span>
              {geoSchedule.enabled ? "已启用" : "已停用"} · 下次运行：{nextRunLabel(geoSchedule, Date.now())}
              <small>运行时用当前问题集；问题集变更后趋势可比性以本页校验为准。</small>
            </span>
            <span className="geo-schedule-actions">
              <button type="button" className="button button-secondary" onClick={toggleGeoSchedule}>
                {geoSchedule.enabled ? "停用" : "启用"}
              </button>
              <button type="button" className="text-link" onClick={() => { window.location.hash = `#/console/${navToSlug("定时任务")}`; }}>
                去定时任务页管理
              </button>
            </span>
          </div>
        ) : (
          <div className="geo-schedule-row">
            <select value={scheduleFreq} onChange={(event) => setScheduleFreq(event.target.value as GeoMonitorFrequency)} aria-label="监测频率">
              {GEO_MONITOR_FREQUENCIES.map((freq) => (
                <option key={freq.key} value={freq.key}>{freq.label}（{freq.hint}）</option>
              ))}
            </select>
            <button type="button" className="button button-secondary" onClick={createGeoSchedule}>
              设为周期监测
            </button>
            <small>一键创建定时任务；运行时用当前问题集，问题集变更后趋势可比性以本页校验为准。页面关闭期间到期会积压，重开后自动补跑。</small>
          </div>
        )}
      </div>

      {busy && progress && <p className="geo-notice">{progress}</p>}
      {error && <p className="geo-error">{error}</p>}
      {notice && <p className="geo-notice">{notice}</p>}

      {history.length === 0 ? (
        <>
          <div className="geo-empty">
            <CalendarClock size={22} />
            <strong>还没有监测记录</strong>
            <p>点「跑一次监测」建立基线。建议每周固定跑一次，问题集保持不变，趋势才有意义。</p>
            <button type="button" className="text-link" onClick={() => setShowSample((v) => !v)} aria-expanded={showSample}>
              {showSample ? "收起示例报告" : "查看示例报告（示例数据）"}
            </button>
          </div>
          {showSample && <SampleReport />}
        </>
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

          {comparison.length > 1 && (
            <div className="geo-compare">
              <h3>竞品对比（最新一次）</h3>
              <ComparisonTable rows={comparison} />
            </div>
          )}

          {topSources.length > 0 && (
            <div className="geo-sources">
              <h3>被引用信源 TOP</h3>
              <SourcesList rows={topSources} />
            </div>
          )}

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

      {/* 第 30 批：稿件引用状态（与信源 TOP 并列，口径一致；无快照时也显示稿件清单） */}
      <CitationSection statuses={approvedDrafts} hasSnapshots={history.length > 0} />

      {history.length > 0 && (
        <p className="geo-sample-link">
          <button type="button" className="text-link" onClick={() => setShowSample((v) => !v)} aria-expanded={showSample}>
            {showSample ? "收起示例报告" : "查看示例报告（示例数据，非真实监测结果）"}
          </button>
        </p>
      )}
      {history.length > 0 && showSample && <SampleReport />}

      <p className="geo-storage-note">
        <Database size={12} />
        <span>
          品牌资料与素材在云端工作区；监测记录本机优先保存（最多 60 次），登录后自动同步到云端。
          {syncLabel ? `当前状态：${syncLabel}。` : ""}
        </span>
        {onSyncNow && (
          <button type="button" className="text-link" onClick={onSyncNow} disabled={syncing}>
            {syncing ? "同步中…" : "立即同步"}
          </button>
        )}
      </p>
    </div>
  );
}
