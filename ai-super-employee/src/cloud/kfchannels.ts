/**
 * 客服渠道中心（域：客服）：渠道清单 + 关键词规则引擎 + 演示模拟器。
 *
 * 规则顺序与 wecom-kf-service 一致：关键词 → （服务端可选 AI 兜底）→ 默认规则。
 * 本模块的规则编辑与模拟在浏览器内完成（localStorage），供接入前先配好话术；
 * 服务端 rules.json 为运行时真源，两边可各自维护——接入后以服务端为准。
 */

export interface KfChannelDef {
  key: string;
  label: string;
  status: "live" | "pending";
  statusLabel: string;
  hint: string;
}

export interface KfRule {
  id: string;
  name: string;
  keywords: string[];
  reply: string;
  enabled: boolean;
  isDefault: boolean;
}

export const KF_CHANNELS: KfChannelDef[] = [
  {
    key: "wecom",
    label: "企业微信客服",
    status: "live",
    statusLabel: "已支持",
    hint: "wecom-kf-service：回调 → 关键词规则 → AI 兜底 → 默认回复；含高意向提醒与客户同步",
  },
  {
    key: "http",
    label: "通用 HTTP 指令",
    status: "live",
    statusLabel: "已支持",
    hint: "im-bot-gateway：飞书事件 / 通用 HTTP 入队，控制台「远程指令」拉取后由用户确认执行",
  },
  {
    key: "douyin",
    label: "抖音企业号客服",
    status: "pending",
    statusLabel: "接入后置",
    hint: "官方客服消息 API 适配器位预留：配置企业号凭据后接同一套规则引擎（按约定不代联调）",
  },
  {
    key: "feishu",
    label: "飞书机器人客服",
    status: "pending",
    statusLabel: "接入后置",
    hint: "复用 im-bot-gateway 的飞书事件入口，回复链路待接官方消息 API",
  },
];

const RULES_KEY = "ai-employee:kf-rules";

/** 演示规则种子：接入前也能跑通模拟器。 */
export function seedRules(): KfRule[] {
  return [
    { id: "price", name: "价格咨询", keywords: ["多少钱", "价格", "报价", "收费"], reply: "你好{{name}}，具体价格按方案定，我把价格体系发你，或回复「人工」约个时间细聊。", enabled: true, isDefault: false },
    { id: "addr", name: "地址与到店", keywords: ["地址", "在哪", "怎么走", "营业"], reply: "{{name}}你好，门店地址与营业时间见下方定位；到店前可以先留个联系方式，我们帮你留位。", enabled: true, isDefault: false },
    { id: "human", name: "转人工", keywords: ["人工", "客服", "转人工"], reply: "已为你转人工，工作时间 9:00-21:00，稍等片刻就有同事联系你。", enabled: true, isDefault: false },
    { id: "fallback", name: "默认兜底", keywords: [], reply: "你好{{name}}，消息已收到。想了解产品/价格/到店，直接回复关键词即可；也可以回复「人工」。", enabled: true, isDefault: true },
  ];
}

export function loadRules(): KfRule[] {
  try {
    const raw = window.localStorage.getItem(RULES_KEY);
    const rows = raw ? (JSON.parse(raw) as KfRule[]) : null;
    if (Array.isArray(rows) && rows.length) return rows;
  } catch {
    // 落回种子规则
  }
  return seedRules();
}

export function saveRules(rules: KfRule[]): void {
  try {
    window.localStorage.setItem(RULES_KEY, JSON.stringify(rules.slice(0, 50)));
  } catch {
    // 隐私模式写入失败不影响本次操作
  }
}

/** 关键词命中：完全相等或包含，按数组顺序取第一条（与服务端 rules.mjs 同语义）。 */
export function matchKeywordRule(rules: KfRule[], text: string): KfRule | null {
  const content = (text ?? "").trim();
  if (!content) return null;
  for (const rule of rules) {
    if (!rule.enabled || rule.isDefault || !rule.keywords.length) continue;
    if (rule.keywords.some((keyword) => keyword && (content === keyword || content.includes(keyword)))) {
      return rule;
    }
  }
  return null;
}

export function matchDefaultRule(rules: KfRule[]): KfRule | null {
  return rules.find((rule) => rule.isDefault && rule.enabled) ?? null;
}

export function matchRule(rules: KfRule[], text: string): KfRule | null {
  return matchKeywordRule(rules, text) ?? matchDefaultRule(rules);
}

/** 模板变量：{{name}} / {{stage}} / {{source}}，未知称呼用「你」（与服务端 renderTemplate 同语义）。 */
export function renderTemplate(
  template: string,
  customer?: { name?: string; stage?: string; source?: string } | null,
): string {
  const name = customer?.name?.trim() || "你";
  const stage = customer?.stage?.trim() || "未分级";
  const source = customer?.source?.trim() || "未知来源";
  return String(template ?? "")
    .replaceAll("{{name}}", name)
    .replaceAll("{{stage}}", stage)
    .replaceAll("{{source}}", source);
}

export interface SimulateResult {
  rule: KfRule | null;
  reply: string;
  via: "keyword" | "default" | "none";
}

/** 演示模拟器：关键词 → 默认兜底；不命中返回 none（服务端还会多一层 AI 兜底）。 */
export function simulateReply(rules: KfRule[], text: string, customer?: { name?: string } | null): SimulateResult {
  const keywordHit = matchKeywordRule(rules, text);
  if (keywordHit) return { rule: keywordHit, reply: renderTemplate(keywordHit.reply, customer), via: "keyword" };
  const fallback = matchDefaultRule(rules);
  if (fallback) return { rule: fallback, reply: renderTemplate(fallback.reply, customer), via: "default" };
  return { rule: null, reply: "", via: "none" };
}
