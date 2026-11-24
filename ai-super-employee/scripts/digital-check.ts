/**
 * 数字人工坊（L1+L2）自检：文案降级、方案归一、组名过滤、SRT、合成脚本、角色门禁。
 * 运行：npm run test:digital
 */
import { canSetRole, listByRole, type MediaAsset } from "../src/cloud/media";
import { buildSrt } from "../src/cloud/mixcut";
import {
  COPY_SOURCES,
  buildDigitalRecipe,
  digitalPlanMarkdown,
  fallbackDigitalPlan,
  fallbackDrafts,
  generateCopyDrafts,
  generateDigitalPlan,
  normalizeSegments,
} from "../src/cloud/digital";

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
  // 1. L1 演示稿
  const drafts = fallbackDrafts("社区面包店开业", 5);
  check("演示稿按模板供给（5 条模板给 5 条）", drafts.length === 5, `got=${drafts.length}`);
  check("演示稿超出模板数封顶", fallbackDrafts("主题", 99).length === 5);
  check("演示稿含主题", drafts.every((item) => item.includes("社区面包店开业")));
  const llmless = await generateCopyDrafts({ source: "industry", industry: "餐饮", topic: "开业", raw: "", count: 8 });
  check("生成入口无通道降级且封顶 3 条", llmless.demo === true && llmless.drafts.length === 3, `got=${llmless.drafts.length}`);
  check("来源三件套齐", COPY_SOURCES.map((item) => item.value).join(",") === "industry,rewrite,ipbrain");

  // 2. 方案降级结构
  const plan = fallbackDigitalPlan("三步讲清引流", 30);
  check("降级方案 demo 标注", plan.demo === true);
  check("降级方案总长=30", plan.totalDuration === 30 && plan.segments.reduce((sum, s) => sum + s.duration, 0) === 30);
  check("降级方案分段完整", plan.segments.every((s) => s.script && s.subtitle && s.duration >= 2));
  check("降级方案多版本与素材提示", plan.voiceVersions.length >= 1 && plan.assetHints.length >= 1);

  // 3. 段落归一（时长缩放 + 组名过滤）
  const normalized = normalizeSegments(
    [
      { script: "钩子开场讲清楚问题所在", duration: 10, subtitle: "开场", brollGroup: "存在的组" },
      { script: "中间给出三个可验证的事实与做法", duration: 10, subtitle: "事实", brollGroup: "非法组名" },
      { script: "结尾只留一个动作指令引导互动", duration: 10, subtitle: "行动" },
    ],
    30,
    ["存在的组"],
  );
  check("归一后总长=目标", normalized.reduce((sum, s) => sum + s.duration, 0) === 30, JSON.stringify(normalized.map((s) => s.duration)));
  check("非法组名被丢弃", normalized[0].brollGroup === "存在的组" && normalized[1].brollGroup === undefined);
  check("缺省字幕回填台词头", normalized[2].subtitle.length > 0);

  const scaled = normalizeSegments(
    [
      { script: "第一段台词内容足够长了", duration: 3, subtitle: "一" },
      { script: "第二段台词内容也足够长", duration: 4, subtitle: "二" },
    ],
    60,
    [],
  );
  check("60s 归一不小于下限", scaled.reduce((sum, s) => sum + s.duration, 0) === 60 && scaled.every((s) => s.duration >= 2));

  // 4. SRT（复用混剪实现）
  const srt = buildSrt(normalized);
  check("SRT 覆盖有字幕段", srt.includes("开场") && srt.includes("行动"));

  // 5. Markdown
  const md = digitalPlanMarkdown(plan, { topic: "三步讲清引流", industry: "餐饮" });
  check("Markdown 含分镜表与降级标记", md.includes("| # | 时长 |") && md.includes("模板降级产出") && md.includes("配音多版本"));

  // 6. 素材角色与门禁
  const assets = [
    mkAsset({ id: "a1", name: "口播-正面.mp4", role: "avatar" }),
    mkAsset({ id: "a2", name: "配音.wav", kind: "audio", mime: "audio/wav", role: "voice" }),
    mkAsset({ id: "a3", name: "分镜1.png", kind: "image", mime: "image/png", group: "产品" }),
    mkAsset({ id: "a4", name: "产品.mp4", group: "产品" }),
    mkAsset({ id: "a5", name: "花絮.mp4", group: "只有视频" }),
  ];
  const planBound = {
    ...plan,
    segments: plan.segments.map((segment, index) =>
      index === 1 ? { ...segment, brollGroup: "产品" } : index === 2 ? { ...segment, brollGroup: "只有视频" } : segment,
    ),
  };
  check("listByRole 过滤", listByRole(assets, "avatar").length === 1 && listByRole(assets, "voice").length === 1);
  check("形象需授权门禁", !canSetRole("avatar", false) && canSetRole("avatar", true));
  check("声音需授权门禁", !canSetRole("voice", false) && canSetRole("voice", true));
  check("broll 无需授权", canSetRole("broll", false));
  check("清除角色无需授权", canSetRole("", false));

  // 7. 合成脚本：形象+配音+副画面
  const recipe = buildDigitalRecipe(planBound, assets, { shell: "sh" });
  check("形象+配音模式", recipe.mode === "avatar+audio" && recipe.avatar === "口播-正面.mp4" && recipe.audio === "配音.wav");
  check("脚本含循环形象与配音映射", recipe.script.includes("-stream_loop -1") && recipe.script.includes('"配音.wav"') && recipe.script.includes("-map 1:a"));
  check("脚本烧录 sub.srt", recipe.script.includes("subtitles=sub.srt"));
  check("脚本含副画面 overlay 时间窗", recipe.script.includes("overlay=enable='between(t,") && recipe.overlays === 1, `overlays=${recipe.overlays}`);
  check("无图组的绑定段记入 skipped", recipe.skipped === 1, `skipped=${recipe.skipped}`);
  check("脚本 cd 到脚本目录", recipe.script.includes('cd "$(dirname "$0")"'));
  check("脚本 set -euo pipefail", recipe.script.includes("set -euo pipefail"));

  // 8. bat 变体
  const bat = buildDigitalRecipe(planBound, assets, { shell: "bat" });
  check("bat 用 ^ 续行与 %~dp0", bat.script.includes("@echo off") && bat.script.includes("^") && bat.script.includes("%~dp0"));

  // 9. 无形象 → 分镜粗拼
  const noAvatar = assets.filter((item) => item.role !== "avatar");
  const footageRecipe = buildDigitalRecipe(planBound, noAvatar, { shell: "sh" });
  check("无形象退化为分镜模式", footageRecipe.mode === "footage+audio" && footageRecipe.script.includes("-f concat"));

  // 10. 无任何视频 → 抛错
  let threw = "";
  try {
    buildDigitalRecipe(planBound, [assets[2]], { shell: "sh" });
  } catch (error) {
    threw = error instanceof Error ? error.message : String(error);
  }
  check("缺视频素材时明确报错", threw.includes("缺少形象视频或分镜视频"), threw);

  // 11. generateDigitalPlan 降级（无模型通道 → fallback）
  const generated = await generateDigitalPlan({ topic: "测试主题", industry: "餐饮", duration: 30, brollGroups: [] });
  check("生成入口可降级返回", generated.segments.length >= 3 && generated.totalDuration === 30 && generated.demo === true);

  console.log(`\n${failed === 0 ? "全部通过" : `${failed} 项失败`}`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
