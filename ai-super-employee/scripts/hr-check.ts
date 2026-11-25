/**
 * AI 人事自检：岗位校验、简历启发式（年限/技能/姓名）、匹配分夹紧、面试题降级、面试记录校验、导出。
 * 只测纯函数与降级路径，不真调 LLM（LLM 成功路径需真实通道，见接入清单）。
 * 运行：npm run test:hr
 */
import {
  HR_NOTE,
  computeMatchScore,
  createJob,
  exportHrMarkdown,
  extractName,
  extractSkills,
  extractYears,
  heuristicParseResume,
  loadInterviews,
  loadJobs,
  loadResumeRecords,
  normalizeInterview,
  normalizeJob,
  normalizeResumeParse,
  parseResume,
  saveInterviews,
  saveJobs,
  saveResumeRecord,
  templateInterviewQuestions,
  toResumeRecord,
  validateInterview,
  validateJob,
  type JobPosting,
} from "../src/cloud/hr";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failed += 1;
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` ｜ ${detail}` : ""}`);
};

const memory = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => void memory.set(key, String(value)),
  removeItem: (key: string) => void memory.delete(key),
};

const job: JobPosting = {
  id: "job-1",
  title: "新媒体运营",
  dept: "市场部",
  requirements: ["熟悉抖音和小红书运营", "会文案和剪辑", "2年以上经验"],
  responsibilities: ["负责账号内容规划"],
  status: "招聘中",
};

const resumeText = [
  "李小明",
  "5年新媒体运营经验，熟悉抖音、小红书平台规则。",
  "主导过品牌账号从 0 到 10 万粉丝增长，负责文案策划与剪辑排期。",
  "熟练使用 Excel 做数据分析，英语可读写。",
  "在上一家公司负责社群运营，提升复购率 20%。",
].join("\n");

// 1. 岗位校验与归一化
check("岗位校验通过", validateJob(job, []).ok);
check("岗位空标题拦截", !validateJob({ ...job, title: "" }, []).ok);
check("岗位非法状态拦截", !validateJob({ ...job, status: "招满了" as never }, []).ok);
check("岗位归一化非法状态回退", normalizeJob({ ...job, status: "x" as never })?.status === "招聘中");
check("岗位归一化缺标题返回 null", normalizeJob({ id: "a", title: "" }) === null);
const manyJobs = Array.from({ length: 30 }, (_, i) => ({ ...job, id: `job-${i}` }));
check("岗位满员拦截新增", !validateJob({ ...createJob("新岗位") }, manyJobs).ok);
check("岗位满员放行编辑已有", validateJob(manyJobs[0], manyJobs).ok);

// 2. 简历启发式抽取
check("年限抽取最大值", extractYears(resumeText) === 5, `years=${extractYears(resumeText)}`);
check("年限无命中为 0", extractYears("刚毕业，没有经验描述。") === 0);
check("技能词典命中", extractSkills(resumeText).includes("抖音") && extractSkills(resumeText).includes("小红书"), JSON.stringify(extractSkills(resumeText)));
check("技能英文大小写不敏感", extractSkills("熟悉 react 和 PYTHON").includes("React") && extractSkills("熟悉 react 和 PYTHON").includes("Python"));
check("姓名首行抽取", extractName(resumeText) === "李小明");
check("姓名标签抽取", extractName("姓名：王小红\n3年销售经验") === "王小红");
check("姓名猜不到标未识别", extractName("123456789\n没有姓名行") === "未识别");

// 3. 匹配分
const matched = computeMatchScore(["抖音", "小红书", "文案", "剪辑", "运营", "新媒体"], 5, job, 500);
check("匹配分高重合较高", matched.score >= 80, `score=${matched.score}`);
check("匹配分含依据说明", matched.reason.includes("命中") && matched.reason.length > 10);
const noMatch = computeMatchScore(["Java"], 0, job, 100);
check("匹配分低重合较低", noMatch.score < matched.score, `score=${noMatch.score}`);
check("匹配分夹紧 0-100", computeMatchScore([], 0, null, 0).score >= 0 && computeMatchScore(SKILLS_MANY(), 50, null, 9999).score <= 100);
function SKILLS_MANY() {
  return ["抖音", "小红书", "文案", "剪辑", "运营", "Excel", "英语", "数据分析", "社群", "CRM", "直播", "电商", "设计", "销售", "客服"];
}

// 4. 启发式解析
const parsed = heuristicParseResume(resumeText, job);
check("启发式标注 demo", parsed.demo === true);
check("启发式姓名年限正确", parsed.name === "李小明" && parsed.years === 5);
check("启发式亮点非空", parsed.highlights.length >= 1);
const thin = heuristicParseResume("张三\n想找工作。", null);
check("简历过短给风险提示", thin.risks.some((item) => item.includes("较短") || item.includes("年限")), JSON.stringify(thin.risks));

let threw = false;
try {
  heuristicParseResume("   ");
} catch {
  threw = true;
}
check("简历空文本抛错", threw);

let parseThrew = false;
try {
  await parseResume({ resumeText: "" });
} catch {
  parseThrew = true;
}
check("parseResume 空文本抛错", parseThrew);

// 5. 归一化夹紧
const normalized = normalizeResumeParse({ name: "测试", years: 999, skills: ["a", "a", ""], matchScore: 150, summary: "s" });
check("归一化年限夹紧 50", normalized.years === 50);
check("归一化分数夹紧 100", normalized.matchScore === 100);
check("归一化技能去重去空", normalized.skills.length === 1);
check("归一化空输入不抛错", normalizeResumeParse(null).name === "未识别" && normalizeResumeParse(undefined).matchScore === 50);

// 6. 面试题降级
const questions = templateInterviewQuestions("新媒体运营", job.requirements);
check("模板题 8 题", questions.length === 8, `n=${questions.length}`);
check("模板题优先岗位相关", questions[0].includes("账号") || questions[0].includes("活动"), questions[0]);
check("模板题含三类标注", questions.some((q) => q.includes("经历深挖")) && questions.some((q) => q.includes("风险验证")));

// 7. 面试记录校验与留档
check("面试校验通过", validateInterview({ candidate: "李小明", score: 85, verdict: "通过" }, []).ok);
check("面试空候选人拦截", !validateInterview({ candidate: "", score: 85, verdict: "通过" }, []).ok);
check("面试非法结论拦截", !validateInterview({ candidate: "李小明", score: 85, verdict: "再看看" as never }, []).ok);
check("面试分数越界拦截", !validateInterview({ candidate: "李小明", score: 120, verdict: "通过" }, []).ok);
check("面试归一化缺候选人返回 null", normalizeInterview({ candidate: "" }) === null);

const record = normalizeInterview({ candidate: "李小明", jobTitle: "新媒体运营", score: 85, notes: "数据口径需复核", verdict: "待定", at: 1700000000000 })!;
saveInterviews([record]);
check("面试留档可读", loadInterviews().length === 1 && loadInterviews()[0].candidate === "李小明");

// 8. 岗位/简历摘要留档不存全文
saveJobs([job]);
check("岗位留档可读", loadJobs().length === 1 && loadJobs()[0].title === "新媒体运营");
const resumeRecord = toResumeRecord(parsed, "新媒体运营", 1700000000000);
check("简历留档不含全文", !JSON.stringify(resumeRecord).includes("10 万粉丝") && !("resumeText" in resumeRecord));
saveResumeRecord(resumeRecord);
check("简历摘要留档可读", loadResumeRecords().length === 1 && loadResumeRecords()[0].name === "李小明");

// 9. 导出
const md = exportHrMarkdown({ jobs: [job], resumes: [resumeRecord], interviews: [record], lastParse: parsed });
check("导出含岗位", md.includes("新媒体运营") && md.includes("招聘中"));
check("导出含面试表", md.includes("| 候选人 | 岗位 | 评分 | 结论 | 备注 |") && md.includes("李小明"));
check("导出含后置说明", md.includes(HR_NOTE) && md.includes("招聘平台直连后置"));
check("导出标注演示解析", md.includes("演示解析"));

console.log(`\n${failed === 0 ? "全部通过" : `${failed} 项失败`}`);
process.exit(failed === 0 ? 0 : 1);
