/**
 * 视频创作通道层（域 04：文生视频 / 图生视频 / 首尾帧）。
 *
 * 设计目标：**功能先落地，接入后置**。
 *   - 未配置视频通道 → 演示模式：同一套表单与任务队列照常工作，
 *     产出的是「分镜脚本」（明确标注，不冒充成片）；
 *   - 配置了通道（Seedance/火山方舟、OpenAI Video、自定义）→
 *     走下方适配器真实提交与轮询，产出可播放的视频。
 *
 * 适配器按各厂商公开文档实现，端点与字段在真实 Key 接入后需各跑一次验证
 * （厂商可能调整参数），失败会把原始错误透传到任务卡片，方便定位。
 *
 * 通道配置只存本机 localStorage，不上云不入库（与文本/图片通道一致）。
 */

import { askLLM } from "./runner";

export type VideoProviderKind = "ark" | "openai" | "custom";
export type VideoMode = "text2video" | "image2video" | "first-last";
export type VideoSize = "16:9" | "9:16" | "1:1";
export type VideoJobStatus = "queued" | "running" | "succeeded" | "failed";

export interface VideoProvider {
  kind: VideoProviderKind;
  /** 端点根地址，例如 https://ark.cn-beijing.volces.com/api/v3 */
  baseUrl: string;
  apiKey: string;
  /** 模型名，例如 doubao-seedance-1-0-pro-250528 */
  model: string;
}

export interface StoryboardScene {
  scene: string;
  visual: string;
  line: string;
  duration: string;
}

export interface VideoJob {
  id: string;
  createdAt: number;
  updatedAt: number;
  mode: VideoMode;
  prompt: string;
  size: VideoSize;
  duration: number;
  model: string;
  channel: VideoProviderKind | "demo";
  status: VideoJobStatus;
  progress: number;
  error?: string;
  /** 成片地址（厂商返回的公网 URL 时使用） */
  videoUrl?: string;
  /** 成片二进制（厂商只给带鉴权的下载地址时，抓下来存本地） */
  videoBlob?: Blob;
  /** 演示模式 / 未出片时的分镜脚本 */
  storyboard?: StoryboardScene[];
  /** 演示模式标记：分镜脚本不是成片，界面必须如实展示 */
  demo?: boolean;
  /** 厂商任务 id，用于轮询 */
  remoteId?: string;
  /** 首/尾帧或图生视频的参考图（本地 dataURL，接入后随请求上传） */
  image?: string;
  image2?: string;
}

export const VIDEO_PROVIDER_KINDS: { value: VideoProviderKind; label: string; hint: string }[] = [
  { value: "ark", label: "火山方舟 · Seedance", hint: "POST /api/v3/contents/generations/tasks，模型如 doubao-seedance-*" },
  { value: "openai", label: "OpenAI Video（Sora 系）", hint: "POST /v1/videos，完成后抓取 /content 得到 mp4" },
  { value: "custom", label: "自定义端点", hint: "兼容 /videos 提交 + 轮询的任意服务" },
];

const STORAGE_KEY = "supe-video-provider";

export function loadVideoProvider(): VideoProvider | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<VideoProvider>;
    if (!parsed.baseUrl || !parsed.apiKey || !parsed.model) return null;
    return {
      kind: (parsed.kind as VideoProviderKind) ?? "ark",
      baseUrl: String(parsed.baseUrl).trim(),
      apiKey: String(parsed.apiKey).trim(),
      model: String(parsed.model).trim(),
    };
  } catch {
    return null;
  }
}

export function saveVideoProvider(provider: VideoProvider): void {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(provider));
}

export function clearVideoProvider(): void {
  window.localStorage.removeItem(STORAGE_KEY);
}

/** 视频通道是否就绪；未就绪时走演示模式。 */
export function videoChannelStatus(): { ready: boolean; label: string; hint: string } {
  const provider = loadVideoProvider();
  if (!provider) {
    return {
      ready: false,
      label: "演示模式",
      hint: "未接入视频通道：现在生成分镜脚本；到「模型接入」填入视频 Key 后同一表单直接出片",
    };
  }
  const kind = VIDEO_PROVIDER_KINDS.find((item) => item.value === provider.kind)?.label ?? provider.kind;
  return { ready: true, label: `${kind} · ${provider.model}`, hint: "由你自己的 Key 出片，不走平台配额" };
}

function canonicalVideoBaseUrl(raw: string): string {
  let url = String(raw ?? "").trim().replace(/\s+/g, "");
  if (!url) return "";
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  return url.replace(/\/+$/, "");
}

