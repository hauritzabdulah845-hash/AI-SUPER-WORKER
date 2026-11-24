/**
 * 第十五批自检：交付物打包 + 知识库本地相关性排序（纯函数）。
 * 运行：npm run test:ops3
 */
import { BUNDLE_KIND_META, buildBundle, formatBytes, safeFileName, type BundleItem } from "../src/cloud/bundle";
import { rankDocs, filteredTerms, terms } from "../src/cloud/kbrank";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failed += 1;
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` ｜ ${detail}` : ""}`);
};

/* ============================ 文件命名 ============================ */

check("非法字符替换", safeFileName("a/b:c*d?e\"f<g>h|i") === "a_b_c_d_e_f_g_h_i", safeFileName("a/b:c*d?e\"f<g>h|i"));
check("空白压缩", safeFileName("  多   空格  ") === "多 空格");
check("去掉开头点", safeFileName("...隐藏") === "隐藏");
check("空标题回退", safeFileName("   ") === "未命名");
check("超长截断", safeFileName("字".repeat(100), 20).length === 20);
check("保留中日文与括号", safeFileName("方案（最终版）v2") === "方案（最终版）v2");

/* ============================== 打包 ============================== */

const items: BundleItem[] = [
  { kind: "content", title: "秋季新品文案", ext: ".md", data: "# 文案\n正文内容", source: "内容工厂" },
  { kind: "content", title: "秋季新品文案", ext: ".md", data: "重复标题的另一个文件", source: "内容工厂" },
  { kind: "office-ppt", title: "招商方案", ext: ".pptx", data: "UEsDBAoAAAAAA", encoding: "base64", source: "AI 办公" },
  { kind: "office-doc", title: "服务制度", ext: ".docx", data: "UEsDBAoAAAAAB", encoding: "base64", source: "AI 办公" },
  { kind: "srt", title: "口播字幕", ext: ".srt", data: "1\n00:00:00,000 --> 00:00:03,000\n你好\n", source: "数字人" },
  { kind: "content", title: "   ", ext: ".md", data: "空标题也能落盘" },
  { kind: "content", title: "空内容", ext: ".md", data: "   ", source: "应被跳过" },
];

const bundle = buildBundle(items, Date.parse("2026-11-24T12:00:00Z"));
check("空内容被跳过", bundle.entries.length === 6, `entries=${bundle.entries.length}`);
check("同名自动加序号", bundle.entries.some((entry) => entry.fileName === "秋季新品文案(2).md"), bundle.entries.map((e) => e.fileName).join(" | "));
check("空标题回退为未命名", bundle.entries.some((entry) => entry.fileName.startsWith("未命名")));
check("按分类落目录", bundle.entries[0].path.startsWith("01-内容产出/") && bundle.entries.some((e) => e.path.startsWith("02-演示文稿/")) && bundle.entries.some((e) => e.path.startsWith("06-字幕/")), bundle.entries.map((e) => e.path).join(" | "));
check("同分类内保持入参顺序", bundle.entries.filter((e) => e.kind === "content").map((e) => e.title)[0] === "秋季新品文案");
check("totalBytes 累加", bundle.totalBytes === bundle.entries.reduce((sum, e) => sum + e.bytes, 0), String(bundle.totalBytes));
check("byKind 数量与字节", bundle.byKind.find((row) => row.kind === "content")?.count === 3, JSON.stringify(bundle.byKind.map((r) => [r.kind, r.count])));
// "UEsDBAoAAAAAA" 长度 13、无填充 → floor(13*3/4) = 9
check("base64 字节估算", bundle.entries.find((e) => e.kind === "office-ppt")?.bytes === 9, String(bundle.entries.find((e) => e.kind === "office-ppt")?.bytes));

const readme = bundle.readme;
check("README 含标题与统计", readme.includes("# 交付物打包清单") && readme.includes("文件数：6"));
check("README 含目录说明", readme.includes("`01-内容产出/`") && readme.includes("`02-演示文稿/`"));
check("README 含文件清单表格", readme.includes("| 文件 | 大小 | 来源 |") && readme.includes("01-内容产出/秋季新品文案.md"));
check("README 标注来源", readme.includes("内容工厂") && readme.includes("AI 办公"));
check("跳过的项写进 README", readme.includes("跳过空内容：1 项"), readme.split("\n").slice(0, 8).join(" / "));

check("空清单不抛错", buildBundle([]).entries.length === 0);
check("全空内容得空清单", buildBundle([{ kind: "content", title: "x", ext: ".md", data: "" }]).entries.length === 0);
check("扩展名缺省补点", buildBundle([{ kind: "other", title: "x", ext: "txt", data: "a" }]).entries[0].fileName === "x.txt");

check("formatBytes B/KB/MB", formatBytes(512) === "512 B" && formatBytes(2048) === "2.0 KB" && formatBytes(3 * 1024 * 1024) === "3.00 MB");
check("分类元数据 8 类", BUNDLE_KIND_META.length === 8 && BUNDLE_KIND_META[0].dir === "01-内容产出");

/* ========================== 本地相关性排序 ========================== */

check("分词：英文按词", terms("VIP Customer").includes("vip") && terms("VIP Customer").includes("customer"));
check("分词：中文 2-gram", terms("价格表").includes("价格") && terms("价格表").includes("格表"));
check("停用词被过滤", !filteredTerms("我们的价格").includes("我们") && filteredTerms("我们的价格").includes("价格"));

const docs = [
  { id: 1, title: "客户报价单模板", content: "本模板用于给客户出具报价单，包含价格明细与折扣说明。" },
  { id: 2, title: "服务流程说明", content: "签约后启动，流程包含需求确认与方案评审。价格另议。" },
  { id: 3, title: "员工手册", content: "考勤、休假、报销等内部制度说明。" },
  { id: 4, title: "Price List", content: "Standard pricing for enterprise customers." },
];

const hits = rankDocs(docs, "报价单 价格");
check("命中排序：报价单模板第一", hits[0]?.id === 1, JSON.stringify(hits.map((h) => [h.id, h.score])));
check("有关键词返回多个候选", hits.length >= 2, `hits=${hits.length}`);
check("完全无关文档被过滤", !hits.some((hit) => hit.id === 3));
check("matched 解释命中词", (hits[0]?.matched ?? []).some((term) => term.includes("报价")), JSON.stringify(hits[0]?.matched));
check("分数降序", hits.every((hit, index) => index === 0 || hits[index - 1].score >= hit.score));

// IDF 验证：冷门词应比常见词更能拉开差距
const idfDocs = [
  { id: 1, title: "通用说明", content: "价格 价格 价格 价格 价格 价格" },
  { id: 2, title: "独家协议模板", content: "价格 说明" },
];
const idfHits = rankDocs(idfDocs, "独家协议");
check("冷门词命中排第一（IDF 生效）", idfHits[0]?.id === 2, JSON.stringify(idfHits));

check("空查询返回空", rankDocs(docs, "").length === 0);
check("全停用词查询返回空", rankDocs(docs, "我们的 是 了").length === 0);
check("空文档集返回空", rankDocs([], "价格").length === 0);
check("limit 生效", rankDocs([...docs, ...docs.map((d) => ({ ...d, id: d.id + 10 }))], "价格", 2).length === 2);
check("英文查询命中英文档", rankDocs(docs, "pricing").some((hit) => hit.id === 4));
check("分数在 0~1 之间", hits.every((hit) => hit.score > 0 && hit.score <= 1), hits.map((h) => h.score).join(","));

console.log(`\n${failed === 0 ? "全部通过" : `${failed} 项失败`}`);
if (failed > 0) process.exit(1);
