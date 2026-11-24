/**
 * 把 demo_tasks 里的历史任务迁移到正式任务表 tasks / task_steps。
 * 一次性脚本，可重复执行（已迁移的标题+创建时间会跳过）。
 * 用法：node scripts/migrate-demo-tasks.mjs
 */
import { createWorkBuddyCloud } from "@tencent-ai/workbuddy-cloud-sdk";

const cloud = createWorkBuddyCloud({
  endpoint: "https://super-agent-os.app.workbuddy.host",
  oauthRelayBaseUrl: "https://www.workbuddy.cn/v2/as/genie-baas/oauth",
  publishableKey: "wbpk_r1hMK5Enk0XVGpjJvncolP_XMyHEqD8JajXB1kUh62aV7E8rGgptkwU",
});

const { data: demos, error: demoError } = await cloud.database.from("demo_tasks").select("*").order("id");
if (demoError) {
  console.error("读取 demo_tasks 失败：", demoError.message);
  process.exit(1);
}

const { data: existing } = await cloud.database.from("tasks").select("id,title,created_at");
const seen = new Set((existing ?? []).map((row) => `${row.title}@${row.created_at}`));

let migrated = 0;
let skipped = 0;

for (const demo of demos ?? []) {
  const key = `${demo.title}@${demo.created_at}`;
  if (seen.has(key)) {
    skipped += 1;
    continue;
  }

  const { data: inserted, error } = await cloud.database
    .from("tasks")
    .insert([
      {
        title: demo.title,
        goal: demo.goal,
        domain: demo.domain,
        template_code: demo.template_code,
        status: demo.status,
        progress: demo.progress,
        result: demo.result ?? {},
        error: demo.error ?? null,
        owner_name: "我的工作区",
      },
    ])
    .select();

  if (error) {
    console.error(`迁移「${demo.title}」失败：`, error.message);
    continue;
  }

  const taskId = inserted?.[0]?.id;
  const steps = Array.isArray(demo.steps) ? demo.steps : [];
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    const { error: stepError } = await cloud.database.from("task_steps").insert([
      {
        task_id: taskId,
        seq: index + 1,
        agent_name: step.agent ?? "AI 员工",
        action: step.action ?? "",
        output: step.output ?? null,
        status: step.status ?? "done",
      },
    ]);
    if (stepError) console.error(`  步骤 ${index + 1} 写入失败：`, stepError.message);
  }

  migrated += 1;
  console.log(`已迁移 #${demo.id} → tasks#${taskId}  ${demo.title}（${steps.length} 步）`);
}

console.log(`\n完成：迁移 ${migrated} 条，跳过 ${skipped} 条（已存在）`);
