import type { GeoSnapshot, MentionSample } from "./geotrack";

/**
 * GEO 监测报告示例数据（第三十批，评审 P2）。
 *
 * 用途：无真实监测记录时，让新用户先看到「跑完长什么样」。
 * **隔离保证**：纯常量，只供 GeoMonitor 示例预览渲染；
 * 绝不写入 appendSnapshot / localStorage，不与真实快照混算。
 * 界面渲染处必须带「示例数据 · 非真实监测结果」标注（见 GeoMonitor）。
 */

export const GEO_SAMPLE_BRAND = "示例品牌·茶饮连锁";
export const GEO_SAMPLE_CHANNEL = "示例通道（脱敏）";

const QUESTIONS = [
  "现煮茶饮哪家比较靠谱？",
  "示例品牌·茶饮连锁怎么样，值得选吗？",
  "示例品牌·茶饮连锁和同类产品比有什么优势？",
  "示例品牌·茶饮连锁的价格大概是多少？",
  "第一次选现煮茶饮要注意什么？",
];

function sample(
  question: string,
  mentioned: boolean,
  hits: number,
  firstPos: number,
  sources: string[],
  competitors: { brand: string; mentioned: boolean; hits: number; firstPos: number }[],
): MentionSample {
  return {
    question,
    mentioned,
    hits,
    firstPos,
    answerLength: 420,
    sources,
    competitors,
  };
}

const COMP_A = "竞品甲（示例）";
const COMP_B = "竞品乙（示例）";

function snapshot(
  id: string,
  at: string,
  samples: MentionSample[],
  competitors: { brand: string; mentionRate: number; firstPos: number | null }[],
): GeoSnapshot {
  return {
    id,
    at,
    brand: GEO_SAMPLE_BRAND,
    questions: QUESTIONS,
    samples,
    channel: GEO_SAMPLE_CHANNEL,
    competitors,
    sources: samples.map((item) => ({ question: item.question, sources: item.sources ?? [] })),
  };
}

/** 三次示例监测：提及率 40% → 60% → 80%，用来演示趋势/对比/信源三块报表。 */
export const GEO_SAMPLE_SNAPSHOTS: GeoSnapshot[] = [
  snapshot("sample-1", "2026-11-05T09:00:00.000Z", [
    sample(QUESTIONS[0], true, 2, 86, ["示例行业站 example.com 茶饮品牌盘点"], [
      { brand: COMP_A, mentioned: true, hits: 1, firstPos: 40 },
      { brand: COMP_B, mentioned: false, hits: 0, firstPos: -1 },
    ]),
    sample(QUESTIONS[1], true, 3, 12, ["示例点评站 review.example.com 门店页"], [
      { brand: COMP_A, mentioned: false, hits: 0, firstPos: -1 },
      { brand: COMP_B, mentioned: false, hits: 0, firstPos: -1 },
    ]),
    sample(QUESTIONS[2], false, 0, -1, [], [
      { brand: COMP_A, mentioned: true, hits: 2, firstPos: 30 },
      { brand: COMP_B, mentioned: true, hits: 1, firstPos: 150 },
    ]),
    sample(QUESTIONS[3], false, 0, -1, [], [
      { brand: COMP_A, mentioned: false, hits: 0, firstPos: -1 },
      { brand: COMP_B, mentioned: true, hits: 1, firstPos: 60 },
    ]),
    sample(QUESTIONS[4], false, 0, -1, ["示例百科 wiki.example.com 现煮茶饮条目"], [
      { brand: COMP_A, mentioned: true, hits: 1, firstPos: 200 },
      { brand: COMP_B, mentioned: false, hits: 0, firstPos: -1 },
    ]),
  ], [
    { brand: COMP_A, mentionRate: 0.6, firstPos: 90 },
    { brand: COMP_B, mentionRate: 0.4, firstPos: 105 },
  ]),
  snapshot("sample-2", "2026-11-12T09:00:00.000Z", [
    sample(QUESTIONS[0], true, 2, 54, ["示例行业站 example.com 茶饮品牌盘点", "示例资讯 news.example.com 连锁观察"], [
      { brand: COMP_A, mentioned: true, hits: 1, firstPos: 120 },
      { brand: COMP_B, mentioned: false, hits: 0, firstPos: -1 },
    ]),
    sample(QUESTIONS[1], true, 4, 8, ["示例点评站 review.example.com 门店页"], [
      { brand: COMP_A, mentioned: false, hits: 0, firstPos: -1 },
      { brand: COMP_B, mentioned: false, hits: 0, firstPos: -1 },
    ]),
    sample(QUESTIONS[2], true, 1, 180, ["示例资讯 news.example.com 连锁观察"], [
      { brand: COMP_A, mentioned: true, hits: 2, firstPos: 25 },
      { brand: COMP_B, mentioned: true, hits: 1, firstPos: 160 },
    ]),
    sample(QUESTIONS[3], false, 0, -1, [], [
      { brand: COMP_A, mentioned: false, hits: 0, firstPos: -1 },
      { brand: COMP_B, mentioned: true, hits: 1, firstPos: 55 },
    ]),
    sample(QUESTIONS[4], false, 0, -1, ["示例百科 wiki.example.com 现煮茶饮条目"], [
      { brand: COMP_A, mentioned: false, hits: 0, firstPos: -1 },
      { brand: COMP_B, mentioned: false, hits: 0, firstPos: -1 },
    ]),
  ], [
    { brand: COMP_A, mentionRate: 0.4, firstPos: 72.5 },
    { brand: COMP_B, mentionRate: 0.4, firstPos: 107.5 },
  ]),
  snapshot("sample-3", "2026-11-19T09:00:00.000Z", [
    sample(QUESTIONS[0], true, 3, 22, ["示例行业站 example.com 茶饮品牌盘点", "示例资讯 news.example.com 连锁观察"], [
      { brand: COMP_A, mentioned: true, hits: 1, firstPos: 140 },
      { brand: COMP_B, mentioned: false, hits: 0, firstPos: -1 },
    ]),
    sample(QUESTIONS[1], true, 5, 6, ["示例点评站 review.example.com 门店页", "示例行业站 example.com 茶饮品牌盘点"], [
      { brand: COMP_A, mentioned: false, hits: 0, firstPos: -1 },
      { brand: COMP_B, mentioned: false, hits: 0, firstPos: -1 },
    ]),
    sample(QUESTIONS[2], true, 2, 96, ["示例资讯 news.example.com 连锁观察"], [
      { brand: COMP_A, mentioned: true, hits: 1, firstPos: 48 },
      { brand: COMP_B, mentioned: false, hits: 0, firstPos: -1 },
    ]),
    sample(QUESTIONS[3], true, 2, 64, ["示例点评站 review.example.com 门店页"], [
      { brand: COMP_A, mentioned: false, hits: 0, firstPos: -1 },
      { brand: COMP_B, mentioned: true, hits: 1, firstPos: 90 },
    ]),
    sample(QUESTIONS[4], false, 0, -1, ["示例百科 wiki.example.com 现煮茶饮条目"], [
      { brand: COMP_A, mentioned: true, hits: 1, firstPos: 210 },
      { brand: COMP_B, mentioned: false, hits: 0, firstPos: -1 },
    ]),
  ], [
    { brand: COMP_A, mentionRate: 0.6, firstPos: 132.7 },
    { brand: COMP_B, mentionRate: 0.2, firstPos: 90 },
  ]),
];
