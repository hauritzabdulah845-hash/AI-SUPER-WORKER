#!/usr/bin/env node
/**
 * C 组真机出片自检（需本机已装 ffmpeg）。
 *
 * 做什么：在临时目录里造一套最小素材（纯色竖屏视频 + 合成音 + 一张图），
 * 把你导出的 make-digital.sh 原样跑一遍，再校验成片：分辨率/码流/时长/音轨，
 * 并抽 3 帧供肉眼确认字幕与副画面。
 *
 * 用法：
 *   node scripts/c-group-verify.mjs                    # 用 acceptance-samples 里的脚本
 *   node scripts/c-group-verify.mjs --script path.sh    # 指定脚本
 *   node scripts/c-group-verify.mjs --fonts fonts/       # 指定中文字体目录（解决豆腐块）
 *
 * 退出码：0 全部通过 / 1 有失败项 / 2 环境缺 ffmpeg
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const run = (cmd, cmdArgs, opts = {}) =>
  execFileSync(cmd, cmdArgs, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });

// 1. 环境
try {
  run("ffmpeg", ["-version"]);
} catch {
  console.error("✗ 未找到 ffmpeg：macOS `brew install ffmpeg` / Windows `winget install ffmpeg`");
  process.exit(2);
}
const hasProbe = (() => {
  try { run("ffprobe", ["-version"]); return true; } catch { return false; }
})();

const repoRoot = resolve(import.meta.dirname, "../..");
const scriptPath = resolve(flag("script", join(repoRoot, "acceptance-samples/make-digital.sh")));
const srtPath = resolve(flag("srt", join(repoRoot, "acceptance-samples/sub.srt")));
const fontDir = flag("fonts", "");
if (!existsSync(scriptPath)) { console.error(`✗ 脚本不存在：${scriptPath}`); process.exit(1); }

const work = mkdtempSync(join(tmpdir(), "cgroup-"));
let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` ｜ ${detail}` : ""}`);
  if (!ok) failed += 1;
};

console.log(`—— C 组出片自检 ——\n脚本：${scriptPath}\n工作目录：${work}\n`);

try {
  // 2. 造素材（名字与导出一致）
  const q = ["-y", "-v", "error", "-hide_banner"];
  run("ffmpeg", [...q, "-f", "lavfi", "-i", "color=c=0x2b4a6f:s=1080x1920:d=12:r=25",
    "-vf", "drawbox=x=340:y=520:w=400:h=520:color=0xf0c9a0:t=fill",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", join(work, "口播-正面.mp4")]);
  run("ffmpeg", [...q, "-f", "lavfi", "-i", "sine=frequency=420:duration=30", "-c:a", "pcm_s16le", join(work, "配音.wav")]);
  run("ffmpeg", [...q, "-f", "lavfi", "-i", "color=c=0xd94f4f:s=1920x1080:d=1", "-frames:v", "1", join(work, "分镜1.png")]);
  cpSync(scriptPath, join(work, "make-digital.sh"));
  cpSync(srtPath, join(work, "sub.srt"));
  if (fontDir && existsSync(fontDir)) {
    cpSync(fontDir, join(work, "fonts"), { recursive: true });
    console.log(`（已复制字体 ${readdirSync(fontDir).length} 个到 fonts/）`);
  }
  check("素材生成", ["口播-正面.mp4", "配音.wav", "分镜1.png", "sub.srt", "make-digital.sh"].every((f) => existsSync(join(work, f))));

  // 3. 原样执行脚本
  const started = Date.now();
  let scriptOut = "";
  try {
    scriptOut = execFileSync("bash", ["make-digital.sh"], { cwd: work, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    scriptOut = `${error.stdout ?? ""}${error.stderr ?? ""}`;
  }
  const outPath = join(work, "digital-out.mp4");
  check("脚本执行成功", existsSync(outPath) && (await import("node:fs")).statSync(outPath).size > 10_000,
    `耗时 ${((Date.now() - started) / 1000).toFixed(1)}s`);
  if (!existsSync(outPath)) {
    const errLine = scriptOut.split("\n").filter((l) => /error|Invalid|could not|not supported/i.test(l)).slice(0, 3);
    console.error(`\n脚本报错片段：\n${errLine.join("\n")}`);
    throw new Error("未产出成片");
  }

  // 4. 成片校验
  const size = (await import("node:fs")).statSync(outPath).size;
  check("成片非空", size > 50_000, `${(size / 1024).toFixed(0)} KB`);

  if (hasProbe) {
    const probe = JSON.parse(run("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", outPath]));
    const video = probe.streams.find((s) => s.codec_type === "video");
    const audio = probe.streams.find((s) => s.codec_type === "audio");
    check("竖屏 1080x1920", video?.width === 1080 && video?.height === 1920, `${video?.width}x${video?.height}`);
    check("视频 h264", video?.codec_name === "h264", video?.codec_name ?? "无");
    check("有音轨且非 pcm", Boolean(audio) && !/pcm/.test(audio.codec_name), audio?.codec_name ?? "无音轨");
    const duration = Number(probe.format.duration);
    check("时长约 30s", duration >= 20 && duration <= 45, `${duration.toFixed(1)}s`);
  } else {
    console.log("（未安装 ffprobe，跳过流参数校验）");
  }

  // 5. 抽帧供肉眼确认
  const frames = [];
  for (const t of [2, 8, 20]) {
    const frame = join(work, `frame-${t}s.png`);
    run("ffmpeg", ["-y", "-v", "error", "-ss", String(t), "-i", outPath, "-frames:v", "1", frame]);
    if (existsSync(frame)) frames.push(frame);
  }
  check("抽帧成功", frames.length === 3, frames.map((f) => f.split("/").pop()).join(" "));

  console.log(`\n成片：${outPath}`);
  console.log(`抽帧：${frames.join("\n      ")}`);
  console.log("\n请肉眼确认抽帧：① 竖屏人像铺满 ② 8s 附近有副画面 ③ 底部中文字幕（非方块）");
  if (!fontDir) console.log("提示：中文变方块时加 --fonts <字体目录>，把中文字体 ttf/otf 放进去重跑。");
} catch (error) {
  console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}`);
  failed += 1;
} finally {
  // 保留成片与抽帧，其余清理
  for (const name of ["口播-正面.mp4", "配音.wav", "分镜1.png"]) {
    try { rmSync(join(work, name), { force: true }); } catch {}
  }
}

console.log(`\n${failed === 0 ? "C 组通过" : `${failed} 项失败`}`);
process.exit(failed === 0 ? 0 : 1);
