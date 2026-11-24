/** 总控台模块与 URL hash 的映射，用于深链分享与刷新保持。 */
export const NAV_SLUGS: Record<string, string> = {
  "AI 总控": "overview",
  智能体团队: "agents",
  任务中心: "tasks",
  模板中心: "templates",
  内容工厂: "content",
  线索与客户: "leads",
  企业知识库: "knowledge",
  企微私域: "wecom",
  数据洞察: "insights",
  "AI 创作": "studio",
  模型接入: "channels",
};

export const SLUG_NAV: Record<string, string> = Object.fromEntries(
  Object.entries(NAV_SLUGS).map(([label, slug]) => [slug, label]),
);

export function navToSlug(label: string): string {
  return NAV_SLUGS[label] ?? "overview";
}

export function slugToNav(slug: string): string {
  return SLUG_NAV[slug] ?? "AI 总控";
}
