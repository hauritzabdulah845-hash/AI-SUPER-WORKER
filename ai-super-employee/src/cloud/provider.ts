import { cloud } from "./client";

/**
 * 模型通道层。
 *
 * 平台通道：WorkBuddy 云端 LLM（匿名态配额很紧，登录后配额更高）。
 * 自定义通道：用户自带 OpenAI 兼容端点（OpenAI / DeepSeek / Moonshot / SiliconFlow / OpenRouter ...），
 *            直接浏览器直连，完全绕开平台配额，适合正式对外演示与真实业务运行。
 *
 * 配置只保存在本机 localStorage，不上云、不入库。
 */

export type ChannelKind = "platform" | "custom";

export interface CustomProvider {
  /** 兼容端点根地址，例如 https://api.deepseek.com/v1 */
  baseUrl: string;
  apiKey: string;
  /** 模型名，例如 deepseek-chat */
  model: string;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface StreamOptions {
  json?: boolean;
  signal?: AbortSignal;
  maxTokens?: number;
  temperature?: number;
}

const STORAGE_KEY = "supe-model-provider";
const CHANNEL_KEY = "supe-model-channel";

/** 已知服务商的标准端点。命中域名就直接用标准值，用户少打一个字符也能跑通。 */
const KNOWN_ENDPOINTS: { host: RegExp; base: string }[] = [
  { host: /^(www\.)?deepseek\.com$/i, base: "https://api.deepseek.com/v1" },
  { host: /^(www\.)?api\.deepseek\.com$/i, base: "https://api.deepseek.com/v1" },
  { host: /^(www\.)?siliconflow\.(cn|com)$/i, base: "https://api.siliconflow.cn/v1" },
  { host: /^(www\.)?moonshot\.cn$/i, base: "https://api.moonshot.cn/v1" },
  { host: /^(www\.)?api\.moonshot\.cn$/i, base: "https://api.moonshot.cn/v1" },
  { host: /^(www\.)?dashscope\.aliyuncs\.com$/i, base: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
  { host: /^(www\.)?api\.openai\.com$/i, base: "https://api.openai.com/v1" },
  { host: /^(www\.)?open\.bigmodel\.cn$/i, base: "https://open.bigmodel.cn/api/paas/v4" },
  { host: /^(www\.)?ark\.cn-beijing\.volces\.com$/i, base: "https://ark.cn-beijing.volces.com/api/v3" },
];

/**
 * 把用户手填的端点规范成真正能用的形式。
 * 常见输入问题：漏写协议、末尾多斜杠、把 /v1 打成 /vi、直接粘贴完整 /chat/completions 地址。
 */
export function canonicalBaseUrl(raw: string): string {
  let url = String(raw ?? "").trim().replace(/[\s\u200b]+/g, "");
  if (!url) return "";
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;

  // 直接粘了完整接口地址 → 剥回端点根
  url = url.replace(/\/chat\/completions\/?$/i, "");

  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    return url.replace(/\/+$/, "");
  }

  const known = KNOWN_ENDPOINTS.find((item) => item.host.test(host));
  if (known) return known.base;

  url = url.replace(/\/+$/, "");
  // 版本段被打错：/vi、/v、/v1。→ /v1
  url = url.replace(/\/v(i|l)?\d*\.?$/i, "/v1");
  // 只有裸域名、没有版本段 → 补 /v1（OpenAI 兼容端点的通行约定）
  try {
    const path = new URL(url).pathname.replace(/\/+$/, "");
    if (!path) url = `${url}/v1`;
  } catch {
    // 解析失败就原样返回
  }
  return url;
}

function normalizeProvider(input: Partial<CustomProvider>): CustomProvider | null {
  const baseUrl = canonicalBaseUrl(String(input.baseUrl ?? ""));
  const apiKey = String(input.apiKey ?? "").trim();
  const model = String(input.model ?? "").trim();
  if (!baseUrl || !apiKey || !model) return null;
  return { baseUrl, apiKey, model };
}

export function loadCustomProvider(): CustomProvider | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CustomProvider>;
    const normalized = normalizeProvider(parsed);
    if (!normalized) return null;
    // 历史配置里的错误端点在这里静默修正并回写，用户无需手动改
    if (parsed.baseUrl !== normalized.baseUrl) {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
    }
    return normalized;
  } catch {
    return null;
  }
}

export function saveCustomProvider(provider: CustomProvider) {
  const normalized = normalizeProvider(provider) ?? provider;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
}

export function clearCustomProvider() {
  window.localStorage.removeItem(STORAGE_KEY);
  window.localStorage.removeItem(CHANNEL_KEY);
}

export function loadChannel(): ChannelKind {
  const stored = window.localStorage.getItem(CHANNEL_KEY);
  if (stored === "custom" && loadCustomProvider()) return "custom";
  return "platform";
}

export function saveChannel(kind: ChannelKind) {
  window.localStorage.setItem(CHANNEL_KEY, kind);
}

/** 把各类错误统一成「是否可重试」的判断依据。 */
export function isThrottleError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /429|限流|rate.?limit|quota|配额/i.test(message);
}

/**
 * 把通道错误翻译成用户能照着修的提示。
 * 关键：不要把真实原因吞掉——401/404/CORS 是三种完全不同的修法。
 */