/* ------------------------------------------------------------------ */
/* 演示模式：分镜脚本（LLM 优先，失败降级本地模板）                      */
/* ------------------------------------------------------------------ */

const STORYBOARD_SYSTEM = [
  "你是短视频分镜导演。根据主题产出可直接拍摄/生成的分镜脚本。",
  "纪律：",
  "1. 画面描述必须围绕主题，禁止编造具体价格、数据、他人背书。",
  "2. 每个镜头给出「画面」「台词/字幕」「时长」，总时长与要求一致。",
  "3. 第 1 个镜头必须是 3 秒内的钩子。",
  "只输出 JSON：",
  '{"scenes":[{"scene":"镜头名","visual":"画面描述","line":"台词或字幕，无则留空","duration":"0-3s"}]}',
].join("\n");

/** 本地兜底：LLM 不可用时也保证有可交付的分镜骨架。 */
function fallbackStoryboard(prompt: string, duration: number): StoryboardScene[] {
  const sceneCount = Math.min(6, Math.max(3, Math.round(duration / 2)));
  const per = Math.max(1, Math.round((duration / sceneCount) * 10) / 10);
  const templates = [
    { scene: "开场钩子", visual: `主体特写入场：${prompt.slice(0, 40)}` },
    { scene: "痛点/亮点", visual: "对比画面，强化冲突或卖点" },
    { scene: "核心展示", visual: "围绕主题的主镜头，信息最密集" },
    { scene: "细节佐证", visual: "局部特写 + 字幕注解" },
    { scene: "场景代入", visual: "真实使用场景，人物入镜" },
    { scene: "行动收口", visual: "品牌露出 + 明确的行动引导" },
  ];
  return templates.slice(0, sceneCount).map((item, index) => {
    const from = Math.round(index * per * 10) / 10;
    const to = Math.round((index + 1) * per * 10) / 10;
    return {
      scene: item.scene,
      visual: item.visual,
      line: index === 0 ? prompt.slice(0, 24) : "",
      duration: `${from}-${to}s`,
    };
  });
}

export async function buildStoryboard(input: {
  prompt: string;
  duration: number;
  signal?: AbortSignal;
}): Promise<StoryboardScene[]> {
  try {
    const { text } = await askLLM(
      [
        { role: "system", content: STORYBOARD_SYSTEM },
        {
          role: "user",
          content: `主题：${input.prompt}\n要求总时长：约 ${input.duration} 秒，分 3-6 个镜头。`,
        },
      ],
      { json: true, signal: input.signal },
    );
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start !== -1 && end > start) {
      const parsed = JSON.parse(text.slice(start, end + 1)) as { scenes?: StoryboardScene[] };
      const scenes = (parsed.scenes ?? []).filter((item) => item && item.scene).slice(0, 8);
      if (scenes.length) {
        return scenes.map((item) => ({
          scene: String(item.scene).slice(0, 20),
          visual: String(item.visual ?? "").slice(0, 160),
          line: String(item.line ?? "").slice(0, 80),
          duration: String(item.duration ?? "").slice(0, 16),
        }));
      }
    }
  } catch {
    // 平台配额/网络问题时降级，演示模式不允许因为模型不可用就整体失败
  }
  return fallbackStoryboard(input.prompt, input.duration);
}

/* ------------------------------------------------------------------ */
/* 适配器：提交 + 轮询（按厂商公开文档实现，待真实 Key 验证）            */
/* ------------------------------------------------------------------ */

interface SubmitResult {
  remoteId: string;
}

interface PollResult {
  status: "running" | "succeeded" | "failed";
  videoUrl?: string;
  videoBlob?: Blob;
  error?: string;
  progress?: number;
}

function sizeParam(size: VideoSize): string {
  return size === "9:16" ? "720x1280" : size === "1:1" ? "1024x1024" : "1280x720";
}

async function readError(response: Response, prefix: string): Promise<Error> {
  const detail = await response.text().catch(() => "");
  const error = new Error(`${prefix} HTTP ${response.status} ${detail.slice(0, 200)}`);
  (error as Error & { status?: number }).status = response.status;
  return error;
}

