import { friendlyError } from "../cloud/friendlyError";
import { useEffect, useId, useMemo, useState } from "react";
import {
  ArrowRight,
  BarChart3,
  Bot,
  Check,
  CheckCircle2,
  ChevronRight,
  Circle,
  FileText,
  Lightbulb,
  LoaderCircle,
  Megaphone,
  Play,
  RotateCcw,
  Sparkles,
  Target,
  Users,
} from "lucide-react";
import { listTemplates, type AgentRow, type AgentTemplate } from "../cloud/api";
import { runAgentTask, type RunnerStep } from "../cloud/runner";

const presets = [
  {
    label: "新品上市",
    command: "为一家连锁餐饮品牌制定 7 天新品营销计划，并完成内容、获客与复盘方案",
  },
  {
    label: "线索激活",
    command: "分析沉睡客户的共同特征，设计一套分层激活与回访计划",
  },
  {
    label: "经营复盘",
    command: "汇总本周内容、线索和销售数据，找出转化断点并生成下周行动建议",
  },
];

const stepVisuals: Record<string, { icon: typeof Bot; color: string }> = {
  策划: { icon: Lightbulb, color: "violet" },
  内容: { icon: FileText, color: "blue" },
  增长: { icon: Target, color: "orange" },
  获客: { icon: Target, color: "orange" },
  销售: { icon: Users, color: "green" },
  私域: { icon: Users, color: "green" },
  分析: { icon: BarChart3, color: "pink" },
  知识: { icon: FileText, color: "blue" },
};

const defaultVisuals = { icon: Bot, color: "violet" };

type RunState = "idle" | "running" | "done" | "error";

interface CommandDemoProps {
  compact?: boolean;
  ownerName?: string | null;
  /** 当前账号已启用的智能体：带自定义人设时按岗位覆盖官方提示词。 */
  agents?: AgentRow[];
  onNeedLogin?: () => void;
  onOpenConsole?: () => void;
  onFinished?: () => void;
  initialGoal?: string;
  initialTemplateCode?: string;
}

