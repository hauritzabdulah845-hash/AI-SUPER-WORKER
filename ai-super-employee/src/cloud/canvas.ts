import { cloud } from "./client";
import { isThrottleError, loadChannel, loadCustomProvider } from "./provider";

/**
 * AI 生图引擎。
 *
 * 平台通道：WorkBuddy 云端 hunyuan-image-alpha（流式返回，配额受平台限制）。
 * 自定义通道：任意 OpenAI 兼容的 /images/generations 接口（OpenAI / 硅基流动 / 智谱 / 通义万相 / OpenRouter）。
 *
 * 生成结果统一落成本地 dataURL 或远端 URL，作品元数据存 IndexedDB，刷新不丢。
 */

export type ImageSize = "1024x1024" | "768x1024" | "1024x768" | "720x1280";

export interface ImageRequest {
  prompt: string;
  size?: ImageSize;
  negative?: string;
  signal?: AbortSignal;
}

export interface ImageResult {
  /** dataURL 或可访问的图片 URL */
  src: string;
  model: string;
  size: string;
  channel: "platform" | "custom";
  createdAt: number;
  prompt: string;
}

const IMAGE_MODEL = "hunyuan-image-alpha";
const DB_NAME = "supe-creative";
const DB_STORE = "images";

/* ------------------------------------------------------------------ */
/* 结果解析：平台返回形态不固定，统一从文本 / 结构中抽取图片             */
/* ------------------------------------------------------------------ */

