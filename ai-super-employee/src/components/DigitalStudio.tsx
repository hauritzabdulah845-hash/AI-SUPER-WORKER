import { useCallback, useEffect, useMemo, useState } from "react";
import { ClipboardCopy, Download, Film, LoaderCircle, Mic, ScanSearch, ScrollText, ShieldCheck, Sparkles, Trash2 } from "lucide-react";
import {
  MEDIA_ROLES,
  canSetRole,
  groupMedia,
  listMedia,
  importMedia,
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
  planFromArticle,
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
import { loadTtsConfig, saveTtsConfig, synthesizeVoice, type TtsConfig } from "../cloud/tts";
import {
  advanceJob,
  loadDigitalJobs,
  loadDigitalProvider,
  refreshDigitalJob,
  saveDigitalJobs,
  saveDigitalProvider,
  submitDigitalJob,
  type DigitalJob,
  type DigitalProviderConfig,
} from "../cloud/digitalhuman";
import {
  analyzeAll,
  autoBindSegments,
  loadAnalyses,
  loadVisualConfig,
  saveAnalyses,
  saveVisualConfig,
  suggestBindings,
  type AssetAnalysis,
  type BindingSuggestion,
  type VisualConfig,
} from "../cloud/mediaanalysis";

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
  const [tab, setTab] = useState<"copy" | "plan" | "produce" | "analysis" | "roles">("copy");

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
  const [planSource, setPlanSource] = useState<"topic" | "article">("topic");
  const [article, setArticle] = useState("");

  // L3 配音 / L4 出片任务
  const [ttsConfig, setTtsConfig] = useState<TtsConfig>(() => loadTtsConfig());
  const [provider, setProvider] = useState<DigitalProviderConfig>(() => loadDigitalProvider());
  const [jobs, setJobs] = useState<DigitalJob[]>(() => loadDigitalJobs());
  const [voiceNote, setVoiceNote] = useState("");

  // 素材 AI 分析（启发式 + 视觉适配器）与话术对位
  const [visualConfig, setVisualConfig] = useState<VisualConfig>(() => loadVisualConfig());
  const [analyses, setAnalyses] = useState<AssetAnalysis[]>(() => loadAnalyses());
  const [bindings, setBindings] = useState<BindingSuggestion[]>([]);

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

  // demo 出片任务自动推进（纯函数更新；真实任务走手动刷新轮询）
  useEffect(() => {
    if (!jobs.some((job) => job.demo && (job.status === "queued" || job.status === "running"))) return;
    const timer = window.setInterval(() => {
      setJobs((prev) => {
        const next = prev.map(advanceJob);
        if (next.every((job, index) => job === prev[index])) return prev;
        saveDigitalJobs(next);
        return next;
      });
    }, 1200);
    return () => window.clearInterval(timer);
  }, [jobs]);

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
    if (planSource === "topic" && !planTopic.trim()) {
      setError("先填写口播主题");
      return;
    }
    if (planSource === "article" && article.trim().length < 40) {
      setError("长文至少 40 字（保留事实，不贴报价单）");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result =
        planSource === "article"
          ? await planFromArticle({ article, duration, brollGroups, industry: planIndustry })
          : await generateDigitalPlan({ topic: planTopic, industry: planIndustry, duration, brollGroups });
      const echo = planSource === "article" ? result.title : planTopic;
      setPlan(result);
      setPlanTopicEcho(echo);
      saveDigitalPlan({ topic: echo, industry: planIndustry, plan: result });
      setSavedPlans(loadSavedDigitalPlans());
      notify(result.demo ? "模型不可用，已给出模板/启发式方案（结构完整）" : "口播方案已生成并留档");
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

  /* --------------------------- L3 配音 / L4 出片 --------------------------- */
  const runVoice = async () => {
    if (busy) return;
    if (!plan) {
      setError("先到「口播方案」生成方案，再生成配音");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const fullText = plan.segments.map((segment) => segment.script).join("。");
      const result = await synthesizeVoice(ttsConfig, fullText);
      const name = `配音-${(planTopicEcho || "未命名").slice(0, 16)}.wav`;
      const file = new File([result.blob], name, { type: "audio/wav" });
      await importMedia([file], "配音");
      await refreshMedia();
      setVoiceNote(
        `${result.demo ? "演示" : "真实"}音轨已入库（${result.seconds}s）：${name}；在「素材角色」勾选授权后可标为「声音」`,
      );
      notify("配音已生成并入素材库");
    } catch (err) {
      setError(err instanceof Error ? err.message : "配音生成失败");
    } finally {
      setBusy(false);
    }
  };

  const runSubmitJob = async () => {
    if (!plan) {
      setError("先生成方案再提交出片任务");
      return;
    }
    let mode = "缺素材";
    try {
      mode = buildDigitalRecipe(plan, assets, { shell: "sh" }).mode;
    } catch {
      /* 素材不齐时用占位模式名，任务仍可提交 */
    }
    const job = await submitDigitalJob(plan.title, mode, provider);
    const next = [job, ...jobs].slice(0, 10);
    setJobs(next);
    saveDigitalJobs(next);
    notify(job.status === "failed" ? `提交失败：${job.note}` : job.demo ? "演示任务已入队" : "已提交到 L4 服务");
  };

  const refreshJobs = async () => {
    const next = await Promise.all(jobs.map((job) => refreshDigitalJob(job, provider)));
    setJobs(next);
    saveDigitalJobs(next);
  };

  /* --------------------------- 素材 AI 分析 / 话术对位 --------------------------- */
  const runAnalyzeAll = async () => {
    if (busy) return;
    if (!assets.length) {
      setError("素材库为空，先上传素材");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const rows = await analyzeAll(assets, visualConfig);
      setAnalyses(saveAnalyses(loadAnalyses().filter((row) => !rows.some((next) => next.assetId === row.assetId)).concat(rows)));
      const vision = rows.filter((row) => row.source === "vision").length;
      notify(`已分析 ${rows.length} 个素材（${vision ? `视觉 ${vision} 个` : "启发式"}）`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "分析失败");
    } finally {
      setBusy(false);
    }
  };

  const adoptSuggestedRole = async (asset: MediaAsset, analysis: AssetAnalysis) => {
    if (!analysis.suggestedRole) return;
    await changeRole(asset, analysis.suggestedRole);
  };

  const runBindings = () => {
    if (!plan) {
      setError("先生成口播方案，再做话术对位");
      return;
    }
    const groups = groupMedia(assets).map((group) => ({ name: group.name, assets: group.assets }));
    const suggestions = suggestBindings(plan.segments, groups);
    setBindings(suggestions);
    if (!suggestions.length) notify("没有达到阈值的匹配（段落与素材组关键词无重合）");
    else notify(`给出 ${suggestions.length} 条对位建议（只补空位，不覆盖已绑定）`);
  };

  const adoptBinding = (suggestion: BindingSuggestion) => {
    if (!plan) return;
    setPlan({
      ...plan,
      segments: plan.segments.map((segment) =>
        segment.order === suggestion.order ? { ...segment, brollGroup: suggestion.group } : segment,
      ),
    });
    setBindings((prev) => prev.filter((item) => item.order !== suggestion.order));
    notify(`第 ${suggestion.order} 段已绑定「${suggestion.group}」（导出前记得重新导出 SRT/脚本）`);
  };

  const adoptAllBindings = () => {
    if (!plan || !bindings.length) return;
    const result = autoBindSegments(plan.segments, bindings);
    setPlan({ ...plan, segments: result.segments });
    setBindings([]);
    notify(`已自动绑定 ${result.applied} 段、保留 ${result.kept} 段人工绑定`);
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
          <button type="button" className={tab === "produce" ? "active" : ""} onClick={() => setTab("produce")}>
            <Film size={15} />配音·出片
          </button>
          <button type="button" className={tab === "analysis" ? "active" : ""} onClick={() => setTab("analysis")}>
            <ScanSearch size={15} />智能分析
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
              <span>方案来源</span>
              <select value={planSource} onChange={(event) => setPlanSource(event.target.value as "topic" | "article")}>
                <option value="topic">主题生成（LLM / 模板降级）</option>
                <option value="article">长文降维（粘贴正文）</option>
              </select>
            </label>
            {planSource === "article" ? (
              <label className="office-field">
                <span>长文正文（≥40 字，保留事实）</span>
                <textarea
                  rows={6}
                  value={article}
                  onChange={(event) => setArticle(event.target.value)}
                  placeholder="粘贴文章/笔记正文，自动降维成 3~6 段口播分镜"
                />
              </label>
            ) : (
              <label className="office-field">
                <span>主题</span>
                <input value={planTopic} onChange={(event) => setPlanTopic(event.target.value)} placeholder="例：三步讲清社区店引流" />
              </label>
            )}
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

      {/* ------------------------- L3 配音 / L4 出片 ------------------------- */}
      {tab === "produce" && (
        <div className="digital-grid">
          <div className="console-card office-form">
            <div className="console-card-header">
              <div>
                <h2>
                  <Mic size={16} /> L3 配音（TTS）
                </h2>
                <p>demo 本机出占位音轨；拿到火山/豆包 Key 后把 HTTP 端点填进 generic（配置仅存本机，不内置厂商签名）。</p>
              </div>
            </div>
            <label className="office-field">
              <span>提供方</span>
              <select
                value={ttsConfig.provider}
                onChange={(event) => setTtsConfig({ ...ttsConfig, provider: event.target.value as "demo" | "generic" })}
              >
                <option value="demo">demo（本机占位音轨）</option>
                <option value="generic">generic（自配 HTTP 端点）</option>
              </select>
            </label>
            {ttsConfig.provider === "generic" && (
              <>
                <label className="office-field">
                  <span>服务地址</span>
                  <input
                    value={ttsConfig.baseUrl}
                    onChange={(event) => setTtsConfig({ ...ttsConfig, baseUrl: event.target.value })}
                    placeholder="https://tts.example.com"
                  />
                </label>
                <div className="office-form-row">
                  <label className="office-field">
                    <span>路径</span>
                    <input value={ttsConfig.path} onChange={(event) => setTtsConfig({ ...ttsConfig, path: event.target.value })} />
                  </label>
                  <label className="office-field">
                    <span>音色</span>
                    <input value={ttsConfig.voice} onChange={(event) => setTtsConfig({ ...ttsConfig, voice: event.target.value })} />
                  </label>
                </div>
              </>
            )}
            <div className="digital-exports">
              <button
                type="button"
                className="button button-secondary"
                onClick={() => {
                  saveTtsConfig(ttsConfig);
                  notify("配音配置已存本机");
                }}
              >
                保存配置
              </button>
              <button type="button" className="button button-primary" disabled={busy || !plan} onClick={() => void runVoice()}>
                {busy ? <LoaderCircle size={15} className="spin" /> : <Mic size={15} />}按当前方案生成配音
              </button>
            </div>
            {voiceNote && <p className="digital-empty-hint">{voiceNote}</p>}
            {!plan && <p className="digital-empty-hint">先到「口播方案」生成方案（配音时长按方案估算，2~60s）</p>}
          </div>

          <div className="console-card office-form">
            <div className="console-card-header">
              <div>
                <h2>
                  <Film size={16} /> L4 出片任务
                </h2>
                <p>未配置服务 → 演示任务队列；配置后 submit/poll 直连。真实转码仍走 L2 导出的 ffmpeg 脚本（本机）。</p>
              </div>
            </div>
            <label className="office-field">
              <span>服务地址（空 = 演示队列）</span>
              <input
                value={provider.baseUrl}
                onChange={(event) => setProvider({ ...provider, baseUrl: event.target.value })}
                placeholder="https://digital.example.com"
              />
            </label>
            <div className="office-form-row">
              <label className="office-field">
                <span>提交路径</span>
                <input value={provider.submitPath} onChange={(event) => setProvider({ ...provider, submitPath: event.target.value })} />
              </label>
              <label className="office-field">
                <span>轮询路径</span>
                <input value={provider.pollPath} onChange={(event) => setProvider({ ...provider, pollPath: event.target.value })} />
              </label>
            </div>
            <div className="office-form-row">
              <label className="office-field">
                <span>任务号字段</span>
                <input value={provider.idField} onChange={(event) => setProvider({ ...provider, idField: event.target.value })} />
              </label>
              <label className="office-field">
                <span>状态字段</span>
                <input value={provider.statusField} onChange={(event) => setProvider({ ...provider, statusField: event.target.value })} />
              </label>
              <label className="office-field">
                <span>完成值</span>
                <input value={provider.doneValue} onChange={(event) => setProvider({ ...provider, doneValue: event.target.value })} />
              </label>
            </div>
            <div className="digital-exports">
              <button
                type="button"
                className="button button-secondary"
                onClick={() => {
                  saveDigitalProvider(provider);
                  notify("出片服务配置已存本机");
                }}
              >
                保存配置
              </button>
              <button type="button" className="button button-primary" disabled={!plan} onClick={() => void runSubmitJob()}>
                <Film size={15} />提交出片任务
              </button>
              <button type="button" className="button button-secondary" disabled={!jobs.length} onClick={() => void refreshJobs()}>
                刷新进度
              </button>
            </div>
            <ul className="digital-drafts">
              {jobs.length === 0 && (
                <li>
                  <p className="digital-empty-hint">暂无任务；生成方案后可提交（演示队列可见进度推进）</p>
                </li>
              )}
              {jobs.map((job) => (
                <li key={job.id}>
                  <span className="digital-draft-index">{job.status === "done" ? "✓" : job.status === "failed" ? "!" : "…"}</span>
                  <p>
                    <strong>{job.topic}</strong>
                    <br />
                    <span className="digital-empty-hint">
                      {job.mode} · {job.note || job.status} · {job.progress}%
                    </span>
                  </p>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {/* ------------------------- 素材 AI 分析 / 话术对位 ------------------------- */}
      {tab === "analysis" && (
        <div className="digital-grid">
          <div className="console-card office-form">
            <div className="console-card-header">
              <div>
                <h2>
                  <ScanSearch size={16} /> 素材分析
                </h2>
                <p>启发式零依赖（文件名/类型/时长→标签与角色建议）；视觉模型走 generic 适配器，Key 到位填地址即接。</p>
              </div>
            </div>
            <label className="office-field">
              <span>分析引擎</span>
              <select
                value={visualConfig.provider}
                onChange={(event) => setVisualConfig({ ...visualConfig, provider: event.target.value as "heuristic" | "generic" })}
              >
                <option value="heuristic">heuristic（本机规则）</option>
                <option value="generic">generic（视觉模型端点）</option>
              </select>
            </label>
            {visualConfig.provider === "generic" && (
              <>
                <label className="office-field">
                  <span>服务地址</span>
                  <input
                    value={visualConfig.baseUrl}
                    onChange={(event) => setVisualConfig({ ...visualConfig, baseUrl: event.target.value })}
                    placeholder="https://vision.example.com"
                  />
                </label>
                <label className="office-field">
                  <span>路径</span>
                  <input value={visualConfig.path} onChange={(event) => setVisualConfig({ ...visualConfig, path: event.target.value })} />
                </label>
              </>
            )}
            <div className="digital-exports">
              <button
                type="button"
                className="button button-secondary"
                onClick={() => {
                  saveVisualConfig(visualConfig);
                  notify("视觉分析配置已存本机");
                }}
              >
                保存配置
              </button>
              <button type="button" className="button button-primary" disabled={busy || !assets.length} onClick={() => void runAnalyzeAll()}>
                {busy ? <LoaderCircle size={15} className="spin" /> : <ScanSearch size={15} />}分析全部素材（{assets.length}）
              </button>
            </div>

            <ul className="digital-role-list">
              {analyses.filter((row) => assets.some((asset) => asset.id === row.assetId)).length === 0 && (
                <li>
                  <span className="digital-empty-hint">还没有分析结果，点上方按钮开始（结果留档本机）</span>
                </li>
              )}
              {analyses
                .filter((row) => assets.some((asset) => asset.id === row.assetId))
                .map((row) => {
                  const asset = assets.find((item) => item.id === row.assetId);
                  if (!asset) return null;
                  return (
                    <li key={row.assetId}>
                      <div className="digital-role-info">
                        <strong>{asset.name}</strong>
                        <span>
                          {row.source === "vision" ? "👁 视觉识别" : "规则启发"} · 建议「
                          {row.suggestedRole === "avatar" ? "形象" : row.suggestedRole === "voice" ? "声音" : "分镜"}」· {row.roleReason}
                        </span>
                        <span>{row.note}</span>
                        <span className="analysis-tags">
                          {row.tags.map((tag) => (
                            <b key={tag}>{tag}</b>
                          ))}
                        </span>
                      </div>
                      <div className="digital-role-actions">
                        <button
                          type="button"
                          className="button button-secondary"
                          disabled={!row.suggestedRole || asset.role === row.suggestedRole}
                          onClick={() => void adoptSuggestedRole(asset, row)}
                        >
                          {asset.role === row.suggestedRole ? "已按建议标注" : "采纳建议"}
                        </button>
                      </div>
                    </li>
                  );
                })}
            </ul>
          </div>

          <div className="console-card office-form">
            <div className="console-card-header">
              <div>
                <h2>
                  <Sparkles size={16} /> 话术自动对位
                </h2>
                <p>按段落台词与素材组的关键词重合度给 brollGroup 建议——只补空位，不覆盖已绑定。</p>
              </div>
            </div>
            <div className="digital-exports">
              <button type="button" className="button button-primary" disabled={!plan} onClick={runBindings}>
                <Sparkles size={15} />按当前方案对位
              </button>
              {bindings.length > 0 && (
                <button type="button" className="button button-secondary" onClick={adoptAllBindings}>
                  全部采纳（{bindings.length}）
                </button>
              )}
            </div>
            {!plan && <p className="digital-empty-hint">先到「口播方案」生成方案</p>}
            {plan && bindings.length === 0 && (
              <p className="digital-empty-hint">点「按当前方案对位」分析 {plan.segments.length} 段台词与 {groupMedia(assets).length} 个素材组</p>
            )}
            <ul className="digital-drafts">
              {bindings.map((item) => (
                <li key={item.order}>
                  <span className="digital-draft-index">{item.order}</span>
                  <p>
                    「{item.segmentText}…」→ <strong>{item.group}</strong>
                    <br />
                    <span className="digital-empty-hint">
                      得分 {item.score} · {item.reason}
                    </span>
                  </p>
                  <button type="button" className="button button-secondary" onClick={() => adoptBinding(item)}>
                    采纳
                  </button>
                </li>
              ))}
            </ul>
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
