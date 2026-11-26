/**
 * GEO 数据上云同步层自检（第三十二批）。
 * 关注点：快照按 id 去重并集/上限 60、整表新者胜、先上行再下行保本机新数据、
 * 首次上行/空组不冲云端、未登录/报错/超时静默回落本机、工作区元信息往返。
 * 运行：npm run test:geosync
 */
import {
  getLocalUpdatedAt,
  loadGeoWorkspace,
  loadSnapshotsLocal,
  loadSyncState,
  markLocalUpdated,
  mergeSnapshots,
  pickNewer,
  removeGeoSnapshotRemote,
  saveGeoWorkspace,
  saveSnapshotsLocal,
  syncGeoData,
  type GeoCloudGroupRow,
  type GeoCloudSnapshotRow,
  type GeoSyncCloud,
} from "../src/cloud/geosync";
import {
  loadLibrary,
  saveLibrary,
  type KeywordLibraryEntry,
  type StorageLike,
} from "../src/cloud/keywordLibrary";
import type { GeoSnapshot } from "../src/cloud/geotrack";

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass += 1; console.log(`✓ ${name}${detail ? ` ｜ ${detail}` : ""}`); }
  else { fail += 1; console.log(`✗ ${name}${detail ? ` ｜ ${detail}` : ""}`); };
};

function memoryStorage(): StorageLike & { dump: Map<string, string> } {
  const dump = new Map<string, string>();
  return {
    dump,
    getItem: (key) => dump.get(key) ?? null,
    setItem: (key, value) => { dump.set(key, value); },
  };
}

const snap = (id: string, at: string, brand = "山野茶饮"): GeoSnapshot => ({
  id, at, brand, questions: ["茶饮哪家好？"], samples: [], channel: "custom",
});

const entry = (word: string): KeywordLibraryEntry => ({
  word, intent: "选型", priority: "高", addedAt: "2026-11-26T00:00:00.000Z", source: "expand",
});

const T1 = "2026-11-26T01:00:00.000Z";
const T2 = "2026-11-26T02:00:00.000Z";
const T3 = "2026-11-26T03:00:00.000Z";

/** 内存假云：记录调用顺序，便于断言先上行再下行。 */
function fakeCloud(): GeoSyncCloud & {
  ops: string[];
  snapshots: Map<string, GeoCloudSnapshotRow>;
  groups: Map<string, GeoCloudGroupRow>;
} {
  const ops: string[] = [];
  const snapshots = new Map<string, GeoCloudSnapshotRow>();
  const groups = new Map<string, GeoCloudGroupRow>();
  const key = (table: string, owner: string, brand: string) => `${table}|${owner}|${brand}`;
  return {
    ops, snapshots, groups,
    async listSnapshots(ownerId) {
      ops.push("listSnapshots");
      return [...snapshots.entries()]
        .filter(([k]) => k.startsWith(`${ownerId}|`))
        .map(([, row]) => row);
    },
    async upsertSnapshot(ownerId, snapshot) {
      ops.push(`upsertSnapshot:${snapshot.id}`);
      snapshots.set(`${ownerId}|${snapshot.id}`, {
        snapshot_id: snapshot.id, brand: snapshot.brand, payload: snapshot, updated_at: T3,
      });
    },
    async deleteSnapshot(ownerId, snapshotId) {
      ops.push(`deleteSnapshot:${snapshotId}`);
      snapshots.delete(`${ownerId}|${snapshotId}`);
    },
    async getGroup(table, ownerId, brand) {
      ops.push(`getGroup:${table}`);
      return groups.get(key(table, ownerId, brand)) ?? null;
    },
    async upsertGroup(table, ownerId, brand, payload, updatedAt) {
      ops.push(`upsertGroup:${table}`);
      groups.set(key(table, ownerId, brand), { brand, payload, updated_at: updatedAt });
    },
    async listGroups(table, ownerId) {
      ops.push(`listGroups:${table}`);
      return [...groups.entries()]
        .filter(([k]) => k.startsWith(`${table}|${ownerId}|`))
        .map(([, row]) => row);
    },
  };
}