/** 火山方舟（Seedance）：提交任务 → 轮询任务状态。 */
async function submitArk(provider: VideoProvider, job: VideoJob): Promise<SubmitResult> {
  const base = canonicalVideoBaseUrl(provider.baseUrl) || "https://ark.cn-beijing.volces.com/api/v3";
  const content: Record<string, unknown>[] = [{ type: "text", text: job.prompt }];
  if (job.image) content.push({ type: "image_url", image_url: { url: job.image } });
  if (job.image2) content.push({ type: "image_url", image_url: { url: job.image2 } });

  const response = await fetch(`${base}/contents/generations/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${provider.apiKey}` },
    body: JSON.stringify({
      model: provider.model,
      content,
      // 厂商文档中的可选参数：不支持的字段一般会被忽略或直接报错，错误会透传到任务卡片
      parameters: { ratio: job.size === "9:16" ? "9:16" : job.size === "1:1" ? "1:1" : "16:9", duration: job.duration },
    }),
  });
  if (!response.ok) throw await readError(response, "方舟视频提交失败");
  const payload = (await response.json()) as { id?: string };
  if (!payload.id) throw new Error("方舟未返回任务 id");
  return { remoteId: payload.id };
}

async function pollArk(provider: VideoProvider, remoteId: string): Promise<PollResult> {
  const base = canonicalVideoBaseUrl(provider.baseUrl) || "https://ark.cn-beijing.volces.com/api/v3";
  const response = await fetch(`${base}/contents/generations/tasks/${encodeURIComponent(remoteId)}`, {
    headers: { Authorization: `Bearer ${provider.apiKey}` },
  });
  if (!response.ok) throw await readError(response, "方舟视频查询失败");
  const payload = (await response.json()) as {
    status?: string;
    error?: { code?: string; message?: string };
    content?: { video_urls?: string[]; video_url?: string };
    progress?: number;
  };
  const status = payload.status ?? "";
  if (status === "succeeded") {
    const url = payload.content?.video_urls?.[0] ?? payload.content?.video_url;
    if (!url) return { status: "failed", error: "任务成功但未返回视频地址" };
    return { status: "succeeded", videoUrl: url, progress: 100 };
  }
  if (status === "failed" || status === "cancelled") {
    return { status: "failed", error: payload.error?.message ?? `任务状态：${status}` };
  }
  return { status: "running", progress: typeof payload.progress === "number" ? payload.progress : undefined };
}

/** OpenAI Video（Sora 系）：multipart 提交 → 轮询 → 抓 /content 得到 mp4。 */
async function submitOpenAI(provider: VideoProvider, job: VideoJob): Promise<SubmitResult> {
  const base = canonicalVideoBaseUrl(provider.baseUrl) || "https://api.openai.com/v1";
  const form = new FormData();
  form.append("model", provider.model);
  form.append("prompt", job.prompt);
  form.append("size", sizeParam(job.size));
  form.append("seconds", String(job.duration));
  if (job.image) {
    const blob = await (await fetch(job.image)).blob();
    form.append("input_image", blob, "input.png");
  }

  const response = await fetch(`${base}/videos`, {
    method: "POST",
    headers: { Authorization: `Bearer ${provider.apiKey}` },
    body: form,
  });
  if (!response.ok) throw await readError(response, "视频任务提交失败");
  const payload = (await response.json()) as { id?: string };
  if (!payload.id) throw new Error("视频服务未返回任务 id");
  return { remoteId: payload.id };
}

async function pollOpenAI(provider: VideoProvider, remoteId: string): Promise<PollResult> {
  const base = canonicalVideoBaseUrl(provider.baseUrl) || "https://api.openai.com/v1";
  const response = await fetch(`${base}/videos/${encodeURIComponent(remoteId)}`, {
    headers: { Authorization: `Bearer ${provider.apiKey}` },
  });
  if (!response.ok) throw await readError(response, "视频任务查询失败");
  const payload = (await response.json()) as { status?: string; progress?: number; error?: { message?: string } };
  const status = payload.status ?? "";
  if (status === "completed") {
    const contentRes = await fetch(`${base}/videos/${encodeURIComponent(remoteId)}/content`, {
      headers: { Authorization: `Bearer ${provider.apiKey}` },
    });
    if (!contentRes.ok) throw await readError(contentRes, "视频文件下载失败");
    const blob = await contentRes.blob();
    return { status: "succeeded", videoBlob: blob, progress: 100 };
  }
  if (status === "failed") return { status: "failed", error: payload.error?.message ?? "视频生成失败" };
  return { status: "running", progress: typeof payload.progress === "number" ? payload.progress : undefined };
}

