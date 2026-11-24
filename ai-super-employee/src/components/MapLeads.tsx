import { useState } from "react";
import { KeyRound, LoaderCircle, MapPin, Search, ShieldCheck, Upload } from "lucide-react";
import type { LeadRow } from "../cloud/api";
import { insertLead } from "../cloud/api";
import {
  dedupeMerchants,
  loadAmapKey,
  merchantToLeadInput,
  saveAmapKey,
  searchMerchants,
  type MapMerchant,
  type MapSearchResult,
} from "../cloud/mapleads";

const RADII = [
  { value: 500, label: "500 米" },
  { value: 1000, label: "1 公里" },
  { value: 2000, label: "2 公里" },
  { value: 5000, label: "5 公里" },
];

/**
 * 地图获客：高德周边搜索采集商家 → 勾选导入线索。
 * 合规边界：不做自动加好友——导入后走企微官方触达 / 生成加微话术。
 */
export function MapLeads(props: {
  ownerName: string;
  existingNames: string[];
  onCreated: (lead: LeadRow) => void;
}) {
  const { ownerName, existingNames, onCreated } = props;

  const [city, setCity] = useState("");
  const [keyword, setKeyword] = useState("");
  const [radius, setRadius] = useState(1000);
  const [keyInput, setKeyInput] = useState("");
  const [hasKey, setHasKey] = useState(() => Boolean(loadAmapKey()));
  const [result, setResult] = useState<MapSearchResult | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [importing, setImporting] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const existing = new Set(existingNames);

  const runSearch = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const next = await searchMerchants({ city, keyword, radius });
      setResult(next);
      setSelected(new Set(next.items.map((item) => item.id)));
      setNotice(next.demo ? next.note ?? "演示数据已加载" : `真实采集 ${next.items.length} 家（命中 ${next.total}）`);
    } catch (err) {
      setResult(null);
      setError(err instanceof Error ? err.message : "搜索失败");
    } finally {
      setBusy(false);
    }
  };

  const saveKey = () => {
    saveAmapKey(keyInput);
    setHasKey(Boolean(loadAmapKey()));
    setKeyInput("");
    setNotice(loadAmapKey() ? "高德 Key 已保存到本机（仅存浏览器，不上云）" : "Key 已清除，回到演示模式");
  };

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const importSelected = async () => {
    if (!result || importing) return;
    const targets = dedupeMerchants(result.items.filter((item) => selected.has(item.id) && !existing.has(item.name)));
    if (!targets.length) {
      setNotice("没有可导入的新商家（已选中的都在线索库，或未勾选）");
      return;
    }
    setImporting(true);
    setError("");
    let created = 0;
    const failed: string[] = [];
    for (const merchant of targets) {
      try {
        const lead = await insertLead(merchantToLeadInput(merchant, ownerName));
        onCreated(lead);
        created += 1;
      } catch {
        failed.push(merchant.name);
      }
    }
    setImporting(false);
    setNotice(
      failed.length
        ? `导入 ${created} 条，失败 ${failed.length} 条${failed[0] ? `（${failed[0]}…）` : ""}`
        : `已导入 ${created} 条线索（source=地图获客），到「线索与客户」继续跟进`,
    );
  };

  const selectable = result?.items.filter((item) => !existing.has(item.name)) ?? [];
  const newCount = selectable.filter((item) => selected.has(item.id)).length;

  return (
    <section className="mapleads-page">
      <div className="console-card mapleads-head">
        <div>
          <h2>
            <MapPin size={16} /> 地图获客
          </h2>
          <p>
            按城市 + 关键词采集周边商家，勾选后一键导入线索（source=地图获客）。
            <strong>合规边界：不做自动加好友</strong>——导入后走企微官方触达或生成加微话术。
            未配置高德 Key 时为演示数据。
          </p>
        </div>
        <div className={`mapleads-mode ${hasKey ? "real" : ""}`}>
          <ShieldCheck size={14} />
          {hasKey ? "真实采集（Key 存本机）" : "演示模式"}
        </div>
      </div>

      <div className="console-card mapleads-config">
        <div className="console-card-header">
          <div>
            <h2>
              <KeyRound size={15} /> 高德 Key（可选）
            </h2>
            <p>Web 服务类型 Key，仅存本机 localStorage；申请后填入即切换真实采集</p>
          </div>
        </div>
        <div className="mapleads-config-row">
          <input
            type="password"
            value={keyInput}
            onChange={(event) => setKeyInput(event.target.value)}
            placeholder={hasKey ? "已保存 Key（重新输入可覆盖）" : "高德 Web 服务 Key"}
            autoComplete="off"
          />
          <button type="button" className="button button-secondary" onClick={saveKey} disabled={!keyInput.trim() && hasKey}>
            保存
          </button>
          {hasKey && (
            <button
              type="button"
              className="text-link"
              onClick={() => {
                saveAmapKey("");
                setHasKey(false);
                setNotice("Key 已清除，回到演示模式");
              }}
            >
              清除
            </button>
          )}
        </div>
      </div>

      <div className="console-card mapleads-search">
        <div className="mapleads-form">
          <label>
            <span>城市</span>
            <input value={city} onChange={(event) => setCity(event.target.value)} placeholder="例：杭州市" />
          </label>
          <label>
            <span>商家关键词</span>
            <input value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="例：茶饮 / 健身房 / 汽修" />
          </label>
          <label>
            <span>范围</span>
            <select value={radius} onChange={(event) => setRadius(Number(event.target.value))}>
              {RADII.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="button button-primary mapleads-search-btn" onClick={() => void runSearch()} disabled={busy}>
            {busy ? <LoaderCircle size={15} className="spin" /> : <Search size={15} />}
            开始采集
          </button>
        </div>
        {notice && <p className="mapleads-notice">{notice}</p>}
        {error && <p className="geo-error">{error}</p>}
      </div>

      {result && (
        <div className="console-card mapleads-results">
          <div className="console-card-header">
            <div>
              <h2>
                采集结果（{result.items.length}）
                {result.demo && <span className="mapleads-demo-badge">演示数据</span>}
              </h2>
              <p>{result.note ?? `已选 ${newCount} 家可导入；已在线索库中的商家自动跳过`}</p>
            </div>
            <div className="mapleads-actions">
              <button
                type="button"
                className="text-link"
                onClick={() =>
                  setSelected(new Set(selectable.map((item) => item.id)))
                }
              >
                全选新商家
              </button>
              <button
                type="button"
                className="text-link"
                onClick={() => setSelected(new Set())}
              >
                清空
              </button>
              <button type="button" className="button button-primary" onClick={() => void importSelected()} disabled={importing || !newCount}>
                {importing ? <LoaderCircle size={15} className="spin" /> : <Upload size={15} />}
                导入选中（{newCount}）
              </button>
            </div>
          </div>

          <div className="mapleads-table-wrap">
            <table className="mapleads-table">
              <thead>
                <tr>
                  <th />
                  <th>商家</th>
                  <th>地址</th>
                  <th>电话</th>
                  <th>类目</th>
                  <th>距离</th>
                </tr>
              </thead>
              <tbody>
                {result.items.map((item: MapMerchant) => {
                  const already = existing.has(item.name);
                  return (
                    <tr key={item.id} className={already ? "existed" : ""}>
                      <td>
                        <input
                          type="checkbox"
                          checked={selected.has(item.id) && !already}
                          disabled={already}
                          onChange={() => toggle(item.id)}
                          aria-label={`选择 ${item.name}`}
                        />
                      </td>
                      <td>
                        <strong>{item.name}</strong>
                        {already && <em className="mapleads-existed">已在线索库</em>}
                      </td>
                      <td>{item.address || "—"}</td>
                      <td>{item.tel || "—"}</td>
                      <td>{item.category}</td>
                      <td>{item.distance != null ? `${item.distance}m` : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}

export default MapLeads;
