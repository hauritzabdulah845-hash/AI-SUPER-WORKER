/**
 * GEO 稿件审核门禁纯逻辑自检（第二十九批）。
 * 关注点：状态机合法/非法流转、自动检查命中与缺失、队列按品牌存取、送审/裁决往返。
 * 运行：npm run test:georeview
 */
import {
  applyTransition,
  canDistribute,
  canTransition,
  checkDraft,
  checksAllPass,
  createReviewItem,
  distributeBlockReason,
  enqueueForReview,
  hasApprovedDraft,
  loadReviewQueue,
  removeReviewItem,
  updateReviewItem,
  type GeoReviewItem,
} from "../src/cloud/geoReview";
import { emptyBrandAssets, type BrandAssets } from "../src/cloud/brandAssets";
import type { StorageLike } from "../src/cloud/keywordLibrary";

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) {
    pass += 1;
    console.log(`✓ ${name}${detail ? ` ｜ ${detail}` : ""}`);
  } else {
    fail += 1;
    console.log(`✗ ${name}${detail ? ` ｜ ${detail}` : ""}`);
  }
};

function memoryStorage(): StorageLike & { dump: Map<string, string> } {
  const dump = new Map<string, string>();
  return {
    dump,
    getItem: (key) => dump.get(key) ?? null,
    setItem: (key, value) => {
      dump.set(key, value);
    },
  };
}

const assets: BrandAssets = {
  ...emptyBrandAssets(),
  rules: {
    bannedWords: ["最好", "第一"],
    requiredWords: ["山野茶饮", "现煮"],
    tone: "亲切口语",
    sentenceStyle: "结论先行",
    numberRule: "",
    disclaimer: "本文不构成投资建议",
  },
};

const goodBody =
  "山野茶饮主打现煮鲜奶茶，12 家门店都在杭州，客单价 18-25 元，支持企业下午茶团购。本文不构成投资建议。";

function draftItem(body = goodBody): GeoReviewItem {
  return createReviewItem({
    brand: "山野茶饮",
    title: "山野茶饮素材稿",
    body,
    kind: "assets",
    assets,
  });
}

console.log("--- 状态机：合法流转 ---");
{
  const item = draftItem();
  ok("新建为草稿", item.status === "draft");
  ok("草稿可送审", canTransition("draft", "submit"));
  const pending = applyTransition(item, "submit");
  ok("送审 → 待审核", pending.status === "pending");
  const approved = applyTransition(pending, "approve");
  ok(
    "通过 → 已通过",
    approved.status === "approved" && Boolean(approved.decidedAt),
  );
  ok(
    "已通过可分发",
    canDistribute(approved) && distributeBlockReason(approved) === "",
  );
  const rejected = applyTransition(pending, "reject", { note: "价格口径不对" });
  ok(
    "驳回 → 已驳回并带理由",
    rejected.status === "rejected" && rejected.rejectReason === "价格口径不对",
  );
  ok(
    "已驳回不可分发",
    !canDistribute(rejected) &&
      distributeBlockReason(rejected).includes("价格口径不对"),
  );
  const resubmitted = applyTransition(rejected, "submit");
  ok(
    "驳回后可重送且清理由",
    resubmitted.status === "pending" && resubmitted.rejectReason === undefined,
  );
  const reopened = applyTransition(approved, "reopen");
  ok(
    "已通过可撤回重审",
    reopened.status === "draft" && reopened.decidedAt === undefined,
  );
}

console.log("\n--- 状态机：非法流转拦截 ---");
{
  const item = draftItem();
  let threw = false;
  try {
    applyTransition(item, "approve");
  } catch {
    threw = true;
  }
  ok("草稿直接通过被拦", threw && !canTransition("draft", "approve"));
  const pending = applyTransition(item, "submit");
  threw = false;
  try {
    applyTransition(pending, "submit");
  } catch {
    threw = true;
  }
  ok("重复送审被拦", threw);
  threw = false;
  try {
    applyTransition(pending, "reject", { note: "  " });
  } catch {
    threw = true;
  }
  ok("驳回不填理由被拦", threw);
  const approved = applyTransition(pending, "approve");
  threw = false;
  try {
    applyTransition(approved, "reject", { note: "x" });
  } catch {
    threw = true;
  }
  ok("已通过直接驳回被拦", threw);
}

