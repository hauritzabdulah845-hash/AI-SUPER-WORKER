import { friendlyError } from "../cloud/friendlyError";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CheckCircle2,
  Clapperboard,
  Copy,
  Download,
  Film,
  LoaderCircle,
  Plus,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import {
  clearVideoProvider,
  createVideoJob,
  hydrateVideoJobs,
  listVideoJobs,
  pollVideoJob,
  removeVideoJob,
  saveVideoJob,
  storyboardMarkdown,
  videoChannelStatus,
  type VideoJob,
  type VideoMode,
  type VideoSize,
} from "../cloud/video";
import { VideoChannelCard } from "./VideoChannelCard";

const MODES: { value: VideoMode; label: string; needImage: 0 | 1 | 2 }[] = [
  { value: "text2video", label: "文生视频", needImage: 0 },
  { value: "image2video", label: "图生视频", needImage: 1 },
  { value: "first-last", label: "首尾帧", needImage: 2 },
];

const SIZES: VideoSize[] = ["16:9", "9:16", "1:1"];
const DURATIONS = [4, 6, 8, 12];

function downloadText(filename: string, content: string) {
  const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
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

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    if (file.size > 5 * 1024 * 1024) {
      reject(new Error("参考图不能超过 5MB"));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("图片读取失败"));
    reader.readAsDataURL(file);
  });
}

/**
 * 成片播放：videoUrl 由加载/轮询阶段的 hydrateVideoJobs 补齐
 * （公网 URL 或本会话的对象地址），渲染路径保持纯净、无 effect。
 */
function VideoPlayer({ job }: { job: VideoJob }) {
  if (!job.videoUrl) return null;
  return <video className="video-player" src={job.videoUrl} controls preload="metadata" />;
}

/**
 * 视频创作工作台：演示模式（分镜脚本）与真实出片共用同一套表单与任务队列。
 * 通道配置在「模型接入」的视频通道卡片里维护，这里只读状态。
 */
