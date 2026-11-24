/**
 * 素材 AI 分析自检：启发式、视觉适配器（成功/失败/超限）、留档、话术对位与绑定。
 * 运行：npm run test:analysis
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { MediaAsset } from "../src/cloud/media";
import {
  MAX_VISION_BYTES,
  analyzeAll,
  analyzeAsset,
  autoBindSegments,
  heuristicAnalysis,
  loadAnalyses,
  loadVisualConfig,
  saveAnalyses,
  saveVisualConfig,
  suggestBindings,
} from "../src/cloud/mediaanalysis";

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
  blob: new Blob([new Uint8Array([1, 2, 3])], { type: "video/mp4" }),
  note: "",
  createdAt: 1,
  ...patch,
});

(async () => {
  // node 环境 localStorage 垫片（留档/配置读写需要）
  const memory = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => void memory.set(key, String(value)),
    removeItem: (key: string) => void memory.delete(key),
  };

  // 1. 启发式
  const avatar = heuristicAnalysis(mkAsset({ id: "a1", name: "口播-正面-门店", group: "形象" }));
  check("出镜词→形象建议", avatar.suggestedRole === "avatar" && avatar.roleReason.includes("出镜"), avatar.roleReason);
  check("标签命中词典+文件名切分", avatar.tags.includes("口播") && avatar.tags.includes("门店"), JSON.stringify(avatar.tags));
  check("标签封顶 6 个", heuristicAnalysis(mkAsset({ id: "a2", name: "门店 环境 产品 菜品 流程 价格 活动 特写" })).tags.length <= 6);

  const voice = heuristicAnalysis(mkAsset({ id: "a3", name: "旁白录音", kind: "audio", mime: "audio/wav" }));
  check("音频→声音建议", voice.suggestedRole === "voice");

  const broll = heuristicAnalysis(mkAsset({ id: "a4", name: "门店外观", kind: "image", mime: "image/png" }));
  check("图片→分镜建议", broll.suggestedRole === "broll" && broll.note.includes("组"));
  check("启发式摘要含类型与时长", broll.note.includes("图片") && heuristicAnalysis(mkAsset({ id: "a5", name: "x", duration: 12 })).note.includes("12s"));

  // 2. 默认配置 → heuristic，不出网
  const defaults = loadVisualConfig();
  const rows = await analyzeAll([avatar as unknown as MediaAsset].map((_, index) => mkAsset({ id: `m${index}`, name: "门店环境" })), defaults);
  check("默认配置全量分析=启发式", rows.length === 1 && rows[0].source === "heuristic");

  // 3. 留档往返
  const saved = saveAnalyses(rows);
  check("分析留档写入", saved.length === 1 && loadAnalyses().length === 1);
  saveAnalyses([]);
  check("留档可清空", loadAnalyses().length === 0);

  // 4. generic 成功路径（本机临时 HTTP 服务）
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const parsed = JSON.parse(body) as { image?: string };
        const okImage = typeof parsed.image === "string" && parsed.image.startsWith("data:");
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(okImage ? { tags: ["识别A", "识别B"], role: "broll", note: "货架前的商品特写" } : { error: "bad image" }));
      } catch {
        res.statusCode = 500;
        res.end("{}");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  const visionOk = await analyzeAsset(mkAsset({ id: "v1", name: "未知文件", blob: new Blob([new Uint8Array([9])], { type: "image/png" }), kind: "image", mime: "image/png" }), {
    provider: "generic",
    baseUrl: `http://127.0.0.1:${port}`,
    path: "/v1/vision",
  });
  check("视觉成功→source=vision", visionOk.source === "vision", visionOk.note);
  check("视觉返回标签与角色覆盖", visionOk.tags[0] === "识别A" && visionOk.suggestedRole === "broll", JSON.stringify(visionOk.tags));
  check("视觉返回描述作 note", visionOk.note.includes("货架"), visionOk.note);

  // 5. generic 失败 → 回退启发式并注明
  server.close();
  const visionFail = await analyzeAsset(mkAsset({ id: "v2", name: "门店环境", kind: "image", mime: "image/png" }), {
    provider: "generic",
    baseUrl: `http://127.0.0.1:${port}`,
    path: "/v1/vision",
  });
  check("视觉失败回退启发式", visionFail.source === "heuristic" && visionFail.note.includes("视觉服务失败"), visionFail.note);
  check("回退后标签仍可用", visionFail.tags.includes("门店"));

  // 6. 超 2MB 跳过视觉
  const big = await analyzeAsset(mkAsset({ id: "v3", name: "大文件", size: MAX_VISION_BYTES + 1, kind: "image", mime: "image/png" }), {
    provider: "generic",
    baseUrl: "http://127.0.0.1:1",
    path: "/x",
  });
  check("超限跳过并注明", big.source === "heuristic" && big.note.includes("超 2MB"), big.note);

  // 7. 话术对位
  const groups = [
    { name: "门店", assets: [{ name: "门店外观", note: "白天全景" }] },
    { name: "产品", assets: [{ name: "产品特写" }] },
  ];
  const suggestions = suggestBindings(
    [
      { order: 1, script: "先看门店环境，位置好找", subtitle: "门店环境" },
      { order: 2, script: "再看产品细节与材质", subtitle: "产品细节" },
      { order: 3, script: "今天天气不错", subtitle: "无关内容" },
    ],
    groups,
  );
  check("段1对位到门店", suggestions.find((item) => item.order === 1)?.group === "门店", JSON.stringify(suggestions));
  check("段2对位到产品", suggestions.find((item) => item.order === 2)?.group === "产品");
  check("无关段无建议", !suggestions.some((item) => item.order === 3));

  // 8. autoBind 只补空位
  const bound = autoBindSegments(
    [
      { order: 1, script: "先看门店环境", subtitle: "门店环境" },
      { order: 2, script: "再看产品细节", subtitle: "产品细节", brollGroup: "人工锁定" },
      { order: 3, script: "今天天气不错", subtitle: "无关" },
    ],
    suggestions,
  );
  check("空位补上", bound.segments[0].brollGroup === "门店" && bound.applied === 1);
  check("人工绑定保留", bound.segments[1].brollGroup === "人工锁定" && bound.kept === 1);
  check("低分段不硬绑", !bound.segments[2].brollGroup);

  // 9. 配置读写
  saveVisualConfig({ provider: "generic", baseUrl: "http://x", path: "/p" });
  check("视觉配置读写", loadVisualConfig().provider === "generic" && loadVisualConfig().path === "/p");
  saveVisualConfig({ provider: "heuristic", baseUrl: "", path: "/v1/vision" });

  console.log(`\n${failed === 0 ? "全部通过" : `${failed} 项失败`}`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
