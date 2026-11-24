#!/usr/bin/env node
/**
 * 字号规范自检。
 *
 * 背景：用户反馈「有些字体大小不符合要求」。实测全站曾有 330 处 ≤11px，
 * 其中 160 处 ≤9px —— 8px 的中文基本无法辨认，尤其 375px 手机上。
 *
 * 规范（三级地板）：
 *   装饰微标（角标/计数/kicker/徽章/全大写标签）  ≥ 10px
 *   辅助信息（时间/来源/提示/说明）                ≥ 11px
 *   正文与可交互（段落/输入/表单标签/表头/按钮）   ≥ 12.5px
 *
 * 除字号外还校验两件事：
 *   - 固定高度容器能否容纳放大后的行高（否则文字被裁）
 *   - 小尺寸单字符容器宽度是否够（否则横向裁字）
 * 运行：npm run test:font
 */
import { readFileSync } from "node:fs";
import { parseCss, cascade, prop } from "./css-parse.mjs";

const css = readFileSync(new URL("../src/App.css", import.meta.url), "utf8");
const rules = parseCss(css);

let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed += 1;
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` ｜ ${detail}` : ""}`);
};

const sizesOf = (body) => [...body.matchAll(/font-size\s*:\s*([\d.]+)px/g)].map((m) => Number(m[1]));

// —— 1. 绝对下限：不允许任何 <10px ——
const tiny = [];
for (const r of rules) {
  for (const s of sizesOf(r.body)) if (s < 10) tiny.push([s, r.selector]);
}
check("无任何 <10px 字号", tiny.length === 0, tiny.length ? tiny.slice(0, 5).map(([s, sel]) => `${s}px ${sel}`).join(" / ") : "0 处");

// —— 2. 正文/可交互元素 ≥12.5px ——
const BODY_SEL = /(\bp\b|textarea|(^|\s)input|select|snippet|desc\b|goal|summary|result\b|answer|sentence|paragraph)/;
const bodyBads = [];
for (const r of rules) {
  const sel = r.selector;
  if (!BODY_SEL.test(sel)) continue;
  if (/placeholder|::placeholder/.test(sel)) continue;
  for (const s of sizesOf(r.body)) if (s < 12.5) bodyBads.push([s, sel]);
}
check("正文类元素 ≥12.5px", bodyBads.length === 0, bodyBads.length ? bodyBads.slice(0, 6).map(([s, sel]) => `${s}px ${sel}`).join(" / ") : "0 处");

// —— 3. 表单标签 / 表头 / 状态切换 ≥11.5px（用户要读要用）——
const LABEL_SEL = /(^|[\s,.])(label|th)\b|status-tabs|filter-chips|tab-bar|legend/;
const labelBads = [];
for (const r of rules) {
  if (!LABEL_SEL.test(r.selector)) continue;
  for (const s of sizesOf(r.body)) if (s < 11) labelBads.push([s, r.selector]);
}
check("表单标签与表头 ≥11px", labelBads.length === 0, labelBads.length ? labelBads.slice(0, 6).map(([s, sel]) => `${s}px ${sel}`).join(" / ") : "0 处");

// —— 4. 固定高度容器容纳行高 ——
const clipped = [];
for (const r of rules) {
  const h = prop(r.body, "height");
  const fs = sizesOf(r.body)[0];
  if (!h || !fs) continue;
  const hv = Number(h.replace("px", ""));
  if (!hv || hv > 60) continue;
  const lhRaw = prop(r.body, "line-height");
  const lh = lhRaw ? (lhRaw.endsWith("px") ? Number(lhRaw.replace("px", "")) : Number(lhRaw) * fs) : fs * 1.2;
  const padTop = Number((prop(r.body, "padding-top") ?? "0").replace("px", "")) || 0;
  const padBottom = Number((prop(r.body, "padding-bottom") ?? "0").replace("px", "")) || 0;
  const padAll = Number((prop(r.body, "padding") ?? "0").replace("px", "")) || 0;
  const pad = padTop + padBottom || padAll * 2;
  if (hv < lh + pad - 0.5) clipped.push([hv, fs, lh, pad, r.selector]);
}
check("固定高度容器不裁字", clipped.length === 0, clipped.length ? clipped.slice(0, 4).map(([h, fs, lh, p, sel]) => `${sel} 高${h} < 行${lh.toFixed(0)}+距${p}`).join(" / ") : `校验 ${rules.filter((r) => prop(r.body, "height")).length} 个容器`);

// —— 5. 单字符小容器宽度够 ——
const narrow = [];
for (const r of rules) {
  const w = prop(r.body, "width");
  const fs = sizesOf(r.body)[0];
  if (!w || !fs) continue;
  const wv = Number(w.replace("px", ""));
  if (!wv || wv > 60) continue;
  if (wv / fs < 1.15) narrow.push([wv, fs, r.selector]);
}
check("单字符容器宽度 ≥1.15×字号", narrow.length === 0, narrow.length ? narrow.slice(0, 4).map(([w, fs, sel]) => `${sel} 宽${w}/字${fs}`).join(" / ") : "0 处");

// —— 6. 分布报告（不判失败，仅提示）——
const dist = new Map();
for (const r of rules) for (const s of sizesOf(r.body)) dist.set(s, (dist.get(s) ?? 0) + 1);
const below11 = [...dist.entries()].filter(([s]) => s < 11).reduce((a, [, n]) => a + n, 0);
const below10 = [...dist.entries()].filter(([s]) => s < 10).reduce((a, [, n]) => a + n, 0);
console.log(`\n  字号分布：<10px ${below10} 处，<11px ${below11} 处，共 ${[...dist.values()].reduce((a, b) => a + b, 0)} 处声明`);
check("<11px 声明占比 <10%", below11 / [...dist.values()].reduce((a, b) => a + b, 0) < 0.1, `${below11} 处（多数为 10px 角标）`);

console.log(`\n${failed === 0 ? "全部通过" : `${failed} 项失败`}`);
process.exit(failed === 0 ? 0 : 1);