/** 自定义端点：JSON 提交 /videos + 轮询，兼容常见返回字段。 */
async function submitCustom(provider: VideoProvider, job: VideoJob): Promise<SubmitResult> {
  const base = canonicalVideoBaseUrl(provider.baseUrl);
  if (!base) throw new Error("请先在「模型接入」填写视频端点地址");
  const response = await fetch(`${base}/videos`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${provider.apiKey}` },
    body: JSON.stringify({
      model: provider.model,
      prompt: job.prompt,
      size: sizeParam(job.size),
      seconds: job.duration,
      duration: job.duration,
      n: 1,
    }),
  });
  if (!response.ok) throw await readError(response, "视频接口返回异常");
  const payload = (await response.json()) as { id?: string; task_id?: string; request_id?: string };
  const remoteId = payload.id ?? payload.task_id ?? payload.request_id;
  if (!remoteId) throw new Error("视频接口未返回任务 id（id/task_id/request_id 均缺失）");
  return { remoteId };
}

async function pollCustom(provider: VideoProvider, remoteId: string): Promise<PollResult> {
  const base = canonicalVideoBaseUrl(provider.baseUrl);
  if (!base) throw new Error("视频端点已失效，请到「模型接入」重新配置");
  const response = await fetch(`${base}/videos/${encodeURIComponent(remoteId)}`, {
    headers: { Authorization: `Bearer ${provider.apiKey}` },
  });
  if (!response.ok) throw await readError(response, "视频任务查询失败");
  const payload = (await response.json()) as {
    status?: string;
    progress?: number;
    error?: { message?: string } | string;
    data?: { video_url?: string; url?: string; video_urls?: string[] };
    video_url?: string;
    url?: string;
    output?: { video_url?: string[] };
  };
  const raw = String(payload.status ?? "").toLowerCase();
  const url =
    payload.data?.video_url ??
    payload.data?.url ??
    payload.data?.video_urls?.[0] ??
    payload.video_url ??
    payload.url ??
    payload.output?.video_url?.[0];

  if (["succeeded", "success", "completed", "done", "finished"].includes(raw) || (url && ["", "success"].includes(raw))) {
    if (!url) return { status: "failed", error: "任务成功但未解析到视频地址" };
    return { status: "succeeded", videoUrl: url, progress: 100 };
  }
  if (["failed", "error", "cancelled", "canceled"].includes(raw)) {
    const message = typeof payload.error === "string" ? payload.error : payload.error?.message;
    return { status: "failed", error: message ?? `任务状态：${payload.status}` };
  }
  return { status: "running", progress: typeof payload.progress === "number" ? payload.progress : undefined };
}

/* ------------------------------------------------------------------ */
/* 对外入口                                                            */
/* ------------------------------------------------------------------ */

export interface CreateVideoJobInput {
  mode: VideoMode;
  prompt: string;
  size: VideoSize;
  duration: number;
  image?: string;
  image2?: string;
}

/** 新建一个任务（演示模式下会同步把分镜脚本生成好）。 */
export async function createVideoJob(input: CreateVideoJobInput): Promise<VideoJob> {
  const prompt = input.prompt.trim();
  if (!prompt) throw new Error("先用一句话描述你要的视频");
  if ((input.mode === "image2video" || input.mode === "first-last") && !input.image) {
    throw new Error("该模式需要先上传参考图");
  }
  if (input.mode === "first-last" && !input.image2) {
    throw new Error("首尾帧模式需要上传首帧和尾帧两张图");
  }

  const provider = loadVideoProvider();
  const now = Date.now();
  const job: VideoJob = {
    id: `video-${now}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: now,
    updatedAt: now,
    mode: input.mode,
    prompt,
    size: input.size,
    duration: input.duration,
    model: provider?.model ?? "演示模式",
    channel: provider?.kind ?? "demo",
    status: "queued",
    progress: 0,
    demo: !provider,
    image: input.image,
    image2: input.image2,
  };

  if (!provider) {
    // 演示模式：产出分镜脚本，明确标记，不冒充成片
    job.status = "running";
    job.storyboard = await buildStoryboard({ prompt, duration: input.duration });
    job.status = "succeeded";
    job.progress = 100;
    job.updatedAt = Date.now();
    return job;
  }

  job.status = "running";
  try {
    const result =
      provider.kind === "ark"
        ? await submitArk(provider, job)
        : provider.kind === "openai"
          ? await submitOpenAI(provider, job)
          : await submitCustom(provider, job);
    job.remoteId = result.remoteId;
  } catch (error) {
    job.status = "failed";
    job.error = error instanceof Error ? error.message : String(error);
  }
  job.updatedAt = Date.now();
  return job;
}

