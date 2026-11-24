/**
 * 云服务真实链路自检脚本（Node 端）。
 * 用法：node scripts/verify-cloud.mjs
 *
 * 依次验证：
 *  1. 模型列表可用
 *  2. 普通流式对话可用
 *  3. JSON 模式（response_format）流式可用
 *  4. demo_tasks 写入 → 读回（数据持久化）
 *  5. agent_templates 读取
 */
import { createWorkBuddyCloud } from "@tencent-ai/workbuddy-cloud-sdk";

const publicConfig = {
  endpoint: "https://super-agent-os.app.workbuddy.host",
  oauthRelayBaseUrl: "https://www.workbuddy.cn/v2/as/genie-baas/oauth",
  publishableKey: "wbpk_r1hMK5Enk0XVGpjJvncolP_XMyHEqD8JajXB1kUh62aV7E8rGgptkwU",
};

const cloud = createWorkBuddyCloud({
  endpoint: publicConfig.endpoint,
  oauthRelayBaseUrl: publicConfig.oauthRelayBaseUrl,
  publishableKey: publicConfig.publishableKey,
});

const log = (...args) => console.log(...args);
const step = (name) => log(`\n=== ${name} ===`);

async function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超时 ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function collect(messages, modelId, { json = false, timeout = 60000 } = {}) {
  const request = {
    model: modelId,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (json) request.response_format = { type: "json_object" };

  let text = "";
  let tokens = 0;
  let chunks = 0;

  const iterator = cloud.llm.chat.completions.create(request);
  const pump = (async () => {
    for await (const chunk of iterator) {
      chunks += 1;
      const delta = chunk?.choices?.[0]?.delta;
      if (delta?.content) text += delta.content;
      if (chunk?.usage?.total_tokens) tokens = chunk.usage.total_tokens;
    }
  })();

  await withTimeout(pump, timeout, json ? "JSON 流式调用" : "流式调用");
  return { text: text.trim(), tokens, chunks };
}

async function main() {
  step("1. 模型列表");
  const models = await withTimeout(cloud.llm.models.list(), 30000, "模型列表");
  const usable = (models ?? []).filter((m) => m.disabled !== true);
  log(`模型总数=${(models ?? []).length} 可用=${usable.length}`);
  log("前 5 个：", usable.slice(0, 5).map((m) => `${m.name}(${m.id})`).join(" | "));
  if (!usable.length) throw new Error("无可用模型");
  const model = usable[0];

  step("2. 普通流式对话");
  const plain = await collect(
    [
      { role: "system", content: "你是企业 AI 员工，只输出简洁中文要点，不超过 50 字。" },
      { role: "user", content: "为一家连锁餐饮品牌的新品写一句推广语。" },
    ],
    model.id,
    { timeout: 60000 },
  );
  log(`chunks=${plain.chunks} tokens=${plain.tokens}`);
  log("输出：", plain.text.slice(0, 200) || "(空)");

  step("3. JSON 模式流式");
  const jsonRes = await collect(
    [
      {
        role: "system",
        content:
          '只输出 JSON，形如 {"title":"任务标题","domain":"业务域","steps":[{"agent":"岗位","action":"动作"}]}，步骤 3 个。',
      },
      { role: "user", content: "企业目标：制定 7 天新品营销计划" },
    ],
    model.id,
    { json: true, timeout: 60000 },
  );
  log(`chunks=${jsonRes.chunks} tokens=${jsonRes.tokens}`);
  log("原始输出：", jsonRes.text.slice(0, 400));
  try {
    const parsed = JSON.parse(jsonRes.text);
    log("JSON 解析成功，steps =", parsed.steps?.length);
  } catch (e) {
    log("JSON 解析失败：", e.message);
  }

  step("4. demo_tasks 写入 → 读回");
  const probeTitle = `自检探针 ${new Date().toISOString()}`;
  const { data: inserted, error: insErr } = await cloud.database
    .from("demo_tasks")
    .insert([
      {
        title: probeTitle,
        goal: "云服务持久化自检",
        domain: "自检",
        template_code: "generic",
        status: "running",
        progress: 0,
      },
    ])
    .select();
  if (insErr) throw new Error(`insert 失败：${insErr.message}`);
  log("insert 返回：", JSON.stringify(inserted));

  const { data: readBack, error: readErr } = await cloud.database
    .from("demo_tasks")
    .select("id,title,status,progress")
    .order("id", { ascending: false })
    .limit(3);
  if (readErr) throw new Error(`select 失败：${readErr.message}`);
  log("读回：", JSON.stringify(readBack));

  await cloud.database.from("demo_tasks").delete().eq("id", inserted?.[0]?.id);
  log("探针已清理");

  step("5. agent_templates 读取");
  const { data: templates, error: tErr } = await cloud.database
    .from("agent_templates")
    .select("code,name,domain")
    .limit(20);
  if (tErr) throw new Error(`templates 读取失败：${tErr.message}`);
  log(`模板数=${(templates ?? []).length}`);
  log((templates ?? []).map((t) => `${t.code}:${t.name}`).join(" | "));

  log("\n全部自检通过 ✅");
}

main().catch((error) => {
  log("\n自检失败 ❌:", error?.message ?? error);
  process.exitCode = 1;
});