console.log("\n--- checkDraft：自动检查 ---");
{
  const good = checkDraft(
    { title: "山野茶饮素材稿", body: goodBody },
    assets.rules,
    "山野茶饮",
  );
  ok(
    "合规稿全过",
    checksAllPass(good),
    good.map((c) => `${c.label}:${c.pass}`).join(" "),
  );
  const banned = checkDraft(
    { title: "最好喝的茶", body: goodBody },
    assets.rules,
    "山野茶饮",
  );
  ok(
    "禁用词命中 fail",
    banned.find((c) => c.key === "banned")?.pass === false &&
      banned.find((c) => c.key === "banned")?.detail.includes("最好") === true,
  );
  const missing = checkDraft(
    {
      title: "茶饮推荐",
      body: "这家茶不错，值得一试，价格也合适，门店很多，推荐大家去喝。本文不构成投资建议。",
    },
    assets.rules,
    "山野茶饮",
  );
  ok(
    "必用词缺失 fail",
    missing.find((c) => c.key === "required")?.pass === false,
  );
  ok("品牌名缺失 fail", missing.find((c) => c.key === "brand")?.pass === false);
  const short = checkDraft(
    { title: "山野茶饮", body: "山野茶饮现煮。" },
    assets.rules,
    "山野茶饮",
  );
  ok("字数过短 fail", short.find((c) => c.key === "length")?.pass === false);
  const noDisclaimer = checkDraft(
    {
      title: "山野茶饮素材稿",
      body: "山野茶饮主打现煮鲜奶茶，12 家门店都在杭州，客单价 18-25 元，支持企业下午茶团购。",
    },
    assets.rules,
    "山野茶饮",
  );
  ok(
    "免责声明缺失 fail",
    noDisclaimer.find((c) => c.key === "disclaimer")?.pass === false,
  );
  const noRules = checkDraft(
    { title: "x", body: goodBody },
    emptyBrandAssets().rules,
    "山野茶饮",
  );
  ok(
    "未设规范时必用词/免责声明 pass",
    noRules.find((c) => c.key === "required")?.pass === true &&
      noRules.find((c) => c.key === "disclaimer")?.pass === true,
  );
  ok(
    "品牌为空时品牌名检查 fail",
    checkDraft({ title: "t", body: goodBody }, assets.rules, "").find(
      (c) => c.key === "brand",
    )?.pass === false,
  );
}

console.log("\n--- 队列存取往返 ---");
{
  const storage = memoryStorage();
  const item = enqueueForReview(
    "山野茶饮",
    { title: "山野茶饮素材稿", body: goodBody, kind: "assets", assets },
    storage,
  );
  ok("送审入队即待审核", item.status === "pending");
  ok("送审带自动检查", item.checks.length === 5 && checksAllPass(item.checks));
  const queue = loadReviewQueue("山野茶饮", storage);
  ok("队列可读回", queue.length === 1 && queue[0].id === item.id);
  ok("品牌隔离", loadReviewQueue("别的品牌", storage).length === 0);
  ok(
    "未通过时 hasApprovedDraft=false",
    hasApprovedDraft("山野茶饮", storage) === false,
  );
  const afterApprove = updateReviewItem(
    "山野茶饮",
    item.id,
    "approve",
    {},
    storage,
  );
  ok("裁决通过后状态更新", afterApprove[0].status === "approved");
  ok(
    "通过后 hasApprovedDraft=true",
    hasApprovedDraft("山野茶饮", storage) === true,
  );
  const afterRemove = removeReviewItem("山野茶饮", item.id, storage);
  ok(
    "删除后队列为空",
    afterRemove.length === 0 &&
      loadReviewQueue("山野茶饮", storage).length === 0,
  );
}

console.log(`\n全部通过（${pass} 通过 / ${fail} 失败）`);
if (fail > 0) process.exit(1);
