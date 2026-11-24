/**
 * 指令队列（本地持久化）。
 *
 * 职责边界：网关只负责「收指令、排队列、回状态」，**不执行任务**——
 * 执行必须在控制台登录态下进行（任务、线索都要归属到账号），这是多租户隔离的硬约束。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MAX_COMMANDS = 500;

function readJson(file, fallback) {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

export function createCommandStore(dataDir) {
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, "commands.json");

  let state = readJson(file, { nextId: 1, commands: [] });
  if (!Array.isArray(state.commands)) state = { nextId: 1, commands: [] };

  const save = () => {
    if (state.commands.length > MAX_COMMANDS) {
      // 只保留最近的记录：已处理的先淘汰，pending 尽量留住
      const overflow = state.commands.length - MAX_COMMANDS;
      const removable = state.commands.filter((item) => item.status !== "pending");
      const drop = new Set(removable.slice(0, overflow).map((item) => item.id));
      state.commands = state.commands.filter((item) => !drop.has(item.id));
    }
    writeFileSync(file, JSON.stringify(state, null, 1), "utf8");
  };

  /**
   * 入队一条指令。eventId 用于幂等（飞书事件重推、HTTP 重试都不会重复）。
   */
  function enqueue({ text, source = "http", from = "", eventId = "" }) {
    const content = String(text ?? "").trim().slice(0, 500);
    if (!content) return { command: null, created: false };

    if (eventId) {
      const existing = state.commands.find((item) => item.eventId === eventId);
      if (existing) return { command: existing, created: false };
    }

    const now = new Date().toISOString();
    const command = {
      id: state.nextId++,
      text: content,
      source,
      from: String(from).slice(0, 80),
      eventId: String(eventId).slice(0, 120),
      status: "pending",
      createdAt: now,
      updatedAt: now,
    };
    state.commands.push(command);
    save();
    return { command, created: true };
  }

  /** 增量拉取：seq 为客户端已见的最大 id。 */
  function listSince(seq = 0, status = "") {
    const commands = state.commands.filter(
      (item) => item.id > Number(seq || 0) && (!status || item.status === status),
    );
    return {
      commands,
      nextSeq: state.commands.reduce((max, item) => Math.max(max, item.id), 0),
    };
  }

  function setStatus(id, status) {
    if (!["pending", "done", "dismissed"].includes(status)) return null;
    const command = state.commands.find((item) => item.id === Number(id));
    if (!command) return null;
    command.status = status;
    command.updatedAt = new Date().toISOString();
    save();
    return command;
  }

  function get(id) {
    return state.commands.find((item) => item.id === Number(id)) ?? null;
  }

  return { enqueue, listSince, setStatus, get };
}

/**
 * 从飞书事件 JSON 里取出指令文本。
 * 只处理文本消息；富媒体/卡片消息记录为占位说明，不猜测内容。
 */
export function extractFeishuText(payload) {
  const message = payload?.event?.message ?? payload?.message;
  if (!message) return { text: "", from: "", eventId: "" };

  const eventId =
    payload?.header?.event_id ?? payload?.event_id ?? message.message_id ?? "";

  const sender =
    payload?.event?.sender?.sender_id?.open_id ??
    payload?.sender?.sender_id?.open_id ??
    payload?.event?.sender?.sender_id?.union_id ??
    "";

  if (message.message_type !== "text") {
    return { text: `[${message.message_type ?? "非文本"}消息暂不支持，请发送文字指令]`, from: sender, eventId };
  }

  let content = "";
  try {
    content = JSON.parse(message.content ?? "{}").text ?? "";
  } catch {
    content = "";
  }
  // 去掉 @机器人 的占位符（飞书文本里是 @_user_1 之类）
  const text = String(content)
    .replace(/@_user_\d+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return { text, from: sender, eventId };
}
