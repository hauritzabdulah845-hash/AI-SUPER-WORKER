#!/usr/bin/env node
/**
 * 弹窗布局自检：按真实 CSS 层叠结果验证「内容再长也不会把按钮裁死」。
 *
 * 用自带的 CSS 解析器（scripts/css-parse.mjs）——正则硬匹配会误取 @media 内
 * 的同名规则，导致"测试通过但线上仍旧"。解析器区分顶层与媒体查询。
 * 运行：npm run test:modallayout
 */
import { readFileSync } from "node:fs";
import { parseCss, cascade, prop } from "./css-parse.mjs";

const css = readFileSync(new URL("../src/App.css", import.meta.url), "utf8");
const rules = parseCss(css);

let failed = 0;
const check = (n, ok, d = "") => { if (!ok) failed++; console.log(`${ok ? "✓" : "✗"} ${n}${d ? ` ｜ ${d}` : ""}`); };

// —— 任务详情弹窗 ——
const modal = cascade(rules, ".task-detail-modal");
const steps = cascade(rules, ".task-detail-modal .task-detail-steps");
const actions = cascade(rules, ".task-detail-modal .task-detail-actions") + "\n" + cascade(rules, ".task-detail-modal > .task-detail-actions");

console.log("task-detail-modal 层叠结果：");
for (const p of ["max-height", "display", "flex-direction", "overflow-y", "padding"]) {
  console.log(`  ${p.padEnd(14)}: ${prop(modal, p) ?? "（未设置）"}`);
}
console.log("步骤区：");
for (const p of ["flex", "min-height", "overflow-y"]) {
  console.log(`  ${p.padEnd(14)}: ${prop(steps, p) ?? "（未设置）"}`);
}
console.log();

check("弹窗纵向 flex", prop(modal, "display") === "flex" && prop(modal, "flex-direction") === "column");
check("弹窗有高度上限", prop(modal, "max-height") !== null, prop(modal, "max-height"));
check("弹窗整体可滚（flex 失效兜底）", prop(modal, "overflow-y") === "auto");
check("步骤区可收缩 min-height:0", prop(steps, "min-height") === "0", "缺它 overflow 形同虚设");
check("步骤区独立滚动", prop(steps, "overflow-y") === "auto");
check("操作按钮吸附", prop(actions, "position") === "sticky", "长内容滚动时按钮始终可见（直接子选择器）");

// —— 其他弹窗也必须有兜底滚动 ——
for (const sel of [".composer-modal", ".persona-modal", ".doc-modal"]) {
  const b = cascade(rules, sel);
  check(`${sel} 可滚`, prop(b, "overflow-y") === "auto", prop(b, "overflow-y") ?? "无");
}

// —— 小屏 dvh：移动端地址栏伸缩不会裁掉底部 ——
const smallRules = rules.filter((r) => r.media && /max-width:\s*640px/.test(r.media));
const smallHit = smallRules.some((r) => /100dvh/.test(r.body));
check("640px 断点用 dvh 适配移动端", smallHit, "地址栏伸缩时底部不被裁");

// —— 高度预算：667px 手机 ——
const VIEWPORT = 667;
const backdropPad = 10 * 2;              // 小屏 .modal-backdrop padding: 10px
const panelMax = Math.min(VIEWPORT * 0.86, 880, VIEWPORT - backdropPad);
const padV = 20 + 16;                    // 小屏 padding 20 16 16
const header = 40 + 34 + 45 + 30 + 50;   // kicker/title/goal/meta/actions 估算
const stepsAvail = panelMax - padV - header;
console.log(`\n  667px 手机：面板 ${panelMax.toFixed(0)}px − 内边距 ${padV} − 头部 ${header} = 步骤区 ${stepsAvail.toFixed(0)}px`);
check("手机上面板不超视口", panelMax + backdropPad <= VIEWPORT, `${panelMax + backdropPad} ≤ ${VIEWPORT}`);
check("手机上步骤区仍有可视高度（≥120px）", stepsAvail >= 120, `${stepsAvail.toFixed(0)}px`);

// —— 矮屏横屏 375×667 以外，再看 320px 极窄 ——
const NARROW = 320;
check("极窄屏面板宽度自适应（有 min/max 约束）", /min\(\s*\d+px/.test(prop(modal, "width") ?? "") || /min\(\s*\d+px/.test(cascade(rules, ".task-detail-modal")), prop(modal, "width") ?? "无");

console.log(`\n${failed === 0 ? "全部通过" : `${failed} 项失败`}`);
process.exit(failed === 0 ? 0 : 1);
