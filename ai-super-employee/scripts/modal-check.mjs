#!/usr/bin/env node
/**
 * 弹窗交互自检。
 *
 * 用户报过「侧栏不能滚」这类"只有真用起来才发现"的问题；弹窗同族隐患是
 * 「关不掉 / 背后的页面在滚 / 焦点丢失」。这里用最小 DOM 桩跑真实 hook 逻辑。
 *
 * 覆盖：
 *  - Esc 关闭（且嵌套时不误关外层）
 *  - 背景滚动锁：多个弹窗嵌套时计数正确，全部关闭才解锁
 *  - 关闭后焦点还原到打开它的按钮
 *  - 滚动条宽度补偿（避免锁滚动时页面横向跳）
 * 运行：npm run test:modal
 */
import { readFileSync } from "node:fs";
import { transformSync } from "esbuild";

let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed += 1;
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` ｜ ${detail}` : ""}`);
};

// ---------- 最小 DOM 桩 ----------
const listeners = new Map();
// 真实浏览器的 CSSStyleDeclaration：未设置的属性读出来是空串，不是 undefined。
// 桩必须一致，否则「解锁后还原为空」这类断言会被 undefined 误判。
const makeStyle = () =>
  new Proxy(
    {},
    {
      get: (target, key) => (key in target ? target[key] : ""),
      set: (target, key, value) => {
        target[key] = value;
        return true;
      },
    },
  );

const makeEl = (tag = "div") => ({
  tagName: tag, style: makeStyle(), children: [], _focused: false,
  focus() { this._focused = true; },
});
const body = makeEl("body");
const documentEl = makeEl("html");
const activeEls = [];
const doc = {
  body,
  documentElement: documentEl,
  activeElement: null,
  contains: () => true,
  addEventListener(type, fn) {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(fn);
  },
  removeEventListener(type, fn) {
    listeners.get(type)?.delete(fn);
  },
  dispatch(type, event) {
    for (const fn of listeners.get(type) ?? []) fn(event);
  },
};
const win = { innerWidth: 1200, innerHeight: 800 };

// 编译 hook 源码（去掉 TS 类型），让它能在桩环境跑
const src = readFileSync(new URL("../src/hooks/use-modal-behavior.ts", import.meta.url), "utf8");
const compiled = transformSync(src, { loader: "ts", format: "esm" }).code;
// useEffect 桩：每次都把 effect 推入"当前收集器"。收集器放在 globalThis 上动态读取，
// 否则 mount() 里换新数组时，闭包里还指着工厂创建时那个旧数组。
const mod = compiled
  .replace(
    /import\s*\{[^}]*\}\s*from\s*"react";?/g,
    "const useEffect=(fn)=>{ if(globalThis.__collector) globalThis.__collector.push(fn); }; const useRef=(v)=>({current:v});",
  )
  .replace(/export\s+/g, "");
globalThis.__effects = [];
globalThis.__collector = null;
globalThis.document = doc;
globalThis.window = win;

const factory = new Function("document", "window", `${mod}; return { useModalBehavior, __isScrollLocked };`);
const { useModalBehavior, __isScrollLocked } = factory(doc, win);

// ---------- 极简 React effect 驱动 ----------
function mount(open, onClose) {
  const effects = [];
  globalThis.__collector = effects;
  useModalBehavior(open, onClose);
  globalThis.__collector = null;
  // 未打开时 hook 内部会提前 return，不收 effect
  const cleanups = effects.map((fn) => fn());
  return () => cleanups.forEach((c) => typeof c === "function" && c());
}

const escEvent = { key: "Escape", stopPropagation() {} };

// ---------- 用例 ----------
// 1. Esc 关闭
let closed = 0;
let unmountA = mount(true, () => { closed += 1; });
doc.dispatch("keydown", escEvent);
check("Esc 触发关闭回调", closed === 1, `调用 ${closed} 次`);

// 2. 背景滚动锁
check("弹窗打开时 body 被锁", body.style.overflow === "hidden", `overflow=${body.style.overflow}`);
check("__isScrollLocked 为真", __isScrollLocked() === true);

// 3. 嵌套：两个弹窗同时打开，关掉一个不应解锁
// 先确保起点干净
unmountA();
check("起点无残留锁", body.style.overflow === "", `overflow=${JSON.stringify(body.style.overflow)}`);

const snapshots = [];
const u1 = mount(true, () => { closedB += 1; });
snapshots.push(body.style.overflow);
const u2 = mount(true, () => { closedB += 1; });
snapshots.push(body.style.overflow);
u1();  // 关内层
snapshots.push(body.style.overflow);
const stillLockedAfterInner = __isScrollLocked();
u2();  // 关外层
snapshots.push(body.style.overflow);

check("嵌套打开时保持锁定", snapshots[0] === "hidden" && snapshots[1] === "hidden");
check("关闭一个弹窗后仍锁定（还有另一个开着）", stillLockedAfterInner === true && snapshots[2] === "hidden");
check("全部关闭后才解锁", snapshots[3] === "");

// 4. 焦点还原
const opener = makeEl("button");
doc.activeElement = opener;
const u3 = mount(true, () => {});
const inside = makeEl("input");
doc.activeElement = inside;
u3();
check("关闭后焦点回到打开它的元素", opener._focused === true);

// 5. 滚动条宽度补偿
body.style.paddingRight = "";
Object.defineProperty(win, "innerWidth", { value: 1200, writable: true, configurable: true });
doc.documentElement = { clientWidth: 1185 };
const u4 = mount(true, () => {});
check("锁滚动时补偿滚动条宽度", body.style.paddingRight === "15px", `padding-right=${body.style.paddingRight}`);
u4();
check("解锁后清除补偿", body.style.paddingRight === "", `padding-right=${JSON.stringify(body.style.paddingRight)}`);

// 6. 未打开时不应有任何副作用
body.style.overflow = "";
const u5 = mount(false, () => {});
check("未打开时不动 body", body.style.overflow === "");
u5();

// 7. 静态检查：12 个弹窗都接入了 hook
const consoleSrc = readFileSync(new URL("../src/components/Console.tsx", import.meta.url), "utf8");
const backdrops = (consoleSrc.match(/modal-backdrop/g) ?? []).length;
const hookCalls = (consoleSrc.match(/useModalBehavior\(/g) ?? []).length;
check("每个 backdrop 都接入 hook", hookCalls >= backdrops, `${backdrops} 个 backdrop / ${hookCalls} 次 hook`);
check("不再有零散 Esc 处理", !/event\.key === "Escape"/.test(consoleSrc));

console.log(`\n${failed === 0 ? "全部通过" : `${failed} 项失败`}`);
process.exit(failed === 0 ? 0 : 1);
