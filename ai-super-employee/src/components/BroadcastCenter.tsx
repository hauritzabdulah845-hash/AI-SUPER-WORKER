import { useCallback, useEffect, useRef, useState } from "react";
import { Clock3, LoaderCircle, Play, Plus, Send, Trash2, Users, X } from "lucide-react";
import type { LeadRow } from "../cloud/api";
import {
  createBroadcast,
  dueBroadcasts,
  executeBroadcast,
  isBroadcastDue,
  loadBroadcasts,
  removeBroadcast,
  renderContent,
  selectRecipients,
  upsertBroadcast,
  type BroadcastPlan,
} from "../cloud/broadcast";

const STAGE_OPTIONS = ["新建", "跟进中", "已预约", "已成交"];
const INTENT_OPTIONS = ["高意向", "中意向", "低意向"];

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString("zh-CN", {
    hour12: false,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function toLocalDateTimeValue(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

interface Draft {
  id: string | null;
  name: string;
  content: string;
  stages: string[];
  intents: string[];
  scheduleAt: string;
  immediate: boolean;
}

function toDraft(plan: BroadcastPlan): Draft {
  return {
    id: plan.id,
    name: plan.name,
    content: plan.content,
    stages: [...plan.filter.stages],
    intents: [...plan.filter.intents],
    scheduleAt: plan.scheduleAt,
    immediate: false,
  };
}

/**
 * 群发计划（主动激活）：受众=线索阶段/意向筛选，内容支持 {{name}} 等变量；
 * 定时到点在本页打开时补跑；未配企微服务地址时为本地演示发送。
 */
export function BroadcastCenter(props: { leads: LeadRow[]; kfBaseUrl: string; kfSecret: string }) {
  const { leads, kfBaseUrl, kfSecret } = props;

  const [plans, setPlans] = useState<BroadcastPlan[]>(() => loadBroadcasts());
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [toast, setToast] = useState("");
  const toastTimer = useRef<number | null>(null);
  const runningRef = useRef<Set<string>>(new Set());

  const notify = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(""), 4500);
  }, []);

  const refresh = useCallback(() => setPlans(loadBroadcasts()), []);

  const runOne = useCallback(
    async (plan: BroadcastPlan, manual: boolean) => {
      if (runningRef.current.has(plan.id)) return;
      runningRef.current.add(plan.id);
      setBusyId(plan.id);
      try {
        const { result, entry } = await executeBroadcast(plan, leads, { baseUrl: kfBaseUrl, secret: kfSecret });
        const updated: BroadcastPlan = {
          ...plan,
          status: plan.scheduleAt && plan.status === "scheduled" && !manual ? "done" : plan.scheduleAt ? "done" : plan.status,
          history: [entry, ...plan.history].slice(0, 10),
        };
        // 手动发送的草稿发送完保持草稿（可改再发）；定时计划发送后置 done
        if (plan.scheduleAt) updated.status = "done";
        upsertBroadcast(updated);
        refresh();
        notify(
          result.total === 0
            ? `「${plan.name}」：${result.detail}`
            : `「${plan.name}」完成：${result.detail}`,
        );
      } catch (error) {
        notify(`发送失败：${error instanceof Error ? error.message : String(error)}`);
      } finally {
        runningRef.current.delete(plan.id);
        setBusyId(null);
      }
    },
    [leads, kfBaseUrl, kfSecret, notify, refresh],
  );

  // 调度：打开立即检查补跑，之后每 30 秒轮询到点计划（与定时流水线同一策略）
  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      const due = dueBroadcasts(loadBroadcasts(), Date.now());
      for (const plan of due) void runOne(plan, false);
    };
    tick();
    const timer = window.setInterval(tick, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [runOne]);

  useEffect(
    () => () => {
      if (toastTimer.current) window.clearTimeout(toastTimer.current);
    },
    [],
  );

  const startCreate = () =>
    setDraft({
      id: null,
      name: "",
      content: "",
      stages: [],
      intents: [],
      scheduleAt: toLocalDateTimeValue(new Date(Date.now() + 3_600_000)),
      immediate: false,
    });

  const saveDraft = () => {
    if (!draft) return;
    if (!draft.name.trim()) {
      notify("先给计划起个名字");
      return;
    }
    if (!draft.content.trim()) {
      notify("群发内容不能为空");
      return;
    }
    const list = loadBroadcasts();
    const existing = list.find((row) => row.id === draft.id);
    const base = existing ?? createBroadcast(draft.name);
    const scheduleAt = draft.scheduleAt && Date.parse(draft.scheduleAt) > Date.now() ? new Date(draft.scheduleAt).toISOString() : "";
    const next: BroadcastPlan = {
      ...base,
      name: draft.name.trim(),
      content: draft.content,
      filter: { stages: [...draft.stages], intents: [...draft.intents] },
      scheduleAt,
      status: scheduleAt ? "scheduled" : "draft",
    };
    const merged = upsertBroadcast(next);
    setPlans(merged);
    setDraft(null);
    notify(scheduleAt ? `已排期：${formatTime(Date.parse(scheduleAt))} 自动发送` : "已保存（手动发送）");
  };

  const removePlan = (id: string) => {
    setPlans(removeBroadcast(id));
    notify("计划已删除");
  };

  const toggleListValue = (list: string[], value: string): string[] =>
    list.includes(value) ? list.filter((item) => item !== value) : [...list, value];

  const preview = draft ? selectRecipients(leads, { stages: draft.stages, intents: draft.intents }) : null;
  const serviceReady = Boolean(kfBaseUrl.trim());

  return (
    <section className="broadcast-page">
      <div className="console-card broadcast-head">
        <div>
          <h2>
            <Send size={16} /> 群发计划（主动激活）
          </h2>
          <p>
            按线索阶段/意向筛选受众，内容支持 <code>{"{{name}}"}</code>、<code>{"{{stage}}"}</code>、<code>{"{{source}}"}</code>{" "}
            变量；定时计划在本页打开时到点自动发送（错过补跑一次）。
            <strong>合规：只发自有线索</strong>——已同步企微的才可真实送达，无服务地址时为演示发送。
            {serviceReady ? " 当前已配置企微服务地址。" : " 当前未配置服务地址，全部为演示发送。"}
          </p>
        </div>
        <button type="button" className="button button-primary" onClick={startCreate}>
          <Plus size={15} />新建计划
        </button>
      </div>

      {toast && <div className="pipeline-toast">{toast}</div>}

      {draft && (
        <div className="console-card broadcast-editor">
          <div className="console-card-header">
            <div>
              <h2>{draft.id ? "编辑计划" : "新建计划"}</h2>
              <p>受众为空 = 全部线索；留空排期时间 = 仅手动发送</p>
            </div>
            <button type="button" className="icon-button" aria-label="关闭" onClick={() => setDraft(null)}>
              <X size={16} />
            </button>
          </div>

          <div className="broadcast-form-row">
            <label>
              <span>计划名称</span>
              <input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="例：高意向客户周末邀约" />
            </label>
            <label>
              <span>定时发送（可选）</span>
              <input
                type="datetime-local"
                value={draft.scheduleAt}
                onChange={(event) => setDraft({ ...draft, scheduleAt: event.target.value })}
              />
            </label>
          </div>

          <label className="broadcast-content-field">
            <span>群发内容</span>
            <textarea
              value={draft.content}
              onChange={(event) => setDraft({ ...draft, content: event.target.value })}
              rows={4}
              placeholder={"{{name}}你好，本周到店可领体验装，回复「1」预留名额"}
            />
          </label>

          <div className="broadcast-filters">
            <div>
              <strong>线索阶段</strong>
              <div className="broadcast-chips">
                {STAGE_OPTIONS.map((stage) => (
                  <button
                    type="button"
                    key={stage}
                    className={draft.stages.includes(stage) ? "active" : ""}
                    onClick={() => setDraft({ ...draft, stages: toggleListValue(draft.stages, stage) })}
                  >
                    {stage}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <strong>意向等级</strong>
              <div className="broadcast-chips">
                {INTENT_OPTIONS.map((intent) => (
                  <button
                    type="button"
                    key={intent}
                    className={draft.intents.includes(intent) ? "active" : ""}
                    onClick={() => setDraft({ ...draft, intents: toggleListValue(draft.intents, intent) })}
                  >
                    {intent}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {preview && (
            <p className="broadcast-preview">
              <Users size={13} /> 命中 {preview.matched.length} 条线索 · 可送达 {preview.deliverable.length} 条
              {preview.noExternalId.length > 0 && ` · ${preview.noExternalId.length} 条无企微ID（发送时跳过）`}
            </p>
          )}

          <div className="broadcast-editor-actions">
            <button type="button" className="button button-secondary" onClick={() => setDraft(null)}>
              取消
            </button>
            <button type="button" className="button button-primary" onClick={saveDraft}>
              保存
            </button>
          </div>
        </div>
      )}

      {plans.length === 0 && !draft && (
        <div className="console-card module-page-card empty-search">
          <Send size={24} />
          <strong>还没有群发计划</strong>
          <span>点「新建计划」创建第一条主动激活消息</span>
        </div>
      )}

      <div className="broadcast-list">
        {plans.map((plan) => {
          const audience = selectRecipients(leads, plan.filter);
          const lastRun = plan.history[0];
          const busy = busyId === plan.id;
          const due = isBroadcastDue(plan, Date.now());
          return (
            <article className="console-card broadcast-card" key={plan.id}>
              <div className="broadcast-card-head">
                <div className="broadcast-card-title">
                  <span className={`pipeline-badge ${plan.status === "scheduled" ? "on" : ""}`}>
                    {plan.status === "scheduled" ? (due ? "待发送" : "已排期") : plan.status === "done" ? "已发送" : "草稿"}
                  </span>
                  <h3>{plan.name}</h3>
                </div>
                <div className="pipeline-card-actions">
                  <button type="button" className="button button-secondary" onClick={() => void runOne(plan, true)} disabled={busy || !plan.content.trim()}>
                    {busy ? <LoaderCircle size={15} className="spin" /> : <Play size={15} />}
                    {busy ? "发送中" : "立即发送"}
                  </button>
                  <button type="button" className="icon-button" aria-label="编辑" onClick={() => setDraft(toDraft(plan))}>
                    <Clock3 size={15} />
                  </button>
                  <button type="button" className="icon-button" aria-label="删除" onClick={() => removePlan(plan.id)}>
                    <Trash2 size={15} />
                  </button>
                </div>
              </div>

              <p className="broadcast-content-preview">{renderContent(plan.content, { name: "张三", stage: "跟进中", source: "地图获客" }) || "（内容为空）"}</p>

              <div className="pipeline-meta">
                <span>
                  <Users size={13} /> 受众 {audience.matched.length}（可送达 {audience.deliverable.length}）
                </span>
                <span>
                  阶段：{plan.filter.stages.length ? plan.filter.stages.join("、") : "全部"} · 意向：
                  {plan.filter.intents.length ? plan.filter.intents.join("、") : "全部"}
                </span>
                <span>{plan.scheduleAt ? `排期 ${formatTime(Date.parse(plan.scheduleAt))}` : "手动发送"}</span>
                <span>上次：{lastRun ? formatTime(lastRun.at) : "未发送"}</span>
              </div>

              {lastRun && (
                <div className="broadcast-lastrun">
                  上次结果：{lastRun.detail}（共 {lastRun.total} · 真发 {lastRun.sent} · 演示 {lastRun.demo} · 跳过 {lastRun.skipped} · 失败 {lastRun.failed}）
                </div>
              )}

              {plan.history.length > 1 && (
                <details className="broadcast-history">
                  <summary>历史记录（{plan.history.length}）</summary>
                  <ul>
                    {plan.history.map((entry) => (
                      <li key={entry.at}>
                        <span>{formatTime(entry.at)}</span>
                        <span>{entry.detail}</span>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </article>
          );
        })}
      </div>

      <div className="pipeline-footnote">
        <Clock3 size={13} /> 计划与历史仅存本机；定时发送需要本页打开（与定时流水线同一调度策略）。
      </div>
    </section>
  );
}

export default BroadcastCenter;
