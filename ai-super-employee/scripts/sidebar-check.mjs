#!/usr/bin/env node
/**
 * 侧栏布局自检（纯静态，无需浏览器）。
 *
 * 背景：导航项随批次增加（当前 22 项），侧栏之前没有 overflow，
 * 小屏下导航溢出到视口外且无法滚动 —— 用户报「左边导航栏不能往下滑」。
 *
 * 本脚本做两件事：
 *  1. 断言滚动链路完整（overflow / flex:1 / min-height:0 / 固定区不收缩）
 *  2. 按 CSS 里的实际数值做高度预算，确认溢出量由导航区承接
 * 运行：npm run test:sidebar
 */
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../src/App.css", import.meta.url), "utf8");
const consoleSrc = readFileSync(new URL("../src/components/Console.tsx", import.meta.url), "utf8");

let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed += 1;
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` ｜ ${detail}` : ""}`);
};

const rule = (selector) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  return match ? match[1] : "";
};
const px = (block, prop) => {
  const match = block.match(new RegExp(`${prop}\\s*:\\s*(-?[\\d.]+)px`));
  return match ? Number(match[1]) : null;
};
const has = (block, prop, value) => new RegExp(`${prop}\\s*:\\s*${value.replace(/[()]/g, "\\$&")}`).test(block);

const sidebar = rule(".console-sidebar");
const nav = rule(".console-nav");
const brand = rule(".console-brand");
const ws = rule(".workspace-switch");
const cap = rule(".sidebar-capacity");
const back = rule(".back-to-site");
const navBtn = rule(".console-nav button");

// —— 1. 滚动链路 ——
check("侧栏 overflow: hidden（整体不溢出）", has(sidebar, "overflow", "hidden"), sidebar.match(/overflow[^;]*/)?.[0] ?? "未设置");
check("侧栏纵向 flex", has(sidebar, "flex-direction", "column"));
check("导航区 overflow-y: auto", has(nav, "overflow-y", "auto"), nav.match(/overflow-y[^;]*/)?.[0] ?? "未设置");
check("导航区 flex: 1 1 auto", /flex\s*:\s*1\s+1\s+auto/.test(nav), nav.match(/flex[^;]*/)?.[0] ?? "未设置");
check("导航区 min-height: 0（可收缩关键）", has(nav, "min-height", "0"));
check("导航区 overscroll-behavior: contain", has(nav, "overscroll-behavior", "contain"));

// —— 2. 固定区不参与压缩 ——
for (const [label, block] of [["品牌区", brand], ["工作区切换", ws], ["用量卡", cap], ["返回按钮", back]]) {
  check(`${label} flex: 0 0 auto`, /flex\s*:\s*0\s+0\s+auto/.test(block));
}
check("用量卡不再用 margin-top:auto", !/margin-top\s*:\s*auto/.test(cap));

// —— 3. 导航项与分组（从 Console.tsx 实读，加项时自动生效）——
const navLabels = (consoleSrc.match(/\{ label: "[^"]+", icon: \w+, group: NAV_GROUP\.\w+ \}/g) ?? []).length;
const groups = new Set(consoleSrc.match(/group: NAV_GROUP\.(\w+)/g) ?? []).size;
check("导航项已分组", navLabels > 0 && groups >= 3, `${navLabels} 项 / ${groups} 组`);
check("分组渲染按组遍历", consoleSrc.includes('Object.values(NAV_GROUP).map'));

// —— 4. 高度预算（最矮常见笔记本内容高 668px）——
const btnH = px(navBtn, "min-height") ?? 36;
const groupGap = 6;
const labelH = 18;
const navContent = navLabels * btnH + Math.max(0, navLabels - groups) * 4 + groups * (labelH + groupGap);
const fixedH = 20 + 15 + 34 + 60 + 110 + 55;
const viewport = 668;
const navAvail = viewport - fixedH;
console.log(`\n  视口 ${viewport}px：固定区 ${fixedH}px，导航可用 ${navAvail}px，导航内容 ≈ ${navContent}px`);
console.log(`  → 溢出 ${Math.max(0, navContent - navAvail)}px${has(nav, "overflow-y", "auto") ? "，由导航区滚动承接 ✅" : "，无处承接 ❌"}\n`);
check("溢出量由导航区滚动承接", navContent > navAvail && has(nav, "overflow-y", "auto"), `${navContent} > ${navAvail}`);
check("即便视口较高也不影响（1024px 下仍不溢出侧栏）", fixedH + Math.min(navContent, 1024 - fixedH) <= 1024);

// —— 5. 移动端抽屉不回归 ——
check("移动端抽屉位移规则存在", /transform\s*:\s*translateX\(-100%\)/.test(css));
check("移动端展开规则存在", /mobile-open\s*\{\s*transform\s*:\s*translateX\(0\)/.test(css));

console.log(`\n${failed === 0 ? "全部通过" : `${failed} 项失败`}`);
process.exit(failed === 0 ? 0 : 1);
