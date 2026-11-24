import { useCallback, useEffect, useMemo, useState } from "react";
import { ClipboardCopy, Download, LoaderCircle, Mic, ScrollText, ShieldCheck, Sparkles, Trash2 } from "lucide-react";
import {
  MEDIA_ROLES,
  canSetRole,
  groupMedia,
  listMedia,
  listByRole,
  updateMedia,
  type MediaAsset,
  type MediaRole,
} from "../cloud/media";
import { buildSrt } from "../cloud/mixcut";
import {
  COPY_SOURCES,
  buildDigitalRecipe,
  digitalPlanMarkdown,
  generateCopyDrafts,
  generateDigitalPlan,
  loadCopyDrafts,
  loadSavedDigitalPlans,
  removeCopyDraftSet,
  removeSavedDigitalPlan,
  saveCopyDrafts,
  saveDigitalPlan,
  type CopyDraftSet,
  type CopySource,
  type DigitalPlan,
  type StoredDigitalPlan,
} from "../cloud/digital";

const INDUSTRIES = ["餐饮", "美妆", "教育", "家居", "电商", "本地生活", "通用"];
const DURATIONS = [15, 30, 60];
const COUNTS = [3, 5, 8];

function downloadFile(filename: string, content: string, mime = "text/plain;charset=utf-8"): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString("zh-CN", { hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

/**
 * 数字人工坊（L1 文案三来源 + L2 口播方案与本机合成导出 + 素材角色标注）。
 * L3 TTS（火山/豆包）与 L4 数字人 API 为适配器后置，本模块保证结构可对接。
 */
export function DigitalStudio() {
  const [tab, setTab] = useState<"copy" | "plan" | "roles">("copy");

  // L1 文案工坊
  const [source, setSource] = useState<CopySource>("industry");
  const [industry, setIndustry] = useState(INDUSTRIES[0]);
  const [copyTopic, setCopyTopic] = useState("");
  const [raw, setRaw] = useState("");
  const [count, setCount] = useState(5);
  const [drafts, setDrafts] = useState<{ items: string[]; demo: boolean } | null>(null);
  const [copySets, setCopySets] = useState<CopyDraftSet[]>([]);

  // L2 口播方案
  const [planTopic, setPlanTopic] = useState("");
  const [planIndustry, setPlanIndustry] = useState(INDUSTRIES[0]);
  const [duration, setDuration] = useState(30);
  const [brollGroups, setBrollGroups] = useState<string[]>([]);
  const [plan, setPlan] = useState<DigitalPlan | null>(null);
  const [planTopicEcho, setPlanTopicEcho] = useState("");
  const [savedPlans, setSavedPlans] = useState<StoredDigitalPlan[]>([]);

  // 素材角色
  const [assets, setAssets] = useState<MediaAsset[]>([]);
  const [confirmed, setConfirmed] = useState<Record<string, boolean>>({});

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const notify = useCallback((message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice(""), 4500);
  }, []);

  const refreshMedia = useCallback(async () => {
    const rows = await listMedia();
    setAssets(rows);
  }, []);

  useEffect(() => {
    void refreshMedia();
    setCopySets(loadCopyDrafts());
    setSavedPlans(loadSavedDigitalPlans());
  }, [refreshMedia]);

  const groups = useMemo(() => groupMedia(assets), [assets]);
  const avatar = useMemo(() => listByRole(assets, "avatar").find((item) => item.kind === "video") ?? null, [assets]);
  const voice = useMemo(() => listByRole(assets, "voice").find((item) => item.kind === "audio") ?? null, [assets]);

  const sourceMeta = COPY_SOURCES.find((item) => item.value === source) ?? COPY_SOURCES[0];

  /* ------------------------------ L1 ------------------------------ */
  const runCopy = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await generateCopyDrafts({ source, industry, topic: copyTopic, raw, count });
      setDrafts({ items: result.drafts, demo: result.demo });
      notify(result.demo ? "模型不可用，已给出演示稿（可直接改）" : `已生成 ${result.drafts.length} 条口播稿`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "生成失败");
    } finally {
      setBusy(false);
    }
  };

  const archiveDrafts = () => {
    if (!drafts) return;
    setCopySets(
      saveCopyDrafts({
        savedAt: Date.now(),
        source,
        industry,
        topic: copyTopic || raw.slice(0, 12),
        drafts: drafts.items,
        demo: drafts.demo,
      }),
    );
    notify("口播稿已留档（本机最多 20 组）");
  };

  /* ------------------------------ L2 ------------------------------ */
  const runPlan = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await generateDigitalPlan({ topic: planTopic, industry: planIndustry, duration, brollGroups });
      setPlan(result);
      setPlanTopicEcho(planTopic);
      saveDigitalPlan({ topic: planTopic, industry: planIndustry, plan: result });
      setSavedPlans(loadSavedDigitalPlans());
      notify(result.demo ? "模型不可用，已给出模板方案（结构完整）" : "口播方案已生成并留档");
    } catch (err) {
      setError(err instanceof Error ? err.message : "方案生成失败");
    } finally {
      setBusy(false);
    }
  };

  const exportRecipe = (shell: "sh" | "bat") => {
    if (!plan) return;
    try {
      const recipe = buildDigitalRecipe(plan, assets, { shell });
      downloadFile(shell === "sh" ? "make-digital.sh" : "make-digital.bat", recipe.script);
      notify(
        `脚本已导出（${recipe.mode} 模式${recipe.skipped ? ` · ${recipe.skipped} 段副画面跳过` : ""}），连同 sub.srt 与素材放同目录运行`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "脚本导出失败");
    }
  };

  const exportSrt = () => {
    if (!plan) return;
    downloadFile("sub.srt", buildSrt(plan.segments));
    notify("字幕已导出为 sub.srt（合成脚本按此文件名烧录）");
  };

  /* --------------------------- 素材角色 --------------------------- */
  const changeRole = async (asset: MediaAsset, role: MediaRole | "") => {
    if (!canSetRole(role, confirmed[asset.id] ?? false)) {
      setError(`「${asset.name}」标注为${role === "avatar" ? "形象" : "声音"}前，请先勾选授权确认`);
      return;
    }
    setError("");
    try {
      if (role) await updateMedia(asset.id, { role: role as MediaRole });
      else await updateMedia(asset.id, { role: undefined });
      await refreshMedia();
      notify(role ? `已标注为「${MEDIA_ROLES.find((item) => item.value === role)?.label}」` : "已清除角色标注");
    } catch (err) {
      setError(err instanceof Error ? err.message : "标注失败");
    }
  };

  return (
    <section className="digital-page">
      <div className="console-card digital-head">
        <div>
          <h2>
            <Mic size={16} /> 数字人工坊
          </h2>
          <p>
            L1 文案三来源 → L2 口播方案（段落绑定副画面）→ 导出 SRT + ffmpeg 脚本<b>本机出片</b>（沙箱不转码）。
            TTS（火山/豆包）与数字人合成 API 为适配器<b>接入后置</b>，结构已预留。
            合规：形象素材需授权确认、音色只用平台官方音色、改写不照搬原句。
          </p>
        </div>
        <div className="office-tabs">
          <button type="button" className={tab === "copy" ? "active" : ""} onClick={() => setTab("copy")}>
            <ScrollText size={15} />文案工坊
          </button>
          <button type="button" className={tab === "plan" ? "active" : ""} onClick={() => setTab("plan")}>
            <Sparkles size={15} />口播方案
          </button>
          <button type="button" className={tab === "roles" ? "active" : ""} onClick={() => setTab("roles")}>
            <ShieldCheck size={15} />素材角色
          </button>
        </div>
      </div>

      {notice && <div className="pipeline-toast">{notice}</div>}
      {error && <p className="geo-error">{error}</p>}

      {/* ------------------------- L1 文案工坊 ------------------------- */}
      {tab === "copy" && (
        <div className="digital-grid">
          <div className="console-card office-form">
            <div className="console-card-header">
              <div>
                <h2>批量口播稿</h2>
                <p>{sourceMeta.hint}</p>
              </div>
            </div>

            <label className="office-field">
              <span>文案来源</span>
              <select value={source} onChange={(event) => setSource(event.target.value as CopySource)}>
                {COPY_SOURCES.map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>

            {source === "industry" && (
              <>
                <label className="office-field">
                  <span>行业</span>
                  <select value={industry} onChange={(event) => setIndustry(event.target.value)}>
                    {INDUSTRIES.map((item) => (
                      <option key={item}>{item}</option>
                    ))}
                  </select>
                </label>
                <label className="office-field">
                  <span>主题/产品</span>
                  <input value={copyTopic} onChange={(event) => setCopyTopic(event.target.value)} placeholder="例：社区面包店开业" />
                </label>
              </>
            )}

            {source === "industry" ? (
              <label className="office-field">
                <span>{sourceMeta.fieldLabel}</span>
                <input value={raw} onChange={(event) => setRaw(event.target.value)} placeholder={sourceMeta.placeholder} />
              </label>
            ) : (
              <label className="office-field">
                <span>{sourceMeta.fieldLabel}</span>
                <textarea value={raw} onChange={(event) => setRaw(event.target.value)} rows={6} placeholder={sourceMeta.placeholder} />
              </label>
            )}

            <label className="office-field">
              <span>生成条数</span>
              <select value={count} onChange={(event) => setCount(Number(event.target.value))}>
                {COUNTS.map((item) => (
                  <option key={item} value={item}>
                    {item} 条
                  </option>
                ))}
              </select>
            </label>

            <button type="button" className="button button-primary" onClick={() => void runCopy()} disabled={busy}>
              {busy ? <LoaderCircle size={15} className="spin" /> : <Sparkles size={15} />}
              生成口播稿
            </button>
          </div>

          <div className="console-card office-preview">
            <div className="console-card-header">
              <div>
                <h2>{drafts ? `口播稿（${drafts.items.length}）` : "预览区"}</h2>
                <p>{drafts ? (drafts.demo ? "演示稿 · 模型不可用降级" : "AI 生成 · 结构：钩子→痛点→证据→行动") : "生成后可逐条复制"}</p>
              </div>
              {drafts && (
                <button type="button" className="button button-secondary" onClick={archiveDrafts}>
                  留档
                </button>
              )}
            </div>
            {drafts ? (
              <ol className="digital-drafts">
                {drafts.items.map((item, index) => (
                  <li key={`${index}-${item.slice(0, 12)}`}>
                    <span className="digital-draft-index">{index + 1}</span>
                    <p>{item}</p>
                    <button
                      type="button"
                      className="text-link"
                      onClick={() => {
                        void copyText(item).then((ok) => notify(ok ? "已复制" : "复制失败"));
                      }}
                    >
                      <ClipboardCopy size={13} />复制
                    </button>
                  </li>
                ))}
              </ol>
            ) : (
              <div className="console-card module-page-card empty-search">
                <ScrollText size={24} />
                <strong>还没有口播稿</strong>
                <span>选来源、填材料后点「生成口播稿」</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ------------------------- L2 口播方案 ------------------------- */}
      {tab === "plan" && (
        <div className="digital-grid">
          <div className="console-card office-form">
            <div className="console-card-header">
              <div>
                <h2>口播方案</h2>
                <p>
                  形象：{avatar ? avatar.name : "未标注（脚本退化为分镜模式）"} · 配音：
                  {voice ? voice.name : "无（用素材原声或后接 TTS）"}
                </p>
              </div>
            </div>

            <label className="office-field">
              <span>主题</span>
              <input value={planTopic} onChange={(event) => setPlanTopic(event.target.value)} placeholder="例：三步讲清社区店引流" />
            </label>
            <div className="office-form-row">
              <label className="office-field">
                <span>行业</span>
                <select value={planIndustry} onChange={(event) => setPlanIndustry(event.target.value)}>
                  {INDUSTRIES.map((item) => (
                    <option key={item}>{item}</option>
                  ))}
                </select>
              </label>
              <label className="office-field">
                <span>时长</span>
                <select value={duration} onChange={(event) => setDuration(Number(event.target.value))}>
                  {DURATIONS.map((item) => (
                    <option key={item} value={item}>
                      {item} 秒
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="broadcast-filters">
              <div>
                <strong>副画面素材组（段落绑定，讲到即切出）</strong>
                <div className="broadcast-chips">
                  {groups.length === 0 && <span className="digital-empty-hint">素材库还没有分组，上传素材后可绑定</span>}
                  {groups.map((group) => (
                    <button
                      type="button"
                      key={group.name}
                      className={brollGroups.includes(group.name) ? "active" : ""}
                      onClick={() =>
                        setBrollGroups((prev) =>
                          prev.includes(group.name) ? prev.filter((item) => item !== group.name) : [...prev, group.name],
                        )
                      }
                    >
                      {group.name}（{group.assets.length}）
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <button type="button" className="button button-primary" onClick={() => void runPlan()} disabled={busy}>
              {busy ? <LoaderCircle size={15} className="spin" /> : <Sparkles size={15} />}
              生成口播方案
            </button>

            {plan && (
              <div className="digital-exports">
                <button type="button" className="button button-secondary" onClick={() => downloadFile(`数字人口播方案-${new Date().toISOString().slice(0, 10)}.md`, digitalPlanMarkdown(plan, { topic: planTopicEcho, industry: planIndustry }), "text/markdown;charset=utf-8")}>
                  <Download size={14} />方案 .md
                </button>
                <button type="button" className="button button-secondary" onClick={exportSrt}>
                  <Download size={14} />字幕 sub.srt
                </button>
                <button type="button" className="button button-primary" onClick={() => exportRecipe("sh")}>
                  <Download size={14} />ffmpeg .sh
                </button>
                <button type="button" className="button button-secondary" onClick={() => exportRecipe("bat")}>
                  <Download size={14} />.bat
                </button>
              </div>
            )}
          </div>

          <div className="console-card office-preview">
            <div className="console-card-header">
              <div>
                <h2>{plan ? plan.title : "预览区"}</h2>
                <p>
                  {plan
                    ? `${plan.segments.length} 段 · ${plan.totalDuration}s${plan.demo ? " · 模板降级" : ""} · 配音版本 ${plan.voiceVersions.length}`
                    : "生成后预览分段、字幕与副画面绑定"}
                </p>
              </div>
            </div>

            {plan ? (
              <div className="digital-plan">
                <div className="mix-scenes">
                  {plan.segments.map((segment) => (
                    <div className="mix-scene" key={`${segment.order}-${segment.subtitle}`}>
                      <em>{segment.duration}s</em>
                      <span className="mix-scene-group">{segment.brollGroup ?? "主画面"}</span>
                      <span className="mix-scene-body">
                        <strong>
                          {segment.order}. {segment.subtitle}
                        </strong>
                        <small>{segment.script}</small>
                      </span>
                    </div>
                  ))}
                </div>

                {plan.voiceVersions.length > 0 && (
                  <div className="mix-voices">
                    <h3>配音多版本（事实一致、表达各异）</h3>
                    {plan.voiceVersions.map((item, index) => (
                      <div className="mix-voice" key={`${index}-${item.slice(0, 10)}`}>
                        <p>{item}</p>
                        <button
                          type="button"
                          className="text-link"
                          onClick={() => {
                            void copyText(item).then((ok) => notify(ok ? "已复制" : "复制失败"));
                          }}
                        >
                          <ClipboardCopy size={13} />复制
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                {plan.assetHints.length > 0 && (
                  <div className="mix-notes">
                    <h3>素材提示</h3>
                    <ul>
                      {plan.assetHints.map((hint) => (
                        <li key={hint}>{hint}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            ) : (
              <div className="console-card module-page-card empty-search">
                <Sparkles size={24} />
                <strong>还没有方案</strong>
                <span>填主题后点「生成口播方案」</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ------------------------- 素材角色 ------------------------- */}
      {tab === "roles" && (
        <div className="console-card digital-roles">
          <div className="console-card-header">
            <div>
              <h2>素材角色标注</h2>
              <p>
                形象=口播主画面（自录模特视频）· 声音=配音音频 · 分镜素材=副画面图片。
                <strong>标注形象/声音前必须勾选授权确认</strong>（肖像与音色合规门禁）
              </p>
            </div>
            <span className="digital-role-summary">
              形象 {listByRole(assets, "avatar").length} · 声音 {listByRole(assets, "voice").length} · 分镜{" "}
              {listByRole(assets, "broll").length}
            </span>
          </div>

          {assets.length === 0 ? (
            <div className="console-card module-page-card empty-search">
              <ShieldCheck size={24} />
              <strong>素材库为空</strong>
              <span>先到「混剪工坊」上传素材，再回这里标注角色</span>
            </div>
          ) : (
            <ul className="digital-role-list">
              {assets.map((asset) => {
                const needsLicense = !asset.role || asset.role === "avatar" || asset.role === "voice";
                const licensed = confirmed[asset.id] ?? false;
                return (
                  <li key={asset.id}>
                    <div className="digital-role-info">
                      <strong>{asset.name}</strong>
                      <span>
                        {asset.kind === "video" ? "视频" : asset.kind === "image" ? "图片" : "音频"} · {asset.group}
                        {asset.role ? ` · ${MEDIA_ROLES.find((item) => item.value === asset.role)?.label}` : ""}
                      </span>
                    </div>
                    <div className="digital-role-actions">
                      {needsLicense && (
                        <label className="digital-license" title="我确认拥有该形象/音色的授权或为本人录制">
                          <input
                            type="checkbox"
                            checked={licensed}
                            onChange={(event) => setConfirmed((prev) => ({ ...prev, [asset.id]: event.target.checked }))}
                          />
                          授权确认
                        </label>
                      )}
                      <select value={asset.role ?? ""} onChange={(event) => void changeRole(asset, event.target.value as MediaRole | "")}>
                        <option value="">无角色</option>
                        {MEDIA_ROLES.map((item) => (
                          <option key={item.value} value={item.value}>
                            {item.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {/* ------------------------- 留档 ------------------------- */}
      {tab === "copy" && copySets.length > 0 && (
        <div className="console-card mix-saved">
          <div className="console-card-header">
            <div>
              <h2>口播稿留档（{copySets.length}）</h2>
              <p>本机最多 20 组</p>
            </div>
          </div>
          <ul>
            {copySets.map((row) => (
              <li key={row.savedAt}>
                <div className="mix-saved-info">
                  <strong>{row.topic || "未命名"}</strong>
                  <span>
                    {COPY_SOURCES.find((item) => item.value === row.source)?.label} · {row.industry || "通用"} · {row.drafts.length} 条 ·{" "}
                    {formatTime(row.savedAt)}
                    {row.demo ? " · 演示" : ""}
                  </span>
                </div>
                <div className="mix-saved-actions">
                  <button
                    type="button"
                    className="text-link"
                    onClick={() => {
                      setDrafts({ items: row.drafts, demo: row.demo });
                      notify("已载入留档");
                    }}
                  >
                    载入
                  </button>
                  <button
                    type="button"
                    className="text-link"
                    onClick={() => setCopySets(removeCopyDraftSet(row.savedAt))}
                  >
                    <Trash2 size={13} />删除
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {tab === "plan" && savedPlans.length > 0 && (
        <div className="console-card mix-saved">
          <div className="console-card-header">
            <div>
              <h2>方案留档（{savedPlans.length}）</h2>
              <p>生成即自动留档，本机最多 20 份</p>
            </div>
          </div>
          <ul>
            {savedPlans.map((row) => (
              <li key={row.savedAt}>
                <div className="mix-saved-info">
                  <strong>{row.plan.title}</strong>
                  <span>
                    {row.topic} · {row.plan.totalDuration}s · {row.plan.segments.length} 段 · {formatTime(row.savedAt)}
                    {row.plan.demo ? " · 模板降级" : ""}
                  </span>
                </div>
                <div className="mix-saved-actions">
                  <button
                    type="button"
                    className="text-link"
                    onClick={() => {
                      setPlan(row.plan);
                      setPlanTopic(row.topic);
                      setPlanTopicEcho(row.topic);
                      setPlanIndustry(row.industry);
                      notify("已载入方案");
                    }}
                  >
                    载入
                  </button>
                  <button
                    type="button"
                    className="text-link"
                    onClick={() => setSavedPlans(removeSavedDigitalPlan(row.savedAt))}
                  >
                    <Trash2 size={13} />删除
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

export default DigitalStudio;