export default function CommandDemo({
  compact = false,
  ownerName,
  agents,
  onNeedLogin,
  onOpenConsole,
  onFinished,
  initialGoal,
  initialTemplateCode,
}: CommandDemoProps) {
  const inputId = useId();
  const [command, setCommand] = useState(initialGoal?.trim() || presets[0].command);
  const [runState, setRunState] = useState<RunState>("idle");
  const [steps, setSteps] = useState<RunnerStep[]>([]);
  const [templates, setTemplates] = useState<AgentTemplate[]>([]);
  const [templateCode, setTemplateCode] = useState<string>(initialTemplateCode ?? "");
  const [title, setTitle] = useState("");
  const [domain, setDomain] = useState("");
  const [summary, setSummary] = useState("");
  const [tokens, setTokens] = useState(0);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    listTemplates()
      .then((rows) => {
        if (!active) return;
        setTemplates(rows);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  const selectedTemplate = useMemo(
    () => templates.find((item) => item.code === templateCode) ?? null,
    [templates, templateCode],
  );

  const resetTask = () => {
    setRunState("idle");
    setSteps([]);
    setSummary("");
    setTokens(0);
    setError("");
  };

  const runTask = async () => {
    if (!command.trim() || runState === "running") return;
    // 数据必须归属到登录账号，未登录不进执行流程。
    if (onNeedLogin) {
      onNeedLogin();
      return;
    }

    setError("");
    setSummary("");
    setTokens(0);
    setSteps([]);
    setRunState("running");

    try {
      const result = await runAgentTask({
        goal: command.trim(),
        template: selectedTemplate,
        templates,
        agents,
        ownerName,
        onProgress: (progress) => {
          setTitle(progress.title);
          setDomain(progress.domain);
          setSteps(progress.steps);
        },
      });
      setTitle(result.title);
      setDomain(result.domain);
      setSteps(result.steps);
      setSummary(result.summary);
      setTokens(result.tokens);
      if (result.status === "failed") {
        setRunState("error");
        setError("模型通道不可用，本次未产出内容（多为平台配额用尽）。到「模型接入」登录账号或配置自己的 Key 后，可在任务中心重跑。");
      } else {
        setRunState("done");
      }
      onFinished?.();
    } catch (runError) {
      setError(runError instanceof Error ? friendlyError(runError) : "任务执行失败，请稍后重试");
      setRunState("error");
    }
  };

  const progress = steps.length
    ? Math.round((steps.filter((step) => step.status === "done" || step.status === "error").length / steps.length) * 100)
    : 0;

  return (
    <div className={`command-demo ${compact ? "command-demo-compact" : ""}`}>
      <div className="command-input-panel">
        <div className="panel-kicker">
          <Sparkles size={15} />
          AI 总控 · 我的工作区
        </div>
        <h3>只说目标，剩下的交给团队</h3>
        <p className="panel-description">
          AI 总控会自动选择智能体、拆解步骤、调用企业知识与工具，并把执行过程与结果写入你的专属云端工作区。
        </p>

        <label htmlFor={inputId} className="command-label">你的业务目标</label>
        <div className="command-textarea-wrap">
          <textarea
            id={inputId}
            value={command}
            onChange={(event) => {
              setCommand(event.target.value);
              if (runState !== "running") resetTask();
            }}
            rows={compact ? 3 : 4}
            maxLength={180}
            placeholder="例如：帮我为新品制定一周营销计划"
          />
          <div className="command-input-meta">
            <span>{command.length}/180</span>
            <span>写入我的专属工作区</span>
          </div>
        </div>

        {templates.length > 0 && (
          <div className="template-picker">
            <span className="template-picker-label">指派岗位模板</span>
            <div className="template-picker-options">
              <button type="button" className={templateCode === "" ? "active" : ""} onClick={() => setTemplateCode("")} disabled={runState === "running"}>自动编排</button>
              {templates.slice(0, 8).map((template) => (
                <button type="button" key={template.code} className={templateCode === template.code ? "active" : ""} onClick={() => setTemplateCode(template.code)} disabled={runState === "running"}>
                  {template.name}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="preset-list" aria-label="目标示例">
          {presets.map((preset) => (
            <button
              key={preset.label}
              type="button"
              className="preset-chip"
              onClick={() => {
                setCommand(preset.command);
                resetTask();
              }}
              disabled={runState === "running"}
            >
              {preset.label}
            </button>
          ))}
        </div>

        <div className="command-actions">
          <button type="button" className="button button-primary command-run" onClick={runTask} disabled={!command.trim() || runState === "running"}>
            {runState === "running" ? (
              <><LoaderCircle size={17} className="spin" />正在协同执行</>
            ) : runState === "done" ? (
              <><RotateCcw size={17} />重新运行</>
            ) : (
              <><Play size={17} fill="currentColor" />开始执行</>
            )}
          </button>
          {onOpenConsole && (
            <button type="button" className="button button-ghost" onClick={onOpenConsole}>
              完整总控台<ArrowRight size={16} />
            </button>
          )}
        </div>

        <div className="approval-note">
          <CheckCircle2 size={16} />
          涉及发布、触达与付费的动作，均需人工审批后执行
        </div>
      </div>

      <div className="execution-panel" aria-live="polite">
        <div className="execution-header">
          <div>
            <span className="execution-eyebrow">{domain ? `任务编排 · ${domain}` : "任务编排"}</span>
            <h3>{runState === "done" ? "任务已完成" : runState === "running" ? "AI 团队正在协作" : runState === "error" ? "执行中断" : "等待你的目标"}</h3>
            {title && <p className="execution-task-title">{title}</p>}
          </div>
          <div className={`run-status ${runState}`}>
            {runState === "running" ? <LoaderCircle size={14} className="spin" /> : runState === "done" ? <Check size={14} /> : <Circle size={12} />}
            {runState === "running" ? "运行中" : runState === "done" ? "已交付" : runState === "error" ? "失败" : "待开始"}
          </div>
        </div>

        <div className="progress-track" aria-label={`任务进度 ${progress}%`}>
          <div className="progress-value" style={{ width: `${progress}%` }} />
        </div>

        <div className="execution-steps">
          {steps.length === 0 && (
            <div className="demo-hint">
              <Bot size={17} />
              点击“开始执行”，由大模型现场拆解任务并逐步交付
            </div>
          )}

          {steps.map((step, index) => {
            const visual = Object.entries(stepVisuals).find(([key]) => step.agent.includes(key))?.[1] ?? defaultVisuals;
            const Icon = visual.icon;
            const isDone = step.status === "done";
            const isActive = step.status === "running";
            const isFailed = step.status === "error";

            return (
              <div className={`execution-step ${isDone ? "is-done" : ""} ${isActive ? "is-active" : ""} ${isFailed ? "is-failed" : ""}`} key={`${step.agent}-${index}`}>
                <div className={`step-icon step-${visual.color}`}>
                  {isDone ? <Check size={17} /> : isActive ? <LoaderCircle size={17} className="spin" /> : isFailed ? <Circle size={17} /> : <Icon size={17} />}
                </div>
                <div className="step-content">
                  <div className="step-title-row">
                    <strong>{step.agent}</strong>
                    <span>{isDone ? "已完成" : isActive ? "执行中" : isFailed ? "失败" : "等待"}</span>
                  </div>
                  <p>{step.action}</p>
                  {step.output && <div className="step-result">{step.output}</div>}
                </div>
                {isDone && <CheckCircle2 size={17} className="step-check" />}
              </div>
            );
          })}
        </div>

        {summary && (
          <div className="delivery-card">
            <div className="delivery-icon"><Megaphone size={20} /></div>
            <div>
              <strong>交付结论</strong>
              <span>{summary}</span>
            </div>
            <ChevronRight size={18} />
          </div>
        )}

        {error && <div className="login-error execution-error">{error}</div>}

        {runState === "done" && (
          <div className="execution-footnote">
            本次执行共消耗 {tokens} tokens，过程与产出已写入云端任务记录。
          </div>
        )}
      </div>
    </div>
  );
}
