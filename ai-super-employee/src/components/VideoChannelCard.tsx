import { useState } from "react";
import { Check, KeyRound, Trash2 } from "lucide-react";
import {
  loadVideoProvider,
  saveVideoProvider,
  VIDEO_PROVIDER_KINDS,
  type VideoProvider,
  type VideoProviderKind,
} from "../cloud/video";

/**
 * 视频通道配置卡：端点 / Key / 模型名，只存本机 localStorage。
 * 「接入后续再做」的落点就在这里——填上 Key，视频创作模块立即从演示切到真实出片。
 */
export function VideoChannelCard({
  onSaved,
  onCleared,
}: {
  onSaved?: () => void;
  onCleared?: () => void;
}) {
  const saved = loadVideoProvider();
  const [kind, setKind] = useState<VideoProviderKind>(saved?.kind ?? "ark");
  const [baseUrl, setBaseUrl] = useState(saved?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState(saved?.apiKey ?? "");
  const [model, setModel] = useState(saved?.model ?? "");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const kindMeta = VIDEO_PROVIDER_KINDS.find((item) => item.value === kind);

  const save = () => {
    setError("");
    if (!baseUrl.trim() || !apiKey.trim() || !model.trim()) {
      setError("端点地址、API Key、模型名都要填");
      return;
    }
    const provider: VideoProvider = {
      kind,
      baseUrl: baseUrl.trim(),
      apiKey: apiKey.trim(),
      model: model.trim(),
    };
    saveVideoProvider(provider);
    setNotice("已保存到本机，视频创作将真实出片");
    onSaved?.();
  };

  const clear = () => {
    setApiKey("");
    setNotice("已清除，恢复演示模式");
    onCleared?.();
  };

  return (
    <div className="video-channel-card">
      <div className="video-channel-head">
        <span><KeyRound size={14} /> 视频通道</span>
        <em>Key 只存本机浏览器，不上云不入库</em>
      </div>

      <div className="video-channel-kinds">
        {VIDEO_PROVIDER_KINDS.map((item) => (
          <button
            key={item.value}
            type="button"
            className={kind === item.value ? "active" : ""}
            onClick={() => {
              setKind(item.value);
              setNotice("");
            }}
            title={item.hint}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="video-channel-fields">
        <label>
          端点地址
          <input
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            placeholder={
              kind === "ark"
                ? "https://ark.cn-beijing.volces.com/api/v3"
                : kind === "openai"
                  ? "https://api.openai.com/v1"
                  : "https://your-video-service.com/v1"
            }
          />
        </label>
        <label>
          API Key
          <input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="填入视频服务的 Key" autoComplete="off" />
        </label>
        <label>
          模型名
          <input
            value={model}
            onChange={(event) => setModel(event.target.value)}
            placeholder={kind === "ark" ? "doubao-seedance-1-0-pro-250528" : kind === "openai" ? "sora-2" : "video-model-name"}
          />
        </label>
      </div>

      {kindMeta && <p className="channel-detail">{kindMeta.label}：{kindMeta.hint}。适配器按公开文档实现，接入后请先用 1 条短任务验证。</p>}
      {error && <p className="geo-error">{error}</p>}
      {notice && <p className="geo-notice">{notice}</p>}

      <div className="channel-actions">
        <button type="button" className="button button-primary" onClick={save}>
          <Check size={14} />保存通道
        </button>
        <button type="button" className="button button-ghost danger-button" onClick={clear} disabled={!saved && !apiKey}>
          <Trash2 size={14} />清除
        </button>
        {saved && <span className="channel-badge ok">已配置 · {saved.model}</span>}
      </div>
    </div>
  );
}
