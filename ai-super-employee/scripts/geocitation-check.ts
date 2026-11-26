/**
 * GEO 稿件引用状态纯逻辑自检（第三十批，评审 P2）。
 * 关注点：三路匹配（发布链接/标题关键词/品牌+平台）、计数与最近时间口径、空输入兜底。
 * 运行：npm run test:geocitation
 */
import {
  CITATION_WAY_LABEL,
  draftPlatform,
  matchDraftCitations,
  reviewItemToCitationDraft,
  type CitationDraftInput,
} from "../src/cloud/geoCitation";
import type { GeoSnapshot } from "../src/cloud/geotrack";
import type { GeoReviewItem } from "../src/cloud/geoReview";

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) {
    pass += 1;
    console.log(`✓ ${name}${detail ? ` ｜ ${detail}` : ""}`);
  } else {
    fail += 1;
    console.log(`✗ ${name}${detail ? ` ｜ ${detail}` : ""}`);
  }
};

function snapshot(id: string, at: string, sources: string[]): GeoSnapshot {
  return {
    id,
    at,
    brand: "山野茶饮",
    questions: ["现煮茶饮哪家比较靠谱？"],
    samples: [
      {
        question: "现煮茶饮哪家比较靠谱？",
        mentioned: true,
        hits: 2,
        firstPos: 20,
        answerLength: 300,
        sources,
      },
    ],
    channel: "demo",
    sources: [{ question: "现煮茶饮哪家比较靠谱？", sources }],
  };
}

const draft = (patch: Partial<CitationDraftInput>): CitationDraftInput => ({
  id: "d1",
  title: "现煮茶饮加盟避坑指南",
  brand: "山野茶饮",
  ...patch,
});

/* ---------- 标题关键词匹配 ---------- */

{
  const [status] = matchDraftCitations(
    [draft({})],
    [snapshot("s1", "2026-11-10T09:00:00Z", ["现煮茶饮加盟避坑指南 - 示例资讯"])],
  );
  ok("完整标题命中", status.cited && status.citationCount === 1 && status.matchWays.includes("title"));
  ok("命中信源名回填", status.matchedSources.length === 1 && status.matchedSources[0].includes("避坑指南"));
  ok("最近引用时间", status.lastCitedAt === "2026-11-10T09:00:00Z");
}

{
  const [status] = matchDraftCitations(
    [draft({ title: "杭州下午茶团购怎么选" })],
    [snapshot("s1", "2026-11-10T09:00:00Z", ["下午茶团购选购要点汇总"])],
  );
  ok("两个弱关键词同时命中", status.cited, "下午茶+团购");
}

{
  const [status] = matchDraftCitations(
    [draft({ title: "杭州下午茶团购怎么选" })],
    [snapshot("s1", "2026-11-10T09:00:00Z", ["杭州美食地图"])],
  );
  ok("单个弱关键词不误判", !status.cited && status.citationCount === 0 && status.lastCitedAt === null);
}

/* ---------- 发布链接域名匹配 ---------- */

{
  const [status] = matchDraftCitations(
    [draft({ title: "门店日常记录", url: "https://www.xiaohongshu.com/explore/abc123" })],
    [snapshot("s1", "2026-11-10T09:00:00Z", ["https://xiaohongshu.com/explore/abc123"])],
  );
  ok("发布链接域名命中（去 www.）", status.cited && status.matchWays.includes("url"));
}

{
  const [status] = matchDraftCitations(
    [draft({ title: "门店日常记录", body: "发布地址 https://mp.weixin.qq.com/s/xyz，欢迎围观" })],
    [snapshot("s1", "2026-11-10T09:00:00Z", ["mp.weixin.qq.com 山野茶饮新店开业"])],
  );
  ok("正文节选里的链接也可命中", status.cited && status.matchWays.includes("url"));
}

{
  const [status] = matchDraftCitations(
    [draft({ title: "门店日常记录", url: "https://www.xiaohongshu.com/explore/abc123" })],
    [snapshot("s1", "2026-11-10T09:00:00Z", ["https://zhihu.com/question/123"])],
  );
  ok("域名不同不命中", !status.cited);
}

/* ---------- 品牌+平台匹配 ---------- */

{
  const [status] = matchDraftCitations(
    [draft({ title: "小红书稿：新品上新", platform: "小红书" })],
    [snapshot("s1", "2026-11-10T09:00:00Z", ["小红书 山野茶饮探店合集"])],
  );
  ok("品牌+平台同时出现命中", status.cited && status.matchWays.includes("brand-platform"));
  ok("平台名回填", status.platform === "小红书");
}

