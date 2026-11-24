import type { AgentRow, AgentTemplate } from "./api";

/**
 * 读取用户给某个智能体自定义的人设（存在 agents.config.prompt）。
 * 模板提示词是官方默认值，客户调整过的版本必须优先，否则客户的调教会全部失效。
 */
export function customPromptOf(agent: AgentRow | undefined): string | null {
  const raw = agent?.config?.prompt;
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

/** 找出某岗位模板对应的、有自定义人设的智能体。 */
export function findPersonaOwner(templateCode: string | undefined, agents: AgentRow[] | undefined): AgentRow | undefined {
  if (!templateCode || !agents?.length) return undefined;
  return agents.find((agent) => agent.template_code === templateCode && customPromptOf(agent));
}

/**
 * 决定某一步最终使用的提示词：
 * 用户自定义人设 > 岗位模板默认提示词 > 通用兜底。
 */
export function resolveStepPrompt(
  template: AgentTemplate | null,
  agents: AgentRow[] | undefined,
): string | null {
  const custom = customPromptOf(findPersonaOwner(template?.code, agents));
  if (custom) return custom;
  const fallback = template?.role_prompt?.trim();
  return fallback || null;
}

/**
 * 步骤 → 岗位提示词的匹配表。
 * 一个任务横跨多个岗位，如果所有步骤都用同一个岗位的提示词，
 * 「视觉设计」那一步就会拿内容策划的标准来写，产出必然不对路。
 * 这里按步骤名称里的关键词把每个步骤路由到最匹配的岗位。
 *
 * 顺序即优先级：越靠前越先匹配（合规、数据这类词出现在别的岗位名里时不会被误抢）。
 */
export const STEP_KEYWORDS: { code: string; words: string[] }[] = [
  { code: "risk-guard", words: ["合规", "审核", "风控", "质检", "校验", "红线"] },
  { code: "data-analyst", words: ["数据", "分析", "复盘", "指标", "漏斗", "归因", "诊断"] },
  { code: "visual-designer", words: ["视觉", "设计", "海报", "配图", "商品图", "图片", "画面"] },
  { code: "video-maker", words: ["视频", "分镜", "成片", "剪辑", "镜头"] },
  { code: "media-matrix", words: ["发布", "排期", "矩阵", "分发", "投放", "账号"] },
  { code: "lead-hunter", words: ["获客", "线索", "拓客", "渠道", "引流"] },
  { code: "private-sales", words: ["销售", "客服", "私域", "跟进", "咨询", "话术", "转化"] },
  { code: "knowledge-keeper", words: ["知识", "资料", "文档", "检索", "入库"] },
  { code: "office-copilot", words: ["纪要", "周报", "办公", "通知", "待办"] },
  { code: "ip-creator", words: ["人设", "自媒体", "涨粉", "账号定位"] },
  { code: "content-repurposer", words: ["复刻", "改写", "拆解", "二创"] },
  { code: "local-store", words: ["门店", "到店", "同城", "商圈"] },
  { code: "ecommerce-growth", words: ["电商", "详情页", "带货", "转化率"] },
  { code: "education-growth", words: ["招生", "课程", "学员", "报名"] },
  { code: "beauty-care", words: ["美业", "养护", "项目", "护理"] },
  { code: "home-sales", words: ["装修", "报价", "签单", "量房"] },
  { code: "voice-dubber", words: ["配音", "口播", "音色", "数字人", "声音"] },
  { code: "content-campaign", words: ["文案", "内容", "选题", "策划", "脚本", "标题"] },
];

export function resolveStepTemplate(
  step: { agent: string; action: string },
  templates: AgentTemplate[] | undefined,
  fallback: AgentTemplate | null,
): AgentTemplate | null {
  if (!templates?.length) return fallback;
  const text = `${step.agent} ${step.action}`;

  // 1. 步骤名里直接出现某个模板的名字（例如「内容战役官」），优先
  const byName = templates.find((item) => text.includes(item.name));
  if (byName) return byName;

  // 2. 按岗位关键词路由
  for (const rule of STEP_KEYWORDS) {
    if (!rule.words.some((word) => text.includes(word))) continue;
    const matched = templates.find((item) => item.code === rule.code);
    if (matched) return matched;
  }

  // 3. 兜底用主模板
  return fallback;
}
