import { cloud } from "./client";
import {
  describeChannelError,
  isThrottleError,
  loadChannel,
  loadCustomProvider,
  streamCustom,
  type ChannelKind,
} from "./provider";
import { resolveStepPrompt, resolveStepTemplate } from "./agent-routing";
import type { AgentRow, AgentTemplate, KnowledgeSnippet } from "./api";
import {
  insertTask,
  insertTaskStep,
  loadKnowledgeContext,
  updateTask,
  updateTaskStep,
} from "./api";

export interface RunnerStep {
  agent: string;
  action: string;
  output?: string;
  status: "pending" | "running" | "done" | "error";
}

export interface RunProgress {
  title: string;
  domain: string;
  progress: number;
  steps: RunnerStep[];
}

export interface RunResult {
  taskId: number;
  title: string;
  domain: string;
  status: "done" | "partial" | "failed";
  steps: RunnerStep[];
  summary: string;
  tokens: number;
}

const DEFAULT_STEPS: { agent: string; action: string }[] = [
  { agent: "策划智能体", action: "理解目标并拆解业务任务" },
  { agent: "内容智能体", action: "结合企业知识生成可交付内容" },
  { agent: "增长智能体", action: "设计获客动作与线索筛选规则" },
  { agent: "销售智能体", action: "制定客户分层与跟进策略" },
  { agent: "分析智能体", action: "汇总结果并给出下一步建议" },
];

/** 平台通道优先选这几个能干活的文本模型，避免被路由到图像 / 视频模型上。 */
const PREFERRED_PLATFORM_MODELS = ["deepseek-v4-flash", "glm-5.3-flash", "hy3", "hunyuan-chat", "minimax-m2.5"];
const NON_TEXT_MODEL = /image|video|tts|embed|rerank|moderation/i;

async function pickModel(): Promise<{ id: string; name: string; channel: ChannelKind }> {
  // 自定义通道优先：用户自带 Key 时完全绕开平台配额。
  if (loadChannel() === "custom") {
    const provider = loadCustomProvider();
    if (provider) return { id: provider.model, name: provider.model, channel: "custom" };
  }

  try {
    const models = await cloud.llm.models.list();
    const usable = (models ?? []).filter((item) => item.disabled !== true && !NON_TEXT_MODEL.test(item.id));
    const chosen = usable.find((item) => PREFERRED_PLATFORM_MODELS.includes(item.id)) ?? usable[0];
    if (!chosen) throw new Error("当前应用暂无可用模型");
    return { id: chosen.id, name: chosen.name ?? chosen.id, channel: "platform" };
  } catch (error) {
    const provider = loadCustomProvider();
    if (provider) return { id: provider.model, name: provider.model, channel: "custom" };
    if (isThrottleError(error)) {
      throw new Error("平台模型配额已用尽：请在「模型接入」登录账号，或填入自己的模型 Key 后重试。");
    }
    throw error;
  }
}

const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

/** 限流 / 网关抖动等临时性错误，值得重试。 */
function isRetryable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /限流|rate.?limit|429|502|503|504|超时|timeout|network|fetch failed|failed to fetch|econn/i.test(message);
}

const RETRY_DELAYS = [2000, 6000, 15000];

