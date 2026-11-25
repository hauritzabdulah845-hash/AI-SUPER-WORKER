/**
 * 企业设置自检：成员校验/管理员门禁/过滤、品牌归一化/上下文、费用估算、目录启停。
 * 运行：npm run test:settings
 */
import {
  MAX_MEMBERS,
  buildBrandContext,
  canRemoveMember,
  canSaveMember,
  countEnabledAdmins,
  createMember,
  defaultModelCatalog,
  estimateCost,
  estimateTextCost,
  filterEnabledCatalog,
  filterMembers,
  loadBrandConfig,
  loadMembers,
  loadModelCatalog,
  normalizeBrandConfig,
  normalizeCatalogEntry,
  normalizeMember,
  saveBrandConfig,
  saveMembers,
  validateMember,
  type Member,
} from "../src/cloud/settings";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failed += 1;
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` ｜ ${detail}` : ""}`);
};

// node 环境 localStorage 垫片（留档/配置读写需要，与 analysis-check 同写法）
const memory = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => void memory.set(key, String(value)),
  removeItem: (key: string) => void memory.delete(key),
};

const admin: Member = { id: "m1", name: "王经理", role: "管理员", status: "启用", note: "负责人" };
const ops: Member = { id: "m2", name: "李运营", role: "运营", status: "启用", note: "" };
const readonly: Member = { id: "m3", name: "赵顾问", role: "只读", status: "停用", note: "外部顾问" };
const team = [admin, ops, readonly];

// 1. 成员校验
check("合法成员通过校验", validateMember(admin, []).ok);
check("空姓名被拦", !validateMember({ ...ops, name: "  " }, []).ok);
check("非法角色被拦", !validateMember({ ...ops, role: "老板" as Member["role"] }, []).ok);
check("非法状态被拦", !validateMember({ ...ops, status: "休假" as Member["status"] }, []).ok);
check("备注超长被拦", !validateMember({ ...ops, note: "备".repeat(101) }, []).ok);
const full = Array.from({ length: MAX_MEMBERS }, (_, index) => ({ ...ops, id: `f${index}` }));
check("满员时新增被拦", !validateMember(createMember("新人"), full).ok);
check("满员时编辑已有成员放行", validateMember({ ...full[0], name: "改名" }, full).ok);

// 2. 归一化
check("归一化非法角色回退运营", normalizeMember({ id: "x", name: "甲", role: "老板" as Member["role"] })?.role === "运营");
check("归一化无 id 返回 null", normalizeMember({ name: "甲" }) === null);
check("归一化姓名限长 20", (normalizeMember({ id: "x", name: "名".repeat(30) })?.name.length ?? 0) === 20);

// 3. 管理员门禁
check("启用管理员计数", countEnabledAdmins(team) === 1);
check("不能删最后一名启用管理员", !canRemoveMember(team, "m1"));
check("可删普通成员", canRemoveMember(team, "m2"));
check("删不存在的成员返回 false", !canRemoveMember(team, "nope"));
const twoAdmins = [...team, { ...admin, id: "m4", name: "陈经理" }];
check("两名管理员时可删其一", canRemoveMember(twoAdmins, "m1"));
check("不能把最后管理员降级", !canSaveMember(team, { ...admin, role: "运营" }));
check("不能把最后管理员停用", !canSaveMember(team, { ...admin, status: "停用" }));
check("改管理员备注放行", canSaveMember(team, { ...admin, note: "新备注" }));
check("新增成员保存放行", canSaveMember(team, createMember("新人")));

// 4. 过滤
check("按角色过滤", filterMembers(team, { role: "运营" }).length === 1);
check("按状态过滤", filterMembers(team, { status: "停用" }).length === 1);
check("关键词命中备注", filterMembers(team, { keyword: "顾问" }).length === 1);
check("空条件=全部", filterMembers(team, {}).length === 3);

// 5. 留档往返
saveMembers(team);
check("成员留档往返", loadMembers().length === 3 && loadMembers()[0].name === "王经理");
saveMembers([]);
check("成员留档可清空", loadMembers().length === 0);

// 6. 品牌归一化与上下文
const brand = normalizeBrandConfig({
  brandName: " 示例餐饮 ",
  industry: "本地生活",
  slogan: "好吃不贵",
  redlines: ["全网最低", "", "全网最低", "稳赚不赔"],
  tone: "亲切口语",
});
check("品牌去空+红线去重去空", brand.brandName === "示例餐饮" && brand.redlines.length === 2, JSON.stringify(brand.redlines));
const context = buildBrandContext(brand);
check("品牌上下文含品牌与红线", context.includes("示例餐饮") && context.includes("全网最低") && context.includes("亲切口语"));
check("空品牌上下文为空串", buildBrandContext(normalizeBrandConfig(null)) === "");
saveBrandConfig(brand);
check("品牌留档往返", loadBrandConfig().brandName === "示例餐饮");

// 7. 模型目录与费用估算
const catalog = defaultModelCatalog();
check("示例目录含示例价格标注", catalog.every((row) => row.note.includes("示例") || row.note.includes("平台")));
check("目录归一化负价夹紧为 0", normalizeCatalogEntry({ id: "x", provider: "P", model: "m", inputPricePer1k: -5 })?.inputPricePer1k === 0);
check("目录归一化缺字段返回 null", normalizeCatalogEntry({ id: "x" }) === null);
check("启停过滤", filterEnabledCatalog(catalog).length === catalog.filter((row) => row.enabled).length && filterEnabledCatalog(catalog).length >= 1);
const entry = catalog[0]; // 输入 0.001 / 输出 0.002 每 1k
check("费用估算正常", estimateCost(entry, 10000, 5000) === 0.02, String(estimateCost(entry, 10000, 5000)));
check("费用估算零 tokens", estimateCost(entry, 0, 0) === 0);
check("费用估算负数夹紧", estimateCost(entry, -100, -50) === 0);
check("费用估算非有限值夹紧", estimateCost(entry, Number.NaN, Number.POSITIVE_INFINITY) === 0);
check("按文本估算费用为正", estimateTextCost(entry, "你好世界这是一段输入文本", "好的，这是输出") > 0);
check("目录留档默认回退示例", loadModelCatalog().length >= 1);

console.log(`\n${failed === 0 ? "全部通过" : `${failed} 项失败`}`);
process.exit(failed === 0 ? 0 : 1);
