/**
 * 客户档案与消息事件流（本地持久化）。
 *
 * 为什么放在服务端而不是云端数据库：
 * 云端按登录身份隔离，服务端没有用户 session，只能写 owner_id="anon" 的行，
 * 写进去用户在控制台里看不到。所以这里只做「企微侧的客户身份 + 对话记录」，
 * 由控制台在登录态下调用 /api/sync 拉取，再用自己的 owner 落库。
 *
 * 数据结构：
 *   customers.json  { "<external_userid>": { externalUserId, name, openKfid, firstSeen, lastSeen, msgCount, lastText, stage, tags } }
 *   events.json     { nextSeq: number, events: [{ seq, externalUserId, direction, text, at, ruleId }] }
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MAX_EVENTS = 2000;

/** 从消息内容粗判意向阶段，仅用于新建线索时的初始阶段，不覆盖人工调整。 */
export function guessStage(text) {
  const value = (text ?? "").trim();
  if (!value) return "新建";
  if (/成交|签合同|打款|付了|下单|要发票/.test(value)) return "成交";
  if (/试用|体验|demo|先试试|注册/.test(value)) return "试用";
  if (/价格|多少钱|报价|费用|怎么收费|优惠/.test(value)) return "报价";
  if (/考虑|再看看|以后|暂时|不急/.test(value)) return "培育";
  return "新建";
}

/** 客户名未知时给一个可识别的占位名，避免线索列表里出现空名字。 */
function placeholderName(externalUserId) {
  const tail = (externalUserId ?? "").slice(-4) || "0000";
  return `企微客户 ${tail}`;
}

function readJson(file, fallback) {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

export function createCustomerStore(dataDir) {
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  const customerFile = join(dataDir, "customers.json");
  const eventFile = join(dataDir, "events.json");

  let customers = readJson(customerFile, {});
  let eventState = readJson(eventFile, { nextSeq: 1, events: [] });
  if (!Array.isArray(eventState.events)) eventState = { nextSeq: 1, events: [] };

  const saveCustomers = () => writeFileSync(customerFile, JSON.stringify(customers, null, 1), "utf8");
  const saveEvents = () => {
    if (eventState.events.length > MAX_EVENTS) {
      eventState.events = eventState.events.slice(-MAX_EVENTS);
    }
    writeFileSync(eventFile, JSON.stringify(eventState, null, 1), "utf8");
  };

  /** 收到客户消息：建档或更新最近活动，返回档案（供回复时做个性化）。 */
  function touch({ externalUserId, openKfid = "", text = "", at = new Date().toISOString() }) {
    if (!externalUserId) return null;
    const existing = customers[externalUserId];
    const customer = existing ?? {
      externalUserId,
      name: placeholderName(externalUserId),
      openKfid,
      firstSeen: at,
      lastSeen: at,
      msgCount: 0,
      lastText: "",
      stage: "新建",
      tags: [],
      named: false,
    };
    customer.lastSeen = at;
    customer.msgCount += 1;
    customer.lastText = text.slice(0, 200);
    if (openKfid) customer.openKfid = openKfid;
    if (!customer.named) customer.stage = guessStage(text);
    customers[externalUserId] = customer;
    saveCustomers();
    return customer;
  }

  /** 追加一条对话事件（in = 客户发来，out = 我们回复）。 */
  function record({ externalUserId, direction, text, type = "text", ruleId = "", at = new Date().toISOString() }) {
    const event = {
      seq: eventState.nextSeq++,
      externalUserId,
      direction,
      type,
      text: (text ?? "").slice(0, 1000),
      ruleId,
      at,
    };
    eventState.events.push(event);
    saveEvents();
    return event;
  }

  /** 增量拉取：返回 seq > since 的事件，以及全量客户档案。 */
  function since(seq = 0) {
    const events = eventState.events.filter((event) => event.seq > Number(seq || 0));
    return {
      customers: Object.values(customers),
      events,
      nextSeq: eventState.nextSeq - 1,
    };
  }

  function list() {
    return Object.values(customers).sort((a, b) => (a.lastSeen < b.lastSeen ? 1 : -1));
  }

  /** 人工在控制台改过名字后，通过服务端更新档案名（可选能力）。 */
  function rename(externalUserId, name) {
    const customer = customers[externalUserId];
    if (!customer) return null;
    customer.name = name;
    customer.named = true;
    saveCustomers();
    return customer;
  }

  return { touch, record, since, list, rename, get: (id) => customers[id] ?? null };
}

/** 规则话术里的模板变量：{{name}} 替换为客户称呼，未知时用「你」。 */
export function renderTemplate(content, customer) {
  if (!content) return content;
  const name = customer?.named ? customer.name : "你";
  return content.replaceAll("{{name}}", name);
}