const loggedIn = async () => ({ id: "owner-1", name: "测试用户" });
const loggedOut = async () => null;

console.log("--- mergeSnapshots：去重并集/上限 60/排序 ---");
{
  const merged = mergeSnapshots([snap("a", T1), snap("b", T2)], [snap("b", T2), snap("c", T3)]);
  ok("按 id 去重并集", merged.length === 3 && merged.map((s) => s.id).join("") === "abc");
  const many = Array.from({ length: 70 }, (_, i) => snap(`s${i}`, new Date(Date.parse(T1) + i * 1000).toISOString()));
  const capped = mergeSnapshots(many, []);
  ok("上限 60 取最新", capped.length === 60 && capped[0].id === "s10" && capped[59].id === "s69");
  const bad = mergeSnapshots([snap("ok", T1)], [{ id: "", samples: [] } as never, null as never]);
  ok("非法快照被过滤", bad.length === 1 && bad[0].id === "ok");
}

console.log("\n--- pickNewer：整表新者胜 ---");
{
  ok("本机较新保本机", pickNewer("local", T3, "remote", T1).source === "local");
  ok("云端较新取云端", pickNewer("local", T1, "remote", T3).source === "remote");
  ok("时间相同保本机", pickNewer("local", T2, "remote", T2).source === "local");
  ok("本机无时间戳云端赢", pickNewer("local", "", "remote", T1).source === "remote");
  ok("云端无时间戳本机赢", pickNewer("local", T1, "remote", "").source === "local");
}

console.log("\n--- 工作区元信息与同步元信息往返 ---");
{
  const storage = memoryStorage();
  saveGeoWorkspace({ brand: "山野茶饮", keywords: "现煮茶饮", materialRef: "知识库3份", updatedAt: T2 }, storage);
  const loaded = loadGeoWorkspace(storage);
  ok("工作区往返", loaded?.brand === "山野茶饮" && loaded?.keywords === "现煮茶饮" && loaded?.updatedAt === T2);
  ok("保存同时标记更新时间", getLocalUpdatedAt("workspace", "山野茶饮", storage) === T2);
  storage.setItem("ai-employee:geo-workspace", "{坏数据");
  ok("坏数据返回 null 不抛错", loadGeoWorkspace(storage) === null);
  saveSnapshotsLocal([snap("x", T1)], storage);
  ok("快照批量存取往返", loadSnapshotsLocal(storage)[0]?.id === "x");
}

console.log("\n--- syncGeoData：首次上行与新者胜 ---");
{
  const storage = memoryStorage();
  const cloudClient = fakeCloud();
  saveLibrary("山野茶饮", [entry("茶饮哪家好")], storage);
  markLocalUpdated("library", "山野茶饮", T2, storage);
  const first = await syncGeoData("山野茶饮", { storage, cloudClient, getUser: loggedIn, now: () => T3 });
  ok("首次同步上行词库", first.mode === "synced" && first.pushed.includes("library"));
  ok("云端收到词库信封", Boolean(cloudClient.groups.get("geo_keyword_library|owner-1|山野茶饮")));
  ok("同步状态落盘", loadSyncState(storage).mode === "synced" && loadSyncState(storage).lastSyncAt === T3);

  // 云端被另一台设备更新（时间更新）→ 下行覆盖本机
  await cloudClient.upsertGroup("geo_keyword_library", "owner-1", "山野茶饮",
    { data: [entry("云端新词")], updatedAt: "2026-11-26T04:00:00.000Z" }, "2026-11-26T04:00:00.000Z");
  const second = await syncGeoData("山野茶饮", { storage, cloudClient, getUser: loggedIn, now: () => T3 });
  ok("云端较新时下行", second.pulled.includes("library") && loadLibrary("山野茶饮", storage)[0]?.word === "云端新词");

  // 本机又改了（时间更新）→ 先上行，云端旧数据不得冲掉本机
  saveLibrary("山野茶饮", [entry("本机最新词")], storage);
  markLocalUpdated("library", "山野茶饮", "2026-11-26T05:00:00.000Z", storage);
  const third = await syncGeoData("山野茶饮", { storage, cloudClient, getUser: loggedIn, now: () => T3 });
  ok("本机较新时上行且不被冲掉",
    third.pushed.includes("library") && loadLibrary("山野茶饮", storage)[0]?.word === "本机最新词");
  const remoteNow = cloudClient.groups.get("geo_keyword_library|owner-1|山野茶饮")?.payload as { data: KeywordLibraryEntry[] };
  ok("上行后云端为本机数据", remoteNow?.data[0]?.word === "本机最新词");
}