export function VideoStudio() {
  const status = videoChannelStatus();
  const [mode, setMode] = useState<VideoMode>("text2video");
  const [prompt, setPrompt] = useState("");
  const [size, setSize] = useState<VideoSize>("9:16");
  const [duration, setDuration] = useState(6);
  const [count, setCount] = useState(1);
  const [image, setImage] = useState<string | undefined>(undefined);
  const [image2, setImage2] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [jobs, setJobs] = useState<VideoJob[]>([]);
  const [channelOpen, setChannelOpen] = useState(false);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const image2InputRef = useRef<HTMLInputElement | null>(null);

  const refresh = useCallback(async () => {
    setJobs(hydrateVideoJobs(await listVideoJobs()));
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const hasRunning = useMemo(() => jobs.some((item) => item.status === "running" && item.channel !== "demo"), [jobs]);

  // 远程任务轮询：有在跑的任务时每 5 秒查一次状态
  useEffect(() => {
    if (!hasRunning) return;
    const timer = window.setInterval(() => {
      void (async () => {
        const current = await listVideoJobs();
        const running = current.filter((item) => item.status === "running" && item.channel !== "demo");
        const updated = await Promise.all(running.map((item) => pollVideoJob(item)));
        for (const job of updated) {
          const before = current.find((item) => item.id === job.id);
          if (!before || before.status !== job.status || before.progress !== job.progress || before.error !== job.error) {
            // 状态变化才落库（含出片时新拿到的 Blob），轮询中的进度不写盘
            await saveVideoJob(job);
          }
        }
        setJobs(hydrateVideoJobs(await listVideoJobs()));
      })();
    }, 5000);
    return () => window.clearInterval(timer);
  }, [hasRunning]);

  const pickImage = async (file: File | undefined, which: 1 | 2) => {
    if (!file) return;
    setError("");
    try {
      const dataUrl = await readFileAsDataUrl(file);
      if (which === 1) setImage(dataUrl);
      else setImage2(dataUrl);
    } catch (err) {
      setError(err instanceof Error ? friendlyError(err) : "图片读取失败");
    }
  };

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const created: VideoJob[] = [];
      for (let index = 0; index < count; index += 1) {
        const job = await createVideoJob({ mode, prompt, size, duration, image, image2 });
        await saveVideoJob(job);
        created.push(job);
      }
      await refresh();
      const failed = created.filter((item) => item.status === "failed");
      if (failed.length) setError(failed[0].error ?? "任务提交失败");
      else if (created[0]?.demo) setNotice(`演示模式：已生成 ${created.length} 份分镜脚本（接入视频通道后同表单直接出片）`);
      else setNotice(`已提交 ${created.length} 个视频任务，生成中会自动刷新状态`);
      setPrompt("");
      setImage(undefined);
      setImage2(undefined);
    } catch (err) {
      setError(err instanceof Error ? friendlyError(err) : "提交失败");
    } finally {
      setBusy(false);
    }
  };

  const removeJob = async (job: VideoJob) => {
    await removeVideoJob(job.id);
    await refresh();
    setNotice("任务已删除");
  };

  const copyStoryboard = async (job: VideoJob) => {
    const text = (job.storyboard ?? [])
      .map((scene, index) => `${index + 1}. ${scene.scene}（${scene.duration}）\n画面：${scene.visual}${scene.line ? `\n台词：${scene.line}` : ""}`)
      .join("\n\n");
    const ok = await copyText(text);
    setNotice(ok ? "分镜已复制" : "复制失败");
  };

  const needImage = MODES.find((item) => item.value === mode)?.needImage ?? 0;
  const canSubmit = prompt.trim().length > 0 && (needImage === 0 || Boolean(image)) && (mode !== "first-last" || Boolean(image2));

  return (
    <section className="video-layout">
      <div className="console-card video-composer">
        <div className="console-card-header">
          <div>
            <h2><Clapperboard size={16} /> 视频创作</h2>
            <p>文生视频 / 图生视频 / 首尾帧 · 横竖屏自适应。当前状态：<b className={status.ready ? "video-ready" : "video-demo"}>{status.label}</b> — {status.hint}</p>
          </div>
          <button type="button" className="button button-secondary" onClick={() => setChannelOpen((value) => !value)}>
            {channelOpen ? <X size={14} /> : <Plus size={14} />}{channelOpen ? "收起通道配置" : "视频通道配置"}
          </button>
        </div>

        {channelOpen && (
          <VideoChannelCard
            onSaved={() => {
              setNotice("视频通道已保存，提交的任务将真实出片");
              setChannelOpen(false);
            }}
            onCleared={() => {
              clearVideoProvider();
              setNotice("视频通道已清除，恢复演示模式");
              setChannelOpen(false);
            }}
          />
        )}

        <div className="video-form">
          <div className="video-modes">
            {MODES.map((item) => (
              <button
                key={item.value}
                type="button"
                className={mode === item.value ? "active" : ""}
                onClick={() => setMode(item.value)}
              >
                {item.label}
                {item.needImage > 0 && <small>需{item.needImage}张图</small>}
              </button>
            ))}
          </div>

          <label className="video-prompt">
            视频描述
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              rows={4}
              placeholder="例如：山野茶饮门店实拍，壶嘴热气特写，镜头缓慢推近，暖色调，竖屏短视频质感"
            />
          </label>

          {needImage > 0 && (
            <div className="video-images">
              <button type="button" className="video-image-slot" onClick={() => imageInputRef.current?.click()}>
                {image ? <img src={image} alt="参考图1" /> : <><Upload size={16} />{mode === "first-last" ? "首帧" : "参考图"}</>}
              </button>
              {mode === "first-last" && (
                <button type="button" className="video-image-slot" onClick={() => image2InputRef.current?.click()}>
                  {image2 ? <img src={image2} alt="参考图2" /> : <><Upload size={16} />尾帧</>}
                </button>
              )}
              <input ref={imageInputRef} type="file" accept="image/*" hidden onChange={(event) => void pickImage(event.target.files?.[0], 1)} />
              <input ref={image2InputRef} type="file" accept="image/*" hidden onChange={(event) => void pickImage(event.target.files?.[0], 2)} />
              <small>支持 5MB 以内图片；接入后随任务上传给视频模型</small>
            </div>
          )}

          <div className="video-options">
            <div className="video-option-group">
              <span>画幅</span>
              {SIZES.map((item) => (
                <button key={item} type="button" className={size === item ? "active" : ""} onClick={() => setSize(item)}>{item}</button>
              ))}
            </div>
            <div className="video-option-group">
              <span>时长</span>
              {DURATIONS.map((item) => (
                <button key={item} type="button" className={duration === item ? "active" : ""} onClick={() => setDuration(item)}>{item}s</button>
              ))}
            </div>
            <div className="video-option-group">
              <span>条数</span>
              {[1, 2].map((item) => (
                <button key={item} type="button" className={count === item ? "active" : ""} onClick={() => setCount(item)}>{item}</button>
              ))}
            </div>
          </div>

          <div className="geo-actions">
            <button type="button" className="button button-primary" onClick={() => void submit()} disabled={busy || !canSubmit}>
              {busy ? <LoaderCircle size={15} className="spin" /> : <Film size={15} />}
              {status.ready ? "生成视频" : "生成分镜脚本（演示）"}
            </button>
            <small className="geo-hint">
              {status.ready
                ? `将提交到 ${status.label}，任务卡自动轮询进度`
                : "接入视频通道后，同一表单直接出片；当前先交付可拍可剪的分镜"}
            </small>
          </div>
          {error && <p className="geo-error">{error}</p>}
          {notice && <p className="geo-notice">{notice}</p>}
        </div>
      </div>

      <div className="video-jobs">
        <div className="console-card video-jobs-head">
          <div className="console-card-header">
            <div><h2>任务与作品（{jobs.length}）</h2><p>演示分镜与真实成片同队列；数据存本机，不上传</p></div>
          </div>
        </div>

        {jobs.length === 0 && (
          <div className="console-card empty-search video-empty">
            <Clapperboard size={24} />
            <strong>还没有视频任务</strong>
            <span>上面写一句描述即可生成；接入通道前产出的是分镜脚本</span>
          </div>
        )}

        {jobs.map((job) => (
          <article className="console-card video-job" key={job.id}>
            <div className="video-job-head">
              <span className={`video-status status-${job.status}`}>
                {job.status === "running" && <LoaderCircle size={12} className="spin" />}
                {job.status === "succeeded" && <CheckCircle2 size={12} />}
                {job.status === "failed" && <X size={12} />}
                {job.status === "queued" ? "排队中" : job.status === "running" ? "生成中" : job.status === "succeeded" ? (job.demo ? "分镜就绪" : "已出片") : "失败"}
              </span>
              <span className="video-meta">{MODES.find((item) => item.value === job.mode)?.label} · {job.size} · {job.duration}s · {job.model}</span>
              <div className="video-job-actions">
                {job.demo && job.storyboard && (
                  <>
                    <button type="button" className="text-link" onClick={() => void copyStoryboard(job)}><Copy size={13} />复制分镜</button>
                    <button type="button" className="text-link" onClick={() => downloadText(`分镜-${job.id}.md`, storyboardMarkdown(job))}><Download size={13} />导出</button>
                  </>
                )}
                <button type="button" className="text-link row-remove" onClick={() => void removeJob(job)}><Trash2 size={13} />删除</button>
              </div>
            </div>

            <p className="video-job-prompt">{job.prompt}</p>

            {job.status === "running" && (
              <div className="video-progress"><span style={{ width: `${Math.max(6, job.progress)}%` }} /></div>
            )}
            {job.error && <p className="geo-error">失败原因：{job.error}</p>}

            {job.status === "succeeded" && <VideoPlayer job={job} />}

            {job.storyboard && job.storyboard.length > 0 && (
              <div className="video-storyboard">
                <h4>{job.demo ? "分镜脚本（演示模式产出 · 非成片）" : "分镜参考"}</h4>
                {job.storyboard.map((scene, index) => (
                  <div className="video-scene" key={`${scene.scene}-${index}`}>
                    <em>{scene.duration}</em>
                    <span>
                      <strong>{index + 1}. {scene.scene}</strong>
                      <small>{scene.visual}</small>
                      {scene.line && <q>{scene.line}</q>}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {job.image && !job.storyboard && (
              <img className="video-ref" src={job.image} alt="参考图" />
            )}
          </article>
        ))}
      </div>
    </section>
  );
}