/** 轮询一个远程任务；演示模式任务原样返回。 */
export async function pollVideoJob(job: VideoJob): Promise<VideoJob> {
  if (!job.remoteId || job.channel === "demo" || job.status !== "running") return job;
  const provider = loadVideoProvider();
  if (!provider) {
    return { ...job, status: "failed", error: "视频通道配置已清除，任务无法继续轮询", updatedAt: Date.now() };
  }
  try {
    const result =
      provider.kind === "ark"
        ? await pollArk(provider, job.remoteId)
        : provider.kind === "openai"
          ? await pollOpenAI(provider, job.remoteId)
          : await pollCustom(provider, job.remoteId);
    return {
      ...job,
      status: result.status === "succeeded" ? "succeeded" : result.status === "failed" ? "failed" : "running",
      progress: result.progress ?? (result.status === "running" ? Math.min(90, job.progress + 8) : job.progress),
      videoUrl: result.videoUrl ?? job.videoUrl,
      videoBlob: result.videoBlob ?? job.videoBlob,
      error: result.error,
      updatedAt: Date.now(),
    };
  } catch (error) {
    return {
      ...job,
      progress: Math.min(90, job.progress + 5),
      error: error instanceof Error ? error.message : String(error),
      updatedAt: Date.now(),
    };
  }
}

/* ------------------------------------------------------------------ */
/* 任务库（IndexedDB，与生图作品库同模式）                               */
/* ------------------------------------------------------------------ */

const DB_NAME = "supe-video";
const DB_STORE = "jobs";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("本地视频任务库不可用"));
  });
}

export async function listVideoJobs(): Promise<VideoJob[]> {
  try {
    const db = await openDb();
    return await new Promise<VideoJob[]>((resolve, reject) => {
      const tx = db.transaction(DB_STORE, "readonly");
      const request = tx.objectStore(DB_STORE).getAll();
      request.onsuccess = () => {
        const rows = (request.result ?? []) as VideoJob[];
        resolve(rows.sort((a, b) => b.createdAt - a.createdAt));
      };
      request.onerror = () => reject(request.error ?? new Error("读取视频任务失败"));
    });
  } catch {
    return [];
  }
}

export async function saveVideoJob(job: VideoJob): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readwrite");
    tx.objectStore(DB_STORE).put(job);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("保存视频任务失败"));
  });
}

export async function removeVideoJob(id: string): Promise<void> {
  revokeJobVideoUrl(id);
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readwrite");
    tx.objectStore(DB_STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("删除视频任务失败"));
  });
}

/**
 * 会话内对象 URL 缓存：videoBlob 存在 IndexedDB 里可跨会话，
 * 但 URL.createObjectURL 的地址只在当前会话有效，所以按任务 id 缓存复用。
 * 必须在异步上下文（加载/轮询）里调用，渲染路径只读 job.videoUrl。
 */
const objectUrlCache = new Map<string, string>();

export function revokeJobVideoUrl(id: string): void {
  const cached = objectUrlCache.get(id);
  if (cached) {
    URL.revokeObjectURL(cached);
    objectUrlCache.delete(id);
  }
}

/** 把带 Blob 的任务补上当前会话可用的 videoUrl（纯读字段的渲染层因此不需要 effect）。 */
export function hydrateVideoJobs(jobs: VideoJob[]): VideoJob[] {
  return jobs.map((job) => {
    if (job.videoBlob) {
      let url = objectUrlCache.get(job.id);
      if (!url) {
        url = URL.createObjectURL(job.videoBlob);
        objectUrlCache.set(job.id, url);
      }
      return url === job.videoUrl ? job : { ...job, videoUrl: url };
    }
    // 上一次会话遗留的 blob 地址已失效，直接清掉，避免播放器加载失败无提示
    if (job.videoUrl?.startsWith("blob:")) return { ...job, videoUrl: undefined };
    return job;
  });
}

/** 演示模式的分镜导出 Markdown。 */
export function storyboardMarkdown(job: VideoJob): string {
  const lines = [
    `# 视频分镜脚本${job.demo ? "（演示模式 · 未接入视频通道）" : ""}`,
    "",
    `主题：${job.prompt}`,
    `画幅：${job.size} · 时长：约 ${job.duration} 秒`,
    "",
  ];
  (job.storyboard ?? []).forEach((scene, index) => {
    lines.push(`## ${index + 1}. ${scene.scene}（${scene.duration}）`);
    lines.push(`- 画面：${scene.visual}`);
    if (scene.line) lines.push(`- 台词/字幕：${scene.line}`);
    lines.push("");
  });
  return lines.join("\n");
}
