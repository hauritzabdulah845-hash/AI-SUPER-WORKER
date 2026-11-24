/**
 * 字幕样式模板自检：预设、ASS 生成与时序、转义、提示词启发式、配方 ass 分支。
 * 运行：npm run test:style
 */
import type { MediaAsset } from "../src/cloud/media";
import { SUB_STYLES, buildAss, escapeAssText, findSubStyle, styleFromPrompt } from "../src/cloud/substyle";
import { buildDigitalRecipe, fallbackDigitalPlan } from "../src/cloud/digital";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failed += 1;
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` ｜ ${detail}` : ""}`);
};

const mkAsset = (patch: Partial<MediaAsset> & { id: string; name: string }): MediaAsset => ({
  group: "默认",
  kind: "video",
  mime: "video/mp4",
  size: 1000,
  blob: new Blob(),
  note: "",
  createdAt: 1,
  ...patch,
});

(async () => {
  // 1. 预设
  check("五套预设且 id 唯一", SUB_STYLES.length === 5 && new Set(SUB_STYLES.map((s) => s.id)).size === 5);
  const plain = findSubStyle("plain");
  const title = findSubStyle("title");
  check("经典=底部描边", plain.alignment === 2 && plain.borderStyle === 1);
  check("标题卡=顶部底框", title.alignment === 1 && title.borderStyle === 3 && title.fontsize > plain.fontsize);
  check("品牌紫描边色", findSubStyle("brand").outlineColour === "&HFF4D7C");
  check("未知 id 回退经典", findSubStyle("nope").id === "plain");

  // 2. buildAss 结构与时序（无字幕段时间轴继续走，与 buildSrt 一致）
  const scenes = [
    { order: 1, subtitle: "开场钩子", duration: 5 },
    { order: 2, subtitle: "中段事实", duration: 3.5 },
    { order: 3, duration: 4 }, // 无字幕，跳过
    { order: 4, subtitle: "结尾行动", duration: 2 },
  ];
  const ass = buildAss(scenes, plain);
  check("ASS 头完整", ass.includes("[Script Info]") && ass.includes("PlayResX: 1080") && ass.includes("[V4+ Styles]") && ass.includes("[Events]"));
  check("Style 行在", ass.includes("Style: Default,Microsoft YaHei,18"));
  const dialogues = ass.split("\n").filter((line) => line.startsWith("Dialogue:"));
  check("Dialogue 数=有字幕段", dialogues.length === 3, `got=${dialogues.length}`);
  check("时序0-5s", dialogues[0].includes("0:00:00.00,0:00:05.00") && dialogues[0].includes("开场钩子"));
  check("跳过段后时间轴延续(5+3.5+4=12.5)", dialogues[2].includes("0:00:12.50,0:00:14.50"), dialogues[2]);
  check("第二段 5.00-8.50", dialogues[1].includes("0:00:05.00,0:00:08.50"));

  // 3. 转义
  check("去大括号覆盖块", escapeAssText("普通{\\b1}加粗{/b}文本") === "普通加粗文本");
  check("换行转 \\N", escapeAssText("第一行\n第二行") === "第一行\\N第二行");
  const dirty = buildAss([{ order: 1, subtitle: "带{覆盖}与\n换行", duration: 2 }], plain);
  check("脏文本整块移除覆盖码", dirty.includes("带与\\N换行") && !dirty.includes("{覆盖}"), dirty.split("\n").find((l) => l.startsWith("Dialogue")) ?? "");

  // 4. 提示词启发式
  const top = styleFromPrompt("顶部大标题红字");
  check("顶部→alignment1+放大+红字", top.alignment === 1 && top.fontsize > 18 && top.primaryColour === "&H000000FF", JSON.stringify({ a: top.alignment, s: top.fontsize, c: top.primaryColour }));
  const bottom = styleFromPrompt("底部紫色描边加粗");
  check("底部紫边加粗", bottom.alignment === 2 && bottom.outlineColour === "&HFF4D7C" && bottom.bold === -1);
  const clean = styleFromPrompt("小字干净无边");
  check("小字无边", clean.fontsize < 18 && clean.outline === 0 && clean.shadow === 0);
  const boxed = styleFromPrompt("底部字幕条带底框");
  check("字幕条→底框", boxed.borderStyle === 3 && boxed.alignment === 2);
  check("提示词样式 id=custom", styleFromPrompt("任意").id === "custom");

  // 5. 配方：默认 srt 回归 + ass 分支
  const plan = fallbackDigitalPlan("样式测试", 30);
  const assets = [
    mkAsset({ id: "a1", name: "口播-正面", role: "avatar" }),
    mkAsset({ id: "a2", name: "配音", kind: "audio", mime: "audio/wav", role: "voice" }),
    mkAsset({ id: "a3", name: "分镜1", kind: "image", mime: "image/png", group: "产品" }),
  ];
  plan.segments[0] = { ...plan.segments[0], brollGroup: "产品" };
  const srtRecipe = buildDigitalRecipe(plan, assets, { shell: "sh" });
  check("默认仍烧 sub.srt", srtRecipe.script.includes("subtitles=sub.srt") && !srtRecipe.script.includes("ass=sub.ass"));
  const assRecipe = buildDigitalRecipe(plan, assets, { shell: "sh", subFormat: "ass" });
  check("ass 模式换过滤器", assRecipe.script.includes("ass=sub.ass") && !assRecipe.script.includes("subtitles=sub.srt"));
  check("ass 模式头注释指 sub.ass", assRecipe.script.includes("sub.ass 与素材放同一目录"));
  check("ass 模式尾注释指 Style 行", assRecipe.script.includes("改 sub.ass 的 Style 行"));
  const assBat = buildDigitalRecipe(plan, assets, { shell: "bat", subFormat: "ass" });
  check("bat ass 组合", assBat.script.includes("ass=sub.ass") && assBat.script.includes("%~dp0") && assBat.script.includes("^"));
  check("ass 模式副画面与模式不变", assRecipe.mode === srtRecipe.mode && assRecipe.overlays === srtRecipe.overlays);

  console.log(`\n${failed === 0 ? "全部通过" : `${failed} 项失败`}`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
