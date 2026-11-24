/**
 * 混剪纯函数自检：SRT 时间轴、ffmpeg 脚本生成、方案 Markdown。
 * 运行：npm run test:mixcut（tsx 直跑，不需要浏览器与模型通道）
 */
import { buildSrt, buildFfmpegRecipe, planMarkdown } from "../src/cloud/mixcut";
import type { MediaAsset, MediaGroup } from "../src/cloud/media";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failed += 1;
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` ｜ ${detail}` : ""}`);
};

const scenes = [
  { order: 1, group: "开场", shot: "钩子", visual: "壶嘴特写", transition: "硬切", subtitle: "现煮的茶", duration: 3 },
  { order: 2, group: "产品", shot: "展示", visual: "全景", transition: "叠化", subtitle: "", duration: 4 },
  { order: 3, group: "空组", shot: "收口", visual: "logo", transition: "推近", subtitle: "到店喝", duration: 3 },
];

// 1. SRT：只收录有字幕的镜头，时间轴按全镜头连续累计
const srt = buildSrt(scenes);
check("SRT 含 2 条字幕", srt.trim().split("\n\n").length === 2, JSON.stringify(srt.slice(0, 48)));
check("SRT 首条从 00:00:00,000 开始", srt.startsWith("1\n00:00:00,000 --> 00:00:03,000"));
check("SRT 第二条起点累计到第 7 秒", srt.includes("00:00:07,000 --> 00:00:10,000"), "3+4=7s（无字幕镜头也占时间轴）");

const mkAsset = (name: string, group: string, duration?: number): MediaAsset => ({
  id: name,
  name,
  group,
  kind: "video",
  mime: "video/mp4",
  size: 1000,
  blob: new Blob(),
  duration,
  note: "",
  createdAt: 1,
});
const groups: MediaGroup[] = [
  { name: "开场", assets: [mkAsset("a1.mp4", "开场", 8), mkAsset("a2.mp4", "开场", 5)] },
  { name: "产品", assets: [mkAsset("b1.mp4", "产品", 6)] },
  { name: "空组", assets: [] },
];

// 2. ffmpeg 脚本：trim 模式（时长齐全）+ 空组跳过
const recipe = buildFfmpegRecipe(scenes, groups, { shell: "sh" });
check("trim 模式选中 2 个素材", recipe.mode === "trim" && recipe.usedAssets.length === 2, `mode=${recipe.mode} used=${recipe.usedAssets.length}`);
check("空组镜头被跳过", recipe.skipped === 1, `skipped=${recipe.skipped}`);
check("脚本含 filter_complex 与 concat", recipe.script.includes("-filter_complex") && recipe.script.includes("concat=n=2"));
check("脚本按方案时长裁剪", recipe.script.includes("trim=0:3.00") && recipe.script.includes("trim=0:4.00"));
check("脚本无裸反斜杠转义", !recipe.script.includes(";\\"), "分号后带反斜杠会被 shell 当字面量");
check("bash 头完整", recipe.script.includes("set -euo pipefail") && recipe.script.includes("素材所在目录"));
check("素材轮取：开场组用第 1 个", recipe.script.includes('-i "a1.mp4"'));

// 3. Windows bat 变体
const bat = buildFfmpegRecipe(scenes, groups, { shell: "bat" });
check("bat 用 ^ 续行与 @echo off", bat.script.includes("@echo off") && bat.script.includes("^"));

// 4. 时长未知 → concat 降级
const noDur = buildFfmpegRecipe(
  scenes,
  [
    { name: "开场", assets: [mkAsset("x.mp4", "开场")] },
    { name: "产品", assets: [mkAsset("y.mp4", "产品")] },
    { name: "空组", assets: [] },
  ],
  { shell: "sh" },
);
check("时长未知降级 concat", noDur.mode === "concat" && noDur.script.includes("-f concat") && noDur.script.includes("-c copy"));

// 5. 方案 Markdown
const md = planMarkdown(
  {
    title: "测试方案",
    totalDuration: 10,
    demo: true,
    scenes: scenes.map((item) => ({ ...item })),
    voiceVersions: ["版本A", "版本B"],
    bgm: "轻快",
    notes: ["注意1"],
  },
  { topic: "开业", style: "口播向" },
);
check("Markdown 含分镜表与降级标记", md.includes("| # | 素材组 |") && md.includes("模板降级产出") && md.includes("版本B"));

  // 结构性校验（与 digital-check 同源）：ffmpeg 逻辑行若后面还有参数，必须以续行符结尾
  const checkScript = (label: string, script: string) => {
    const physical = script.split("\n");
    const start = physical.findIndex((line) => line.startsWith("ffmpeg "));
    if (start < 0) return check(`${label}: 含 ffmpeg 命令`, false);
    const end = physical.findIndex((line, index) => index > start && /\.mp4"\s*$/.test(line) && !line.trim().startsWith("#") && !line.trim().startsWith("rem"));
    const commandLines = physical.slice(start, end + 1).filter((line) => line.trim() !== "");
    // bat 的续行符是「空格+^」，trimEnd 会把空格吃掉，故两种结尾都要认
    const truncated = commandLines.slice(0, -1).filter((line) => !line.trimEnd().endsWith("\\") && !line.endsWith("^"));
    check(`${label}: 每行正确续行（含末个输入）`, truncated.length === 0, truncated.length ? truncated.map((l) => l.trim().slice(0, 36)).join(" | ") : `${commandLines.length} 行`);
  };

  checkScript("混剪 sh", recipe.script);
  checkScript("混剪 bat", bat.script);

console.log(`\n${failed === 0 ? "全部通过" : `${failed} 项失败`}`);
process.exit(failed === 0 ? 0 : 1);