async function collect(
  messages: { role: string; content: string }[],
  modelId: string,
  options: { json?: boolean; signal?: AbortSignal } = {},
): Promise<{ text: string; tokens: number }> {
  if (loadChannel() === "custom" && loadCustomProvider()) {
    return streamCustom(messages as never, {
      json: options.json,
      signal: options.signal,
      maxTokens: options.json ? 1400 : 3000,
    });
  }

  let text = "";
  let tokens = 0;

  const request: Record<string, unknown> = {
    model: modelId,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (options.json) request.response_format = { type: "json_object" };
  if (options.signal) request.signal = options.signal;

  for await (const chunk of cloud.llm.chat.completions.create(request as never)) {
    const delta = chunk.choices?.[0]?.delta;
    if (delta?.content) text += delta.content;
    if (chunk.usage?.total_tokens) tokens = chunk.usage.total_tokens;
  }

  return { text: text.trim(), tokens };
}

/** 带退避重试的调用：限流 / 502 / 网络抖动自动重试，最多 4 次尝试。 */
async function collectWithRetry(
  messages: { role: string; content: string }[],
  modelId: string,
  options: { json?: boolean; signal?: AbortSignal } = {},
): Promise<{ text: string; tokens: number }> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt += 1) {
    if (attempt > 0) {
      if (options.signal?.aborted) break;
      await sleep(RETRY_DELAYS[attempt - 1]);
    }
    try {
      return await collect(messages, modelId, options);
    } catch (error) {
      lastError = error;
      if (options.signal?.aborted) break;
      // 配额用尽（429）重试无意义，立即收敛，避免用户长时间等待。
      if (isThrottleError(error)) break;
      if (!isRetryable(error)) break;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * 给新模块（GEO 工作台、聚合发布等）复用的单轮 LLM 调用：
 * 与任务执行走同一套模型选择与退避重试，配额/通道行为完全一致。
 */
export async function askLLM(
  messages: { role: string; content: string }[],
  options: { json?: boolean; signal?: AbortSignal } = {},
): Promise<{ text: string; tokens: number }> {
  const model = await pickModel();
  return collectWithRetry(messages, model.id, options);
}

const fallbackPlan = { title: "业务增长作战任务", domain: "综合业务", steps: DEFAULT_STEPS };

function parsePlan(raw: string): { title: string; domain: string; steps: { agent: string; action: string }[] } {
  const fallback = fallbackPlan;
  if (!raw) return fallback;
  try {
    const jsonStart = raw.indexOf("{");
    const jsonEnd = raw.lastIndexOf("}");
    if (jsonStart === -1 || jsonEnd === -1) return fallback;
    const parsed = JSON.parse(raw.slice(jsonStart, jsonEnd + 1)) as {
      title?: string;
      domain?: string;
      steps?: { agent?: string; action?: string }[];
    };
    const steps = (parsed.steps ?? [])
      .filter((step) => step && step.agent && step.action)
      .slice(0, 6)
      .map((step) => ({ agent: String(step.agent), action: String(step.action) }));
    return {
      title: parsed.title?.trim() || fallback.title,
      domain: parsed.domain?.trim() || fallback.domain,
      steps: steps.length ? steps : fallback.steps,
    };
  } catch {
    return fallback;
  }
}

/**
 * 给规划器的岗位简报。
 * 这里只放「怎么排步骤」需要的信息——完整岗位提示词（几百字）留给执行阶段，
 * 否则规划请求会被还没用上的细节淹没，步骤反而更泛。
 *
 * 同时给出全部可调用岗位：规划器挑出来的 step.agent 会直接命中执行阶段的岗位路由，
 * 这样「策划用策划的标准、审核用审核的标准」，而不是全篇套一个岗位。
 */
function buildTemplateBrief(template: AgentTemplate | null, templates?: AgentTemplate[]): string {
  const roster = (templates ?? []).length
    ? [
        "可调用岗位清单（步骤的 agent 请直接使用这里的岗位名）：",
        ...(templates ?? []).map((item) => `- ${item.name}（${item.domain}）：${item.summary}`),
      ].join("\n")
    : "";

  if (!template) {
    return roster || "未指定行业模板，请按通用企业增长流程拆解。";
  }

  return [
    `主责岗位：${template.name}（${template.domain}）`,
    `职责：${template.summary}`,
    `标准流程：${template.workflow.join(" → ")}`,
    `必须产出：${template.outputs.join("、")}`,
    `审批要求：${template.approvals.length ? template.approvals.join("；") : "无"}`,
    roster,
  ]
    .filter(Boolean)
    .join("\n");
}

export async function runAgentTask(options: {
  goal: string;
  template: AgentTemplate | null;
  /** 全部官方模板：用于把每个步骤路由到对应岗位的提示词。 */
  templates?: AgentTemplate[];
  /** 用户已启用的智能体：带自定义人设时优先使用用户版本。 */
  agents?: AgentRow[];
  ownerName?: string | null;
  /** 显式传入企业资料；不传则按目标自动检索知识库。 */
  knowledge?: KnowledgeSnippet[];
  onProgress?: (progress: RunProgress) => void;
  signal?: AbortSignal;
}): Promise<RunResult> {
  const { goal, template, onProgress, signal } = options;
  const model = await pickModel();
  const brief = buildTemplateBrief(template, options.templates);
  const knowledge = options.knowledge ?? (await loadKnowledgeContext(goal));
  const knowledgeBlock = knowledge.length
    ? knowledge.map((doc, index) => `【资料${index + 1}｜${doc.title}（${doc.docType}）】\n${doc.content}`).join("\n\n")
    : "";
  const knowledgeIndex = knowledge.length ? knowledge.map((doc) => `- ${doc.title}（${doc.docType}）`).join("\n") : "";

  // 规划失败（限流 / 网关抖动）时降级为默认步骤，保证任务仍可执行。
  let plan = { ...fallbackPlan };
  try {
    plan = parsePlan(
      (
        await collectWithRetry(
          [
            {
              role: "system",
              content: [
                "你是企业 AI 总控的任务规划器。老板只给一句话目标，你要把它拆成一份能直接开工的作战计划。",
                "",
                "规划纪律：",
                "1. 步骤 3 到 5 个，必须贴合下面给出的岗位标准流程，不要套用「调研—分析—执行—复盘」这种通用骨架。",
                "2. 每步的 action 写成「动词 + 对象 + 交付物」，例如「拆解 3 类客群并输出对应卖点卡」；禁止「分析市场」「优化方案」这类看不出产出物的写法。",
                "3. 步骤之间要有依赖：后一步能直接拿前一步的产出继续干。",
                "4. 最后一步必须是可验证的收口动作（审核清单、排期表、复盘结论），不能是「总结一下」。",
                "5. 企业资料里已有的价格、政策、案例，步骤要明确「引用资料」而不是重新编造。",
                "",
                "只输出 JSON，不要解释：",
                '{"title":"不超过20字，一眼看出这次做了什么","domain":"所属业务域","steps":[{"agent":"岗位名称","action":"具体动作与交付物"}]}',
              ].join("\n"),
            },
            {
              role: "user",
              content: `企业目标：${goal}\n\n企业已有资料（规划时要贴合这些真实业务，不要把步骤写成通用模板）：\n${knowledgeIndex || "（暂无企业资料）"}\n\n可用岗位与流程参考：\n${brief}`,
            },
          ],
          model.id,
          { json: true, signal },
        )
      ).text,
    );
  } catch {
    if (signal?.aborted) throw new Error("任务已取消");
    // 规划失败降级：标题直接取用户目标，避免所有降级任务都叫同一个名字、分不清谁是谁。
    plan = { ...fallbackPlan, title: goal.trim().slice(0, 24) || fallbackPlan.title };
  }

  const steps: RunnerStep[] = plan.steps.map((step) => ({ ...step, status: "pending" }));

  const task = await insertTask({
    title: plan.title,
    goal,
    domain: plan.domain,
    templateCode: template?.code ?? "generic",
    ownerName: options.ownerName,
  });

  const stepRows: { id: number; seq: number }[] = [];
  for (let index = 0; index < steps.length; index += 1) {
    const row = await insertTaskStep({
      taskId: task.id,
      seq: index + 1,
      agentName: steps[index].agent,
      action: steps[index].action,
      status: "pending",
    });
    stepRows.push({ id: row.id, seq: index + 1 });
  }

  onProgress?.({ title: plan.title, domain: plan.domain, progress: 0, steps: [...steps] });

  let tokens = 0;
  const outputs: string[] = [];
  let failedSteps = 0;
  /** 最近一次失败的真实原因：必须落库，用户才知道该修什么。 */
  let lastFailure = "";

  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    // 按岗位路由提示词：内容策划、视觉设计、数据分析各自用各自的专业标准。
    const stepTemplate = resolveStepTemplate(step, options.templates, template);
    step.status = "running";
    onProgress?.({
      title: plan.title,
      domain: plan.domain,
      progress: Math.round((index / steps.length) * 100),
      steps: steps.map((item) => ({ ...item })),
    });

    const context = outputs.length
      ? outputs.map((text, order) => `第 ${order + 1} 步产出：${text}`).join("\n")
      : "暂无前置产出，请独立完成该步骤。";

    try {
      const { text, tokens: used } = await collectWithRetry(
        [
          {
            role: "system",
            content: [
              resolveStepPrompt(stepTemplate, options.agents) ??
                [
                  "你是企业里能独当一面的 AI 员工，独立完成这一步并交付可用的成果。",
                  "输出结构固定：①开头一句话给出本步核心结论；②交付物主体（表格用 Markdown 表格、方案写成稿、清单按条给全）；③末尾单列「待补充」清单。",
                  "务实、可直接使用，不空话，不编造企业资料里没有的数据。",
                ].join("\n"),
              "",
              "【交付纪律】",
              "1. 直接给成稿，不要解释你打算怎么写，不要复述任务，不要写「好的，我来帮你…」。",
              "2. 信息不足不要编：在成稿末尾单列「待补充：…」，写清缺什么、会影响哪部分。",
              "3. 不出现「赋能、闭环、抓手、生态、全面提升、助力」这类无法验证的词；每个结论都要有依据。",
              "4. 长度按交付物类型定：文案/方案 600-1200 字；话术、清单按条给全；分析类先给结论再给论据。",
              "5. 只做你这一步该做的事，不要重复前面步骤已经完成的产出，保持口径一致。",
              "6. 引用企业资料里的价格、政策、案例时，在对应位置标注（依据：资料标题），方便老板核对；资料之间冲突时以更新时间更近的为准并注明。",
              "7. 输出前按本岗位【输出规格】逐项自检，缺项补齐再交；表格用 Markdown 表格呈现，不要用纯文字堆列名。",
            ].join("\n"),
          },
          {
            role: "user",
            content: [
              `企业总目标：${goal}`,
              `你当前负责的环节：${step.agent} —— ${step.action}`,
              `企业资料（价格、政策、案例、卖点必须以这里为准；资料没有的不要编）：\n${knowledgeBlock || "（本次未检索到相关企业资料，按行业通识完成，并在末尾列出需要企业补充的信息清单）"}`,
              `前面步骤的产出：\n${context}`,
            ].join("\n\n"),
          },
        ],
        model.id,
        { signal },
      );

      tokens += used;
      step.output = text || "（本次未产出内容）";
      step.status = "done";
      outputs.push(step.output);
    } catch (error) {
      if (options.signal?.aborted) throw error instanceof Error ? error : new Error(String(error));
      // 单步重试后仍失败：标记该步骤失败并继续后续步骤，不中断整个任务。
      failedSteps += 1;
      step.status = "error";
      const reason = describeChannelError(error);
      lastFailure = reason;
      step.output = isThrottleError(error)
        ? `${reason}（该步骤已跳过）`
        : `${reason}（该步骤已跳过，不影响其余步骤）`;
    }

    if (stepRows[index]) {
      await updateTaskStep(stepRows[index].id, { status: step.status, output: step.output, tokens });
    }
  }

  let summary = "";
  if (outputs.length) {
    const summaryResult = await collectWithRetry(
      [
        {
          role: "system",
          content: [
            "你是企业 AI 总控。综合各步骤产出，写一段 150 字以内的交付结论，必须包含三部分：",
            "① 交付了什么——列出具体产出物名称，不要只说「完成了方案」；",
            "② 最关键的一到两条判断——有什么风险、什么必须老板拍板；",
            "③ 下一步做什么——谁、做什么、什么时候。",
            "不要复述过程，不要空话，不要重复各步骤原文。",
          ].join("\n"),
        },
        {
          role: "user",
          content: `企业目标：${goal}\n\n各岗位产出：\n${outputs.map((text, order) => `${order + 1}. ${text}`).join("\n")}`,
        },
      ],
      model.id,
      { signal },
    ).catch(() => ({ text: "", tokens: 0 }));
    tokens += summaryResult.tokens;
    summary = summaryResult.text;
  }

  if (!summary) {
    if (failedSteps === steps.length) {
      summary = `本次所有步骤均未产出：${lastFailure || "模型通道不可用"}。修复通道后可在任务中心一键重跑。`;
    } else if (failedSteps) {
      summary = `部分步骤未能完成：${lastFailure || "模型通道受限"}。其余产出已交付，可在任务中心重跑失败步骤。`;
    } else {
      summary = "任务已完成，请查看各岗位产出。";
    }
  }

  const status = failedSteps === 0 ? "done" : failedSteps === steps.length ? "failed" : "partial";
  // 失败原因写入 error 字段：任务中心与详情可以直接看到为什么失败。
  const errorReason = failedSteps === 0
    ? null
    : failedSteps === steps.length
      ? `全部 ${steps.length} 个步骤失败：${lastFailure || "模型通道不可用"}`
      : `${failedSteps}/${steps.length} 个步骤失败：${lastFailure || "模型通道受限"}，其余产出已交付。`;

  await updateTaskState(task.id, {
    status,
    progress: 100,
    result: { summary, steps: steps.map((item) => ({ ...item })), tokens },
    tokens,
    error: errorReason,
  });

  onProgress?.({ title: plan.title, domain: plan.domain, progress: 100, steps: steps.map((item) => ({ ...item })) });

  return { taskId: task.id, title: plan.title, domain: plan.domain, status, steps, summary, tokens };
}

async function updateTaskState(
  taskId: number,
  patch: {
    status: string;
    progress: number;
    result?: Record<string, unknown>;
    error?: string | null;
    steps?: RunnerStep[];
    tokens?: number;
  },
) {
  const result = patch.result ?? {};
  await updateTask(taskId, {
    status: patch.status,
    progress: patch.progress,
    // tokens 不是独立列，跟其余结果一起存进 result，任务详情据此展示消耗。
    result: patch.tokens != null ? { ...result, tokens: patch.tokens } : result,
    error: patch.error ?? null,
    finished_at: new Date().toISOString(),
  });
}
