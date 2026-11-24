/**
 * 名单与意向事件（竞品差距 11.2#8 余项：白/黑名单、意向用户提醒）。
 *
 * - 名单：data/lists.json，群发与自动回复共用——
 *   黑名单：群发跳过、客服不自动回复（消息仍记录）；
 *   白名单：非空时群发只发名单内客户（回复不受白名单限制）。
 * - 意向事件：data/intents.json，客户阶段跃迁进高意向档时落一条
 *   （与群机器人 webhook 同触发条件，本地始终留档，webhook 可选）。
 * 合规边界：只作用于已同步 external_userid 的自有客户。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const INTENT_CAP = 50;

function readJson(file, fallback) {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function normalizeEntry(raw) {
  const source = raw ?? {};
  return {
    id: String(source.id ?? source.external_userid ?? "").trim(),
    name: String(source.name ?? "").slice(0, 40),
    note: String(source.note ?? "").slice(0, 120),
    addedAt: new Date().toISOString(),
  };
}

export function createListStore(dataDir) {
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, "lists.json");
  let state = { blacklist: [], whitelist: [] };
  const loaded = readJson(file, null);
  if (loaded && Array.isArray(loaded.blacklist) && Array.isArray(loaded.whitelist)) {
    state = { blacklist: loaded.blacklist, whitelist: loaded.whitelist };
  }
  const save = () => writeFileSync(file, JSON.stringify(state), "utf8");

  function add(kind, entries) {
    if (kind !== "blacklist" && kind !== "whitelist") throw new Error("kind 必须是 blacklist 或 whitelist");
    if (!Array.isArray(entries)) throw new Error("entries 必须是数组");
    let added = 0;
    for (const raw of entries) {
      const entry = normalizeEntry(raw);
      if (!entry.id) continue;
      const list = state[kind];
      const existing = list.find((item) => item.id === entry.id);
      if (existing) {
        existing.name = entry.name || existing.name;
        existing.note = entry.note || existing.note;
        continue;
      }
      list.push(entry);
      added += 1;
    }
    save();
    return { added };
  }

  function remove(kind, ids) {
    if (kind !== "blacklist" && kind !== "whitelist") throw new Error("kind 必须是 blacklist 或 whitelist");
    const idSet = new Set((Array.isArray(ids) ? ids : []).map((id) => String(id).trim()).filter(Boolean));
    const before = state[kind].length;
    state[kind] = state[kind].filter((item) => !idSet.has(item.id));
    save();
    return { removed: before - state[kind].length };
  }

  function replace(kind, entries) {
    if (kind !== "blacklist" && kind !== "whitelist") throw new Error("kind 必须是 blacklist 或 whitelist");
    state[kind] = (Array.isArray(entries) ? entries : [])
      .map(normalizeEntry)
      .filter((entry) => entry.id);
    save();
    return { count: state[kind].length };
  }

  function isBlacklisted(id) {
    const value = String(id ?? "").trim();
    return Boolean(value) && state.blacklist.some((item) => item.id === value);
  }

  /** 群发准入：返回 "" 表示可发，否则返回跳过原因。 */
  function checkBroadcast(id) {
    const value = String(id ?? "").trim();
    if (isBlacklisted(value)) return "黑名单客户，已跳过";
    if (state.whitelist.length && !state.whitelist.some((item) => item.id === value)) {
      return "不在白名单，已跳过";
    }
    return "";
  }

  return {
    get: () => ({ blacklist: [...state.blacklist], whitelist: [...state.whitelist] }),
    add,
    remove,
    replace,
    isBlacklisted,
    checkBroadcast,
  };
}

/** 意向事件留档（高意向阶段跃迁），cap 50，供控制台「意向提醒」拉取。 */
export function createIntentStore(dataDir) {
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, "intents.json");
  let events = readJson(file, []);
  if (!Array.isArray(events)) events = [];
  const save = () => {
    if (events.length > INTENT_CAP) events = events.slice(-INTENT_CAP);
    writeFileSync(file, JSON.stringify(events), "utf8");
  };

  return {
    push(event) {
      const row = {
        at: event.at ?? new Date().toISOString(),
        name: String(event.name ?? "").slice(0, 40),
        externalUserId: String(event.externalUserId ?? ""),
        stageFrom: String(event.stageFrom ?? ""),
        stage: String(event.stage ?? ""),
        text: String(event.text ?? "").slice(0, 120),
      };
      // 同一客户同阶段只记一次跃迁，避免重复轰炸
      const last = events.filter((item) => item.externalUserId === row.externalUserId).pop();
      if (last && last.stage === row.stage && last.stageFrom === row.stageFrom) return false;
      events.push(row);
      save();
      return true;
    },
    list: () => [...events],
    clear: () => {
      events = [];
      save();
      return true;
    },
  };
}
