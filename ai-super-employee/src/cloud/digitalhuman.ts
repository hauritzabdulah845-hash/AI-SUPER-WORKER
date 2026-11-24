/**
 * L4 数字人出片任务：demo 任务队列（本机留档）+ generic submit/poll（配置存本机，服务到位即接）。
 * demo 不做真实转码——任务完成提示走 L2 导出的 ffmpeg 脚本出片（与混剪工坊同边界）。
 */

export interface DigitalProviderConfig {
  baseUrl: string;
  submitPath: string;
  pollPath: string;
  idField: string;
  statusField: string;
  doneValue: string;
}

export const DIGITAL_PROVIDER_KEY = "ai-employee:digital-provider";

const DEFAULT_PROVIDER: DigitalProviderConfig = {
  baseUrl: "",
  submitPath: "/api/digital/jobs",
  pollPath: "/api/digital/jobs",
  idField: "id",
  statusField: "status",
  doneValue: "done",
};

export function loadDigitalProvider(): DigitalProviderConfig {
  try {
    const raw = localStorage.getItem(DIGITAL_PROVIDER_KEY);
    if (raw) return { ...DEFAULT_PROVIDER, ...(JSON.parse(raw) as Partial<DigitalProviderConfig>) };
  } catch {
    /* 节点测试环境无 localStorage */
  }
  return { ...DEFAULT_PROVIDER };
}

export function saveDigitalProvider(config: DigitalProviderConfig): void {
  try {
    localStorage.setItem(DIGITAL_PROVIDER_KEY, JSON.stringify(config));
  } catch {
    /* 只读环境忽略 */
  }
}

export interface DigitalJob {
  id: string;
  topic: string;
  mode: string;
  status: "queued" | "running" | "done" | "failed";
  progress: number;
  note: string;
  demo: boolean;
  createdAt: number;
}

export const DIGITAL_JOBS_KEY = "ai-employee:digital-jobs";
const JOB_CAP = 10;

export function loadDigitalJobs(): DigitalJob[] {
  try {
    const raw = localStorage.getItem(DIGITAL_JOBS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as DigitalJob[]) : [];
  } catch {
    return [];
  }
}

export function saveDigitalJobs(jobs: DigitalJob[]): void {
  try {
    localStorage.setItem(DIGITAL_JOBS_KEY, JSON.stringify(jobs.slice(0, JOB_CAP)));
  } catch {
    /* 只读环境忽略 */
  }
}

/** demo 任务推进一步（纯函数）：queued→running→每 tick +20%→done；真实任务与已完成任务不动。 */
export function advanceJob(job: DigitalJob): DigitalJob {
  if (!job.demo || job.status === "done" || job.status === "failed") return job;
  if (job.status === "queued") return { ...job, status: "running", progress: 10, note: "演示任务执行中…" };
  const progress = Math.min(100, job.progress + 20);
  if (progress >= 100) {
    return {
      ...job,
      status: "done",
      progress: 100,
      note: "演示任务完成；真实出片请执行 L2 导出的 ffmpeg 脚本，或配置 L4 服务后重提",
    };
  }
  return { ...job, progress, note: "演示任务执行中…" };
}

/**
 * 提交出片任务：
 * - 配置了 baseUrl → POST submitPath（body {topic, mode}），按 idField 取任务号；网络失败记 failed；
 * - 未配置 → 本地 demo 任务（立即可见的队列体验）。
 */
export async function submitDigitalJob(
  topic: string,
  mode: string,
  provider: DigitalProviderConfig,
): Promise<DigitalJob> {
  const base: DigitalJob = {
    id: `demo-${Date.now().toString(36)}`,
    topic,
    mode,
    status: "queued",
    progress: 0,
    note: "",
    demo: !provider.baseUrl.trim(),
    createdAt: Date.now(),
  };

  if (!provider.baseUrl.trim()) {
    return { ...base, note: "演示任务（未配置 L4 服务）" };
  }

  try {
    const response = await fetch(provider.baseUrl.replace(/\/$/, "") + provider.submitPath, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ topic, mode }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = (await response.json()) as Record<string, unknown>;
    const externalId = data[provider.idField];
    return {
      ...base,
      id: externalId === undefined ? base.id : String(externalId),
      demo: false,
      note: "已提交到 L4 服务",
    };
  } catch (error) {
    return {
      ...base,
      status: "failed",
      note: `提交失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** 轮询真实任务状态；demo 任务直接推进一步。 */
export async function refreshDigitalJob(job: DigitalJob, provider: DigitalProviderConfig): Promise<DigitalJob> {
  if (job.demo) return advanceJob(job);
  if (!provider.baseUrl.trim() || job.status === "done" || job.status === "failed") return job;
  try {
    const response = await fetch(provider.baseUrl.replace(/\/$/, "") + provider.pollPath, {
      method: "GET",
      headers: { "content-type": "application/json" },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = (await response.json()) as Record<string, unknown>;
    const status = String(data[provider.statusField] ?? "");
    if (status === provider.doneValue) return { ...job, status: "done", progress: 100, note: "服务端已完成" };
    if (status === "failed") return { ...job, status: "failed", note: "服务端任务失败" };
    return { ...job, status: "running", note: `服务端状态：${status || "unknown"}` };
  } catch (error) {
    return { ...job, note: `轮询失败：${error instanceof Error ? error.message : String(error)}` };
  }
}
