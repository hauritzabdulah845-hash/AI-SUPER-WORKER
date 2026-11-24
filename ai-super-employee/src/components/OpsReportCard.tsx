import { useCallback, useEffect, useState } from "react";
import { BarChart3, Download, LoaderCircle, RefreshCw } from "lucide-react";
import type { LeadRow, TaskRow } from "../cloud/api";
import { collectOpsMetrics, reportToCsv, type OpsReport } from "../cloud/metrics";

/**
 * 渠道运营报表卡片（数据洞察内）：
 * 任务/线索来自业务库，视频/素材/流水线来自本机库，只读聚合。
 * 竞品「接待人数/曝光私信」依赖桌面 RPA 采集，此处以真实可数口径替代。
 */
export function OpsReportCard(props: {
  tasks: TaskRow[];
  leads: LeadRow[];
  knowledgeCount: number;
  contentCount: number;
}) {
  const { tasks, leads, knowledgeCount, contentCount } = props;
  const [report, setReport] = useState<OpsReport | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const next = await collectOpsMetrics({ tasks, leads, knowledgeCount, contentCount });
      setReport(next);
    } finally {
      setLoading(false);
    }
  }, [tasks, leads, knowledgeCount, contentCount]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const exportCsv = () => {
    if (!report) return;
    const blob = new Blob([reportToCsv(report)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `渠道运营报表-${new Date(report.generatedAt).toISOString().slice(0, 10)}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const maxTrend = report ? Math.max(1, ...report.trend.map((point) => Math.max(point.tasks, point.leads, point.videos))) : 1;

  return (
    <div className="console-card ops-card">
      <div className="console-card-header">
        <div>
          <h2>
            <BarChart3 size={15} /> 渠道运营报表
          </h2>
          <p>业务库 + 本机库聚合 · 7 日趋势 · 只读统计</p>
        </div>
        <div className="ops-actions">
          <button type="button" className="icon-button" aria-label="刷新" onClick={() => void refresh()} disabled={loading}>
            {loading ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />}
          </button>
          <button type="button" className="text-link" onClick={exportCsv} disabled={!report}>
            <Download size={14} /> 导出 CSV
          </button>
        </div>
      </div>

      {!report && (
        <div className="ops-loading">
          <LoaderCircle size={16} className="spin" /> 正在聚合各模块指标…
        </div>
      )}

      {report && (
        <>
          <div className="ops-tiles">
            {report.tiles.map((tile) => (
              <div className="ops-tile" key={tile.key}>
                <span className="ops-tile-label">{tile.label}</span>
                <strong>{tile.value}</strong>
                <span className="ops-tile-hint">{tile.hint}</span>
              </div>
            ))}
          </div>

          <div className="ops-trend">
            <div className="ops-trend-head">
              <strong>近 7 日趋势</strong>
              <span>
                <i className="dot tasks" />任务
                <i className="dot leads" />线索
                <i className="dot videos" />视频
              </span>
            </div>
            <div className="ops-trend-bars">
              {report.trend.map((point) => (
                <div className="ops-trend-day" key={point.day}>
                  <div className="ops-trend-col">
                    <span className="bar tasks" style={{ height: `${Math.round((point.tasks / maxTrend) * 100)}%` }} title={`任务 ${point.tasks}`} />
                    <span className="bar leads" style={{ height: `${Math.round((point.leads / maxTrend) * 100)}%` }} title={`线索 ${point.leads}`} />
                    <span className="bar videos" style={{ height: `${Math.round((point.videos / maxTrend) * 100)}%` }} title={`视频 ${point.videos}`} />
                  </div>
                  <span className="ops-trend-label">{point.day.slice(5)}</span>
                </div>
              ))}
            </div>
          </div>

          <p className="ops-note">
            口径说明：线索/任务来自业务库；视频/素材/流水线来自本机库。竞品的「曝光私信、发布评论」等依赖桌面端 RPA
            采集，我们不做，对应以真实可数指标替代。
          </p>
        </>
      )}
    </div>
  );
}

export default OpsReportCard;
