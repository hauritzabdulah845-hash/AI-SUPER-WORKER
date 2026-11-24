import { useEffect, useMemo, useState } from "react";
import {
  Check,
  Copy,
  Download,
  LoaderCircle,
  Megaphone,
  Send,
  Sparkles,
} from "lucide-react";
import { buildPlatformPosts, PUBLISH_PLATFORMS, type PlatformPost } from "../cloud/geo";

export interface PublishSource {
  title: string;
  agent: string;
  output: string;
  created_at: string;
}

interface PublishHubProps {
  contents: PublishSource[];
  /** 从内容工厂「去发布」带过来的预选产出（`标题-创建时间`） */
  initialSourceId?: string;
  /** 已消费预选值，通知父级清空 */
  onSourceConsumed?: () => void;
}

function downloadMarkdown(filename: string, content: string) {
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

const DEFAULT_PLATFORMS = ["抖音", "小红书", "视频号"];

/**
 * 聚合发布（半自动）：AI 负责各平台适配稿与发布清单，人工负责上传与点击发布。
 * 不碰任何平台的非官方接口——自动分发需要各平台开放平台授权，属于后续路线图。
 */
export function PublishHub({ contents, initialSourceId = "", onSourceConsumed }: PublishHubProps) {
  const [sourceId, setSourceId] = useState<string>(() =>
    initialSourceId && contents.some((item) => `${item.title}-${item.created_at}` === initialSourceId) ? initialSourceId : "custom",
  );
  const [customText, setCustomText] = useState("");
  const [platforms, setPlatforms] = useState<string[]>(DEFAULT_PLATFORMS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [posts, setPosts] = useState<PlatformPost[] | null>(null);
  const [checked, setChecked] = useState<Record<string, boolean>>({});

  const selected = useMemo(() => contents.find((item) => `${item.title}-${item.created_at}` === sourceId), [contents, sourceId]);

  // 预选值只用一次：用掉就通知父级清掉，避免切页回来又被覆盖
  useEffect(() => {
    if (initialSourceId && sourceId !== "custom") onSourceConsumed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const sourceText = sourceId === "custom" ? customText : (selected?.output ?? "");

  const togglePlatform = (name: string) => {
    setPlatforms((current) =>
      current.includes(name) ? current.filter((item) => item !== name) : [...current, name],
    );
  };

  const runGenerate = async () => {
    if (!sourceText.trim()) {
      setError("请先选择一条内容产出，或粘贴要分发的正文。");
      return;
    }
    if (!platforms.length) {
      setError("请至少选择 1 个平台。");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await buildPlatformPosts({ content: sourceText, platformNames: platforms });
      setPosts(result);
      setChecked({});
      setNotice(`已生成 ${result.length} 个平台的适配稿，逐个复制到平台后台发布即可。`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "生成失败");
    } finally {
      setBusy(false);
    }
  };

  const copyPost = async (post: PlatformPost) => {
    const text = [post.title, "", post.caption, "", post.tags.map((tag) => `#${tag}`).join(" ")].join("\n");
    const ok = await copyText(text);
    setNotice(ok ? `「${post.platform}」标题+正文+话题已复制` : "复制失败，请手动选择文本");
  };

  const toggleCheck = (key: string) => setChecked((current) => ({ ...current, [key]: !current[key] }));

  const exportSchedule = () => {
    if (!posts?.length) return;
    const lines: string[] = ["# 聚合发布排期", ""];
    lines.push(`生成时间：${new Date().toLocaleString("zh-CN", { hour12: false })}`);
    lines.push(`来源：${sourceId === "custom" ? "手工粘贴" : selected?.title ?? "内容产出"}`, "");
    posts.forEach((post, index) => {
      lines.push(`## ${index + 1}. ${post.platform}`);
      lines.push(`- 标题（${post.title.length} 字）：${post.title}`);
      lines.push(`- 建议时段：${post.time}`);
      lines.push(`- 话题：${post.tags.map((tag) => `#${tag}`).join(" ") || "（无）"}`);
      lines.push("", post.caption, "", "### 发布步骤");
      post.steps.forEach((step, stepIndex) => lines.push(`${stepIndex + 1}. ${step}`));
      lines.push("");
    });
    downloadMarkdown(`聚合发布排期-${new Date().toISOString().slice(0, 10)}.md`, lines.join("\n"));
    setNotice("发布排期已导出（Markdown）");
  };

  const doneCount = posts ? posts.filter((post) => checked[post.platformKey]).length : 0;

  return (
    <section className="publish-layout">
      <div className="console-card publish-compose">
        <div className="console-card-header">
          <div>
            <h2><Megaphone size={16} /> 聚合发布</h2>
            <p>一条内容 → 各平台原生风格的标题、正文与话题标签。半自动模式：AI 写稿，你在各平台后台完成上传发布。</p>
          </div>
          <button type="button" className="button button-secondary" onClick={exportSchedule} disabled={!posts?.length}>
            <Download size={15} />导出排期
          </button>
        </div>

        <div className="publish-form">
          <label>
            选择内容产出
            <select value={sourceId} onChange={(event) => setSourceId(event.target.value)}>
              <option value="custom">手工粘贴…</option>
              {contents.map((item) => (
                <option key={`${item.title}-${item.created_at}`} value={`${item.title}-${item.created_at}`}>
                  {item.title}
                </option>
              ))}
            </select>
          </label>

          {sourceId === "custom" ? (
            <label>
              要分发的正文
              <textarea
                value={customText}
                onChange={(event) => setCustomText(event.target.value)}
                rows={6}
                placeholder="粘贴视频口播稿、图文正文或活动文案…"
              />
            </label>
          ) : (
            <div className="publish-preview">
              <small>{selected?.agent} · {selected ? new Date(selected.created_at).toLocaleString("zh-CN", { hour12: false }) : ""}</small>
              <p>{selected?.output.slice(0, 300)}{selected && selected.output.length > 300 ? "…" : ""}</p>
            </div>
          )}

          <fieldset className="publish-platforms">
            <legend>目标平台（可多选）</legend>
            {PUBLISH_PLATFORMS.map((item) => (
              <label key={item.key} className={platforms.includes(item.name) ? "active" : ""}>
                <input
                  type="checkbox"
                  checked={platforms.includes(item.name)}
                  onChange={() => togglePlatform(item.name)}
                />
                {item.name}
                <small>标题≤{item.maxTitle}字</small>
              </label>
            ))}
          </fieldset>

          <div className="geo-actions">
            <button type="button" className="button button-primary" onClick={() => void runGenerate()} disabled={busy}>
              {busy ? <LoaderCircle size={15} className="spin" /> : <Sparkles size={15} />}生成各平台适配稿
            </button>
            <small className="geo-hint">发布仍需人工完成；本模块不调用任何平台的非官方接口。</small>
          </div>
          {error && <p className="geo-error">{error}</p>}
          {notice && <p className="geo-notice">{notice}</p>}
        </div>
      </div>

      {posts && (
        <div className="publish-results">
          <div className="console-card publish-progress">
            <div className="console-card-header">
              <div><h2>发布进度</h2><p>勾选表示该平台已完成上传发布</p></div>
              <strong className={`geo-rate ${doneCount === posts.length ? "good" : "mid"}`}>{doneCount}/{posts.length}</strong>
            </div>
            <div className="publish-progress-track">
              <span style={{ width: `${posts.length ? Math.round((doneCount / posts.length) * 100) : 0}%` }} />
            </div>
          </div>

          {posts.map((post) => (
            <article className="console-card publish-card" key={post.platformKey}>
              <div className="publish-card-head">
                <span className="publish-platform">{post.platform}</span>
                <em>{post.time}</em>
                <button type="button" className="text-link" onClick={() => void copyPost(post)}>
                  <Copy size={14} />复制全部
                </button>
              </div>

              <div className="publish-field">
                <small>标题（{post.title.length} 字）</small>
                <strong>{post.title || "（未生成）"}</strong>
              </div>
              <div className="publish-field">
                <small>正文 / 描述</small>
                <p>{post.caption}</p>
              </div>
              {post.tags.length > 0 && (
                <div className="publish-tags">
                  {post.tags.map((tag) => <span key={tag}>#{tag}</span>)}
                </div>
              )}

              <ol className="publish-steps">
                {post.steps.map((step) => <li key={step}>{step}</li>)}
              </ol>

              <button
                type="button"
                className={`button ${checked[post.platformKey] ? "button-secondary" : "button-primary"} publish-done`}
                onClick={() => toggleCheck(post.platformKey)}
              >
                {checked[post.platformKey] ? <><Check size={15} />已完成发布</> : <><Send size={15} />标记已发布</>}
              </button>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