export function describeChannelError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const status = (error as { status?: number } | null)?.status;
  const provider = loadCustomProvider();
  const endpoint = provider?.baseUrl ?? "";

  if (status === 401 || status === 403) {
    return `模型服务拒绝了密钥（HTTP ${status}）：API Key 无效、过期或没有该模型权限，请回到「模型接入」重新填写。`;
  }
  if (status === 404) {
    return `端点或模型名不存在（HTTP 404）：当前端点 ${endpoint || "未填写"}，请确认带版本路径（如 https://api.deepseek.com/v1），模型名与服务商文档一致。`;
  }
  if (status === 429 || /429|rate.?limit|quota|配额/i.test(message)) {
    return `模型服务限流或配额用尽（HTTP 429）：请稍后重试，或更换服务商 / 提升额度。`;
  }
  if (status === 400 || /HTTP 400/.test(message)) {
    return `请求被模型服务拒绝（HTTP 400）：${message.replace(/^HTTP 400\s*/, "").slice(0, 140) || "参数不被接受，请检查模型名是否支持该接口。"}`;
  }
  if (status === 402) {
    return "模型服务提示余额不足（HTTP 402），请充值后再试。";
  }
  if (/failed to fetch|networkerror|load failed|network request failed/i.test(message)) {
    return `无法连接${endpoint ? ` ${endpoint}` : "模型端点"}：可能是地址填错，或该服务不允许浏览器直连（CORS）。建议换用支持浏览器调用的服务（如 DeepSeek、硅基流动），或检查网络。`;
  }
  if (/abort/i.test(message)) return "调用被取消。";
  return message.slice(0, 180) || "未知错误，请到「模型接入」点「验证连通」自查。";
}

/** 平台通道：匿名态配额紧张，登录后配额更高。 */
export async function probePlatform(): Promise<{ ok: boolean; detail: string }> {
  const started = Date.now();
  try {
    const models = await cloud.llm.models.list();
    const list = (models ?? []).filter((item) => item.disabled !== true);
    if (!list.length) return { ok: false, detail: "平台未下发可用模型" };
    const modelId = list[0].id;
    const stream = await cloud.llm.chat.completions.create({
      model: modelId,
      messages: [{ role: "user", content: "回复「ok」" }],
      stream: true,
      max_tokens: 8,
    } as never);
    let got = "";
    for await (const chunk of stream) {
      const delta = chunk?.choices?.[0]?.delta?.content;
      if (delta) got += delta;
      if (got.length > 8) break;
    }
    return { ok: true, detail: `可用（${modelId}，${Date.now() - started}ms）` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error ?? "");
    if (isThrottleError(error)) {
      return { ok: false, detail: "平台配额已用尽（429），登录账号可提升配额，或改用自定义通道" };
    }
    return { ok: false, detail: message.slice(0, 120) || "平台通道不可用" };
  }
}

/** 自定义通道：探活，非流式 + 极小 token，快速返回。 */
export async function probeCustom(provider = loadCustomProvider()): Promise<{ ok: boolean; detail: string }> {
  if (!provider) return { ok: false, detail: "尚未配置自定义通道" };
  const baseUrl = canonicalBaseUrl(provider.baseUrl);
  const started = Date.now();
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${provider.apiKey}`,
      },
      body: JSON.stringify({
        model: provider.model,
        messages: [{ role: "user", content: "回复「ok」" }],
        max_tokens: 8,
        stream: false,
      }),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      const error = new Error(`HTTP ${response.status} ${text.slice(0, 160)}`);
      (error as Error & { status?: number }).status = response.status;
      return { ok: false, detail: describeChannelError(error) };
    }
    const payload = (await response.json()) as { choices?: { message?: { content?: string } }[] };
    const reply = payload?.choices?.[0]?.message?.content ?? "";
    return { ok: true, detail: `可用（${provider.model}，${Date.now() - started}ms）· 端点 ${baseUrl}${reply ? ` · 回显 ${reply.slice(0, 12)}` : ""}` };
  } catch (error) {
    return { ok: false, detail: describeChannelError(error) };
  }
}

/** 自定义通道流式调用（OpenAI 兼容 SSE）。 */
export async function streamCustom(
  messages: ChatMessage[],
  options: StreamOptions = {},
): Promise<{ text: string; tokens: number }> {
  const provider = loadCustomProvider();
  if (!provider) throw new Error("自定义通道未配置");

  const response = await fetch(`${provider.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${provider.apiKey}`,
    },
    body: JSON.stringify({
      model: provider.model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      temperature: options.temperature ?? 0.4,
      max_tokens: options.maxTokens ?? 1600,
      ...(options.json ? { response_format: { type: "json_object" } } : {}),
    }),
    signal: options.signal,
  });

  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => "");
    const error = new Error(`HTTP ${response.status} ${text.slice(0, 160)}`);
    (error as Error & { status?: number }).status = response.status;
    throw error;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let tokens = 0;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const chunk = JSON.parse(payload) as {
          choices?: { delta?: { content?: string } }[];
          usage?: { total_tokens?: number };
        };
        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) text += delta;
        if (chunk.usage?.total_tokens) tokens = chunk.usage.total_tokens;
      } catch {
        // 单行解析失败不影响整体流
      }
    }
  }

  return { text: text.trim(), tokens };
}
