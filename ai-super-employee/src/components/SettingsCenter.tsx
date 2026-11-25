import { useMemo, useState } from "react";
import { Building2, Calculator, Save, Trash2, UserPlus, Users } from "lucide-react";
import {
  MEMBER_ROLES,
  MEMBER_STATUSES,
  buildBrandContext,
  canRemoveMember,
  canSaveMember,
  createMember,
  estimateCost,
  filterEnabledCatalog,
  filterMembers,
  loadBrandConfig,
  loadMembers,
  loadModelCatalog,
  normalizeBrandConfig,
  saveBrandConfig,
  saveMembers,
  saveModelCatalog,
  validateMember,
  type BrandConfig,
  type Member,
  type MemberRole,
  type MemberStatus,
  type ModelCatalogEntry,
} from "../cloud/settings";

/**
 * 企业设置：成员与权限 / 品牌与业务配置 / 模型目录与价格。
 * 全部本机留档（localStorage），接入云端成员体系后置——界面如实标注。
 */
export function SettingsCenter() {
  const [members, setMembers] = useState<Member[]>(() => loadMembers());
  const [brand, setBrand] = useState<BrandConfig>(() => loadBrandConfig());
  const [catalog, setCatalog] = useState<ModelCatalogEntry[]>(() => loadModelCatalog());
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  // 成员表单
  const [editing, setEditing] = useState<Member | null>(null);
  const [memberKeyword, setMemberKeyword] = useState("");

  // 费用试算
  const enabledCatalog = useMemo(() => filterEnabledCatalog(catalog), [catalog]);
  const [trialModelId, setTrialModelId] = useState("");
  const [trialInput, setTrialInput] = useState("10000");
  const [trialOutput, setTrialOutput] = useState("5000");

  const visibleMembers = useMemo(() => filterMembers(members, { keyword: memberKeyword }), [members, memberKeyword]);
  const brandContext = useMemo(() => buildBrandContext(brand), [brand]);
  const trialEntry = enabledCatalog.find((row) => row.id === trialModelId) ?? enabledCatalog[0] ?? null;
  const trialCost = trialEntry ? estimateCost(trialEntry, Number(trialInput) || 0, Number(trialOutput) || 0) : 0;

  const persistMembers = (next: Member[]) => {
    setMembers(next);
    saveMembers(next);
  };

  const saveEditingMember = () => {
    if (!editing) return;
    const validation = validateMember(editing, members);
    if (!validation.ok) {
      setError(validation.errors.join("；"));
      return;
    }
    if (!canSaveMember(members, editing)) {
      setError("不能停用或降级最后一名启用管理员，请先新增另一名管理员。");
      return;
    }
    const exists = members.some((row) => row.id === editing.id);
    persistMembers(exists ? members.map((row) => (row.id === editing.id ? editing : row)) : [...members, editing]);
    setEditing(null);
    setError("");
    setNotice(exists ? "成员已更新" : "成员已添加");
  };

  const removeMember = (id: string) => {
    if (!canRemoveMember(members, id)) {
      setError("不能删除最后一名启用管理员，请先新增另一名管理员。");
      return;
    }
    persistMembers(members.filter((row) => row.id !== id));
    setError("");
    setNotice("成员已删除");
  };

  const saveBrand = () => {
    const next = saveBrandConfig(normalizeBrandConfig(brand));
    setBrand(next);
    setNotice("品牌配置已保存（本机留档）");
  };

  const updateCatalogPrice = (id: string, field: "inputPricePer1k" | "outputPricePer1k", value: string) => {
    const num = Number(value);
    const next = catalog.map((row) => (row.id === id ? { ...row, [field]: Number.isFinite(num) && num >= 0 ? num : 0 } : row));
    setCatalog(next);
    saveModelCatalog(next);
  };

  const toggleCatalog = (id: string) => {
    const next = catalog.map((row) => (row.id === id ? { ...row, enabled: !row.enabled } : row));
    setCatalog(next);
    saveModelCatalog(next);
  };

  return (
    <section className="settings-page">
      <div className="console-card settings-head">
        <div>
          <h2>
            <Building2 size={16} /> 企业设置
          </h2>
          <p>成员与权限、品牌与业务配置、模型目录与价格。本机留档，接入云端成员体系后置——当前名单只在本浏览器生效。</p>
        </div>
        <div className="settings-stats">
          <span>{members.length} 名成员</span>
          <span>{enabledCatalog.length} 个启用模型</span>
        </div>
      </div>

      {error && <p className="form-error settings-banner">{error}</p>}
      {notice && <p className="settings-notice">{notice}</p>}

      <div className="console-card">
        <div className="console-card-header">
          <div>
            <h2>
              <Users size={15} /> 成员与权限
            </h2>
            <p>角色：管理员 / 运营 / 只读；至少保留 1 名启用管理员（删除与降级都会被拦截）</p>
          </div>
          <div className="settings-actions">
            <input
              className="settings-search"
              value={memberKeyword}
              onChange={(event) => setMemberKeyword(event.target.value)}
              placeholder="搜索姓名/备注"
            />
            <button type="button" className="button button-primary" onClick={() => setEditing(createMember(""))}>
              <UserPlus size={14} />新增成员
            </button>
          </div>
        </div>

        <div className="settings-body">
          {editing && (
            <div className="settings-form">
              <label>
                <span>姓名 *</span>
                <input value={editing.name} onChange={(event) => setEditing({ ...editing, name: event.target.value })} placeholder="如：王经理" />
              </label>
              <label>
                <span>角色</span>
                <select value={editing.role} onChange={(event) => setEditing({ ...editing, role: event.target.value as MemberRole })}>
                  {MEMBER_ROLES.map((role) => (
                    <option key={role} value={role}>
                      {role}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>状态</span>
                <select value={editing.status} onChange={(event) => setEditing({ ...editing, status: event.target.value as MemberStatus })}>
                  {MEMBER_STATUSES.map((status) => (
                    <option key={status} value={status}>
                      {status}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>备注</span>
                <input value={editing.note} onChange={(event) => setEditing({ ...editing, note: event.target.value })} placeholder="选填，如负责门店" />
              </label>
              <div className="settings-form-actions">
                <button type="button" className="button button-secondary" onClick={() => setEditing(null)}>
                  取消
                </button>
                <button type="button" className="button button-primary" onClick={saveEditingMember}>
                  <Save size={14} />保存成员
                </button>
              </div>
            </div>
          )}

          {visibleMembers.length === 0 ? (
            <p className="form-hint">还没有成员（或无匹配）。点「新增成员」先建一名管理员。</p>
          ) : (
            <ul className="settings-member-list">
              {visibleMembers.map((member) => (
                <li key={member.id} className={member.status === "停用" ? "disabled" : ""}>
                  <div className="settings-member-info">
                    <strong>
                      {member.name}
                      <em className="settings-role-badge">{member.role}</em>
                      {member.status === "停用" && <em className="settings-role-badge muted">已停用</em>}
                    </strong>
                    {member.note && <span>{member.note}</span>}
                  </div>
                  <div className="settings-actions">
                    <button type="button" className="text-link" onClick={() => setEditing(member)}>
                      编辑
                    </button>
                    <button type="button" className="text-link" onClick={() => removeMember(member.id)}>
                      <Trash2 size={13} />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="console-card">
        <div className="console-card-header">
          <div>
            <h2>品牌与业务配置</h2>
            <p>保存后生成「品牌上下文」片段，后续任务编排可引用（本批先预览，不改任务链路）</p>
          </div>
        </div>
        <div className="settings-body">
          <div className="settings-form">
            <label>
              <span>品牌名称</span>
              <input value={brand.brandName} onChange={(event) => setBrand({ ...brand, brandName: event.target.value })} placeholder="如：示例餐饮" />
            </label>
            <label>
              <span>所属行业</span>
              <input value={brand.industry} onChange={(event) => setBrand({ ...brand, industry: event.target.value })} placeholder="如：本地生活" />
            </label>
            <label>
              <span>品牌口号</span>
              <input value={brand.slogan} onChange={(event) => setBrand({ ...brand, slogan: event.target.value })} placeholder="选填" />
            </label>
            <label>
              <span>表达语气</span>
              <input value={brand.tone} onChange={(event) => setBrand({ ...brand, tone: event.target.value })} placeholder="如：专业克制 / 亲切口语" />
            </label>
            <label className="settings-form-wide">
              <span>话术红线（每行一条，生成内容时禁止出现）</span>
              <textarea
                rows={3}
                value={brand.redlines.join("\n")}
                onChange={(event) => setBrand({ ...brand, redlines: event.target.value.split("\n") })}
                placeholder={"全网最低\n稳赚不赔"}
              />
            </label>
            <div className="settings-form-actions">
              <button type="button" className="button button-primary" onClick={saveBrand}>
                <Save size={14} />保存品牌配置
              </button>
            </div>
          </div>
          <div className="settings-context">
            <span>品牌上下文预览（可注入提示词）</span>
            <pre>{brandContext || "（尚未填写，填写品牌信息后这里会生成上下文片段）"}</pre>
          </div>
        </div>
      </div>

      <div className="console-card">
        <div className="console-card-header">
          <div>
            <h2>模型目录与价格</h2>
            <p>内置为示例价格，正式计费前请按厂商官网核对；价格可直接编辑，停用后不参与试算</p>
          </div>
        </div>
        <div className="settings-body">
          <div className="settings-table-wrap">
            <table className="settings-table">
              <thead>
                <tr>
                  <th>服务商</th>
                  <th>模型</th>
                  <th>输入价 /1k</th>
                  <th>输出价 /1k</th>
                  <th>币种</th>
                  <th>启用</th>
                </tr>
              </thead>
              <tbody>
                {catalog.map((row) => (
                  <tr key={row.id} className={row.enabled ? "" : "disabled"}>
                    <td>{row.provider}</td>
                    <td>{row.model}</td>
                    <td>
                      <input
                        type="number"
                        min="0"
                        step="0.0001"
                        value={row.inputPricePer1k}
                        onChange={(event) => updateCatalogPrice(row.id, "inputPricePer1k", event.target.value)}
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        min="0"
                        step="0.0001"
                        value={row.outputPricePer1k}
                        onChange={(event) => updateCatalogPrice(row.id, "outputPricePer1k", event.target.value)}
                      />
                    </td>
                    <td>{row.currency}</td>
                    <td>
                      <input type="checkbox" checked={row.enabled} onChange={() => toggleCatalog(row.id)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="settings-trial">
            <h3>
              <Calculator size={14} /> 费用试算
            </h3>
            <div className="settings-form">
              <label>
                <span>模型</span>
                <select value={trialEntry?.id ?? ""} onChange={(event) => setTrialModelId(event.target.value)}>
                  {enabledCatalog.map((row) => (
                    <option key={row.id} value={row.id}>
                      {row.provider} · {row.model}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>输入 tokens</span>
                <input type="number" min="0" value={trialInput} onChange={(event) => setTrialInput(event.target.value)} />
              </label>
              <label>
                <span>输出 tokens</span>
                <input type="number" min="0" value={trialOutput} onChange={(event) => setTrialOutput(event.target.value)} />
              </label>
            </div>
            <p className="settings-trial-result">
              预估费用：<strong>{trialEntry ? `${trialCost} ${trialEntry.currency}` : "—"}</strong>
              <span>（tokens 口径与「配额与消耗」一致，为趋势估算）</span>
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
