/**
 * L3 配音（TTS）适配器层。
 * 零 Key 可用：demo 在本机生成占位 WAV（近静音+提示音，时长按文案估算）；
 * generic 走用户自配 HTTP 端点（火山/豆包等拿到 Key 后在「配音与出片」页填地址即可），
 * 本模块不内置任何厂商签名——签名以厂商文档为准，由接入方配置。
 */

export interface TtsConfig {
  provider: "demo" | "generic";
  /** generic 模式：POST baseUrl + path，body = { text, voice }，期望返回音频二进制 */
  baseUrl: string;
  path: string;
  voice: string;
}

export const TTS_STORAGE_KEY = "ai-employee:tts-config";

const DEFAULT_TTS: TtsConfig = { provider: "demo", baseUrl: "", path: "/tts", voice: "demo-voice" };

export function loadTtsConfig(): TtsConfig {
  try {
    const raw = localStorage.getItem(TTS_STORAGE_KEY);
    if (raw) return { ...DEFAULT_TTS, ...(JSON.parse(raw) as Partial<TtsConfig>) };
  } catch {
    /* 节点测试环境无 localStorage，或数据损坏 */
  }
  return { ...DEFAULT_TTS };
}

export function saveTtsConfig(config: TtsConfig): void {
  try {
    localStorage.setItem(TTS_STORAGE_KEY, JSON.stringify(config));
  } catch {
    /* 只读环境忽略 */
  }
}

/** 按字数估算朗读时长（中文约 4 字/秒），夹紧到 2~60 秒。 */
export function estimateSpeechSeconds(text: string): number {
  const length = text.replace(/\s+/g, "").length;
  return Math.min(60, Math.max(2, Math.round(length / 4)));
}

/**
 * 合法 16-bit PCM 单声道 WAV：前 3 秒每秒一个 80ms 提示音（证明音轨存在），其余近静音。
 * 用途：demo 模式下让 L2 合成链路（ffmpeg -i 配音.wav）端到端可跑。
 */
export function demoWav(seconds: number): Blob {
  const sampleRate = 16000;
  const safeSeconds = Math.min(120, Math.max(1, Math.round(seconds)));
  const frames = sampleRate * safeSeconds;
  const buffer = new ArrayBuffer(44 + frames * 2);
  const view = new DataView(buffer);
  const writeAscii = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index += 1) view.setUint8(offset + index, text.charCodeAt(index));
  };

  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + frames * 2, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true); // PCM 块大小
  view.setUint16(20, 1, true); // 格式 = PCM
  view.setUint16(22, 1, true); // 单声道
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // 字节率
  view.setUint16(32, 2, true); // 块对齐
  view.setUint16(34, 16, true); // 位深
  writeAscii(36, "data");
  view.setUint32(40, frames * 2, true);

  for (let index = 0; index < frames; index += 1) {
    const t = index / sampleRate;
    const inBlip = t < 3 && t % 1 < 0.08;
    const sample = inBlip ? Math.sin(2 * Math.PI * 880 * t) * 0.12 : 0;
    view.setInt16(44 + index * 2, Math.round(sample * 32767), true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}

export interface SynthResult {
  blob: Blob;
  demo: boolean;
  seconds: number;
  note: string;
}

/** 生成配音：demo 本机出占位音轨；generic POST 到自配端点（失败抛错由 UI 展示）。 */
export async function synthesizeVoice(config: TtsConfig, text: string): Promise<SynthResult> {
  const seconds = estimateSpeechSeconds(text);
  if (config.provider === "demo" || !config.baseUrl.trim()) {
    return {
      blob: demoWav(seconds),
      demo: true,
      seconds,
      note: "演示音轨（近静音+提示音）；配置 generic 服务后将替换为真实配音",
    };
  }

  const response = await fetch(config.baseUrl.replace(/\/$/, "") + config.path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, voice: config.voice }),
  });
  if (!response.ok) throw new Error(`TTS 服务返回 HTTP ${response.status}`);
  const blob = await response.blob();
  if (blob.size <= 44) throw new Error("TTS 服务返回的不是有效音频（内容过短）");
  return { blob, demo: false, seconds, note: "" };
}
