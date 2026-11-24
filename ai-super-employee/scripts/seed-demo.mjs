/**
 * 演示工作区数据治理：
 *  1. 删除 demo_tasks 中的失败/卡死记录（保留成功记录）
 *  2. 预置若干已完成的演示任务，让总控台首屏数据有可读性
 * 用法：node scripts/seed-demo.mjs
 */
import { createWorkBuddyCloud } from "@tencent-ai/workbuddy-cloud-sdk";

const cloud = createWorkBuddyCloud({
  endpoint: "https://super-agent-os.app.workbuddy.host",
  oauthRelayBaseUrl: "https://www.workbuddy.cn/v2/as/genie-baas/oauth",
  publishableKey: "wbpk_r1hMK5Enk0XVGpjJvncolP_XMyHEqD8JajXB1kUh62aV7E8rGgptkwU",
});

const daysAgo = (days) => new Date(Date.now() - days * 86400000).toISOString();

/* ------------------------- 1. 清理失败演示任务 ------------------------- */
const { data: stale, error: readError } = await cloud.database
  .from("demo_tasks")
  .select("id,title,status")
  .neq("status", "done");
if (readError) {
  console.error("读取失败任务出错：", readError.message);
  process.exit(1);
}
for (const row of stale ?? []) {
  const { error } = await cloud.database.from("demo_tasks").delete().eq("id", row.id);
  console.log(error ? `删除 #${row.id} 失败：${error.message}` : `已删除失败任务 #${row.id}「${row.title}」`);
}
if (!stale?.length) console.log("没有需要清理的失败任务。");

/* ------------------------- 2. 预置成功演示任务 ------------------------- */
const seeds = [
  {
    title: "连锁餐饮品牌 7 天新品营销计划",
    goal: "为一家连锁餐饮品牌制定 7 天新品营销计划，并完成内容、获客与复盘方案",
    domain: "本地生活",
    tokens: 5240,
    created_at: daysAgo(3),
    steps: [
      { agent: "策划智能体", action: "拆解新品上市目标并制定 7 天分阶段节奏", status: "done", output: "锁定 25-35 岁都市白领客群；D1-D2 悬念预热、D3-D4 到店转化、D5-D6 社交裂变、D7 复盘沉淀；核心 KPI：曝光 50w、核销 3000 单、新增会员 2000。" },
      { agent: "内容智能体", action: "产出多平台适配的内容素材与排期", status: "done", output: "交付 12 条内容：抖音短视频脚本 3 条（主打“第一口爆汁”卖点）、小红书笔记 4 篇、朋友圈海报 3 张、门店台卡文案 2 套，附完整发布排期表。" },
      { agent: "增长智能体", action: "设计获客链路与线索筛选规则", status: "done", output: "配置“关注领券 + 企微社群裂变”双链路；高意向判定规则：领取优惠券且 48h 内互动≥2 次；预计单客获客成本可控制在 8 元以内。" },
      { agent: "分析智能体", action: "汇总全链路数据并给出下周行动建议", status: "done", output: "建议下周将预算向小红书倾斜（互动率 6.2% 最高）；到店转化断点在“领券未核销”环节，建议增加 24h 到店提醒推送。" },
    ],
    summary: "已交付完整 7 天营销作战方案：内容矩阵 12 条、双链路获客方案与数据复盘建议，核心抓手为小红书种草 + 企微裂变，预计 7 天可达成 3000 单核销目标。",
  },
  {
    title: "沉睡客户分层激活与回访计划",
    goal: "分析沉睡客户的共同特征，设计一套分层激活与回访计划",
    domain: "私域运营",
    tokens: 4680,
    created_at: daysAgo(1),
    steps: [
      { agent: "策划智能体", action: "定义沉睡客户分层标准与激活目标", status: "done", output: "按最后消费时间分三层：30-60 天轻度沉睡（45%）、60-90 天中度（35%）、90 天以上重度（20%）；首期激活目标：轻度层回流率 25%。" },
      { agent: "销售智能体", action: "制定分层触达话术与回访 SOP", status: "done", output: "轻度层用“新品回归礼”模板（转化预期 18%）；中度层配专属客服 1v1 回访 + 限时券；重度层暂缓触达，避免打扰导致删除好友。" },
      { agent: "内容智能体", action: "产出激活所需的朋友圈与私信素材", status: "done", output: "交付朋友圈文案 5 条、私信模板 3 套、回归礼海报 2 张；全部素材已按分层打标，可直接由企微侧一键发送。" },
      { agent: "分析智能体", action: "设定效果衡量指标与复盘节点", status: "done", output: "核心指标：触达打开率、回流率、券核销率；建议 T+3 与 T+7 两次复盘，打开率低于 12% 时立即更换素材钩子。" },
    ],
    summary: "已交付三层沉睡客户激活方案：45% 轻度沉睡客户为首发激活对象，配齐话术、素材与回访 SOP，预期整体回流率 15% 以上。",
  },
  {
    title: "本周经营数据复盘与下周行动建议",
    goal: "汇总本周内容、线索和销售数据，找出转化断点并生成下周行动建议",
    domain: "经营分析",
    tokens: 3920,
    created_at: daysAgo(0),
    steps: [
      { agent: "策划智能体", action: "圈定复盘范围与数据口径", status: "done", output: "复盘窗口：周一至周日；口径统一为“有效线索 = 互动≥2 次且留资”；数据源：内容后台、企微侧边栏、成交记录。" },
      { agent: "分析智能体", action: "定位全链路转化断点", status: "done", output: "断点定位在“咨询到预约”：咨询 286 人，仅 41 人预约（14.3%），主因是晚间 20-22 点咨询高峰无人值守，流失 63 条高意向线索。" },
      { agent: "内容智能体", action: "输出下周内容优化方向", status: "done", output: "“案例对比”类内容互动率最高（7.8%），建议下周占比提升至 50%；停发纯促销类内容（互动率仅 1.9%）。" },
      { agent: "销售智能体", action: "给出私域承接与排班建议", status: "done", output: "建议晚间高峰启用智能客服首响 + 人工 10 分钟内接管；高意向线索 30 分钟内必须跟进，当前平均响应 3.2 小时需压缩。" },
    ],
    summary: "核心结论：最大转化断点在晚间咨询承接，启用智能客服值守 + 高意向 30 分钟跟进机制后，预计预约率可从 14.3% 提升至 22%。",
  },
];

for (const seed of seeds) {
  const row = {
    title: seed.title,
    goal: seed.goal,
    domain: seed.domain,
    template_code: "generic",
    status: "done",
    progress: 100,
    tokens: seed.tokens,
    created_at: seed.created_at,
    error: null,
    steps: seed.steps,
    result: { summary: seed.summary, steps: seed.steps, tokens: seed.tokens },
  };
  const { error } = await cloud.database.from("demo_tasks").insert([row]);
  console.log(error ? `预置「${seed.title}」失败：${error.message}` : `已预置演示任务「${seed.title}」（${seed.steps.length} 步）`);
}

const { count } = await cloud.database.from("demo_tasks").select("*", { count: "exact", head: true });
console.log(`\ndemo_tasks 当前总数：${count}`);
