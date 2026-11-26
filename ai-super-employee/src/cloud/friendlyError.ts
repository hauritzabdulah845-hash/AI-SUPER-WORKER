/**
 * 错误人话化（第 27 批，依据 2026-11-26 GEO 实跑评审）：
 * 走查发现模型通道失败时把「Network error: Failed to fetch」原样抛给用户，
 * 非技术用户看不懂也不知道该怎么办。这里把常见原始错误映射为中文人话，
 * 原始信息保留到 console 供排查；已经是中文人话的校验提示（如「请先填写…」）直接透传。
 */

const FALLBACK = "服务暂时不可用，请稍后再试";

/** 把任意错误转成给用户看的中文提示；原始错误打到 console。 */
export function friendlyError(err: unknown): string {
  const raw = err instanceof Error ? err.message : err == null ? "" : String(err);
  const msg = raw.trim();
  if (msg) console.warn("[friendlyError] 原始错误：", msg);
  if (!msg) return FALLBACK;

  const lower = msg.toLowerCase();

  // 网络层失败（含监测「全部失败…首个错误：Network error: Failed to fetch」这类嵌套文案）
  if (/failed to fetch|networkerror|network error|network|fetch failed|err_network|load failed|econn|enotfound|socket/.test(lower)) {
    return "网络连接失败，请检查后重试";
  }
  // 超时（用户主动取消的 AbortError 文案是中文「已取消」，不会命中这里）
  if (/timeout|timed out|超时/.test(lower)) {
    return "请求超时，请稍后再试";
  }
  // 登录态失效
  if (/\b401\b|\b403\b|unauthorized|forbidden|session|登录.*过期|未登录|请先登录/.test(lower)) {
    return "登录已过期，请重新登录";
  }
  // 限流
  if (/\b429\b|rate limit|too many requests|请求太频繁|配额/.test(lower)) {
    return "请求太频繁，请稍后再试";
  }
  // 服务端错误
  if (/\b5\d\d\b|internal server|bad gateway|service unavailable|gateway timeout/.test(lower)) {
    return FALLBACK;
  }
  // 已是中文人话（业务校验提示）：透传。去掉 GEO/AI 等品牌词后再判断是否混有英文技术词。
  const withoutBrandWords = msg.replace(/GEO|AI|LLM|Markdown/gi, "");
  if (/[\u4e00-\u9fff]/.test(msg) && !/[a-z]{4,}/i.test(withoutBrandWords)) {
    return msg;
  }
  return FALLBACK;
}
