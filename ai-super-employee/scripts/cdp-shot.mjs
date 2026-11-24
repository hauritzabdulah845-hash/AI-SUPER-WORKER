/**
 * CDP 探针：打开指定页面、执行步骤脚本、截图。
 * 用法：node scripts/cdp-shot.mjs <url> <outPng> [步骤JSON文件]
 */
import { writeFileSync } from "node:fs";

const url = process.argv[2] ?? "http://127.0.0.1:5173/";
const out = process.argv[3] ?? "shot.png";
const stepsFile = process.argv[4] ?? null;
const width = Number(process.env.CDP_W ?? 1440);
const height = Number(process.env.CDP_H ?? 1000);

const targets = await (await fetch("http://127.0.0.1:9333/json/list")).json();
const page = targets.find((t) => t.type === "page");
if (!page) throw new Error("没有可用的页面目标");

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
  }
};

await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});

const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const msgId = ++id;
    pending.set(msgId, { resolve, reject });
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evaluate = async (expression) => {
  const res = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (res.exceptionDetails) return { error: res.exceptionDetails.text };
  return res.result?.value;
};

await send("Page.enable");
await send("Runtime.enable");

const consoleLog = [];
// 统一消息分发：既处理请求响应，也收集控制台输出
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.method === "Runtime.consoleAPICalled") {
    const text = (msg.params.args ?? []).map((a) => a.value ?? a.description ?? "").join(" ");
    consoleLog.push(`[${msg.params.type}] ${text}`.slice(0, 300));
  }
  if (msg.method === "Runtime.exceptionThrown") {
    consoleLog.push(`[exception] ${JSON.stringify(msg.params.exceptionDetails).slice(0, 300)}`);
  }
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
  }
};

await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 600 });
await send("Page.navigate", { url });
await sleep(2600);

if (stepsFile) {
  const steps = JSON.parse(await (await import("node:fs/promises")).readFile(stepsFile, "utf8"));
  for (const step of steps) {
    if (step.wait) await sleep(step.wait);
    if (step.eval) {
      const result = await evaluate(step.eval);
      console.log(`[step:${step.name ?? "eval"}]`, JSON.stringify(result)?.slice(0, 600));
    }
    if (step.click) {
      const result = await evaluate(`(() => {
        const nodes = [...document.querySelectorAll(${JSON.stringify(step.click)})];
        const el = nodes.find(n => n.textContent && n.textContent.trim().length);
        if (!el) return "NOT_FOUND";
        el.click();
        return "CLICKED:" + (el.textContent || "").trim().slice(0, 40);
      })()`);
      console.log(`[step:${step.name ?? "click"}]`, result);
    }
  }
}

const shot = await send("Page.captureScreenshot", {
  format: "png",
  captureBeyondViewport: !process.env.CDP_VIEWPORT,
});
writeFileSync(out, Buffer.from(shot.data, "base64"));
console.log("saved", out);
if (process.env.CDP_CONSOLE) consoleLog.forEach((line) => console.log("[console]", line));
ws.close();
process.exit(0);
