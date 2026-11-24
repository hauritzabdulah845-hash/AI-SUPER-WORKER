import { useMemo, useState } from "react";
import { Bot, CheckCircle2, MessageSquareText, Plug, Save, Sparkles, Trash2, Wrench } from "lucide-react";
import {
  KF_CHANNELS,
  loadRules,
  saveRules,
  seedRules,
  simulateReply,
  type KfRule,
} from "../cloud/kfchannels";

/**
 * 客服渠道中心：渠道清单 + 关键词规则编辑 + 对话模拟器。
 * 规则顺序与 wecom-kf-service 一致（关键词 → 默认兜底；服务端另有可选 AI 兜底），
 * 接入前先把话术配好，接入后以服务端 rules.json 为运行时真源。
 */
export function ServiceChannels() {
  const [rules, setRules] = useState<KfRule[]>(() => loadRules());
  const [text, setText] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [result, setResult] = useState<{ reply: string; ruleName: string; via: string } | null>(null);
  const [notice, setNotice] = useState("");
  const [editing, setEditing] = useState<KfRule | null>(null);

  const persist = (next: KfRule[]) => {
    setRules(next);
    saveRules(next);
  };

  const runSimulate = () => {
    if (!text.trim()) {
      setNotice("先输入一条客户消息");
      return;
    }
    const hit = simulateReply(rules, text, { name: customerName.trim() || undefined });
    setResult({
      reply: hit.reply || "（没有命中任何规则，服务端将记录未回复）",
      ruleName: hit.rule?.name ?? "未命中",
      via: hit.via === "keyword" ? "关键词命中" : hit.via === "default" ? "默认兜底" : "未命中",
    });
    setNotice("");
  };

  const addRule = () => {
    const rule: KfRule = {
      id: `rule-${Date.now()}`,
      name: "新规则",
      keywords: [],
      reply: "",
      enabled: true,
      isDefault: false,
    };
    setEditing(rule);
  };

  const saveEditing = () => {
    if (!editing) return;
    if (!editing.name.trim() || !editing.reply.trim()) {
      setNotice("规则需要名称与回复内容");
      return;
    }
    const exists = rules.some((row) => row.id === editing.id);
    const next = exists ? rules.map((row) => (row.id === editing.id ? editing : row)) : [...rules, editing];
    persist(next);
    setEditing(null);
    setNotice(`规则「${editing.name}」已保存（仅本机；服务端接入后以 rules.json 为准）`);
  };

  const toggleRule = (id: string) => {
    persist(rules.map((row) => (row.id === id ? { ...row, enabled: !row.enabled } : row)));
  };

  const removeRule = (id: string) => {
    persist(rules.filter((row) => row.id !== id));
    setNotice("规则已删除");
  };

  const resetSeed = () => {
    persist(seedRules());
    setNotice("已恢复演示规则种子");
  };

  const keywordCount = useMemo(() => rules.reduce((sum, rule) => sum + rule.keywords.length, 0), [rules]);

  return (
    <section className="service-page">
      <div className="console-card service-head">
        <div>
          <h2>
            <MessageSquareText size={16} /> 客服渠道中心
          </h2>
          <p>
            多渠道客服的统一入口：已支持渠道直接可用，未接渠道预留适配器位（按约定由你后续接入）。
            下方规则引擎与模拟器在浏览器内即可用——接入前先把关键词话术配好。
          </p>
        </div>
        <div className="service-stats">
          <span>{KF_CHANNELS.filter((channel) => channel.status === "live").length} 个渠道已支持</span>
          <span>{rules.length} 条规则 · {keywordCount} 个关键词</span>
        </div>
      </div>

      <div className="service-channels">
        {KF_CHANNELS.map((channel) => (
          <article className={`console-card service-channel ${channel.status}`} key={channel.key}>
            <div className="service-channel-head">
              <span className="service-channel-icon">
                {channel.status === "live" ? <CheckCircle2 size={16} /> : <Wrench size={16} />}
              </span>
              <h3>{channel.label}</h3>
              <em className={channel.status}>{channel.statusLabel}</em>
            </div>
            <p>{channel.hint}</p>
          </article>
        ))}
      </div>

      <div className="service-grid">
        <div className="console-card service-rules">
          <div className="console-card-header">
            <div>
              <h2>关键词规则</h2>
              <p>顺序：关键词命中 → 默认兜底（服务端另有可选 AI 意图兜底）</p>
            </div>
            <div className="service-actions">
              <button type="button" className="text-link" onClick={resetSeed}>
                恢复演示种子
              </button>
              <button type="button" className="button button-secondary" onClick={addRule}>
                <Sparkles size={14} />新建规则
              </button>
            </div>
          </div>

          {editing && (
            <div className="service-rule-editor">
              <label>
                <span>规则名称</span>
                <input value={editing.name} onChange={(event) => setEditing({ ...editing, name: event.target.value })} />
              </label>
              <label>
                <span>关键词（逗号分隔）</span>
                <input
                  value={editing.keywords.join(", ")}
                  onChange={(event) =>
                    setEditing({
                      ...editing,
                      keywords: event.target.value
                        .split(/[,，]/)
                        .map((item) => item.trim())
                        .filter(Boolean),
                    })
                  }
                  placeholder="多少钱, 价格, 报价"
                />
              </label>
              <label>
                <span>回复内容（支持 {"{{name}}"} {"{{stage}}"} {"{{source}}"}</span>
                <textarea rows={3} value={editing.reply} onChange={(event) => setEditing({ ...editing, reply: event.target.value })} />
              </label>
              <label className="service-check">
                <input
                  type="checkbox"
                  checked={editing.isDefault}
                  onChange={(event) => setEditing({ ...editing, isDefault: event.target.checked })}
                />
                设为默认兜底规则
              </label>
              <div className="service-editor-actions">
                <button type="button" className="button button-secondary" onClick={() => setEditing(null)}>
                  取消
                </button>
                <button type="button" className="button button-primary" onClick={saveEditing}>
                  <Save size={14} />保存规则
                </button>
              </div>
            </div>
          )}

          <ul className="service-rule-list">
            {rules.map((rule) => (
              <li key={rule.id} className={rule.enabled ? "" : "disabled"}>
                <div className="service-rule-info">
                  <strong>
                    {rule.name}
                    {rule.isDefault && <em className="default">默认</em>}
                  </strong>
                  <span>{rule.keywords.length ? rule.keywords.join(" / ") : "（无关键词）"}</span>
                  <p>{rule.reply}</p>
                </div>
                <div className="service-rule-actions">
                  <button type="button" className="text-link" onClick={() => toggleRule(rule.id)}>
                    {rule.enabled ? "停用" : "启用"}
                  </button>
                  <button type="button" className="text-link" onClick={() => setEditing(rule)}>
                    编辑
                  </button>
                  {!rule.isDefault && (
                    <button type="button" className="text-link" onClick={() => removeRule(rule.id)}>
                      <Trash2 size={13} />
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>

        <div className="console-card service-sim">
          <div className="console-card-header">
            <div>
              <h2>
                <Bot size={15} /> 对话模拟器
              </h2>
              <p>用当前规则预览客户消息的自动回复效果</p>
            </div>
          </div>

          <label className="service-field">
            <span>客户称呼（可选）</span>
            <input value={customerName} onChange={(event) => setCustomerName(event.target.value)} placeholder="例：王总" />
          </label>
          <label className="service-field">
            <span>客户消息</span>
            <textarea rows={3} value={text} onChange={(event) => setText(event.target.value)} placeholder="你们这边多少钱？" />
          </label>
          <button type="button" className="button button-primary" onClick={runSimulate}>
            <Sparkles size={15} />模拟回复
          </button>

          {notice && <p className="mapleads-notice">{notice}</p>}

          {result && (
            <div className="service-sim-result">
              <div className="service-sim-meta">
                <span className="service-sim-via">{result.via}</span>
                <span>命中规则：{result.ruleName}</span>
              </div>
              <div className="service-sim-bubble customer">{text}</div>
              <div className="service-sim-bubble agent">
                <MessageSquareText size={14} />
                {result.reply}
              </div>
              <p className="service-sim-note">
                <Plug size={12} /> 模拟在浏览器内完成；真实链路为 wecom-kf-service（关键词 → AI 兜底 → 默认）。
              </p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

export default ServiceChannels;
