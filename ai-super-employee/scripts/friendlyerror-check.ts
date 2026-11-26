/**
 * friendlyError 错误人话化自检（第 27 批）。
 * 关注点：技术错误映射为中文人话、中文校验提示透传、原始错误保留到 console。
 * 运行：npm run test:friendlyerror
 */
import { friendlyError } from "../src/cloud/friendlyError";

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass += 1; console.log(`✓ ${name}${detail ? ` ｜ ${detail}` : ""}`); }
  else { fail += 1; console.log(`✗ ${name}${detail ? ` ｜ ${detail}` : ""}`); }
};

// 捕获 console.warn，验证原始错误被保留
const warned: string[] = [];
const originalWarn = console.warn;
console.warn = (...args: unknown[]) => { warned.push(args.map(String).join(" ")); };

console.log("--- friendlyError：技术错误映射 ---");
ok("Failed to fetch → 网络连接失败", friendlyError(new Error("Network error: Failed to fetch")) === "网络连接失败，请检查后重试");
ok("纯 Failed to fetch", friendlyError(new Error("Failed to fetch")) === "网络连接失败，请检查后重试");
ok("监测嵌套文案 → 网络连接失败", friendlyError(new Error("全部 5 条问题都失败了，本次不计入趋势。首个错误：Network error: Failed to fetch")) === "网络连接失败，请检查后重试");
ok("timeout → 请求超时", friendlyError(new Error("Request timeout after 30000ms")) === "请求超时，请稍后再试");
ok("中文超时 → 请求超时", friendlyError(new Error("请求超时")) === "请求超时，请稍后再试");
ok("401 → 登录已过期", friendlyError(new Error("401 Unauthorized")) === "登录已过期，请重新登录");
ok("403 → 登录已过期", friendlyError(new Error("HTTP 403 Forbidden")) === "登录已过期，请重新登录");
ok("429 → 请求太频繁", friendlyError(new Error("429 Too Many Requests")) === "请求太频繁，请稍后再试");
ok("rate limit → 请求太频繁", friendlyError(new Error("rate limit exceeded")) === "请求太频繁，请稍后再试");
ok("500 → 服务暂时不可用", friendlyError(new Error("500 Internal Server Error")) === "服务暂时不可用，请稍后再试");
ok("未知英文错误 → 服务暂时不可用", friendlyError(new Error("Something unexpected happened")) === "服务暂时不可用，请稍后再试");

console.log("--- friendlyError：中文人话透传 ---");
ok("校验提示透传（填资料）", friendlyError(new Error("请先填写或从知识库导入企业资料，体检需要真实素材。")) === "请先填写或从知识库导入企业资料，体检需要真实素材。");
ok("校验提示透传（品牌）", friendlyError(new Error("请先填写品牌/企业名称，否则无法判断是否被提及。")) === "请先填写品牌/企业名称，否则无法判断是否被提及。");
ok("解析失败透传", friendlyError(new Error("体检结果解析失败，请重试。")) === "体检结果解析失败，请重试。");
ok("含 GEO 品牌词仍透传", friendlyError(new Error("请先拓词，再生成选题。")) === "请先拓词，再生成选题。");

console.log("--- friendlyError：边界 ---");
ok("空 Error → 兜底", friendlyError(new Error("")) === "服务暂时不可用，请稍后再试");
ok("null → 兜底", friendlyError(null) === "服务暂时不可用，请稍后再试");
ok("字符串错误可映射", friendlyError("Failed to fetch") === "网络连接失败，请检查后重试");
ok("原始错误保留到 console", warned.some((line) => line.includes("Failed to fetch")));

console.warn = originalWarn;
console.log(`\n${fail === 0 ? "全部通过" : `${fail} 项失败`}（${pass} 通过 / ${fail} 失败）`);
process.exit(fail === 0 ? 0 : 1);