const DATA_URI = /data:image\/[a-z+]+;base64,[A-Za-z0-9+/=]+/g;
const REMOTE_IMG = /https?:\/\/[^\s"'<>)\]]+?\.(?:png|jpe?g|webp|gif)(?:\?[^\s"'<>)\]]*)?/gi;

function extractImages(text: string): string[] {
  const found: string[] = [];
  const dataUris = text.match(DATA_URI);
  if (dataUris) found.push(...dataUris);
  const remotes = text.match(REMOTE_IMG);
  if (remotes) found.push(...remotes);
  return Array.from(new Set(found));
}

function extractFromChunk(chunk: unknown): string[] {
  const out: string[] = [];
  const visit = (value: unknown, depth: number) => {
    if (!value || depth > 4) return;
    if (typeof value === "string") {
      if (/^data:image\//.test(value) || /^https?:\/\/\S+\.(png|jpe?g|webp)/i.test(value)) out.push(value);
      else if (/data:image\/|!\[[^\]]*\]\(https?:\/\//.test(value)) out.push(...extractImages(value));
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, depth + 1));
      return;
    }
    if (typeof value === "object") {
      const record = value as Record<string, unknown>;
      for (const key of ["url", "b64_json", "image", "image_url", "data_url", "src"]) {
        const candidate = record[key];
        if (typeof candidate === "string") {
          if (key === "b64_json") out.push(`data:image/png;base64,${candidate}`);
          else if (candidate.startsWith("data:") || /^https?:\/\//.test(candidate)) out.push(candidate);
        }
      }
      for (const key of ["data", "images", "output", "content", "choices", "delta", "message", "result"]) {
        if (key in record) visit(record[key], depth + 1);
      }
    }
  };
  visit(chunk, 0);
  return out;
}

/* ------------------------------------------------------------------ */
/* 平台通道                                                            */
/* ------------------------------------------------------------------ */

async function generateOnPlatform(request: ImageRequest): Promise<ImageResult[]> {
  const prompt = request.size ? `${request.prompt}\n\n画幅比例要求：${request.size}` : request.prompt;
  const stream = await cloud.llm.chat.completions.create({
    model: IMAGE_MODEL,
    stream: true,
    messages: [{ role: "user", content: prompt }],
  } as never);

  const collected: string[] = [];
  let text = "";
  for await (const chunk of stream) {
    if (request.signal?.aborted) throw new Error("已取消");
    const picked = extractFromChunk(chunk);
    if (picked.length) collected.push(...picked);
    const delta = (chunk as { choices?: { delta?: { content?: string } }[] })?.choices?.[0]?.delta?.content;
    if (typeof delta === "string" && delta) text += delta;
  }

  const fromText = extractImages(text);
  const all = Array.from(new Set([...collected, ...fromText]));
  if (!all.length) {
    throw new Error(text.trim() ? `模型未返回图片：${text.trim().slice(0, 120)}` : "模型未返回图片，请换个描述再试");
  }
  const now = Date.now();
  return all.map((src) => ({
    src,
    model: IMAGE_MODEL,
    size: request.size ?? "1024x1024",
    channel: "platform" as const,
    createdAt: now,
    prompt: request.prompt,
  }));
}

/* ------------------------------------------------------------------ */
/* 自定义通道（OpenAI 兼容 /images/generations）                        */
/* ------------------------------------------------------------------ */

async function generateOnCustom(request: ImageRequest): Promise<ImageResult[]> {
  const provider = loadCustomProvider();
  if (!provider) throw new Error("尚未配置自定义通道，请到「模型接入」填写图片模型端点与 Key");

  const base = provider.baseUrl.replace(/\/+$/, "");
  const response = await fetch(`${base}/images/generations`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${provider.apiKey}`,
    },
    body: JSON.stringify({
      model: provider.model,
      prompt: request.size ? `${request.prompt}。画幅比例 ${request.size}` : request.prompt,
      n: 1,
      size: request.size ?? "1024x1024",
      response_format: "b64_json",
    }),
    signal: request.signal,
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    const error = new Error(`图片接口返回 HTTP ${response.status} ${detail.slice(0, 160)}`);
    (error as Error & { status?: number }).status = response.status;
    throw error;
  }

  const payload = (await response.json()) as {
    data?: { b64_json?: string; url?: string }[];
  };
  const items = payload?.data ?? [];
  const now = Date.now();
  const results: ImageResult[] = [];
  for (const item of items) {
    if (item.b64_json) {
      results.push({
        src: `data:image/png;base64,${item.b64_json}`,
        model: provider.model,
        size: request.size ?? "1024x1024",
        channel: "custom",
        createdAt: now,
        prompt: request.prompt,
      });
    } else if (item.url) {
      results.push({
        src: item.url,
        model: provider.model,
        size: request.size ?? "1024x1024",
        channel: "custom",
        createdAt: now,
        prompt: request.prompt,
      });
    }
  }
  if (!results.length) throw new Error("图片接口没有返回图片数据");
  return results;
}

/* ------------------------------------------------------------------ */
/* 对外入口                                                            */
/* ------------------------------------------------------------------ */

export async function generateImage(request: ImageRequest): Promise<ImageResult[]> {
  const prompt = request.prompt.trim();
  if (!prompt) throw new Error("请先描述你想要的画面");

  const channel = loadChannel();
  try {
    return channel === "custom" ? await generateOnCustom({ ...request, prompt }) : await generateOnPlatform({ ...request, prompt });
  } catch (error) {
    if (isThrottleError(error)) {
      throw new Error(
        "平台绘图配额已用尽（429）。请到「模型接入」登录账号提升配额，或切换到自定义通道（填入支持图片生成的 Key）。",
      );
    }
    const message = error instanceof Error ? error.message : String(error ?? "");
    if (/请求参数无效|HTTP 400|不支持|not support/i.test(message)) {
      throw new Error(
        "平台图片模型当前不接受这次请求（接口参数校验失败），生图暂不可用。可到「模型接入」改用支持生图的服务（硅基流动 FLUX、智谱 CogView 等）后重试；文字类任务不受影响。",
      );
    }
    throw error;
  }
}

/** 判断当前环境是否具备绘图能力，用于页面顶部状态提示。 */
export function imageChannelStatus(): { ready: boolean; label: string; hint: string } {
  const channel = loadChannel();
  if (channel === "custom") {
    const provider = loadCustomProvider();
    if (!provider) return { ready: false, label: "自定义通道未配置", hint: "到「模型接入」填写图片模型端点与 Key" };
    return { ready: true, label: `自定义通道 · ${provider.model}`, hint: "由你自己的 Key 出图，不受平台配额影响" };
  }
  return { ready: true, label: "平台通道 · 混元生图", hint: "走平台配额；若提示接口不可用，请改用支持生图的自定义通道" };
}

/* ------------------------------------------------------------------ */
/* 作品库（IndexedDB）                                                  */
/* ------------------------------------------------------------------ */

export interface Artwork extends ImageResult {
  id: string;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DB_STORE)) {
        db.createObjectStore(DB_STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("本地作品库不可用"));
  });
}

export async function listArtworks(): Promise<Artwork[]> {
  try {
    const db = await openDb();
    return await new Promise<Artwork[]>((resolve, reject) => {
      const tx = db.transaction(DB_STORE, "readonly");
      const request = tx.objectStore(DB_STORE).getAll();
      request.onsuccess = () => {
        const rows = (request.result ?? []) as Artwork[];
        resolve(rows.sort((a, b) => b.createdAt - a.createdAt));
      };
      request.onerror = () => reject(request.error ?? new Error("读取作品失败"));
    });
  } catch {
    return [];
  }
}

export async function saveArtworks(items: ImageResult[]): Promise<Artwork[]> {
  const db = await openDb();
  const saved: Artwork[] = items.map((item, index) => ({
    ...item,
    id: `${item.createdAt}-${index}-${Math.random().toString(36).slice(2, 8)}`,
  }));
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readwrite");
    const store = tx.objectStore(DB_STORE);
    saved.forEach((item) => store.put(item));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("保存作品失败"));
  });
  return saved;
}

export async function removeArtwork(id: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readwrite");
    tx.objectStore(DB_STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("删除作品失败"));
  });
}

export async function clearArtworks(): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readwrite");
    tx.objectStore(DB_STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("清空作品失败"));
  });
}