console.log("\n--- syncGeoData：快照并集双向补齐 ---");
{
  const storage = memoryStorage();
  const cloudClient = fakeCloud();
  saveSnapshotsLocal([snap("local-1", T1)], storage);
  await cloudClient.upsertSnapshot("owner-1", snap("remote-1", T2));
  const result = await syncGeoData("山野茶饮", { storage, cloudClient, getUser: loggedIn, now: () => T3 });
  const localIds = loadSnapshotsLocal(storage).map((s) => s.id);
  ok("快照并集合并到本机", localIds.includes("local-1") && localIds.includes("remote-1"));
  ok("本机独有快照补推云端", cloudClient.snapshots.has("owner-1|local-1") && result.pushed.includes("snapshots"));
  await removeGeoSnapshotRemote("local-1", { storage, cloudClient, getUser: loggedIn });
  ok("删除同步到云端", !cloudClient.snapshots.has("owner-1|local-1"));
}

console.log("\n--- syncGeoData：降级路径（未登录/报错/超时） ---");
{
  const storage = memoryStorage();
  const cloudClient = fakeCloud();
  saveLibrary("山野茶饮", [entry("茶饮哪家好")], storage);
  const noLogin = await syncGeoData("山野茶饮", { storage, cloudClient, getUser: loggedOut });
  ok("未登录回落本机模式", noLogin.mode === "local" && loadLibrary("山野茶饮", storage).length === 1);

  const throwing: GeoSyncCloud = {
    ...fakeCloud(),
    async listSnapshots() { throw new Error("relation \"geo_snapshots\" does not exist"); },
  };
  const onError = await syncGeoData("山野茶饮", { storage, cloudClient: throwing, getUser: loggedIn });
  ok("云端报错静默回落不抛错", onError.mode === "local" && !/relation|does not exist/.test(onError.message));

  const hanging: GeoSyncCloud = {
    ...fakeCloud(),
    async listSnapshots() { return new Promise<never>(() => {}); },
  };
  const onTimeout = await syncGeoData("山野茶饮", { storage, cloudClient: hanging, getUser: loggedIn, timeoutMs: 50 });
  ok("超时静默回落本机模式", onTimeout.mode === "local");

  // 本机为空、云端有数据：下行恢复（换设备场景），且不把空组上行冲掉云端
  const fresh = memoryStorage();
  const cloud2 = fakeCloud();
  await cloud2.upsertGroup("geo_keyword_library", "owner-1", "山野茶饮",
    { data: [entry("换设备恢复词")], updatedAt: T2 }, T2);
  const restored = await syncGeoData("山野茶饮", { storage: fresh, cloudClient: cloud2, getUser: loggedIn, now: () => T3 });
  ok("空本机从云端恢复", restored.pulled.includes("library") && loadLibrary("山野茶饮", fresh)[0]?.word === "换设备恢复词");
  const stillThere = cloud2.groups.get("geo_keyword_library|owner-1|山野茶饮")?.payload as { data: KeywordLibraryEntry[] };
  ok("空组不上行冲云端", stillThere?.data[0]?.word === "换设备恢复词");
}

console.log(`\n${fail === 0 ? "全部通过" : `${fail} 项失败`}（${pass} 通过 / ${fail} 失败）`);
process.exit(fail === 0 ? 0 : 1);
