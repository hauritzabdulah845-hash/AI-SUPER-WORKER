import { useMemo, useState } from "react";
import { Bell, Bot, CheckCircle2, MessageSquareText, Plug, Save, ShieldAlert, Sparkles, Trash2, Wrench } from "lucide-react";
import {
  KF_CHANNELS,
  loadLists,
  loadRules,
  parseListInput,
  saveLists,
  saveRules,
  seedRules,
  simulateReply,
  type KfListEntry,
  type KfLists,
  type KfRule,
} from "../cloud/kfchannels";

/**
 * 客服渠道中心：渠道清单 + 关键词规则编辑 + 对话模拟器。
 * 规则顺序与 wecom-kf-service 一致（关键词 → 默认兜底；服务端另有可选 AI 兜底），
 * 接入前先把话术配好，接入后以服务端 rules.json 为运行时真源。
 */
export interface ServiceChannelsProps {
  /** 控制台已存的企微服务地址/密钥（ai-employee:kf-sync）；用于名单同步与意向拉取 */
  kfBaseUrl?: string;
  kfSecret?: string;
}

interface LocalIntent {
  at: number;
  text: string;
  source: "模拟器" | "服务";
  stage?: string;
}

export function ServiceChannels({ kfBaseUrl = "", kfSecret = "" }: ServiceChannelsProps) {
  const [rules, setRules] = useState<KfRule[]>(() => loadRules());
  const [text, setText] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [result, setResult] = useState<{ reply: string; ruleName: string; via: string; intent: boolean; attachment?: string } | null>(null);
  const [notice, setNotice] = useState("");
  const [editing, setEditing] = useState<KfRule | null>(null);

  // 名单（白/黑名单）与意向提醒
  const [lists, setLists] = useState<KfLists>(() => loadLists());
  const [listKind, setListKind] = useState<"blacklist" | "whitelist">("blacklist");
  const [listInput, setListInput] = useState("");
  const [localIntents, setLocalIntents] = useState<LocalIntent[]>([]);
  const serviceConfigured = Boolean(kfBaseUrl.trim() && kfSecret.trim());

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
      intent: hit.intent,
      attachment: hit.attachment,
    });
    if (hit.intent) {
      setLocalIntents((prev) => [{ at: Date.now(), text: text.trim(), source: "模拟器" as const }, ...prev].slice(0, 20));
    }
    setNotice(hit.intent ? "⚠ 命中高意向词，已记入下方意向提醒（真实链路阶段跃迁时服务端也会落档）" : "");
  };

  /* ------------------------------ 名单 ------------------------------ */
  const persistLists = (next: KfLists) => setLists(saveLists(next));

  const addListEntries = () => {
    const entries = parseListInput(listInput);
    if (!entries.length) {
      setNotice("粘贴内容为空：每行 `id` 或 `id,姓名` 或 `id,姓名,备注`");
      return;
    }
    const list = lists[listKind];
    const ids = new Set(list.map((item) => item.id));
    const merged: KfListEntry[] = [...list];
    for (const entry of entries) {
      if (ids.has(entry.id)) continue;
      merged.push(entry);
      ids.add(entry.id);
    }
    persistLists({ ...lists, [listKind]: merged });
    setListInput("");
    setNotice(`已加入${listKind === "blacklist" ? "黑名单" : "白名单"} ${entries.length} 条（本机留档）`);
  };

  const removeListEntry = (kind: "blacklist" | "whitelist", id: string) => {
    persistLists({ ...lists, [kind]: lists[kind].filter((item) => item.id !== id) });
    setNotice("已移除");
  };

  const pushListsToService = async () => {
    if (!serviceConfigured) {
      setNotice("先在「企微私域」配置服务地址与密钥");
      return;
    }
    try {
      for (const kind of ["blacklist", "whitelist"] as const) {
        const response = await fetch(`${kfBaseUrl.trim().replace(/\/+$/, "")}/api/lists`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-admin-secret": kfSecret.trim() },
          body: JSON.stringify({ kind, action: "replace", entries: lists[kind] }),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
      }
      setNotice("名单已同步到服务端（群发门禁与自动回复即刻生效）");
    } catch (error) {
      setNotice(`同步失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const pullIntentsFromService = async () => {
    if (!serviceConfigured) {
      setNotice("先在「企微私域」配置服务地址与密钥");
      return;
    }
    try {
      const response = await fetch(`${kfBaseUrl.trim().replace(/\/+$/, "")}/api/intents`, {
        headers: { "x-admin-secret": kfSecret.trim() },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = (await response.json()) as { intents?: { at: string; text: string; stage: string }[] };
      const rows = (data.intents ?? []).map((item) => ({
        at: Date.parse(item.at) || Date.now(),
        text: item.text,
        stage: item.stage,
        source: "服务" as const,
      }));
      setLocalIntents(rows.slice(0, 20));
      setNotice(`已拉取 ${rows.length} 条意向提醒`);
    } catch (error) {
      setNotice(`拉取失败：${error instanceof Error ? error.message : String(error)}`);
    }
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
              <label>
                <span>附件文件名（可选：命中后回复正文 + [附件] 记录）</span>
                <input
                  value={editing.attachmentName ?? ""}
                  onChange={(event) => setEditing({ ...editing, attachmentName: event.target.value || undefined })}
                  placeholder="例：使用手册.pdf"
                />
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
                  <span>
                    {rule.keywords.length ? rule.keywords.join(" / ") : "（无关键词）"}
                    {rule.attachmentName && <em className="default">附件：{rule.attachmentName}</em>}
                  </span>
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
                {result.intent && <span className="service-sim-via intent">⚠ 高意向</span>}
                {result.attachment && <span className="service-sim-via">📎 {result.attachment}</span>}
              </div>
              <div className="service-sim-bubble customer">{text}</div>
              <div className="service-sim-bubble agent">
                <MessageSquareText size={14} />
                {result.reply}
                {result.attachment && <div className="service-sim-attachment">[附件] {result.attachment}</div>}
              </div>
              <p className="service-sim-note">
                <Plug size={12} /> 模拟在浏览器内完成；真实链路为 wecom-kf-service（关键词 → AI 兜底 → 默认）。
              </p>
            </div>
          )}
        </div>
      </div>

      <div className="service-grid">
        <div className="console-card service-rules">
          <div className="console-card-header">
            <div>
              <h2>
                <ShieldAlert size={15} /> 名单管理（白 / 黑名单）
              </h2>
              <p>黑名单：群发跳过 + 客服不自动回复（消息仍留档）；白名单非空时群发只发名单内客户</p>
            </div>
            {serviceConfigured && (
              <div className="service-actions">
                <button type="button" className="button button-secondary" onClick={() => void pushListsToService()}>
                  同步到服务
                </button>
              </div>
            )}
          </div>

          <div className="service-actions" style={{ marginBottom: 10 }}>
            <button
              type="button"
              className={`button ${listKind === "blacklist" ? "button-primary" : "button-secondary"}`}
              onClick={() => setListKind("blacklist")}
            >
              黑名单（{lists.blacklist.length}）
            </button>
            <button
              type="button"
              className={`button ${listKind === "whitelist" ? "button-primary" : "button-secondary"}`}
              onClick={() => setListKind("whitelist")}
            >
              白名单（{lists.whitelist.length}）
            </button>
          </div>

          <label className="service-field">
            <span>粘贴名单：每行 `id` 或 `id,姓名` 或 `id,姓名,备注`（id = 企微 external_userid）</span>
            <textarea
              rows={3}
              value={listInput}
              onChange={(event) => setListInput(event.target.value)}
              placeholder={"wmABC123,王总\nwmDEF456,李经理,多次询价"}
            />
          </label>
          <button type="button" className="button button-primary" onClick={addListEntries}>
            <ShieldAlert size={14} />加入{listKind === "blacklist" ? "黑名单" : "白名单"}
          </button>

          <ul className="service-rule-list">
            {lists[listKind].length === 0 && <li className="service-empty">当前名单为空</li>}
            {lists[listKind].map((entry) => (
              <li key={entry.id}>
                <div className="service-rule-info">
                  <strong>{entry.name || entry.id}</strong>
                  <span>{entry.id}{entry.note ? ` · ${entry.note}` : ""}</span>
                </div>
                <div className="service-rule-actions">
                  <button type="button" className="text-link" onClick={() => removeListEntry(listKind, entry.id)}>
                    <Trash2 size={13} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>

        <div className="console-card service-sim">
          <div className="console-card-header">
            <div>
              <h2>
                <Bell size={15} /> 意向提醒
              </h2>
              <p>模拟器命中高意向词即入列；接入后服务端在阶段跃迁（报价/成交/试用）时落档，可从 /api/intents 拉取</p>
            </div>
            {serviceConfigured && (
              <div className="service-actions">
                <button type="button" className="button button-secondary" onClick={() => void pullIntentsFromService()}>
                  从服务拉取
                </button>
              </div>
            )}
          </div>
          <ul className="service-rule-list">
            {localIntents.length === 0 && (
              <li className="service-empty">暂无提醒——在模拟器输入「多少钱」类消息试试</li>
            )}
            {localIntents.map((item) => (
              <li key={`${item.at}-${item.text.slice(0, 8)}`}>
                <div className="service-rule-info">
                  <strong>⚠ {item.stage ? `${item.stage}阶段` : "高意向"}</strong>
                  <span>
                    {new Date(item.at).toLocaleTimeString("zh-CN", { hour12: false })} · {item.source} · {item.text}
                  </span>
                </div>
              </li>
            ))}
          </ul>
          <p className="service-sim-note">
            <Plug size={12} /> 本机演示不外发；真实提醒 = 服务端 intents留档 + 可选企微群机器人 webhook。
          </p>
        </div>
      </div>
    </section>
  );
}

export default ServiceChannels;
