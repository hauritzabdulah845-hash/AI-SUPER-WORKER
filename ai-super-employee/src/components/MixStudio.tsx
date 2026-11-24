import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  Copy,
  Download,
  Film,
  LoaderCircle,
  Music,
  Scissors,
  Trash2,
  Upload,
} from "lucide-react";
import {
  formatSize,
  groupMedia,
  importMedia,
  listMedia,
  removeMedia,
  type MediaAsset,
} from "../cloud/media";
import {
  buildFfmpegRecipe,
  buildSrt,
  generateMixPlan,
  loadSavedPlans,
  planMarkdown,
  removeSavedPlan,
  savePlan,
  type MixPlan,
  type StoredMixPlan,
} from "../cloud/mixcut";

const STYLES = ["口播向", "产品展示", "氛围向"];
const DURATIONS = [15, 30, 60];

function downloadFile(filename: string, content: string, mime = "text/plain;charset=utf-8") {
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
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(area);
    return ok;
  }
}

/**
 * 混剪工坊：素材库（左）→ 分镜方案（右）→ 导出 SRT / ffmpeg 脚本。
 * 转码不进浏览器：本机有 ffmpeg 就跑导出的脚本，没有就把方案交给剪映/PR。
 */
export function MixStudio() {
  const [assets, setAssets] = useState<MediaAsset[]>([]);
  const [uploadGroup, setUploadGroup] = useState("");
  const [uploading, setUploading] = useState(false);
  const [topic, setTopic] = useState("");
  const [style, setStyle] = useState(STYLES[0]);
  const [duration, setDuration] = useState(30);
  const [versions, setVersions] = useState(3);
  const [selectedGroups, setSelectedGroups] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [plan, setPlan] = useState<MixPlan | null>(null);
  const [saved, setSaved] = useState<StoredMixPlan[]>([]);

  useEffect(() => {
    setSaved(loadSavedPlans());
  }, []);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const groups = useMemo(() => groupMedia(assets), [assets]);

  const refresh = useCallback(async () => {
    const rows = await listMedia();
    setAssets(rows);
    setSelectedGroups((current) => (current.length ? current : groupMedia(rows).map((item) => item.name)));
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setUploading(true);
    setError("");
    try {
      const { added, skipped } = await importMedia(Array.from(files), uploadGroup);
      await refresh();
      const addedGroups = Array.from(new Set(added.map((item) => item.group)));
      setSelectedGroups((current) => Array.from(new Set([...current, ...addedGroups])));
      setNotice(`已导入 ${added.length} 个素材${skipped.length ? `，跳过 ${skipped.length} 个：${skipped.join("、")}` : ""}`);
      setUploadGroup("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "素材导入失败");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const removeAsset = async (id: string) => {
    await removeMedia(id);
    await refresh();
    setNotice("素材已删除");
  };

  const toggleGroup = (name: string) => {
    setSelectedGroups((current) =>
      current.includes(name) ? current.filter((item) => item !== name) : [...current, name],
    );
  };

  const runGenerate = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const chosen = groups.filter((item) => selectedGroups.includes(item.name));
      const result = await generateMixPlan({
        topic,
        style,
        duration,
        versions,
        groups: chosen.map((item) => ({
          name: item.name,
          count: item.assets.length,
          hints: item.assets.map((asset) => asset.name),
        })),
      });
      setPlan(result);
      savePlan({ topic, style, plan: result });
      setSaved(loadSavedPlans());
      setNotice(result.demo ? "模型不可用，已给出模板方案（结构完整，可直接改）" : "混剪方案已生成");
    } catch (err) {
      setError(err instanceof Error ? err.message : "方案生成失败");
    } finally {
      setBusy(false);
    }
  };

  const copyVersion = async (text: string) => {
    const ok = await copyText(text);
    setNotice(ok ? "配音文案已复制" : "复制失败");
  };

  const exportAll = () => {
    if (!plan) return;
    const stamp = new Date().toISOString().slice(0, 10);
    downloadFile(`混剪方案-${stamp}.md`, planMarkdown(plan, { topic, style }), "text/markdown;charset=utf-8");
    setNotice("方案已导出（.md）");
  };

  const exportSrt = () => {
    if (!plan) return;
    downloadFile(`混剪字幕-${new Date().toISOString().slice(0, 10)}.srt`, buildSrt(plan.scenes));
    setNotice("字幕已导出（.srt）");
  };

  const exportRecipe = (shell: "sh" | "bat") => {
    if (!plan) return;
    const result = buildFfmpegRecipe(plan.scenes, groups, { shell });
    if (result.skipped > 0) {
      setNotice(`注意：${result.skipped} 个镜头所在素材组为空，已在脚本中跳过`);
    } else {
      setNotice(`ffmpeg 脚本已导出（${result.mode === "trim" ? "精确裁剪" : "粗拼"}模式）`);
    }
    downloadFile(`混剪-${shell === "sh" ? "make.sh" : "make.bat"}`, result.script, "text/plain;charset=utf-8");
  };

  const assetCount = assets.length;

  return (
    <section className="mix-layout">
      <div className="console-card mix-library">
        <div className="console-card-header">
          <div>
            <h2><Film size={16} /> 素材库</h2>
            <p>按场景/镜头组归类（{groups.length} 组 · {assetCount} 个素材）· 存本机，不上传</p>
          </div>
          <button type="button" className="button button-primary" onClick={() => fileInputRef.current?.click()} disabled={uploading}>
            {uploading ? <LoaderCircle size={14} className="spin" /> : <Upload size={14} />}上传素材
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            accept="video/*,image/*,audio/*"
            onChange={(event) => void upload(event.target.files)}
          />
        </div>

        <div className="mix-upload-row">
          <input
            value={uploadGroup}
            onChange={(event) => setUploadGroup(event.target.value)}
            placeholder="归入场景组，例如：开场钩子 / 产品特写 / 门店实拍"
          />
          <small>不填则进「未分组」；支持 mp4/mov/图片/mp3，单个 ≤300MB</small>
        </div>

        {groups.length === 0 && (
          <div className="empty-search mix-empty">
            <Film size={24} />
            <strong>素材库还是空的</strong>
            <span>上传视频/图片并归组，混剪方案才能按组取材</span>
          </div>
        )}

        <div className="mix-groups">
          {groups.map((group) => (
            <div className="mix-group" key={group.name}>
              <div className="mix-group-head">
                <strong>{group.name}</strong>
                <em>{group.assets.length} 个</em>
              </div>
              <div className="mix-group-assets">
                {group.assets.map((asset) => (
                  <span className="mix-asset" key={asset.id} title={`${asset.name}${asset.duration ? ` · ${asset.duration}s` : ""}`}>
                    <i className={`kind-${asset.kind}`}>
                      {asset.kind === "audio" ? <Music size={11} /> : asset.kind === "video" ? <Film size={11} /> : <Check size={11} />}
                    </i>
                    {asset.name}
                    {asset.duration ? <em>{asset.duration}s</em> : null}
                    <small>{formatSize(asset.size)}</small>
                    <button type="button" aria-label={`删除${asset.name}`} onClick={() => void removeAsset(asset.id)}>
                      <Trash2 size={11} />
                    </button>
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="console-card mix-compose">
        <div className="console-card-header">
          <div>
            <h2><Scissors size={16} /> 混剪方案</h2>
            <p>分镜取材到组、转场与字幕到镜、配音出多版本；导出 SRT 与可执行 ffmpeg 脚本</p>
          </div>
        </div>

        <div className="mix-form">
          <label>
            主题 / 配音脚本
            <textarea
              value={topic}
              onChange={(event) => setTopic(event.target.value)}
              rows={4}
              placeholder="例如：山野茶饮开业短视频，突出现煮与围炉氛围，结尾引导到店"
            />
          </label>

          <div className="mix-options">
            <div className="video-option-group">
              <span>风格</span>
              {STYLES.map((item) => (
                <button key={item} type="button" className={style === item ? "active" : ""} onClick={() => setStyle(item)}>{item}</button>
              ))}
            </div>
            <div className="video-option-group">
              <span>时长</span>
              {DURATIONS.map((item) => (
                <button key={item} type="button" className={duration === item ? "active" : ""} onClick={() => setDuration(item)}>{item}s</button>
              ))}
            </div>
            <div className="video-option-group">
              <span>配音版本</span>
              {[2, 3].map((item) => (
                <button key={item} type="button" className={versions === item ? "active" : ""} onClick={() => setVersions(item)}>{item}</button>
              ))}
            </div>
          </div>

          <fieldset className="mix-group-pick">
            <legend>取材素材组</legend>
            {groups.length === 0 && <small className="geo-hint">先在左侧上传素材并归组</small>}
            {groups.map((group) => (
              <label key={group.name} className={selectedGroups.includes(group.name) ? "active" : ""}>
                <input type="checkbox" checked={selectedGroups.includes(group.name)} onChange={() => toggleGroup(group.name)} />
                {group.name}<small>{group.assets.length}</small>
              </label>
            ))}
          </fieldset>

          <div className="geo-actions">
            <button
              type="button"
              className="button button-primary"
              onClick={() => void runGenerate()}
              disabled={busy || !topic.trim() || selectedGroups.length === 0}
            >
              {busy ? <LoaderCircle size={15} className="spin" /> : <Scissors size={15} />}生成混剪方案
            </button>
            <small className="geo-hint">没有素材组时无法取材；只出方案不需要本机 ffmpeg</small>
          </div>
          {error && <p className="geo-error">{error}</p>}
          {notice && <p className="geo-notice">{notice}</p>}
        </div>
      </div>

      {plan && (
        <div className="console-card mix-plan">
          <div className="console-card-header">
            <div>
              <h2>{plan.title}</h2>
              <p>
                共 {plan.scenes.length} 镜 · 合计 {plan.totalDuration} 秒
                {plan.demo ? " · 模板降级产出（接入模型通道后可重新生成）" : ""}
              </p>
            </div>
            <div className="mix-export">
              <button type="button" className="button button-secondary" onClick={exportAll}><Download size={14} />方案 .md</button>
              <button type="button" className="button button-secondary" onClick={exportSrt}><Download size={14} />字幕 .srt</button>
              <button type="button" className="button button-primary" onClick={() => exportRecipe("sh")}><Download size={14} />ffmpeg .sh</button>
              <button type="button" className="button button-secondary" onClick={() => exportRecipe("bat")}><Download size={14} />.bat</button>
            </div>
          </div>

          <div className="mix-scenes">
            {plan.scenes.map((scene) => (
              <div className="mix-scene" key={`${scene.order}-${scene.group}`}>
                <em>{scene.duration}s</em>
                <span className="mix-scene-group">{scene.group}</span>
                <span className="mix-scene-body">
                  <strong>{scene.order}. {scene.shot}</strong>
                  <small>{scene.visual}</small>
                  <div>
                    <i>{scene.transition}</i>
                    {scene.subtitle && <q>{scene.subtitle}</q>}
                  </div>
                </span>
              </div>
            ))}
          </div>

          <div className="mix-voices">
            <h3>配音多版本（事实一致、表达各异，矩阵分发防重复）</h3>
            {plan.voiceVersions.map((item, index) => (
              <div className="mix-voice" key={`${item}-${index}`}>
                <p>{item}</p>
                <button type="button" className="text-link" onClick={() => void copyVersion(item)}>
                  <Copy size={13} />复制
                </button>
              </div>
            ))}
          </div>

          {plan.bgm && (
            <div className="mix-bgm">
              <h3><Music size={13} /> BGM 建议</h3>
              <p>{plan.bgm}</p>
            </div>
          )}

          {plan.notes.length > 0 && (
            <div className="mix-notes">
              <h3>注意</h3>
              <ul>{plan.notes.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}</ul>
            </div>
          )}
        </div>
      )}

      {saved.length > 0 && (
        <div className="console-card mix-saved">
          <div className="console-card-header">
            <div>
              <h2>留档方案（{saved.length}）</h2>
              <p>手动与「定时流水线」生成的方案都在这里，最多留 20 份，仅存本机</p>
            </div>
          </div>
          <ul>
            {saved.map((row) => (
              <li key={row.savedAt}>
                <div className="mix-saved-info">
                  <strong>{row.plan.title}</strong>
                  <span>
                    {row.topic} · {row.style} ·{" "}
                    {new Date(row.savedAt).toLocaleString("zh-CN", { hour12: false })}
                    {row.plan.demo ? " · 模板降级" : ""}
                  </span>
                </div>
                <div className="mix-saved-actions">
                  <button
                    type="button"
                    className="text-link"
                    onClick={() => {
                      void copyText(planMarkdown(row.plan, { topic: row.topic, style: row.style })).then((ok) =>
                        setNotice(ok ? "方案 Markdown 已复制" : "复制失败"),
                      );
                    }}
                  >
                    <Copy size={13} />复制
                  </button>
                  <button
                    type="button"
                    className="text-link"
                    onClick={() => {
                      removeSavedPlan(row.savedAt);
                      setSaved(loadSavedPlans());
                    }}
                  >
                    删除
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