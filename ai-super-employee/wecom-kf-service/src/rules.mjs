/**
 * 规则匹配：关键词优先，AI 兜底可选。
 * 回复只有两种类型：text（指定内容）与 miniprogram（AI 名片）。
 */

/** 只做关键词匹配：完全相等或包含即命中，按数组顺序取第一条；不命中返回 null。 */
export function matchKeywordRule(rules, text) {
  const content = (text ?? "").trim();
  if (!content) return null;
  for (const rule of rules) {
    if (rule.enabled === false || !Array.isArray(rule.keywords)) continue;
    if (rule.keywords.some((keyword) => keyword && (content === keyword || content.includes(keyword)))) {
      return rule;
    }
  }
  return null;
}

/** 取兜底规则（isDefault）。 */
export function matchDefaultRule(rules) {
  return rules.find((rule) => rule.isDefault && rule.enabled !== false) ?? null;
}

/**
 * 关键词优先，最后用 isDefault 兜底（不含 AI 意图识别）。
 * 服务端的真实顺序是「关键词 → AI 兜底 → 默认规则」，用 matchKeywordRule +
 * matchDefaultRule 组合，避免默认规则把 AI 兜底挡在前面。
 */
export function matchRule(rules, text) {
  return matchKeywordRule(rules, text) ?? matchDefaultRule(rules);
}

/**
 * AI 兜底：规则都没命中时，让模型在既有规则里挑一个意图。
 * 只允许返回规则 id 或 "none"，避免模型自由生成不可控内容。
 */
export async function pickRuleByAI({ rules, text, apiKey, model = "deepseek-chat" }) {
  const candidates = rules
    .filter((rule) => rule.enabled !== false && rule.id !== "fallback")
    .map((rule) => `- ${rule.id}：${(rule.keywords ?? []).join(" / ") || rule.description || ""}`)
    .join("\n");
  if (!candidates) return null;

  try {
    const res = await fetch("https://api.deepseek.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 20,
        messages: [
          {
            role: "system",
            content: `你是客服意图分类器。根据客户消息，从下列意图里选最匹配的一个，只输出意图 id；都不匹配输出 none。\n${candidates}`,
          },
          { role: "user", content: text },
        ],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const id = (data.choices?.[0]?.message?.content ?? "").trim();
    return rules.find((rule) => rule.id === id) ?? null;
  } catch {
    return null;
  }
}

/** 按规则生成发送动作；返回 null 表示不回复。 */
export function buildReply(rule, config) {
  if (!rule || !rule.reply) return null;
  if (rule.reply.type === "miniprogram") {
    return {
      type: "miniprogram",
      appid: rule.reply.appid ?? config.miniAppId,
      title: rule.reply.title ?? config.miniTitle,
      pagepath: rule.reply.pagepath ?? config.miniPagePath,
      thumbMediaId: rule.reply.thumbMediaId ?? config.miniThumbMediaId ?? "",
    };
  }
  if (rule.reply.type === "text" && rule.reply.content) {
    return { type: "text", content: rule.reply.content };
  }
  // 关键词→附件：正文（可空）随消息带出，附件本体需素材上传 API（接入清单），先记录待发
  if (rule.reply.type === "attachment") {
    return {
      type: "attachment",
      content: rule.reply.content ?? "",
      fileName: String(rule.reply.fileName ?? "附件").slice(0, 80),
    };
  }
  return null;
}
