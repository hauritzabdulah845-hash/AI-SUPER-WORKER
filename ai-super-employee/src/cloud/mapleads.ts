/**
 * 地图获客（域：线索获取）：高德地图 POI 采集适配器 + 演示数据。
 *
 * - 真实模式：用户本机填高德 Web 服务 Key（仅存 localStorage，不上云），
 *   浏览器直连 restapi.amap.com 的地理编码 + 周边搜索；
 * - 演示模式：无 Key 时返回确定性示例商家，界面明确标注「演示数据」；
 * - 合规边界：**不做自动加好友**（封号风险）——结果一键导入 leads，
 *   走企微官方触达 / 生成加微话术（沿用路线图 C 类边界）。
 */

export interface MapMerchant {
  id: string;
  name: string;
  address: string;
  tel: string;
  category: string;
  lng: number;
  lat: number;
  distance?: number;
}

export interface MapSearchInput {
  city: string;
  keyword: string;
  /** 搜索半径（米），真实模式走周边搜索，演示模式用于估算距离 */
  radius: number;
}

export interface MapSearchResult {
  items: MapMerchant[];
  demo: boolean;
  /** 真实模式下的总命中数（高德 count），演示模式为示例条数 */
  total: number;
  note?: string;
}

const AMAP_KEY_STORAGE = "ai-employee:amap-key";

export function loadAmapKey(): string {
  try {
    return window.localStorage.getItem(AMAP_KEY_STORAGE) ?? "";
  } catch {
    return "";
  }
}

export function saveAmapKey(key: string): void {
  try {
    const trimmed = key.trim();
    if (trimmed) window.localStorage.setItem(AMAP_KEY_STORAGE, trimmed);
    else window.localStorage.removeItem(AMAP_KEY_STORAGE);
  } catch {
    // 隐私模式写入失败不影响本次操作
  }
}

/* ------------------------------------------------------------------ */
/* 演示数据（确定性生成，便于测试与无 Key演示）                            */
/* ------------------------------------------------------------------ */

const DEMO_SUFFIX = ["旗舰店", "社区店", "直营店", "概念店", "中山路店", "万象城店", "高新店", "车站店"];
const DEMO_ROADS = ["中山路", "人民街", "解放路", "滨江道", "文化路", "青年街", "站前大道", "学院路"];

export function demoMerchants(input: MapSearchInput): MapMerchant[] {
  const city = input.city.trim() || "示例市";
  const keyword = input.keyword.trim() || "商家";
  const radius = Math.max(500, input.radius || 1000);
  return DEMO_SUFFIX.map((suffix, index) => ({
    id: `demo-${index + 1}`,
    name: `${keyword}·${city}${suffix}`,
    address: `${city}${DEMO_ROADS[index]}${12 + index * 9}号`,
    tel: `0571-888000${String(index + 1).padStart(2, "0")}`,
    category: `${keyword}服务`,
    lng: 120.1 + index * 0.004,
    lat: 30.2 + index * 0.003,
    distance: Math.round((radius * (index + 1)) / (DEMO_SUFFIX.length + 1)),
  }));
}

/** 按「名称+地址」去重，保留先出现的（导入前调用，防止重复线索）。 */
export function dedupeMerchants(items: MapMerchant[]): MapMerchant[] {
  const seen = new Set<string>();
  const result: MapMerchant[] = [];
  for (const item of items) {
    const key = `${item.name.trim()}|${item.address.trim()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

/** 商家转线索字段（source/owner/channel 统一口径，便于报表归因）。 */
export function merchantToLeadInput(merchant: MapMerchant, owner: string): {
  name: string;
  source: string;
  intent: string;
  need: string;
  owner: string;
  channel: string;
} {
  return {
    name: merchant.name,
    source: "地图获客",
    intent: "中意向",
    need: [merchant.category, merchant.address].filter(Boolean).join(" · ").slice(0, 60),
    owner: owner || "AI 跟进",
    channel: "地图",
  };
}

/* ------------------------------------------------------------------ */
/* 真实适配器：高德 Web 服务 API（浏览器直连，Key 仅存本机）               */
/* ------------------------------------------------------------------ */

async function amapGet(path: string, params: Record<string, string>): Promise<Record<string, unknown>> {
  const key = loadAmapKey();
  if (!key) throw new Error("未配置高德 Key");
  const url = new URL(path);
  url.searchParams.set("key", key);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  const response = await fetch(url.toString());
  if (!response.ok) throw new Error(`高德接口 HTTP ${response.status}`);
  const data = (await response.json()) as Record<string, unknown>;
  if (String(data.status) !== "1") {
    const info = typeof data.info === "string" ? data.info : "接口返回异常";
    throw new Error(`高德返回：${info}${String(data.infocode) === "10001" ? "（Key 无效，请检查）" : ""}`);
  }
  return data;
}

function poisOf(data: Record<string, unknown>): MapMerchant[] {
  const pois = Array.isArray(data.pois) ? (data.pois as Record<string, unknown>[]) : [];
  const items: MapMerchant[] = [];
  for (const poi of pois) {
    const location = typeof poi.location === "string" ? poi.location.split(",") : null;
    if (!location || location.length !== 2) continue;
    const lng = Number(location[0]);
    const lat = Number(location[1]);
    if (Number.isNaN(lng) || Number.isNaN(lat)) continue;
    const bizArea = typeof poi.business_area === "string" ? poi.business_area : "";
    const address = typeof poi.address === "string" && poi.address ? poi.address : bizArea;
    const distance = Number(poi.distance);
    items.push({
      id: String(poi.id ?? `${lng},${lat}`),
      name: String(poi.name ?? "未命名商家").slice(0, 40),
      address: String(address).slice(0, 80),
      tel: typeof poi.tel === "string" ? poi.tel.slice(0, 30) : "",
      category: String(poi.type ?? "").split(";")[0] || "商家",
      lng,
      lat,
      distance: Number.isFinite(distance) ? Math.round(distance) : undefined,
    });
  }
  return items;
}

/**
 * 搜索商家：有 Key 走高德（地理编码→周边搜索），无 Key 返回演示数据。
 * 单次最多 20 条（高德单页上限），radius 生效于 around 接口。
 */
export async function searchMerchants(input: MapSearchInput): Promise<MapSearchResult> {
  const city = input.city.trim();
  const keyword = input.keyword.trim();
  if (!city) throw new Error("先填写获客城市");
  if (!keyword) throw new Error("先填写商家关键词（如店铺名称）");
  if (!loadAmapKey()) {
    const items = demoMerchants(input);
    return { items, demo: true, total: items.length, note: "未配置高德 Key，当前为演示数据；填入 Key 后即真实采集" };
  }

  const geo = await amapGet("https://restapi.amap.com/v3/geocode/geo", { address: city });
  const location = typeof geo.location === "string" ? geo.location : "";
  if (!location) throw new Error(`未能定位「${city}」，请填写更具体的城市名（如「杭州市」）`);

  const around = await amapGet("https://restapi.amap.com/v3/place/around", {
    location,
    keywords: keyword,
    radius: String(Math.min(50000, Math.max(100, input.radius || 1000))),
    offset: "20",
    page: "1",
    extensions: "base",
  });
  const items = dedupeMerchants(poisOf(around));
  const total = Number(around.count ?? items.length) || items.length;
  if (!items.length) {
    return { items: [], demo: false, total: 0, note: `「${city}·${keyword}」${input.radius} 米内没有命中，可换关键词或扩大半径` };
  }
  return { items, demo: false, total };
}
