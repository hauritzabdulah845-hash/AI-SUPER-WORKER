import { useCallback, useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Clock3, Download, LoaderCircle, Pencil, Play, Plus, Trash2, X } from "lucide-react";
import {
  createPipeline,
  isDue,
  isPipelineRunning,
  loadPipelines,
  newStep,
  nextRunLabel,
  runPipelineById,
  savePipelines,
  STEP_META,
  type Pipeline,
  type PipelineRun,
  type PipelineStep,
  type PipelineStepKind,
  type PipelineStepResult,
} from "../cloud/pipeline";

const KIND_ORDER: PipelineStepKind[] = ["task", "geo", "video", "mixcut", "leads-scan"];

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString("zh-CN", { hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60_000)}min`;
}

interface DraftStep {
  id: string;
  kind: PipelineStepKind;
  params: Record<string, string>;
}

interface Draft {
  id: string | null;
  name: string;
  mode: "daily" | "interval";
  time: string;
  hours: number;
  steps: DraftStep[];
}

function toDraft(pipeline: Pipeline): Draft {
  return {
    id: pipeline.id,
    name: pipeline.name,
    mode: pipeline.mode,
    time: pipeline.time,
    hours: pipeline.hours,
    steps: pipeline.steps.map((step) => ({ id: step.id, kind: step.kind, params: { ...step.params } })),
  };
}

function emptyDraft(): Draft {
  const base = createPipeline("");
  return toDraft(base);
}

/**
 * 定时任务流水线（总控开关）：
 * - 每条流水线可配「每天 HH:MM」或「每 N 小时」；
 * - 页面打开时 30 秒检查一次，每日任务错过即补跑一次；
 * - 步骤按顺序执行，单步失败记 partial 不中断；
 * - 仅本机 localStorage，任务类步骤的产出在任务中心/内容工厂可见。
 */
export function PipelineCenter() {
  const [pipelines, setPipelines] = useState<Pipeline[]>(() => loadPipelines());
  const [draft, setDraft] = useState<Draft | null>(null);
  const [running, setRunning] = useState<Record<string, boolean>>({});
  const [liveSteps, setLiveSteps] = useState<Record<string, PipelineStepResult[]>>({});
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [toast, setToast] = useState("");
  const toastTimer = useRef<number | null>(null);

  const notify = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(""), 4000);
  }, []);

  const refresh = useCallback(() => {
    setPipelines(loadPipelines());
  }, []);

  const runOne = useCallback(
    async (id: string, manual: boolean) => {
      if (isPipelineRunning(id)) {
        if (manual) notify("这条流水线正在运行，等它跑完再点");
        return;
      }
      setRunning((prev) => ({ ...prev, [id]: true }));
      setLiveSteps((prev) => ({ ...prev, [id]: [] }));
      try {
        const run = await runPipelineById(id, (step) => {
          setLiveSteps((prev) => ({ ...prev, [id]: [...(prev[id] ?? []), step] }));
        });
        if (!run) {
          if (manual) notify("流水线状态已变化，请刷新后重试");
          return;
        }
        const failed = run.steps.filter((step) => step.status === "failed").length;
        const name = loadPipelines().find((row) => row.id === id)?.name ?? "流水线";
        notify(
          failed === 0
            ? `「${name}」执行完成（${run.steps.length} 步 · ${formatDuration(run.durationMs)}）`
            : `「${name}」执行结束：${failed} 步失败（详见运行记录）`,
        );
      } catch (error) {
        notify(`执行失败：${error instanceof Error ? error.message : String(error)}`);
      } finally {
        setRunning((prev) => ({ ...prev, [id]: false }));
        refresh();
      }
    },
    [notify, refresh],
  );

  // 调度：打开立即检查一次（含补跑），之后每 30 秒轮询到点的流水线。
  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      const due = loadPipelines().filter((row) => isDue(row, Date.now()));
      for (const pipeline of due) void runOne(pipeline.id, false);
    };
    tick();
    const timer = window.setInterval(tick, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [runOne]);

  useEffect(() => () => {
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
  }, []);

  const startEdit = (pipeline: Pipeline) => setDraft(toDraft(pipeline));
  const startCreate = () => setDraft(emptyDraft());

  const saveDraft = () => {
    if (!draft) return;
    const name = draft.name.trim();
    if (!name) {
      notify("先给流水线起个名字");
      return;
    }
    if (!draft.steps.length) {
      notify("至少添加一个步骤");
      return;
    }
    const time = /^\d{1,2}:\d{2}$/.test(draft.time) ? draft.time : "09:00";
    const hours = Math.min(168, Math.max(1, Math.round(draft.hours) || 24));
    const list = loadPipelines();
    const existing = list.find((row) => row.id === draft.id);
    const base = existing ?? createPipeline(name);
    const next: Pipeline = {
      ...base,
      name,
      mode: draft.mode,
      time,
      hours,
      steps: draft.steps.map((step) => ({ id: step.id, kind: step.kind, params: { ...step.params } })) as PipelineStep[],
    };
    const merged = existing ? list.map((row) => (row.id === next.id ? next : row)) : [...list, next];
    savePipelines(merged);
    setPipelines(merged);
    setDraft(null);
    notify(existing ? "流水线已更新" : "流水线已创建（默认停用，打开开关后到点自动跑）");
  };

  const removePipeline = (id: string) => {
    const list = loadPipelines().filter((row) => row.id !== id);
    savePipelines(list);
    setPipelines(list);
    notify("流水线已删除");
  };

  const togglePipeline = (pipeline: Pipeline) => {
    const list = loadPipelines().map((row) => (row.id === pipeline.id ? { ...row, enabled: !row.enabled } : row));
    savePipelines(list);
    setPipelines(list);
    notify(pipeline.enabled ? `「${pipeline.name}」已停用` : `「${pipeline.name}」已启用，到点自动执行`);
  };

  const toggleAll = (enabled: boolean) => {
    const list = loadPipelines().map((row) => (row.id ? { ...row, enabled } : row));
    savePipelines(list);
    setPipelines(list);
    notify(enabled ? "已一键启动全部流水线" : "已一键停止全部流水线");
  };

  const setDraftStepParam = (stepId: string, key: string, value: string) => {
    setDraft((prev) =>
      prev
        ? {
            ...prev,
            steps: prev.steps.map((step) => (step.id === stepId ? { ...step, params: { ...step.params, [key]: value } } : step)),
          }
        : prev,
    );
  };

  const enabledCount = pipelines.filter((row) => row.enabled).length;

  return (
    <section className="pipeline-page">
      <div className="console-card pipeline-head">
        <div>
          <h2>定时任务流水线</h2>
          <p>
            把智能体任务、GEO 体检、视频生成、混剪方案、高意向扫描串成一条到点自动执行的流水线。
            页面打开时才会调度；每日任务错过时间，下次打开会补跑一次。当前 {pipelines.length} 条，启用 {enabledCount} 条。
          </p>
        </div>
        <div className="pipeline-head-actions">
          <button type="button" className="button button-secondary" onClick={() => toggleAll(false)} disabled={!enabledCount}>
            一键停止全部
          </button>
          <button
            type="button"
            className="button button-primary"
            onClick={() => toggleAll(true)}
            disabled={!pipelines.length || enabledCount === pipelines.length}
          >
            <Play size={15} />一键启动全部
          </button>
          <button type="button" className="button button-primary" onClick={startCreate}>
            <Plus size={15} />新建流水线
          </button>
        </div>
      </div>

      {toast && <div className="pipeline-toast">{toast}</div>}

      {draft && (
        <div className="console-card pipeline-editor">
          <div className="console-card-header">
            <div>
              <h2>{draft.id ? "编辑流水线" : "新建流水线"}</h2>
              <p>步骤按顺序执行；单步失败会记入运行记录，但不中断后面的步骤</p>
            </div>
            <button type="button" className="icon-button" onClick={() => setDraft(null)} aria-label="关闭">
              <X size={16} />
            </button>
          </div>

          <div className="pipeline-form-row">
            <label>
              <span>名称</span>
              <input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="例：每日晨报流水线" />
            </label>
            <label>
              <span>触发方式</span>
              <select
                value={draft.mode}
                onChange={(event) => setDraft({ ...draft, mode: event.target.value as Draft["mode"] })}
              >
                <option value="daily">每天定时</option>
                <option value="interval">固定间隔</option>
              </select>
            </label>
            {draft.mode === "daily" ? (
              <label>
                <span>触发时刻</span>
                <input type="time" value={draft.time} onChange={(event) => setDraft({ ...draft, time: event.target.value })} />
              </label>
            ) : (
              <label>
                <span>间隔（小时）</span>
                <input
                  type="number"
                  min={1}
                  max={168}
                  value={draft.hours}
                  onChange={(event) => setDraft({ ...draft, hours: Number(event.target.value) })}
                />
              </label>
            )}
          </div>

          <div className="pipeline-steps-editor">
            {draft.steps.map((step, index) => {
              const meta = STEP_META[step.kind];
              return (
                <div className="pipeline-step-edit" key={step.id}>
                  <div className="pipeline-step-edit-head">
                    <span className="pipeline-step-index">{index + 1}</span>
                    <select
                      value={step.kind}
                      onChange={(event) => {
                        const kind = event.target.value as PipelineStepKind;
                        setDraft((prev) =>
                          prev
                            ? {
                                ...prev,
                                steps: prev.steps.map((row) =>
                                  row.id === step.id ? { ...newStep(kind), id: row.id } : row,
                                ),
                              }
                            : prev,
                        );
                      }}
                    >
                      {KIND_ORDER.map((kind) => (
                        <option key={kind} value={kind}>
                          {STEP_META[kind].label}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label="删除步骤"
                      onClick={() =>
                        setDraft((prev) => (prev ? { ...prev, steps: prev.steps.filter((row) => row.id !== step.id) } : prev))
                      }
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                  <p className="pipeline-step-hint">{meta.hint}</p>
                  {meta.params.map((param) => (
                    <label key={param.key} className="pipeline-step-param">
                      <span>{param.label}</span>
                      <input
                        value={step.params[param.key] ?? ""}
                        placeholder={param.placeholder}
                        onChange={(event) => setDraftStepParam(step.id, param.key, event.target.value)}
                      />
                    </label>
                  ))}
                </div>
              );
            })}
            <button type="button" className="button button-secondary pipeline-add-step" onClick={() => setDraft((prev) => (prev ? { ...prev, steps: [...prev.steps, newStep("task")] } : prev))}>
              <Plus size={15} />添加步骤
            </button>
          </div>

          <div className="pipeline-editor-actions">
            <button type="button" className="button button-secondary" onClick={() => setDraft(null)}>
              取消
            </button>
            <button type="button" className="button button-primary" onClick={saveDraft}>
              保存
            </button>
          </div>
        </div>
      )}

      {pipelines.length === 0 && !draft && (
        <div className="console-card module-page-card empty-search">
          <Clock3 size={24} />
          <strong>还没有流水线</strong>
          <span>点「新建流水线」把重复动作串起来，到点自动执行</span>
        </div>
      )}

      <div className="pipeline-list">
        {pipelines.map((pipeline) => {
          const lastRun = pipeline.history[0];
          const busy = running[pipeline.id] || isPipelineRunning(pipeline.id);
          const live = liveSteps[pipeline.id] ?? [];
          return (
            <article className="console-card pipeline-card" key={pipeline.id}>
              <div className="pipeline-card-head">
                <div className="pipeline-card-title">
                  <span className={`pipeline-badge ${pipeline.enabled ? "on" : ""}`}>{pipeline.enabled ? "运行中" : "已停用"}</span>
                  <h3>{pipeline.name}</h3>
                </div>
                <div className="pipeline-card-actions">
                  <button type="button" className="button button-secondary" onClick={() => void runOne(pipeline.id, true)} disabled={busy}>
                    {busy ? <LoaderCircle size={15} className="spin" /> : <Play size={15} />}
                    {busy ? "执行中" : "立即运行"}
                  </button>
                  <button type="button" className="icon-button" aria-label="编辑" onClick={() => startEdit(pipeline)}>
                    <Pencil size={15} />
                  </button>
                  <button type="button" className="icon-button" aria-label="删除" onClick={() => removePipeline(pipeline.id)}>
                    <Trash2 size={15} />
                  </button>
                  <button
                    type="button"
                    className={`pipeline-switch ${pipeline.enabled ? "on" : ""}`}
                    role="switch"
                    aria-checked={pipeline.enabled}
                    aria-label={pipeline.enabled ? "停用流水线" : "启用流水线"}
                    onClick={() => togglePipeline(pipeline)}
                  >
                    <span />
                  </button>
                </div>
              </div>

              <div className="pipeline-meta">
                <span>
                  <Clock3 size={13} /> {nextRunLabel(pipeline, Date.now())}
                </span>
                <span>
                  {pipeline.mode === "daily" ? `每天 ${pipeline.time}` : `每 ${pipeline.hours} 小时`} · {pipeline.steps.length} 步
                </span>
                <span>上次：{lastRun ? formatTime(lastRun.at) : "未运行"}</span>
              </div>

              <div className="pipeline-chips">
                {pipeline.steps.map((step, index) => (
                  <span className="pipeline-chip" key={step.id}>
                    {index + 1}. {STEP_META[step.kind].label}
                  </span>
                ))}
              </div>

              {busy && live.length > 0 && (
                <ul className="pipeline-live">
                  {live.map((step) => (
                    <li key={step.stepId} className={step.status}>
                      {step.status === "done" ? <Check size={13} /> : <X size={13} />}
                      <strong>{step.label}</strong>
                      <span>{step.detail}</span>
                    </li>
                  ))}
                </ul>
              )}

              {lastRun && (
                <div className="pipeline-history">
                  <button
                    type="button"
                    className="pipeline-history-toggle"
                    onClick={() => setExpandedId(expandedId === pipeline.id ? null : pipeline.id)}
                  >
                    <ChevronDown size={14} className={expandedId === pipeline.id ? "rotated" : ""} />
                    最近运行：{formatTime(lastRun.at)} · {lastRun.status === "done" ? "全部成功" : lastRun.status === "partial" ? "部分失败" : "失败"} ·{" "}
                    {formatDuration(lastRun.durationMs)}（{pipeline.history.length} 条记录）
                  </button>
                  {expandedId === pipeline.id && (
                    <ol className="pipeline-run-list">
                      {pipeline.history.map((run: PipelineRun) => (
                        <li key={run.at}>
                          <div className="pipeline-run-head">
                            <span>{formatTime(run.at)}</span>
                            <span className={`pipeline-run-status ${run.status}`}>{run.status}</span>
                            <span>{formatDuration(run.durationMs)}</span>
                          </div>
                          <ul>
                            {run.steps.map((step) => (
                              <li key={`${run.at}-${step.stepId}`} className={step.status}>
                                <strong>{step.label}</strong>
                                <span>{step.detail}</span>
                              </li>
                            ))}
                          </ul>
                        </li>
                      ))}
                    </ol>
                  )}
                </div>
              )}
            </article>
          );
        })}
      </div>

      <div className="pipeline-footnote">
        <Download size={13} /> 流水线配置与运行记录只存在本机浏览器；任务类步骤的产出请到「任务中心 / 内容工厂」查看。
      </div>
    </section>
  );
}

export default PipelineCenter;