{
  const [status] = matchDraftCitations(
    [draft({ title: "小红书稿：新品上新", platform: "小红书" })],
    [snapshot("s1", "2026-11-10T09:00:00Z", ["小红书 茶饮探店合集"])],
  );
  ok("只有平台没有品牌不命中", !status.cited);
}

{
  const [status] = matchDraftCitations(
    [draft({ title: "新品上新记录" })],
    [snapshot("s1", "2026-11-10T09:00:00Z", ["小红书 山野茶饮探店合集"])],
  );
  ok("稿件无平台线索时品牌+平台路不触发", !status.cited);
}

/* ---------- 计数与多快照口径 ---------- */

{
  const [status] = matchDraftCitations(
    [draft({})],
    [
      snapshot("s2", "2026-11-17T09:00:00Z", ["现煮茶饮加盟避坑指南 - 示例资讯", "现煮茶饮加盟避坑指南（转载）"]),
      snapshot("s1", "2026-11-10T09:00:00Z", ["现煮茶饮加盟避坑指南 - 示例资讯"]),
    ],
  );
  ok("跨快照累计计数", status.citationCount === 3, `count=${status.citationCount}`);
  ok("最近时间取最新快照（乱序输入也对）", status.lastCitedAt === "2026-11-17T09:00:00Z");
  ok("命中信源去重上限内", status.matchedSources.length === 2);
}

/* ---------- 平台推断 ---------- */

ok("标题前缀推断平台", draftPlatform(draft({ title: "小红书稿：新品上新" })) === "小红书");
ok("正文别名推断平台", draftPlatform(draft({ title: "新品上新", body: "已发布到知乎专栏" })) === "知乎");
ok("无线索平台为空", draftPlatform(draft({ title: "新品上新" })) === "");
ok("显式平台优先", draftPlatform(draft({ title: "小红书稿：新品", platform: "公众号" })) === "公众号");

/* ---------- 空输入与旧快照兼容 ---------- */

ok("空稿件列表返回空", matchDraftCitations([], [snapshot("s1", "2026-11-10T09:00:00Z", ["任意来源"])]).length === 0);
{
  const [status] = matchDraftCitations([draft({})], []);
  ok("空快照未被引用", !status.cited && status.citationCount === 0 && status.matchedSources.length === 0);
}
{
  // 旧快照：无快照级 sources，只有样本级 sources
  const legacy: GeoSnapshot = {
    id: "old",
    at: "2026-11-01T09:00:00Z",
    brand: "山野茶饮",
    questions: ["现煮茶饮哪家比较靠谱？"],
    samples: [
      {
        question: "现煮茶饮哪家比较靠谱？",
        mentioned: true,
        hits: 1,
        firstPos: 10,
        answerLength: 200,
        sources: ["现煮茶饮加盟避坑指南 - 旧站"],
      },
    ],
    channel: "demo",
  };
  const [status] = matchDraftCitations([draft({})], [legacy]);
  ok("旧快照样本级来源可回退匹配", status.cited && status.citationCount === 1);
}

/* ---------- 审核条目映射 ---------- */

{
  const item: GeoReviewItem = {
    id: "rev-1",
    brand: "山野茶饮",
    title: "小红书稿：现煮茶饮加盟避坑指南",
    body: "正文节选，发布地址 https://www.xiaohongshu.com/explore/abc",
    kind: "platform",
    status: "approved",
    checks: [],
    createdAt: "2026-11-09T09:00:00Z",
  };
  const input = reviewItemToCitationDraft(item);
  ok("审核条目映射保留标题/品牌", input.title === item.title && input.brand === "山野茶饮");
  const [status] = matchDraftCitations([input], [
    snapshot("s1", "2026-11-10T09:00:00Z", ["https://xiaohongshu.com/explore/abc"]),
  ]);
  ok("映射后可走链接匹配", status.cited && status.matchWays.includes("url"));
  ok("匹配路径标签齐全", CITATION_WAY_LABEL.url === "发布链接" && CITATION_WAY_LABEL.title === "标题关键词");
}

console.log(`\n${fail === 0 ? "全部通过" : "有失败"}（${pass} 通过 / ${fail} 失败）`);
if (fail > 0) process.exit(1);
