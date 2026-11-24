import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  ArrowLeft,
  ArrowUpRight,
  BarChart3,
  Bell,
  BookOpen,
  Bot,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Clapperboard,
  ClipboardCopy,
  Clock3,
  Download,
  ExternalLink,
  FileText,
  Upload,
  FolderKanban,
  FolderOpen,
  FolderPlus,
  Gauge,
  Globe2,
  HardDrive,
  Inbox,
  KeyRound,
  LayoutDashboard,
  Link2,
  LoaderCircle,
  LogIn,
  Megaphone,
  Mic,
  Menu,
  Map as MapIcon,
  ImagePlus,
  MessageSquareText,
  Palette,
  Pencil,
  Plug,
  Presentation,
  Plus,
  Radio,
  RefreshCw,
  RotateCcw,
  Scissors,
  ScrollText,
  Wand2,
  Search,
  Send,
  Sparkles,
  Target,
  Trash2,
  Timer,
  TrendingUp,
  Users,
  X,
  Zap,
} from "lucide-react";
import CommandDemo from "./CommandDemo";
import { KfSyncCard } from "./KfSyncCard";
import { WecomGuide } from "./WecomGuide";
import { GeoWorkbench } from "./GeoWorkbench";
import { VideoStudio } from "./VideoStudio";
import { CommandInbox } from "./CommandInbox";
import { MixStudio } from "./MixStudio";
import { PipelineCenter } from "./PipelineCenter";
import { OpsReportCard } from "./OpsReportCard";
import { OfficeStudio } from "./OfficeStudio";
import { MapLeads } from "./MapLeads";
import { BroadcastCenter } from "./BroadcastCenter";
import { ServiceChannels } from "./ServiceChannels";
import { KnowledgeList } from "./KnowledgeList";
import { UsagePanel } from "./UsagePanel";
import { DigitalStudio } from "./DigitalStudio";
import { PublishHub } from "./PublishHub";
import {
  clearArtworks,
  generateImage,
  imageChannelStatus,
  listArtworks,
  removeArtwork,
  saveArtworks,
  type Artwork,
  type ImageSize,
} from "../cloud/canvas";
import LoginPanel from "./LoginPanel";
import { customPromptOf } from "../cloud/agent-routing";
import { slugToNav } from "../nav";
import type { SessionUser } from "../cloud/client";
import { signOut } from "../cloud/client";
import {
  canonicalBaseUrl,
  clearCustomProvider,
  loadChannel,
  loadCustomProvider,
  probeCustom,
  probePlatform,
  saveChannel,
  saveCustomProvider,
  type ChannelKind,
} from "../cloud/provider";
import {
  ensurePermission,
  filesFromInput,
  forgetHandle,
  importFromFileMap,
  importItems,
  loadFolderBinding,
  loadHandle,
  pickFolder,
  scanFolder,
  supportsFolderPicker,
  type FolderBinding,
  type KbFileItem,
} from "../cloud/kb-import";
import {
  deleteAgent,
  deleteKnowledgeDoc,
  deleteLead,
  deleteTask,
  deleteWecomLink,
  getKnowledgeDoc,
  instantiateAgent,
  insertKnowledgeDoc,
  insertLead,
  insertWecomLink,
  insertFollowUp,
  importKfMessages,
  listAgents,
  listFollowUps,
  listKfMessages,
  listKnowledgeDocs,
  listLeads,
  listPrivateTasks,
  listTemplates,
  listTaskSteps,
  listWecomLinks,
  reapStaleTasks,
  saveAgentPersona,
  updateAgent,
  updateTaskStep,
  updateLead,
  upsertLeadByExternalId,
  type AgentRow,
  type AgentTemplate,
  type DemoTaskRow,
  type KnowledgeRow,
  type LeadRow,
  type FollowUpRow,
  type KfCustomerPayload,
  type KfEventPayload,
  type KfMessageRow,
  type TaskRow,
  type WecomLinkRow,
} from "../cloud/api";
import { parseLeadsCsv, type LeadImportRow } from "../cloud/leadcsv";
import { summarizeTasks, taskStatsHeadline } from "../cloud/tasksummary";

const navItems = [
  { label: "AI 总控", icon: LayoutDashboard },
  { label: "远程指令", icon: Inbox },
  { label: "智能体团队", icon: Bot },
  { label: "任务中心", icon: FolderKanban },
  { label: "定时任务", icon: Timer },
  { label: "模板中心", icon: Sparkles },
  { label: "内容工厂", icon: FileText },
  { label: "聚合发布", icon: Megaphone },
  { label: "线索与客户", icon: Users },
  { label: "地图获客", icon: MapIcon },
  { label: "企业知识库", icon: BookOpen },
  { label: "企微私域", icon: MessageSquareText },
  { label: "群发计划", icon: Send },
  { label: "客服渠道", icon: Radio },
  { label: "GEO 工作台", icon: Globe2 },
  { label: "数据洞察", icon: BarChart3 },
  { label: "AI 创作", icon: Palette },
  { label: "视频创作", icon: Clapperboard },
  { label: "混剪工坊", icon: Scissors },
  { label: "数字人工坊", icon: Mic },
  { label: "AI 办公", icon: Presentation },
  { label: "模型接入", icon: Plug },
];

const STAGE_FLOW = ["新建", "跟进中", "已预约", "已成交"];
const INTENT_OPTIONS = ["高意向", "中意向", "低意向"];
const DOC_TYPE_OPTIONS = ["产品手册", "价格体系", "流程制度", "培训资料", "客户案例", "常见问答"];

type AnyTask = TaskRow | DemoTaskRow;

interface StepView {
  label: string;
  action: string;
  output: string | null;
  status: string;
}

/** 轻量 Markdown 渲染：先转义 HTML 再替换加粗/标题/列表符，LLM 产出不会被当标签执行。 */
function renderStepOutput(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/^#{1,5}\s*(.+)$/gm, "<strong>$1</strong>")
    .replace(/^[-*]\s+/gm, "· ");
}

interface ConsoleProps {
  onBack: () => void;
  user: SessionUser | null;
  onSignedIn: () => void;
  initialNav?: string;
  onNavChange?: (label: string) => void;
}

export default function Console({ onBack, user, onSignedIn, initialNav = "AI 总控", onNavChange }: ConsoleProps) {
  const [activeNav, setActiveNav] = useState(slugToNav(initialNav));
  const [templates, setTemplates] = useState<AgentTemplate[]>([]);
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [tasks, setTasks] = useState<AnyTask[]>([]);
  const [leads, setLeads] = useState<LeadRow[]>([]);
  const [knowledge, setKnowledge] = useState<KnowledgeRow[]>([]);
  const [wecomLinks, setWecomLinks] = useState<WecomLinkRow[]>([]);
  const [showComposer, setShowComposer] = useState(false);
  const [showNotifications, setShowNotifications] = useState(false);
  const [showLogin, setShowLogin] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);
  const [toast, setToast] = useState("");
  const [loading, setLoading] = useState(true);
  const [selectedTask, setSelectedTask] = useState<AnyTask | null>(null);
  const [selectedSteps, setSelectedSteps] = useState<StepView[]>([]);
  const [stepsLoading, setStepsLoading] = useState(false);
  const [showPalette, setShowPalette] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [showLeadForm, setShowLeadForm] = useState(false);
  const [csvText, setCsvText] = useState("");
  const [showCsvImport, setShowCsvImport] = useState(false);
  const [leadForm, setLeadForm] = useState({ name: "", source: "", intent: "高意向", need: "", owner: "" });
  // 表单提交中状态：云端写入有时需数秒，按钮必须给反馈，避免用户重复点击造成重复数据。
  const [formSaving, setFormSaving] = useState<"" | "lead" | "knowledge" | "wecom" | "followup" | "csv">("");
  const [showKnowledgeForm, setShowKnowledgeForm] = useState(false);
  const [knowledgeForm, setKnowledgeForm] = useState({ title: "", docType: "产品手册", content: "" });
  const [docDetail, setDocDetail] = useState<KnowledgeRow | null>(null);
  const [composerSeed, setComposerSeed] = useState<{ goal?: string; templateCode?: string } | null>(null);
  const [seenNotificationSignature, setSeenNotificationSignature] = useState(() => window.localStorage.getItem("wb-notif-seen") ?? "");
  const [taskFilter, setTaskFilter] = useState<"全部" | "running" | "done" | "partial" | "failed">("全部");
  const [domainFilter, setDomainFilter] = useState<string | null>(null);
  const [templateDomain, setTemplateDomain] = useState("全部");
  const [templateQuery, setTemplateQuery] = useState("");
  const [contentAgent, setContentAgent] = useState("全部");
  /** 「去发布」预选的产出（`标题-创建时间`），传给聚合发布页 */
  const [publishSource, setPublishSource] = useState("");
  const [contentDetail, setContentDetail] = useState<{ title: string; agent: string; output: string; created_at: string; taskId: number | null; stepIndex: number; demo: boolean } | null>(null);
  const [agentEditing, setAgentEditing] = useState<{ id: number; name: string } | null>(null);
  // 人设编辑：baseline 是官方默认提示词，prompt 是正在编辑的内容。
  const [personaEditing, setPersonaEditing] = useState<{ agentId: number; name: string; templateName: string; baseline: string; prompt: string } | null>(null);
  const [personaSaving, setPersonaSaving] = useState(false);
  const [showPersonaDefault, setShowPersonaDefault] = useState(false);
  const [showWecomForm, setShowWecomForm] = useState(false);
  const [wecomForm, setWecomForm] = useState({ kind: "智能文档", title: "", summary: "", url: "" });
  // 跟进回填：企微里聊完回到系统记一笔，阶段与漏斗随之更新（闭环的回流半边）。
  const [followUpLead, setFollowUpLead] = useState<LeadRow | null>(null);
  const [followUps, setFollowUps] = useState<FollowUpRow[]>([]);
  const [followUpLoading, setFollowUpLoading] = useState(false);
  // 企微客户同步：服务地址与密钥属于运维配置，存本机；游标决定增量拉取范围。
  const [kfConfig, setKfConfig] = useState<{ baseUrl: string; secret: string; lastSeq: number; lastAt: string }>(() => {
    const fallback = { baseUrl: "", secret: "", lastSeq: 0, lastAt: "" };
    try {
      const raw = window.localStorage.getItem("ai-employee:kf-sync");
      return raw ? { ...fallback, ...(JSON.parse(raw) as Partial<typeof fallback>) } : fallback;
    } catch {
      return fallback;
    }
  });
  const [kfSyncing, setKfSyncing] = useState(false);
  const [kfSummary, setKfSummary] = useState("");
  const [kfMessages, setKfMessages] = useState<KfMessageRow[]>([]);
  const [followUpForm, setFollowUpForm] = useState({ channel: "企微", result: "已联系", next: "", note: "" });
  const [followUpStage, setFollowUpStage] = useState("跟进中");
  const [channel, setChannel] = useState<ChannelKind>(() => loadChannel());
  const [providerForm, setProviderForm] = useState(() => {
    const saved = loadCustomProvider();
    return { baseUrl: saved?.baseUrl ?? "", apiKey: saved?.apiKey ?? "", model: saved?.model ?? "" };
  });
  const [platformStatus, setPlatformStatus] = useState<{ ok: boolean; detail: string } | null>(null);
  const [customStatus, setCustomStatus] = useState<{ ok: boolean; detail: string } | null>(null);
  const [probing, setProbing] = useState<"platform" | "custom" | null>(null);
  // AI 创作（生图）
  const [studioPrompt, setStudioPrompt] = useState("");
  const [studioSize, setStudioSize] = useState<ImageSize>("1024x1024");
  const [studioBusy, setStudioBusy] = useState(false);
  const [studioError, setStudioError] = useState("");
  const [studioNotice, setStudioNotice] = useState("");
  const [artworks, setArtworks] = useState<Artwork[]>([]);
  const [preview, setPreview] = useState<Artwork | null>(null);
  const [kbBinding, setKbBinding] = useState<FolderBinding | null>(() => loadFolderBinding());
  const [kbScan, setKbScan] = useState<{ items: KbFileItem[]; selected: string[]; folder: string } | null>(null);
  const [kbBusy, setKbBusy] = useState<"" | "scan" | "import">("");
  const [kbProgress, setKbProgress] = useState("");
  const [kbResult, setKbResult] = useState("");
  const [kbOnlySupported, setKbOnlySupported] = useState(true);

  // ---------- AI 创作 ----------
  const studioChannel = imageChannelStatus();

  const loadArtworks = useCallback(async () => {
    setArtworks(await listArtworks());
  }, []);

  useEffect(() => {
    if (activeNav === "AI 创作") void loadArtworks();
  }, [activeNav, loadArtworks]);

  const runGenerate = async () => {
    const prompt = studioPrompt.trim();
    if (!prompt) {
      setStudioError("先用一句话描述你想要的画面");
      return;
    }
    setStudioBusy(true);
    setStudioError("");
    setStudioNotice("");
    try {
      const results = await generateImage({ prompt, size: studioSize });
      const saved = await saveArtworks(results);
      setArtworks((current) => [...saved, ...current]);
      setStudioNotice(`已生成 ${saved.length} 张，已存入本地作品库`);
    } catch (error) {
      setStudioError(error instanceof Error ? error.message : "生成失败，请稍后重试");
    } finally {
      setStudioBusy(false);
    }
  };

  const removeArtworkItem = async (item: Artwork) => {
    try {
      await removeArtwork(item.id);
      setArtworks((current) => current.filter((row) => row.id !== item.id));
      if (preview?.id === item.id) setPreview(null);
      setToast("作品已删除");
    } catch (error) {
      setToast(error instanceof Error ? error.message : "删除失败");
    }
  };

  const clearAllArtworks = async () => {
    try {
      await clearArtworks();
      setArtworks([]);
      setPreview(null);
      setToast("作品库已清空");
    } catch (error) {
      setToast(error instanceof Error ? error.message : "清空失败");
    }
  };

  const downloadArtwork = (item: Artwork) => {
    const link = document.createElement("a");
    link.href = item.src;
    link.download = `supe-artwork-${item.id}.png`;
    link.rel = "noopener";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };


  const runPlatformProbe = async () => {
    setProbing("platform");
    setPlatformStatus(null);
    try {
      setPlatformStatus(await probePlatform());
    } finally {
      setProbing(null);
    }
  };

  const runCustomProbe = async () => {
    if (!providerForm.baseUrl.trim() || !providerForm.apiKey.trim() || !providerForm.model.trim()) {
      setToast("请先填写端点地址、API Key 与模型名");
      return;
    }
    const fixed = { baseUrl: canonicalBaseUrl(providerForm.baseUrl), apiKey: providerForm.apiKey.trim(), model: providerForm.model.trim() };
    if (fixed.baseUrl !== providerForm.baseUrl) setProviderForm({ ...providerForm, baseUrl: fixed.baseUrl });
    setProbing("custom");
    setCustomStatus(null);
    saveCustomProvider(fixed);
    try {
      const result = await probeCustom(fixed);
      setCustomStatus(result);
      setToast(result.ok ? "自定义通道连通正常，可切换使用" : `连通失败：${result.detail}`);
    } finally {
      setProbing(null);
    }
  };

  const switchChannel = (kind: ChannelKind) => {
    if (kind === "custom") {
      if (!providerForm.baseUrl.trim() || !providerForm.apiKey.trim() || !providerForm.model.trim()) {
        setToast("请先填写并验证自定义通道信息");
        return;
      }
      const fixed = { baseUrl: canonicalBaseUrl(providerForm.baseUrl), apiKey: providerForm.apiKey.trim(), model: providerForm.model.trim() };
      if (fixed.baseUrl !== providerForm.baseUrl) setProviderForm({ ...providerForm, baseUrl: fixed.baseUrl });
      saveCustomProvider(fixed);
    }
    saveChannel(kind);
    setChannel(kind);
    setToast(kind === "custom" ? "已切换到自定义模型通道，任务将走你自己的 Key" : "已切换到平台通道");
  };

  const resetCustomProvider = () => {
    clearCustomProvider();
    setProviderForm({ baseUrl: "", apiKey: "", model: "" });
    setCustomStatus(null);
    setChannel("platform");
    setToast("已清除自定义通道，恢复使用平台模型");
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // 先自愈：把上次会话中断留下的「执行中」僵尸任务标记掉，避免列表里挂着不动。
      await reapStaleTasks();
      const [templateRows, agentRows, taskRows, leadRows, docRows, linkRows] = await Promise.all([
        listTemplates(),
        listAgents(),
        listPrivateTasks(),
        listLeads(),
        listKnowledgeDocs(),
        listWecomLinks(),
      ]);
      setTemplates(templateRows);
      setAgents(agentRows);
      setTasks(taskRows as AnyTask[]);
      setLeads(leadRows);
      setKnowledge(docRows);
      setWecomLinks(linkRows);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "数据加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const fallbackInputRef = useRef<HTMLInputElement | null>(null);
  const fallbackMapRef = useRef<Map<string, File> | null>(null);

  const applyScan = (items: KbFileItem[], folder: string) => {
    setKbScan({ items, selected: items.filter((item) => item.supported).map((item) => item.id), folder });
    setKbBinding(loadFolderBinding());
  };

  const handlePickFolder = async () => {
    setKbResult("");
    if (!supportsFolderPicker()) {
      fallbackInputRef.current?.click();
      return;
    }
    try {
      setKbBusy("scan");
      setKbProgress("正在请求文件夹权限…");
      const handle = await pickFolder();
      if (!handle) return;
      setKbProgress("正在扫描文件…");
      const items = await scanFolder(handle, (count, name) => setKbProgress(`已发现 ${count} 个文件 · ${name.slice(0, 26)}`));
      fallbackMapRef.current = null;
      applyScan(items, handle.name);
      setToast(`扫描完成：${items.length} 个文件，其中 ${items.filter((item) => item.supported).length} 个可导入`);
    } catch (error) {
      const err = error as Error;
      if (err.name !== "AbortError") setToast(err.message || "读取文件夹失败");
    } finally {
      setKbBusy("");
      setKbProgress("");
    }
  };

  const handleRescan = async () => {
    setKbResult("");
    try {
      setKbBusy("scan");
      setKbProgress("正在校验文件夹权限…");
      const handle = await loadHandle();
      if (!handle) {
        setToast("找不到上次选择的文件夹，请重新选择");
        return;
      }
      const granted = await ensurePermission(handle);
      if (!granted) {
        setToast("未获得该文件夹的读取权限");
        return;
      }
      setKbProgress("正在重新扫描…");
      const items = await scanFolder(handle, (count, name) => setKbProgress(`已发现 ${count} 个文件 · ${name.slice(0, 26)}`));
      applyScan(items, handle.name);
      setToast(`重新扫描完成：${items.length} 个文件`);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "重新扫描失败");
    } finally {
      setKbBusy("");
      setKbProgress("");
    }
  };

  const handleUnbindFolder = async () => {
    await forgetHandle();
    setKbBinding(null);
    setKbScan(null);
    setKbResult("");
    setToast("已解绑文件夹，云端已导入的资料不受影响");
  };

  const handleFallbackFiles = async (fileList: FileList | null) => {
    if (!fileList?.length) return;
    try {
      setKbBusy("scan");
      const firstPath = (fileList[0] as File & { webkitRelativePath?: string }).webkitRelativePath ?? "";
      const folderName = firstPath.includes("/") ? firstPath.split("/")[0] : "本地文件夹";
      const { items, contents } = await filesFromInput(fileList);
      fallbackMapRef.current = contents;
      applyScan(items, folderName);
      setToast(`扫描完成：${items.length} 个文件`);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "读取文件失败");
    } finally {
      setKbBusy("");
    }
  };

  const toggleKbItem = (id: string) => {
    setKbScan((prev) =>
      prev
        ? { ...prev, selected: prev.selected.includes(id) ? prev.selected.filter((item) => item !== id) : [...prev.selected, id] }
        : prev,
    );
  };

  const toggleKbAll = () => {
    setKbScan((prev) => {
      if (!prev) return prev;
      const selectable = prev.items.filter((item) => item.supported).map((item) => item.id);
      return { ...prev, selected: prev.selected.length === selectable.length ? [] : selectable };
    });
  };

  const handleImportSelected = async () => {
    if (!kbScan) return;
    const chosen = kbScan.items.filter((item) => kbScan.selected.includes(item.id) && item.supported);
    if (!chosen.length) {
      setToast("请至少选择一个可导入的文件");
      return;
    }
    try {
      setKbBusy("import");
      setKbResult("");
      const progress = (done: number, total: number, name: string) => setKbProgress(`${done}/${total} · ${name || "完成"}`);
      const handle = await loadHandle();
      let imported = 0;
      let updated = 0;
      let failed = 0;
      let firstError = "";

      if (handle) {
        const granted = await ensurePermission(handle);
        if (!granted) throw new Error("未获得文件夹读取权限");
        const outcome = await importItems(handle, chosen, { folderName: kbScan.folder, ownerName: user?.name ?? null, onProgress: progress });
        imported = outcome.imported;
        updated = outcome.updated;
        failed = outcome.failed;
        firstError = outcome.errors[0] ?? "";
      } else if (fallbackMapRef.current) {
        const outcome = await importFromFileMap(fallbackMapRef.current, chosen, {
          folderName: kbScan.folder,
          ownerName: user?.name ?? null,
          onProgress: progress,
        });
        imported = outcome.imported;
        updated = outcome.updated;
        failed = outcome.failed;
        firstError = outcome.errors[0] ?? "";
      } else {
        throw new Error("文件夹已失效，请重新选择");
      }

      await load();
      const updatedPart = updated ? `，更新 ${updated} 份已存在的资料` : "";
      setKbResult(`已导入 ${imported} 份资料${updatedPart}${failed ? `，${failed} 份失败：${firstError}` : "，智能体现在可以调用这些内容"}`);
      setToast(`导入完成：新增 ${imported} 份${updated ? ` · 更新 ${updated} 份` : ""}`);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "导入失败");
    } finally {
      setKbBusy("");
      setKbProgress("");
    }
  };

  // 模块与 URL hash 双向同步：刷新 / 后退 / 分享都能停在同一个模块
  useEffect(() => {
    onNavChange?.(activeNav);
  }, [activeNav, onNavChange]);

  useEffect(() => {
    const next = slugToNav(initialNav);
    setActiveNav((current) => (current === next ? current : next));
  }, [initialNav]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 4200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  // ⌘K / Ctrl+K 打开全局搜索
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setShowPalette((value) => !value);
        setPaletteQuery("");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const openComposer = (seed?: { goal?: string; templateCode?: string }) => {
    setComposerSeed(seed ?? null);
    setShowComposer(true);
  };

  const filteredTasks = useMemo(() => {
    const byStatus = taskFilter === "全部" ? tasks : tasks.filter((task) => task.status === taskFilter);
    if (!domainFilter) return byStatus;
    return byStatus.filter((task) => ((task as DemoTaskRow).domain ?? "") === domainFilter);
  }, [tasks, taskFilter, domainFilter]);

  const taskStatusCounts = useMemo(
    () => ({
      全部: tasks.length,
      running: tasks.filter((task) => task.status === "running").length,
      done: tasks.filter((task) => task.status === "done").length,
      partial: tasks.filter((task) => task.status === "partial").length,
      failed: tasks.filter((task) => task.status === "failed").length,
    }),
    [tasks],
  );

  const runningCount = tasks.filter((task) => task.status === "running").length;
  const doneCount = tasks.filter((task) => task.status === "done").length;
  const failedCount = tasks.filter((task) => task.status === "failed").length;
  const pendingLeads = leads.filter((lead) => lead.stage === "新建" || lead.stage === "跟进中").length;
  const highIntent = leads.filter((lead) => lead.intent === "高意向").length;
  const totalTokens = tasks.reduce((sum, task) => sum + ((task as DemoTaskRow).tokens ?? 0), 0);

  const now = new Date();
  const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const weekdayLabels = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

  // 近 7 天每日任务创建数（真实统计）
  const trend = useMemo(() => {
    const days = Array.from({ length: 7 }, (_, index) => {
      const dayStart = startOfDay(now) - (6 - index) * 86400000;
      return { dayStart, count: 0, label: index === 6 ? "今天" : weekdayLabels[new Date(dayStart).getDay()] };
    });
    tasks.forEach((task) => {
      const ts = startOfDay(new Date(task.created_at));
      const slot = days.find((day) => day.dayStart === ts);
      if (slot) slot.count += 1;
    });
    return days;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks]);

  const trendMax = Math.max(...trend.map((day) => day.count), 1);

  // 本月任务用量（真实统计，500 为月度额度上限）
  const monthTasks = tasks.filter((task) => {
    const created = new Date(task.created_at);
    return created.getFullYear() === now.getFullYear() && created.getMonth() === now.getMonth();
  }).length;
  const monthQuota = 500;
  const quotaPercent = Math.min(100, Math.round((monthTasks / monthQuota) * 100));

  const todayText = `${now.getFullYear()} 年 ${now.getMonth() + 1} 月 ${now.getDate()} 日 · ${weekdayLabels[now.getDay()]}`;

  const contentOutputs = useMemo(() => {
    const items: { title: string; agent: string; output: string; created_at: string; taskId: number | null; stepIndex: number; demo: boolean }[] = [];
    tasks.forEach((task) => {
      const steps = (task as DemoTaskRow).steps ?? [];
      steps.forEach((step, stepIndex) => {
        if (!step.output) return;
        items.push({
          title: `${step.agent} · ${task.title ?? "任务产出"}`,
          agent: step.agent,
          output: step.output,
          created_at: task.created_at,
          taskId: task.id,
          stepIndex,
          demo: "steps" in task,
        });
      });
    });
    return items.slice(0, 24);
  }, [tasks]);

  const contentAgents = useMemo(
    () => ["全部", ...Array.from(new Set(contentOutputs.map((item) => item.agent)))],
    [contentOutputs],
  );

  const visibleContent = useMemo(
    () => (contentAgent === "全部" ? contentOutputs : contentOutputs.filter((item) => item.agent === contentAgent)),
    [contentOutputs, contentAgent],
  );

  const templateDomains = useMemo(
    () => ["全部", ...Array.from(new Set(templates.map((template) => template.domain)))],
    [templates],
  );

  const visibleTemplates = useMemo(() => {
    const query = templateQuery.trim().toLowerCase();
    return templates.filter((template) => {
      const domainOk = templateDomain === "全部" || template.domain === templateDomain;
      const queryOk = !query || `${template.name}${template.summary}${template.domain}${template.capabilities.join("")}`.toLowerCase().includes(query);
      return domainOk && queryOk;
    });
  }, [templates, templateDomain, templateQuery]);

  const openTask = async (task: AnyTask) => {
    setSelectedTask(task);
    const demoSteps = (task as DemoTaskRow).steps ?? [];
    // 匿名态同样可以读 task_steps，不能因为没登录就不拉步骤——否则详情永远是空的。
    if (Array.isArray(demoSteps) && demoSteps.length > 0) {
      setSelectedSteps(demoSteps.map((step) => ({ label: step.agent, action: step.action, output: step.output ?? null, status: step.status })));
      return;
    }
    setSelectedSteps([]);
    setStepsLoading(true);
    try {
      const rows = await listTaskSteps(task.id);
      setSelectedSteps(rows.map((row) => ({ label: row.agent_name, action: row.action, output: row.output, status: row.status })));
    } catch {
      setSelectedSteps([]);
    } finally {
      setStepsLoading(false);
    }
  };

  /* ------------------------------- 派生数据 ------------------------------- */

  // 任务详情：结论摘要 / tokens / 失败原因都存在 result 与 error 里，直接展示，不用用户自己猜。
  const taskResult = (selectedTask?.result ?? {}) as { summary?: string; tokens?: number };
  const taskSummary = typeof taskResult.summary === "string" ? taskResult.summary : "";
  const taskTokens = Number(taskResult.tokens ?? (selectedTask as DemoTaskRow | null)?.tokens ?? 0) || 0;
  const taskError = selectedTask?.error ?? "";
  const stepsDoneCount = selectedSteps.filter((step) => step.status === "done").length;

  const copyTaskOutput = async () => {
    if (!selectedTask) return;
    const statusText = selectedTask.status === "done" ? "已交付" : selectedTask.status === "failed" ? "失败" : selectedTask.status === "partial" ? "部分完成" : "执行中";
    const lines: string[] = [
      `# ${selectedTask.title ?? selectedTask.goal}`,
      `目标：${selectedTask.goal}`,
      `状态：${statusText} · 进度 ${selectedTask.progress}% · ${new Date(selectedTask.created_at).toLocaleString("zh-CN", { hour12: false })}`,
      "",
    ];
    if (taskSummary) lines.push("## 结论摘要", taskSummary, "");
    if (taskError) lines.push("## 失败原因", taskError, "");
    selectedSteps.forEach((step, index) => {
      lines.push(`## ${index + 1}. ${step.label}｜${step.action}`, step.output ?? "（无产出）", "");
    });
    await copyText(lines.join("\n"), "已复制完整任务产出，可直接粘贴到文档");
  };

  const notifications = useMemo(() => {
    const items: { icon: typeof Activity; text: string; tone: string }[] = [];
    tasks
      .filter((task) => task.status === "running")
      .slice(0, 2)
      .forEach((task) => items.push({ icon: Activity, text: `「${task.title ?? task.goal.slice(0, 16)}」正在执行`, tone: "violet" }));
    tasks
      .filter((task) => task.status === "failed")
      .slice(0, 2)
      .forEach((task) => items.push({ icon: CircleDot, text: `「${task.title ?? task.goal.slice(0, 16)}」执行失败，可重跑`, tone: "red" }));
    tasks
      .filter((task) => task.status === "partial")
      .slice(0, 2)
      .forEach((task) => items.push({ icon: Clock3, text: `「${task.title ?? task.goal.slice(0, 16)}」部分完成`, tone: "orange" }));
    leads
      .filter((lead) => lead.intent === "高意向" && (lead.stage === "新建" || lead.stage === "跟进中"))
      .slice(0, 3)
      .forEach((lead) => items.push({ icon: Target, text: `高意向客户「${lead.name}」待跟进：${lead.need.slice(0, 18)}`, tone: "orange" }));
    if (knowledge.length === 0) items.push({ icon: BookOpen, text: "企业知识库还是空的，录入资料可提升智能体产出质量", tone: "violet" });
    return items.slice(0, 8);
  }, [tasks, leads, knowledge]);

  const notificationSignature = notifications.map((item) => item.text).join("|");
  const hasUnreadNotifications = notifications.length > 0 && notificationSignature !== seenNotificationSignature;

  const markNotificationsRead = () => {
    window.localStorage.setItem("wb-notif-seen", notificationSignature);
    setSeenNotificationSignature(notificationSignature);
  };

  const paletteItems = useMemo(() => {
    const query = paletteQuery.trim().toLowerCase();
    const match = (...fields: (string | null | undefined)[]) => !query || fields.some((field) => (field ?? "").toLowerCase().includes(query));
    const items: { label: string; sub: string; module: string; run: () => void }[] = [];
    tasks.forEach((task) => {
      if (match(task.title, task.goal)) {
        items.push({
          label: task.title ?? task.goal.slice(0, 24),
          sub: `任务 · ${task.status === "done" ? "已交付" : task.status === "failed" ? "失败" : task.status === "partial" ? "部分完成" : "执行中"}`,
          module: "任务中心",
          run: () => openTask(task),
        });
      }
    });
    leads.forEach((lead) => {
      if (match(lead.name, lead.need, lead.source)) {
        items.push({ label: `${lead.name}（${lead.stage}）`, sub: `线索 · ${lead.need.slice(0, 24)}`, module: "线索与客户", run: () => setActiveNav("线索与客户") });
      }
    });
    templates.forEach((template) => {
      if (match(template.name, template.summary, template.domain)) {
        items.push({ label: template.name, sub: `模板 · ${template.domain}`, module: "模板中心", run: () => setActiveNav("模板中心") });
      }
    });
    knowledge.forEach((doc) => {
      if (match(doc.title, doc.doc_type)) {
        items.push({ label: doc.title, sub: `知识 · ${doc.doc_type}`, module: "企业知识库", run: () => setActiveNav("企业知识库") });
      }
    });
    return items.slice(0, 9);
  }, [paletteQuery, tasks, leads, templates, knowledge]);

  const funnelStages = useMemo(
    () => [
      { label: "内容产出", value: contentOutputs.length },
      { label: "进入跟进", value: leads.filter((lead) => lead.stage !== "新建").length },
      { label: "高意向", value: highIntent },
      { label: "已预约", value: leads.filter((lead) => lead.stage === "已预约").length },
      { label: "已成交", value: leads.filter((lead) => lead.stage === "已成交").length },
    ],
    [contentOutputs, leads, highIntent],
  );
  const funnelMax = Math.max(...funnelStages.map((stage) => stage.value), 1);

  // AI 员工产出排行（按步骤产出条数真实统计）
  const agentRanking = useMemo(() => {
    const map = new Map<string, number>();
    contentOutputs.forEach((item) => map.set(item.agent, (map.get(item.agent) ?? 0) + 1));
    const rows = Array.from(map.entries()).map(([agent, count]) => ({ agent, count }));
    rows.sort((a, b) => b.count - a.count);
    return rows.slice(0, 5);
  }, [contentOutputs]);

  // 线索来源分布
  const leadSources = useMemo(() => {
    const map = new Map<string, number>();
    leads.forEach((lead) => {
      const key = lead.source?.trim() || "未标注";
      map.set(key, (map.get(key) ?? 0) + 1);
    });
    const rows = Array.from(map.entries()).map(([source, count]) => ({ source, count }));
    rows.sort((a, b) => b.count - a.count);
    return rows.slice(0, 5);
  }, [leads]);

  const leadSourceMax = Math.max(...leadSources.map((row) => row.count), 1);
  const successRate = tasks.length === 0 ? 0 : Math.round(((doneCount + tasks.filter((task) => task.status === "partial").length) / tasks.length) * 100);

  const battlePack = useMemo(() => {
    const lines: string[] = [];
    lines.push(`【AI 超级员工 · 跟进作战包】${todayText}`);
    lines.push("");
    lines.push("一、高意向线索（建议今日跟进）");
    const hot = leads.filter((lead) => lead.intent === "高意向");
    if (hot.length === 0) lines.push("  暂无高意向线索");
    hot.forEach((lead, index) => lines.push(`  ${index + 1}. ${lead.name}（${lead.stage}）· 需求：${lead.need} · 跟进人：${lead.owner}`));
    lines.push("");
    lines.push("二、最新任务结论");
    const latestDone = tasks.find((task) => task.status === "done" || task.status === "partial");
    const summary = (latestDone?.result as { summary?: string } | undefined)?.summary;
    lines.push(summary ? `  ${summary}` : "  暂无已交付任务，先在 AI 总控发起一个目标吧。");
    lines.push("");
    lines.push("三、可引用的企业知识");
    if (knowledge.length === 0) lines.push("  知识库为空，建议先录入产品/价格资料。");
    knowledge.slice(0, 3).forEach((doc) => lines.push(`  · ${doc.title}（${doc.doc_type}，${doc.chunks} 个片段）`));
    return lines.join("\n");
  }, [leads, tasks, knowledge, todayText]);

  const createAgentFromTemplate = async (template: AgentTemplate) => {
    try {
      const agent = await instantiateAgent(template);
      setAgents((current) => [...current, agent]);
      setToast(`已从「${template.name}」实例化智能体：${agent.name}`);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "智能体创建失败");
    }
  };

  /* ------------------------------- 数据操作 ------------------------------- */

  const advanceLead = async (lead: LeadRow) => {
    const currentIndex = STAGE_FLOW.indexOf(lead.stage);
    const next = currentIndex === -1
      ? "跟进中"
      : STAGE_FLOW[Math.min(currentIndex + 1, STAGE_FLOW.length - 1)];
    if (next === lead.stage) {
      setToast(`「${lead.name}」已在最终阶段「${lead.stage}」，可在企微私域生成作战包跟进`);
      return;
    }
    try {
      await updateLead(lead.id, { stage: next });
      setLeads((current) => current.map((item) => (item.id === lead.id ? { ...item, stage: next } : item)));
      setToast(`「${lead.name}」已推进到「${next}」`);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "线索更新失败");
    }
  };

  const removeLead = async (lead: LeadRow) => {
    try {
      await deleteLead(lead.id);
      setLeads((current) => current.filter((item) => item.id !== lead.id));
      setToast(`线索「${lead.name}」已删除`);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "线索删除失败");
    }
  };

  /* --------------------------- 企微客户同步（身份打通） --------------------------- */

  const saveKfConfig = (patch: Partial<typeof kfConfig>) => {
    setKfConfig((current) => {
      const next = { ...current, ...patch };
      try {
        window.localStorage.setItem("ai-employee:kf-sync", JSON.stringify(next));
      } catch {
        // 隐私模式下写入失败不影响本次同步
      }
      return next;
    });
  };

  /** 从企微回复服务拉客户档案与对话，用当前登录身份写入线索与消息。 */
  const syncKfCustomers = async () => {
    const base = kfConfig.baseUrl.trim().replace(/\/+$/, "");
    if (!/^https?:\/\//.test(base)) {
      setToast("请先填回复服务地址，例如 https://kf.yourdomain.com");
      return;
    }
    if (!kfConfig.secret.trim()) {
      setToast("请填同步密钥（服务端 config.json 里的 adminSecret）");
      return;
    }
    setKfSyncing(true);
    try {
      // 密钥走请求头而不是 query：URL 会进浏览器历史与网关访问日志。
      const res = await fetch(
        `${base}/api/sync?since=${kfConfig.lastSeq}`,
        { headers: { accept: "application/json", "x-admin-secret": kfConfig.secret.trim() } },
      );
      if (res.status === 403) throw new Error("同步密钥不对，请核对服务端 adminSecret");
      if (!res.ok) throw new Error(`服务返回 ${res.status}，检查地址与服务是否在运行`);
      const payload = (await res.json()) as {
        ok: boolean;
        nextSeq: number;
        customers: KfCustomerPayload[];
        events: KfEventPayload[];
      };
      if (!payload.ok) throw new Error("服务返回异常，检查 /api/sync 是否正常");

      const leadIdMap = new Map<string, number>();
      /** 只有本次真的来了新消息的客户才允许覆盖「最新需求」，避免同步把人工编辑冲掉。 */
      const activeIds = new Set(payload.events.map((event) => event.externalUserId));
      let createdCount = 0;
      for (const customer of payload.customers) {
        const { leadId, created } = await upsertLeadByExternalId(customer, { touchNeed: activeIds.has(customer.externalUserId) });
        leadIdMap.set(customer.externalUserId, leadId);
        if (created) createdCount += 1;
      }

      const grouped = new Map<string, KfEventPayload[]>();
      for (const event of payload.events) {
        const list = grouped.get(event.externalUserId) ?? [];
        list.push(event);
        grouped.set(event.externalUserId, list);
      }
      let imported = 0;
      for (const [externalId, events] of grouped) {
        const leadId = leadIdMap.get(externalId);
        if (!leadId) continue;
        imported += await importKfMessages(leadId, events);
      }

      saveKfConfig({ lastSeq: payload.nextSeq, lastAt: new Date().toISOString() });
      const hotStages = ["报价", "成交", "试用", "已预约"];
      const hotCount = payload.customers.filter(
        (item) => activeIds.has(item.externalUserId) && hotStages.includes(item.stage),
      ).length;
      const summary =
        `新增 ${createdCount} 位客户 · 导入 ${imported} 条对话` +
        (hotCount ? ` · ${hotCount} 位高意向` : "") +
        (payload.events.length === 0 ? "（暂无新消息）" : "");
      setKfSummary(summary);
      setToast(`企微同步完成：${summary}`);
      setLeads(await listLeads());
    } catch (error) {
      const message = error instanceof Error ? error.message : "同步失败";
      setKfSummary(message);
      setToast(message);
    } finally {
      setKfSyncing(false);
    }
  };

  /* ----------------------------- 跟进回填（回流闭环） ----------------------------- */

  const openFollowUp = async (lead: LeadRow) => {
    setFollowUpLead(lead);
    setFollowUpStage(STAGE_FLOW.includes(lead.stage) ? lead.stage : "跟进中");
    setFollowUpForm({ channel: "企微", result: "已联系", next: "", note: "" });
    setFollowUpLoading(true);
    setKfMessages([]);
    try {
      const [records, chats] = await Promise.all([listFollowUps(lead.id), listKfMessages(lead.id).catch(() => [])]);
      setFollowUps(records);
      setKfMessages(chats);
    } catch (error) {
      setFollowUps([]);
      setToast(error instanceof Error ? error.message : "跟进记录读取失败");
    } finally {
      setFollowUpLoading(false);
    }
  };

  const submitFollowUp = async () => {
    if (!followUpLead) return;
    if (!followUpForm.next.trim()) {
      setToast("请填写下一步动作，不留「再看看」");
      return;
    }
    const lead = followUpLead;
    setFormSaving("followup");
    try {
      const record = await insertFollowUp({
        leadId: lead.id,
        channel: followUpForm.channel,
        result: followUpForm.result,
        nextStep: followUpForm.next.trim(),
        note: followUpForm.note.trim(),
      });
      setFollowUps((current) => [record, ...current]);
      const stageChanged = followUpStage !== lead.stage;
      if (stageChanged) {
        await updateLead(lead.id, { stage: followUpStage });
        setLeads((current) => current.map((item) => (item.id === lead.id ? { ...item, stage: followUpStage } : item)));
      }
      setFollowUpForm({ channel: followUpForm.channel, result: "已联系", next: "", note: "" });
      setToast(stageChanged ? `跟进已记录，「${lead.name}」推进到「${followUpStage}」` : `「${lead.name}」的跟进已记录`);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "跟进记录保存失败");
    } finally {
      setFormSaving("");
    }
  };

  /** 单客户跟进包：给企微里跟进的人看的最小上下文，复制即用。 */
  const copyLeadBattlePack = async () => {
    if (!followUpLead) return;
    const lead = followUpLead;
    const lines = [
      `【客户跟进包】${lead.name}`,
      `阶段：${lead.stage} · 意向：${lead.intent} · 跟进人：${lead.owner}`,
      `需求：${lead.need}`,
      "",
      "最近跟进：",
    ];
    if (followUps.length === 0) lines.push("  暂无记录");
    followUps.slice(0, 5).forEach((item, index) => {
      const when = new Date(item.created_at).toLocaleString("zh-CN", { hour12: false });
      lines.push(`  ${index + 1}. ${when} ${item.result}（${item.channel}）${item.note ? `｜${item.note}` : ""}`);
    });
    const lastNext = followUps[0]?.next_step;
    if (lastNext) {
      lines.push("");
      lines.push(`下一步：${lastNext}`);
    }
    const text = lines.join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setToast("跟进包已复制，可直接粘贴到企微");
    } catch {
      const area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      document.execCommand("copy");
      document.body.removeChild(area);
      setToast("跟进包已复制，可直接粘贴到企微");
    }
  };

  const submitLeadForm = async () => {
    if (!leadForm.name.trim() || !leadForm.need.trim()) {
      setToast("请至少填写客户名称与最新需求");
      return;
    }
    setFormSaving("lead");
    try {
      const created = await insertLead({
        name: leadForm.name.trim(),
        source: leadForm.source.trim() || "手动录入",
        intent: leadForm.intent,
        need: leadForm.need.trim(),
        owner: leadForm.owner.trim() || user?.name || "AI 跟进",
      });
      setLeads((current) => [created, ...current]);
      setShowLeadForm(false);
      setLeadForm({ name: "", source: "", intent: "高意向", need: "", owner: "" });
      setToast(`线索「${created.name}」已录入`);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "线索录入失败");
    } finally {
      setFormSaving("");
    }
  };

  const submitKnowledgeForm = async () => {
    if (!knowledgeForm.title.trim() || knowledgeForm.content.trim().length < 10) {
      setToast("请填写标题，且内容不少于 10 个字");
      return;
    }
    setFormSaving("knowledge");
    try {
      const created = await insertKnowledgeDoc({
        title: knowledgeForm.title.trim(),
        docType: knowledgeForm.docType,
        content: knowledgeForm.content.trim(),
        ownerName: user?.name ?? null,
      });
      const { data } = await cloudSafeList();
      setKnowledge(data ?? [created]);
      setShowKnowledgeForm(false);
      setKnowledgeForm({ title: "", docType: "产品手册", content: "" });
      setToast(`知识「${created.title}」已录入，可供智能体调用`);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "知识录入失败");
    }
  };

  const cloudSafeList = async () => {
    try {
      return { data: await listKnowledgeDocs() };
    } catch {
      return { data: [] as KnowledgeRow[] };
    }
  };

  const openKnowledgeDoc = async (doc: KnowledgeRow) => {
    setDocDetail({ ...doc, content: "正在读取…" });
    try {
      const full = await getKnowledgeDoc(doc.id);
      setDocDetail(full);
    } catch {
      setDocDetail({ ...doc, content: "内容读取失败，请稍后重试。" });
    }
  };

  const removeKnowledgeDoc = async (doc: KnowledgeRow) => {
    try {
      await deleteKnowledgeDoc(doc.id);
      setKnowledge((current) => current.filter((item) => item.id !== doc.id));
      setDocDetail(null);
      setToast(`知识「${doc.title}」已删除`);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "知识删除失败");
    }
  };

  const removeAgent = async (agent: AgentRow) => {
    try {
      await deleteAgent(agent.id);
      setAgents((current) => current.filter((item) => item.id !== agent.id));
      setToast(`智能体「${agent.name}」已移除`);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "智能体删除失败");
    }
  };

  const rerunTask = (task: AnyTask) => {
    openComposer({ goal: task.goal });
  };

  const removeTask = async (task: AnyTask) => {
    try {
      await deleteTask(task.id);
      setTasks((current) => current.filter((item) => item.id !== task.id));
      setSelectedTask(null);
      setToast("任务记录已删除");
    } catch (error) {
      setToast(error instanceof Error ? error.message : "任务删除失败");
    }
  };

  /** CSV 批量导入：逐条 insertLead，失败计数不中断（库表逐行写入）。 */
  const importLeadsCsv = async () => {
    if (!csvText.trim()) {
      setToast("先粘贴 CSV 内容或选择文件");
      return;
    }
    const parsed = parseLeadsCsv(csvText, leads);
    if (!parsed.rows.length) {
      setToast(
        `没有可导入的行（重复 ${parsed.duplicatesInFile + parsed.duplicatesExisting} 条，跳过 ${parsed.skipped} 行）`,
      );
      return;
    }
    setFormSaving("csv");
    let created = 0;
    let failedRows = 0;
    const createdRows: LeadRow[] = [];
    for (const row of parsed.rows as LeadImportRow[]) {
      try {
        const lead = await insertLead({
          name: row.name,
          source: row.source,
          intent: row.intent,
          need: row.need,
          owner: row.owner || user?.name || "AI 跟进",
          stage: row.stage,
          channel: "CSV 导入",
        });
        createdRows.push(lead);
        created += 1;
      } catch {
        failedRows += 1;
      }
    }
    setLeads((current) => [...createdRows, ...current]);
    setFormSaving("");
    setCsvText("");
    setToast(
      `导入完成：新增 ${created} 位客户` +
        (parsed.duplicatesExisting ? ` · 已有重复 ${parsed.duplicatesExisting} 条` : "") +
        (parsed.duplicatesInFile ? ` · 文件内重复 ${parsed.duplicatesInFile} 条` : "") +
        (parsed.skipped ? ` · 跳过空行/缺名 ${parsed.skipped}` : "") +
        (failedRows ? ` · 写入失败 ${failedRows}` : ""),
    );
  };

  const exportLeadsCsv = () => {
    const header = "客户,来源,意向等级,最新需求,跟进人,阶段,创建时间";
    const rows = leads.map((lead) =>
      [lead.name, lead.source, lead.intent, lead.need, lead.owner, lead.stage, new Date(lead.created_at).toLocaleDateString("zh-CN")]
        .map((value) => `"${String(value).replace(/"/g, '""')}"`)
        .join(","),
    );
    const blob = new Blob(["\ufeff" + [header, ...rows].join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `线索清单-${new Date().toISOString().slice(0, 10)}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
    setToast(`已导出 ${leads.length} 条线索到 CSV`);
  };

  const copyBattlePack = async () => {
    try {
      await navigator.clipboard.writeText(battlePack);
      setToast("作战包已复制，可直接粘贴到企微/微信群");
      return;
    } catch {
      // 降级到 execCommand，兼容非安全上下文
    }
    try {
      const area = document.createElement("textarea");
      area.value = battlePack;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(area);
      if (ok) {
        setToast("作战包已复制，可直接粘贴到企微/微信群");
        return;
      }
    } catch {
      // 继续走选中文本方案
    }
    const pre = document.querySelector(".battle-pack pre");
    if (pre) {
      const range = document.createRange();
      range.selectNodeContents(pre);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      setToast("已选中作战包全文，按 Ctrl+C 即可复制");
      return;
    }
    setToast("复制失败，请手动选中文本复制");
  };

  const copyText = async (text: string, successMessage: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setToast(successMessage);
      return;
    } catch {
      // 继续降级
    }
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(area);
      setToast(ok ? successMessage : "复制失败，请手动选中文本");
    } catch {
      setToast("复制失败，请手动选中文本");
    }
  };

  const removeContentOutput = async (item: NonNullable<typeof contentDetail>) => {
    if (item.taskId === null) {
      setToast("未找到对应的任务记录");
      return;
    }
    try {
      const rows = await listTaskSteps(item.taskId);
      const target = rows.find((row) => row.seq === item.stepIndex + 1);
      if (!target) {
        setToast("未找到对应的执行步骤");
        return;
      }
      await updateTaskStep(target.id, { output: null });
      setContentDetail(null);
      await load();
      setToast("该条内容产出已移除");
    } catch (error) {
      setToast(error instanceof Error ? error.message : "内容移除失败");
    }
  };

  const exportInsightReport = () => {
    const lines: string[] = [];
    lines.push(`# AI 超级员工 · 经营诊断报告`);
    lines.push("");
    lines.push(`生成时间：${new Date().toLocaleString("zh-CN", { hour12: false })}`);
    lines.push(`数据范围：我的云端工作区（实时读取）`);
    lines.push("");
    lines.push("## 一、任务概览");
    lines.push(`- 任务总数：${tasks.length}`);
    lines.push(`- 已交付：${doneCount}｜部分完成：${taskStatusCounts.partial}｜失败：${failedCount}｜执行中：${runningCount}`);
    lines.push(`- 交付成功率：${successRate}%`);
    lines.push(`- 累计 tokens：${totalTokens}`);
    lines.push("");
    lines.push("## 二、线索与转化");
    lines.push(`- 线索总数：${leads.length}，高意向 ${highIntent} 条，待跟进 ${pendingLeads} 条`);
    funnelStages.forEach((stage) => lines.push(`- ${stage.label}：${stage.value}`));
    lines.push("");
    lines.push("## 三、渠道来源");
    if (leadSources.length === 0) lines.push("- 暂无来源数据");
    leadSources.forEach((row) => lines.push(`- ${row.source}：${row.count} 条（${Math.round((row.count / Math.max(leads.length, 1)) * 100)}%）`));
    lines.push("");
    lines.push("## 四、AI 员工产出");
    if (agentRanking.length === 0) lines.push("- 暂无产出记录");
    agentRanking.forEach((row) => lines.push(`- ${row.agent}：${row.count} 项产出`));
    lines.push("");
    lines.push("## 五、知识资产");
    lines.push(`- 知识文档 ${knowledge.length} 份，共 ${knowledge.reduce((sum, doc) => sum + doc.chunks, 0)} 个片段`);
    lines.push("");
    lines.push("## 六、建议动作");
    if (highIntent > 0) lines.push(`1. 优先跟进 ${highIntent} 条高意向线索，在「企微私域」生成作战包。`);
    lines.push(`2. ${knowledge.length === 0 ? "尽快录入产品与价格资料，提升智能体产出质量。" : "定期更新知识库，确保引用的是最新价格与政策。"}`);
    lines.push(`3. ${failedCount > 0 ? `有 ${failedCount} 个任务失败，可在任务中心一键重跑。` : "保持当前任务节奏，按周复盘转化数据。"}`);

    const blob = new Blob([lines.join("\n")], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `经营诊断报告-${new Date().toISOString().slice(0, 10)}.md`;
    anchor.click();
    URL.revokeObjectURL(url);
    setToast("诊断报告已导出（Markdown）");
  };

  const submitWecomForm = async () => {
    if (!wecomForm.title.trim() || !/^https?:\/\//.test(wecomForm.url.trim())) {
      setToast("请填写资产标题，并填写以 http(s) 开头的链接");
      return;
    }
    setFormSaving("wecom");
    try {
      const created = await insertWecomLink(wecomForm);
      setWecomLinks((current) => [created, ...current]);
      setShowWecomForm(false);
      setWecomForm({ kind: "智能文档", title: "", summary: "", url: "" });
      setToast("企微资产已登记，团队可在列表中直达");
    } catch (error) {
      setToast(error instanceof Error ? error.message : "企微资产登记失败");
    } finally {
      setFormSaving("");
    }
  };

  const removeWecomLink = async (link: WecomLinkRow) => {
    try {
      await deleteWecomLink(link.id);
      setWecomLinks((current) => current.filter((item) => item.id !== link.id));
      setToast(`已移除「${link.title}」`);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "企微资产删除失败");
    }
  };

  const submitAgentRename = async () => {
    if (!agentEditing) return;
    const name = agentEditing.name.trim();
    if (!name) {
      setToast("名称不能为空");
      return;
    }
    try {
      const updated = await updateAgent(agentEditing.id, { name });
      setAgents((current) => current.map((item) => (item.id === agentEditing.id ? { ...item, name: updated?.name ?? name } : item)));
      setAgentEditing(null);
      setToast("智能体名称已更新");
    } catch (error) {
      setToast(error instanceof Error ? error.message : "智能体重命名失败");
    }
  };

  /* ------------------------------ 人设编辑 ------------------------------ */

  const openPersonaEditor = (agent: AgentRow) => {
    const template = templates.find((item) => item.code === agent.template_code) ?? null;
    const baseline = template?.role_prompt?.trim() ?? "";
    setShowPersonaDefault(false);
    setPersonaEditing({
      agentId: agent.id,
      name: agent.name,
      templateName: template?.name ?? agent.template_name ?? agent.name,
      baseline,
      prompt: customPromptOf(agent) ?? baseline,
    });
  };

  const savePersona = async () => {
    if (!personaEditing) return;
    const custom = personaEditing.prompt.trim();
    if (!custom) {
      setToast("人设内容不能为空，如需恢复官方版本请点「恢复默认人设」");
      return;
    }
    setPersonaSaving(true);
    try {
      const updated = await saveAgentPersona(personaEditing.agentId, custom === personaEditing.baseline ? "" : custom);
      setAgents((current) => current.map((item) => (item.id === personaEditing.agentId ? { ...item, config: updated?.config ?? item.config } : item)));
      setPersonaEditing(null);
      setToast(custom === personaEditing.baseline ? "已恢复官方默认人设" : `「${personaEditing.name}」的人设已保存，下次派活即生效`);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "人设保存失败");
    } finally {
      setPersonaSaving(false);
    }
  };

  const resetPersona = () => {
    if (!personaEditing) return;
    setPersonaEditing({ ...personaEditing, prompt: personaEditing.baseline });
    setToast("已填入官方默认人设，保存后生效");
  };

  return (
    <div className="console-shell">
      <aside className={`console-sidebar ${mobileNav ? "mobile-open" : ""}`}>
        <div className="console-brand">
          <button type="button" className="brand" onClick={onBack} aria-label="返回官网">
            <span className="brand-mark"><Sparkles size={19} /></span>
            <span className="brand-copy"><strong>超级员工</strong><small>SUPER AGENT OS</small></span>
          </button>
          <button type="button" className="icon-button sidebar-close" onClick={() => setMobileNav(false)} aria-label="关闭导航"><X size={19} /></button>
        </div>

        <div className="workspace-switch">
          <span className="workspace-avatar">{user ? user.name.slice(0, 1) : "我"}</span>
          <span><strong>{user ? user.name : "我的工作区"}</strong><small>{user ? "我的云端工作区" : "云端实时 · 未绑定账号"}</small></span>
          <ChevronDown size={15} />
        </div>

        <nav className="console-nav" aria-label="产品功能">
          <span className="console-nav-label">工作台</span>
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <button
                type="button"
                key={item.label}
                className={activeNav === item.label ? "active" : ""}
                onClick={() => {
                  setActiveNav(item.label);
                  setMobileNav(false);
                }}
              >
                <Icon size={18} />
                {item.label}
                {item.label === "任务中心" && tasks.length > 0 && <span className="nav-count">{tasks.length}</span>}
              </button>
            );
          })}
        </nav>

        <div className="sidebar-capacity">
          <div className="capacity-title"><span>本月任务用量</span><strong>{quotaPercent}%</strong></div>
          <div className="capacity-track"><span style={{ width: `${quotaPercent}%` }} /></div>
          <p>本月已运行 {monthTasks} / {monthQuota} 个任务</p>
          <button type="button" onClick={() => setActiveNav("数据洞察")}>查看用量明细<ArrowUpRight size={14} /></button>
        </div>

        <button type="button" className="back-to-site" onClick={onBack}><ArrowLeft size={17} />返回品牌官网</button>
      </aside>

      {mobileNav && <button className="sidebar-scrim" aria-label="关闭导航" onClick={() => setMobileNav(false)} />}

      <main className="console-main">
        <header className="console-topbar">
          <div className="console-topbar-left">
            <button type="button" className="icon-button mobile-menu" onClick={() => setMobileNav(true)} aria-label="打开导航"><Menu size={20} /></button>
            <div><span>{user ? user.name : "我的工作区"} /</span><strong>{activeNav}</strong></div>
          </div>
          <div className="console-topbar-actions">
            <button type="button" className="console-search" onClick={() => { setShowPalette(true); setPaletteQuery(""); }}>
              <Search size={16} />
              <span className="search-placeholder">搜索任务、客户、模板或知识</span>
              <kbd>⌘ K</kbd>
            </button>
            <div className="notification-wrap">
              <button type="button" className="icon-button notification-button" onClick={() => setShowNotifications(!showNotifications)} aria-label="通知">
                <Bell size={19} />
                {hasUnreadNotifications && <span className="notification-dot" />}
              </button>
              {showNotifications && (
                <div className="notification-popover">
                  <div><strong>通知中心</strong><button type="button" onClick={() => setShowNotifications(false)}><X size={15} /></button></div>
                  {notifications.length === 0 && <p><CheckCircle2 size={16} />暂无待处理事项，一切正常。</p>}
                  {notifications.map((item, index) => {
                    const Icon = item.icon;
                    return <p key={index}><Icon size={16} />{item.text}</p>;
                  })}
                  {notifications.length > 0 && (
                    <button type="button" className="notif-mark-read" onClick={markNotificationsRead}>
                      {hasUnreadNotifications ? "全部标为已读" : "暂无新通知"}
                    </button>
                  )}
                </div>
              )}
            </div>
            <button type="button" className="button button-primary new-task-button" onClick={() => openComposer()}><Plus size={17} />新建任务</button>
            {user ? (
              <button type="button" className="console-user console-user-button" onClick={() => signOut().then(() => onSignedIn())}>
                <span>{user.name.slice(0, 1)}</span>
                <div><strong>{user.name}</strong><small>退出登录</small></div>
              </button>
            ) : (
              <button type="button" className="button button-secondary console-login-button" onClick={() => setShowLogin(true)}>登录工作区</button>
            )}
          </div>
        </header>

        <div className="console-content">
          <div className="console-page-heading">
            <div>
              <span className="console-date">{todayText}</span>
              <h1>{activeNav === "AI 总控" ? (user ? `${user.name}，欢迎回来` : "欢迎体验 AI 超级员工") : activeNav}</h1>
              <p>
                {activeNav === "AI 总控"
                  ? user
                    ? `你的云端工作区已就绪，${runningCount} 个任务执行中，${pendingLeads} 条线索待跟进。`
                    : `你的云端工作区已就绪，${runningCount} 个任务执行中，${pendingLeads} 条线索待跟进。绑定账号后数据归属你本人。`
                  : `集中管理${activeNav}，所有数据来自云端实时读取。`}
              </p>
            </div>
            <span className="demo-data-badge"><CircleDot size={13} />{user ? "我的云端工作区" : "云端工作区 · 实时"}</span>
          </div>

          {activeNav === "AI 总控" && (
            <>
              <section className="console-metrics">
                {[
                  { label: "云端任务总数", value: String(tasks.length), change: "实时读取", icon: Zap, color: "violet" },
                  { label: "执行中", value: String(runningCount), change: "多智能体协作", icon: Activity, color: "blue" },
                  { label: "已交付", value: String(doneCount), change: failedCount ? `${failedCount} 个失败` : "全部成功", icon: CheckCircle2, color: "green" },
                  { label: "待跟进线索", value: String(pendingLeads), change: `高意向 ${highIntent} 条`, icon: Target, color: "orange" },
                ].map((metric) => {
                  const Icon = metric.icon;
                  return (
                    <div className="console-metric" key={metric.label}>
                      <div className={`metric-icon metric-${metric.color}`}><Icon size={20} /></div>
                      <span>{metric.label}</span>
                      <strong>{metric.value}</strong>
                      <small><TrendingUp size={13} />{metric.change}</small>
                    </div>
                  );
                })}
              </section>

              <section className="console-dashboard-grid">
                <div className="console-card performance-card">
                  <div className="console-card-header">
                    <div><h2>任务执行趋势</h2><p>近 7 天任务创建数量 · 云端实时统计</p></div>
                    <span className="period-button">近 7 天<ChevronDown size={14} /></span>
                  </div>
                  <div className="chart-legend"><span><i className="legend-violet" />每日新建任务</span><span><i className="legend-green" />已交付 {doneCount} 个</span></div>
                  <div className="line-chart">
                    <div className="chart-grid"><span /><span /><span /><span /></div>
                    <svg viewBox="0 0 640 220" role="img" aria-label="近 7 天任务创建趋势图" preserveAspectRatio="none">
                      <defs>
                        <linearGradient id="barFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#8a78e4" /><stop offset="100%" stopColor="#6d5dfc" /></linearGradient>
                      </defs>
                      {trend.map((day, index) => {
                        const barWidth = 52;
                        const gap = (640 - barWidth * 7) / 8;
                        const x = gap + index * (barWidth + gap);
                        const barHeight = day.count === 0 ? 4 : Math.max(14, Math.round((day.count / trendMax) * 168));
                        const y = 196 - barHeight;
                        return (
                          <g key={day.dayStart}>
                            <rect x={x} y={y} width={barWidth} height={barHeight} rx={8} fill={index === 6 ? "url(#barFill)" : "#ded9f5"} />
                            <text x={x + barWidth / 2} y={y - 10} textAnchor="middle" fontSize="18" fontWeight="600" fill={day.count ? "#5b4bc4" : "#b6b0be"}>{day.count}</text>
                          </g>
                        );
                      })}
                    </svg>
                    <div className="chart-labels">{trend.map((day) => <span key={day.dayStart}>{day.label}</span>)}</div>
                  </div>
                </div>

                <div className="console-card team-status-card">
                  <div className="console-card-header"><div><h2>AI 团队状态</h2><p>{agents.length} 位智能体在线协作</p></div><button type="button" className="text-link" onClick={() => setActiveNav("智能体团队")}>管理<ArrowUpRight size={14} /></button></div>
                  <div className="team-status-list">
                    {agents.slice(0, 5).map((agent) => (
                      <div key={agent.id} className="team-status-item">
                        <div className="agent-mini-icon metric-violet"><Bot size={16} /></div>
                        <div><strong>{agent.name}</strong><span>{agent.template_name ?? agent.domain}</span></div>
                        <span className="agent-load"><span style={{ width: `${60 + (agent.id % 4) * 9}%` }} /></span>
                        <i />
                      </div>
                    ))}
                  </div>
                </div>
              </section>

              <section className="console-card tasks-card">
                <div className="console-card-header"><div><h2>云端任务记录</h2><p>任务过程与产出均已持久化</p></div><button type="button" className="text-link" onClick={() => setActiveNav("任务中心")}>全部任务<ArrowUpRight size={14} /></button></div>
                <TaskTable tasks={filteredTasks.slice(0, 5)} onOpen={openTask} onRerun={rerunTask} onDelete={removeTask} />
              </section>
            </>
          )}

          {activeNav === "远程指令" && (
            <CommandInbox onExecute={(goal) => openComposer({ goal })} />
          )}

          {activeNav === "智能体团队" && (
            <section className="agent-management-grid">
              {agents.map((agent) => (
                <div className="console-card agent-management-card" key={agent.id}>
                  <div className="agent-card-tools">
                    <button type="button" className="icon-button agent-mini-action" title="重命名" aria-label={`重命名${agent.name}`} onClick={() => setAgentEditing({ id: agent.id, name: agent.name })}><Pencil size={14} /></button>
                    <button type="button" className="icon-button agent-mini-action danger" title="移除" aria-label={`移除${agent.name}`} onClick={() => removeAgent(agent)}><Trash2 size={14} /></button>
                  </div>
                  <div className="agent-large-icon metric-violet"><Bot size={25} /></div>
                  <div className="agent-online"><i />在线</div>
                  <h2>{agent.name}</h2>
                  <p>{agent.role ?? agent.template_name ?? "AI 员工"}</p>
                  {customPromptOf(agent) && <span className="agent-persona-badge"><ScrollText size={12} />自定义人设</span>}
                  <div className="agent-management-stats"><span><strong>{(agent.capabilities ?? []).length}</strong>核心能力</span><span><strong>{(agent.tools ?? []).length}</strong>可调工具</span></div>
                  <div className="agent-card-actions">
                    <button type="button" className="button button-secondary" onClick={() => openComposer({ templateCode: agent.template_code })}><Send size={15} />分配任务</button>
                    <button type="button" className="button button-ghost" onClick={() => openPersonaEditor(agent)}><Wand2 size={15} />编辑人设</button>
                    <button type="button" className="button button-ghost" onClick={() => { setDomainFilter(agent.domain ?? null); setTaskFilter("全部"); setActiveNav("任务中心"); }}><FolderKanban size={15} />查看任务</button>
                  </div>
                </div>
              ))}
              <button type="button" className="add-agent-card" onClick={() => setActiveNav("模板中心")}><Plus size={25} /><strong>从模板创建智能体</strong><span>{templates.length} 个官方岗位模板可配置</span></button>
            </section>
          )}

          {activeNav === "任务中心" && (
            <section className="console-card tasks-card module-page-card">
              <div className="console-card-header">
                <div><h2>全部任务</h2><p>共 {tasks.length} 条云端任务记录 · 当前筛选 {filteredTasks.length} 条</p></div>
                <button type="button" className="button button-primary" onClick={() => openComposer()}><Plus size={16} />创建任务</button>
              </div>
              {(() => {
                const stats = summarizeTasks(tasks);
                if (stats.total === 0) return null;
                return (
                  <div className="task-stats-card">
                    <div className="task-stats-head">
                      <strong>失败与重试统计</strong>
                      <span>{taskStatsHeadline(stats)}</span>
                    </div>
                    <div className="task-stats-body">
                      <div className="task-stats-spark" title="近 7 天失败数（左旧右新）">
                        {stats.dailyFailures.map((count, index) => (
                          <i
                            key={index}
                            className={count ? "has" : ""}
                            style={{ height: `${Math.min(100, count * 30 + (count ? 25 : 8))}%` }}
                            title={`${6 - index} 天前：${count} 次`}
                          />
                        ))}
                      </div>
                      <ul className="task-stats-reasons">
                        {stats.failures.slice(0, 3).map((group) => (
                          <li key={group.reason}>
                            <span>{group.reason}</span>
                            <em>{group.count} 次</em>
                            <small>{group.advice}</small>
                          </li>
                        ))}
                        {stats.failures.length === 0 && <li className="task-stats-ok">没有失败任务</li>}
                      </ul>
                    </div>
                    {stats.retryIds.length > 0 && (
                      <button
                        type="button"
                        className="text-link"
                        onClick={() => {
                          const targets = tasks.filter((task) => stats.retryIds.includes(task.id));
                          targets.forEach((task) => rerunTask(task));
                          setToast(`已按目标重新发起 ${targets.length} 条任务`);
                        }}
                      >
                        一键重跑全部失败任务（{stats.retryIds.length}）
                      </button>
                    )}
                  </div>
                );
              })()}
              <p className="task-list-tip">点击任意一行，查看该任务每个岗位的执行过程、完整产出与结论摘要。</p>
              <div className="status-tabs">
                {([
                  { key: "全部", label: "全部" },
                  { key: "running", label: "执行中" },
                  { key: "done", label: "已交付" },
                  { key: "partial", label: "部分完成" },
                  { key: "failed", label: "失败" },
                ] as const).map((tab) => (
                  <button
                    type="button"
                    key={tab.key}
                    className={taskFilter === tab.key ? "active" : ""}
                    onClick={() => setTaskFilter(tab.key)}
                  >
                    {tab.label}
                    <span>{taskStatusCounts[tab.key]}</span>
                  </button>
                ))}
                {domainFilter && (
                  <button type="button" className="domain-filter-chip" onClick={() => setDomainFilter(null)}>
                    仅看「{domainFilter}」<X size={12} />
                  </button>
                )}
              </div>
              <TaskTable tasks={filteredTasks} onOpen={openTask} onRerun={rerunTask} onDelete={removeTask} />
              {filteredTasks.length === 0 && <div className="empty-search"><Search size={24} /><strong>没有符合条件的任务</strong><span>切换筛选条件，或创建一条新任务</span></div>}
            </section>
          )}

          {activeNav === "定时任务" && <PipelineCenter />}

          {activeNav === "模板中心" && (
            <section className="template-center">
              <div className="template-center-head">
                <div><h2>智能体岗位模板</h2><p>把 {templates.length} 个官方模板收敛为「角色 + 知识 + 工具 + 流程 + 审批 + 指标」六要素，一键实例化为你的专属 AI 员工。</p></div>
                <label className="template-search">
                  <Search size={15} />
                  <input aria-label="搜索模板" placeholder="搜索岗位或能力，例如：复盘" value={templateQuery} onChange={(event) => setTemplateQuery(event.target.value)} />
                </label>
              </div>
              <div className="filter-chips">
                {templateDomains.map((domain) => (
                  <button type="button" key={domain} className={templateDomain === domain ? "active" : ""} onClick={() => setTemplateDomain(domain)}>
                    {domain}
                    <span>{domain === "全部" ? templates.length : templates.filter((template) => template.domain === domain).length}</span>
                  </button>
                ))}
              </div>
              <div className="template-grid">
                {visibleTemplates.map((template) => {
                  const instantiated = agents.some((agent) => agent.template_code === template.code);
                  return (
                    <article className="console-card template-card" key={template.code}>
                      <div className="template-card-top">
                        <div><span className="template-domain">{template.domain}</span><h3>{template.name}</h3></div>
                        <span className="template-official">{instantiated ? "已启用" : "官方"}</span>
                      </div>
                      <p className="template-summary">{template.summary}</p>
                      <div className="template-block"><span>核心能力</span><div>{template.capabilities.map((item) => <i key={item}>{item}</i>)}</div></div>
                      <div className="template-block"><span>标准流程</span><ol>{template.workflow.map((item) => <li key={item}>{item}</li>)}</ol></div>
                      <div className="template-block"><span>必备知识</span><div>{template.knowledge.map((item) => <i key={item}>{item}</i>)}</div></div>
                      <div className="template-block template-block-split"><div><span>审批要求</span><p>{template.approvals.length ? template.approvals.join("；") : "无强制审批"}</p></div><div><span>衡量指标</span><p>{template.metrics.join("、")}</p></div></div>
                      <button type="button" className="button button-primary template-instantiate" onClick={() => createAgentFromTemplate(template)}><Sparkles size={15} />实例化为我的智能体</button>
                    </article>
                  );
                })}
                {visibleTemplates.length === 0 && <div className="console-card module-page-card empty-search"><Search size={22} /><strong>没有匹配的岗位模板</strong><span>换个关键词或切换领域筛选</span></div>}
              </div>
            </section>
          )}

          {activeNav === "内容工厂" && (
            <section className="content-factory">
              <div className="console-card content-factory-head">
                <div><h2>内容工厂</h2><p>每条任务中 AI 员工的产出都会沉淀到这里，共 {contentOutputs.length} 条，可直接复制或沉淀到企微。</p></div>
                <div className="content-factory-actions">
                  <button type="button" className="button button-secondary" onClick={() => exportInsightReport()}><Download size={15} />导出报告</button>
                  <button type="button" className="button button-primary" onClick={() => openComposer({ goal: "为秋季新品生成 7 天内容排期与 3 条朋友圈文案" })}><Sparkles size={15} />生成新内容</button>
                </div>
              </div>
              <div className="filter-chips">
                {contentAgents.map((agent) => (
                  <button type="button" key={agent} className={contentAgent === agent ? "active" : ""} onClick={() => setContentAgent(agent)}>
                    {agent}
                    <span>{agent === "全部" ? contentOutputs.length : contentOutputs.filter((item) => item.agent === agent).length}</span>
                  </button>
                ))}
              </div>
              <div className="content-library-grid">
                {visibleContent.length === 0 && (
                  <div className="console-card module-page-card empty-search"><FileText size={24} /><strong>还没有内容产出</strong><span>点击「生成新内容」发起任务，产出会自动沉淀到这里</span></div>
                )}
                {visibleContent.map((item, index) => (
                  <button
                    type="button"
                    className="console-card content-item content-item-button"
                    key={`${item.title}-${index}`}
                    onClick={() => setContentDetail(item)}
                  >
                    <div className={`content-thumbnail metric-${["violet", "orange", "green", "blue"][index % 4]}`}><FileText size={28} /><span>{item.agent}</span></div>
                    <div className="content-item-body">
                      <span className="content-status">云端产出</span>
                      <h2>{item.title}</h2>
                      <p>{item.output.slice(0, 60)}…</p>
                      <div><span className="content-time">{new Date(item.created_at).toLocaleString("zh-CN", { hour12: false })}</span><span className="content-open">查看全文<ArrowUpRight size={13} /></span></div>
                    </div>
                  </button>
                ))}
              </div>
            </section>
          )}

          {activeNav === "聚合发布" && (
            <PublishHub contents={contentOutputs} initialSourceId={publishSource} onSourceConsumed={() => setPublishSource("")} />
          )}

          {activeNav === "线索与客户" && (
            <section className="console-card module-page-card">
              <div className="console-card-header">
                <div><h2>客户线索</h2><p>共 {leads.length} 条线索 · 高意向 {highIntent} 条 · 阶段可点击推进，企微跟进后记得回填结果</p></div>
                <div className="lead-header-actions">
                  <button type="button" className="button button-secondary" onClick={exportLeadsCsv}><Download size={15} />导出 CSV</button>
                  <button type="button" className="button button-secondary" onClick={() => setShowCsvImport((current) => !current)}><Upload size={15} />批量导入</button>
                  <button type="button" className="button button-primary" onClick={() => setShowLeadForm(true)}><Plus size={15} />新增线索</button>
                </div>
              </div>
              <div className="lead-table-wrap"><table className="lead-table"><thead><tr><th>客户</th><th>来源</th><th>意向等级</th><th>最新需求</th><th>跟进人</th><th>阶段</th><th>操作</th></tr></thead><tbody>{leads.map((lead) => <tr key={lead.id}><td><span className="lead-avatar">{lead.name.slice(0, 1)}</span><strong>{lead.name}</strong></td><td>{lead.source}{lead.external_userid ? <span className="kf-badge" title={`企微身份：${lead.external_userid}`}>企微</span> : null}</td><td><span className={`intent-badge ${lead.intent === "高意向" ? "hot" : ""}`}>{lead.intent}</span></td><td>{lead.need}</td><td>{lead.owner}</td><td><button type="button" className="stage-chip" title="点击推进到下一阶段" onClick={() => advanceLead(lead)}>{lead.stage}<ChevronRight size={12} /></button></td><td><button type="button" className="icon-button" title="回填跟进结果" aria-label={`回填${lead.name}的跟进结果`} onClick={() => { void openFollowUp(lead); }}><ClipboardCopy size={14} /></button><button type="button" className="icon-button row-remove" aria-label={`删除${lead.name}`} onClick={() => removeLead(lead)}><Trash2 size={14} /></button></td></tr>)}</tbody></table></div>
              {showCsvImport && (
                <div className="lead-csv-panel">
                  <div className="console-card-header">
                    <div>
                      <h2>CSV 批量导入</h2>
                      <p>表头支持：客户/姓名、来源、意向等级、最新需求、跟进人、阶段、企微ID；同名同企微ID自动去重</p>
                    </div>
                    <button type="button" className="icon-button" aria-label="关闭" onClick={() => setShowCsvImport(false)}>×</button>
                  </div>
                  <label className="service-field">
                    <span>粘贴 CSV 内容，或选择 .csv 文件</span>
                    <textarea
                      rows={5}
                      value={csvText}
                      onChange={(event) => setCsvText(event.target.value)}
                      placeholder={["客户,来源,意向等级,最新需求,跟进人,阶段", "张三,抖音,高意向,想了解团购,小李,跟进中"].join(String.fromCharCode(10))}
                    />
                  </label>
                  <div className="form-actions">
                    <label className="button button-secondary">
                      <Upload size={14} />选择文件
                      <input
                        type="file"
                        accept=".csv,text/csv"
                        hidden
                        onChange={async (event) => {
                          const file = event.target.files?.[0];
                          if (!file) return;
                          const text = await file.text();
                          setCsvText(text);
                          event.target.value = "";
                        }}
                      />
                    </label>
                    <button type="button" className="button button-primary" onClick={() => void importLeadsCsv()} disabled={formSaving === "csv"}>
                      {formSaving === "csv" ? "导入中…" : "开始导入"}
                    </button>
                  </div>
                </div>
              )}
              {leads.length === 0 && <div className="empty-search"><Users size={24} /><strong>还没有线索</strong><span>点击「新增线索」录入第一位客户</span></div>}
            </section>
          )}

          {activeNav === "地图获客" && (
            <MapLeads ownerName={user?.name || "AI 跟进"} existingNames={leads.map((lead) => lead.name)} onCreated={(lead) => setLeads((current) => [lead, ...current])} />
          )}

          {activeNav === "企业知识库" && (
            <section className="knowledge-layout">
              <div className="console-card knowledge-summary">
                <div className="knowledge-orb"><BookOpen size={30} /></div>
                <h2>企业知识已连接</h2>
                <p>{knowledge.length} 份资料 · 供智能体按权限调用</p>
                <div className="knowledge-stats"><span><strong>{knowledge.reduce((sum, doc) => sum + doc.chunks, 0)}</strong>知识片段</span><span><strong>{knowledge.length}</strong>资料数</span></div>
                <div className="knowledge-source-actions">
                  <button type="button" className="button button-primary" onClick={handlePickFolder} disabled={kbBusy !== ""}>
                    {kbBusy === "scan" ? <LoaderCircle size={15} className="spin" /> : <FolderPlus size={15} />}选择文件夹导入
                  </button>
                  <button type="button" className="button button-secondary" onClick={() => setShowKnowledgeForm(true)}><Plus size={15} />手动录入</button>
                </div>
                <input
                  ref={fallbackInputRef}
                  type="file"
                  hidden
                  multiple
                  {...{ webkitdirectory: "" }}
                  onChange={(event) => { void handleFallbackFiles(event.target.files); event.target.value = ""; }}
                />
                {kbBinding && (
                  <div className="knowledge-binding">
                    <HardDrive size={13} />
                    <span title={kbBinding.name}>{kbBinding.name}</span>
                    <button type="button" onClick={handleRescan} disabled={kbBusy !== ""}><RefreshCw size={12} />重新扫描</button>
                    <button type="button" onClick={handleUnbindFolder}>解绑</button>
                  </div>
                )}
                {(kbProgress || kbResult) && <p className="knowledge-progress">{kbProgress || kbResult}</p>}
              </div>
              <KnowledgeList docs={knowledge} onOpen={openKnowledgeDoc} />

              {kbScan && (
                <div className="console-card kb-import-panel">
                  <div className="console-card-header">
                    <div>
                      <h2>待导入 · {kbScan.folder}</h2>
                      <p>共 {kbScan.items.length} 个文件，已选 {kbScan.selected.length} 个 · 支持 txt / md / csv / json / html / docx / pdf / xlsx</p>
                    </div>
                    <div className="kb-import-tools">
                      <button type="button" className="text-link" onClick={toggleKbAll}>全选 / 取消</button>
                      <label className="kb-toggle"><input type="checkbox" checked={kbOnlySupported} onChange={(event) => setKbOnlySupported(event.target.checked)} />只看可导入</label>
                      <button type="button" className="button button-primary" onClick={handleImportSelected} disabled={kbBusy === "import" || kbScan.selected.length === 0}>
                        {kbBusy === "import" ? <LoaderCircle size={14} className="spin" /> : <FolderOpen size={14} />}导入选中 {kbScan.selected.length} 个
                      </button>
                    </div>
                  </div>
                  <div className="kb-file-list">
                    {(kbOnlySupported ? kbScan.items.filter((item) => item.supported) : kbScan.items).map((item) => (
                      <label className={`kb-file-row ${item.supported ? "" : "unsupported"}`} key={item.id}>
                        <input
                          type="checkbox"
                          checked={kbScan.selected.includes(item.id)}
                          disabled={!item.supported || kbBusy === "import"}
                          onChange={() => toggleKbItem(item.id)}
                        />
                        <FileText size={15} />
                        <span className="kb-file-name"><strong>{item.name}</strong><small>{item.dir || "根目录"}</small></span>
                        <span className="kb-file-ext">{item.ext || "—"}</span>
                        <span className="kb-file-size">{item.size >= 1024 * 1024 ? `${(item.size / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(item.size / 1024))}KB`}</span>
                        {!item.supported && <em>{item.reason}</em>}
                      </label>
                    ))}
                  </div>
                </div>
              )}
            </section>
          )}

          {activeNav === "企微私域" && (
            <section className="wecom-module">
              <div className="console-card wecom-head">
                <div className="wecom-head-icon"><MessageSquareText size={24} /></div>
                <div><h2>企业微信私域链路</h2><p>先用下方「接入企业微信」向导把通道打通：A 欢迎语零开发即生效，B 微信客服自动回复由项目自带服务承接；日常用作战包 + 跟进回填闭环。</p></div>
                <span className="wecom-status" title={wecomLinks.length ? "已登记的企微资产链接" : "登记企微资产链接后显示已登记"}><i />{wecomLinks.length > 0 ? `已登记 ${wecomLinks.length} 条` : "未登记"}</span>
              </div>
              <WecomGuide onToast={setToast} />
              <KfSyncCard
                config={kfConfig}
                syncing={kfSyncing}
                summary={kfSummary}
                onChange={saveKfConfig}
                onSync={() => { void syncKfCustomers(); }}
              />
              <div className="wecom-grid">
                <div className="console-card wecom-links">
                  <div className="console-card-header">
                    <div><h2>已同步的企微资产</h2><p>智能表格 / 智能文档 / 待办的真实链接（{wecomLinks.length} 条）</p></div>
                    <button type="button" className="button button-secondary" onClick={() => setShowWecomForm(true)}><Plus size={15} />登记资产</button>
                  </div>
                  {wecomLinks.length === 0 && <div className="empty-search"><Link2 size={22} /><strong>还没有登记资产</strong><span>把团队已建好的企微文档 / 智能表格链接登记进来，全员可直达</span></div>}
                  {wecomLinks.map((link) => (
                    <div className="wecom-link-row" key={link.id}>
                      <a className="wecom-link-item" href={link.url} target="_blank" rel="noreferrer">
                        <span className="wecom-link-kind">{link.kind}</span>
                        <div><strong>{link.title}</strong><p>{link.summary || link.url}</p></div>
                        <ExternalLink size={16} />
                      </a>
                      <button type="button" className="icon-button row-remove" aria-label={`移除${link.title}`} onClick={() => removeWecomLink(link)}><Trash2 size={14} /></button>
                    </div>
                  ))}
                </div>
                <div className="console-card wecom-guide">
                  <div className="console-card-header"><div><h2>私域动作清单</h2><p>已支持的能力与规划中的能力，如实标注</p></div></div>
                  {[
                    { status: "已支持", tone: "done", title: "作战包一键复制", desc: "高意向线索、任务结论、企业知识打包，粘贴到企微群直接用", icon: ClipboardCopy },
                    { status: "已支持", tone: "done", title: "跟进结果回填", desc: "企微里聊完回系统记一笔，线索阶段与转化漏斗自动更新", icon: CheckCircle2 },
                    { status: "规划中", tone: "planned", title: "线索自动回写智能表格", desc: "自动同步需企微开放 API 授权与云端回调，规划中", icon: Users },
                    { status: "规划中", tone: "planned", title: "跟进任务生成企微待办", desc: "自动同步需企微开放 API 授权与云端回调，规划中", icon: FileText },
                    { status: "规划中", tone: "planned", title: "群发前风控确认", desc: "群发与对外发布前的人工审批流，规划中", icon: Gauge },
                  ].map((action) => {
                    const Icon = action.icon;
                    return <div className="wecom-action" key={action.title}><span><Icon size={16} /></span><div><strong>{action.title}</strong><p>{action.desc}</p></div><span className={`action-status ${action.tone}`}>{action.status}</span></div>;
                  })}
                  <div className="wecom-script">
                    <span>分发流程</span>
                    <code>生成作战包 → 粘贴到企微群 → 回填跟进结果</code>
                  </div>
                  <div className="battle-pack">
                    <div className="battle-pack-head">
                      <span>今日作战包（复制后直接粘贴到企微/群聊）</span>
                      <button type="button" className="button button-secondary battle-copy" onClick={copyBattlePack}><ClipboardCopy size={14} />一键复制</button>
                    </div>
                    <pre>{battlePack}</pre>
                  </div>
                </div>
              </div>
            </section>
          )}

          {activeNav === "群发计划" && (
            <BroadcastCenter leads={leads} kfBaseUrl={kfConfig.baseUrl} kfSecret={kfConfig.secret} />
          )}

          {activeNav === "客服渠道" && <ServiceChannels kfBaseUrl={kfConfig.baseUrl} kfSecret={kfConfig.secret} />}

          {activeNav === "GEO 工作台" && (
            <GeoWorkbench knowledge={knowledge} />
          )}

          {activeNav === "数据洞察" && (
            <section className="insights-grid">
              <div className="console-card insight-hero">
                <span className="panel-kicker"><Gauge size={15} />AI 经营分析</span>
                <h2>{highIntent > 0 ? `当前有 ${highIntent} 条高意向线索，${pendingLeads} 条待跟进。` : "数据已就绪，等待更多业务输入。"}</h2>
                <p>系统已沉淀 {tasks.length} 个任务（交付成功率 {successRate}%）、{totalTokens} tokens 的执行记录，{knowledge.length} 份企业资料可用于生成。建议优先处理高意向线索的跟进动作，并在下周复盘中校验内容产出转化率。</p>
                <div className="insight-actions">
                  <button type="button" className="button button-primary" onClick={exportInsightReport}>导出诊断报告<Download size={15} /></button>
                  <button type="button" className="button button-secondary" onClick={() => openComposer()}>生成新任务<ArrowUpRight size={15} /></button>
                </div>
              </div>
              <div className="console-card funnel-card">
                <div className="console-card-header"><div><h2>私域转化漏斗</h2><p>基于线索阶段实时计算 · 回填跟进结果后自动推进</p></div><button type="button" className="text-link" onClick={exportLeadsCsv}><Download size={14} />导出线索<ArrowUpRight size={13} /></button>
                </div>
                {funnelStages.map((stage, index) => (
                  <div className="funnel-row" key={stage.label}>
                    <div><span>{stage.label}</span><strong>{stage.value}</strong></div>
                    <div className="funnel-bar"><span style={{ width: `${Math.max(6, Math.round((stage.value / funnelMax) * 100))}%`, opacity: 1 - index * 0.14 }} /></div>
                  </div>
                ))}
              </div>
              <div className="console-card status-card">
                <div className="console-card-header"><div><h2>任务状态分布</h2><p>全量 {tasks.length} 条任务记录</p></div></div>
                {([
                  { key: "done", label: "已交付", tone: "green" },
                  { key: "partial", label: "部分完成", tone: "orange" },
                  { key: "running", label: "执行中", tone: "violet" },
                  { key: "failed", label: "失败", tone: "red" },
                ] as const).map((row) => (
                  <div className="funnel-row" key={row.key}>
                    <div><span>{row.label}</span><strong>{taskStatusCounts[row.key]}</strong></div>
                    <div className={`funnel-bar tone-${row.tone}`}><span style={{ width: `${taskStatusCounts[row.key] === 0 ? 3 : Math.round((taskStatusCounts[row.key] / Math.max(tasks.length, 1)) * 100)}%` }} /></div>
                  </div>
                ))}
              </div>
              <div className="console-card ranking-card">
                <div className="console-card-header"><div><h2>AI 员工产出排行</h2><p>按任务步骤产出的内容条数统计</p></div></div>
                {agentRanking.length === 0 && <div className="empty-search"><Bot size={22} /><strong>暂无产出数据</strong><span>发起一个任务即可看到各岗位的交付量</span></div>}
                {agentRanking.map((row, index) => (
                  <div className="ranking-row" key={row.agent}>
                    <span className={`ranking-index rank-${index}`}>{index + 1}</span>
                    <div><strong>{row.agent}</strong><div className="ranking-bar"><span style={{ width: `${Math.round((row.count / Math.max(agentRanking[0].count, 1)) * 100)}%` }} /></div></div>
                    <b>{row.count}</b>
                  </div>
                ))}
              </div>
              <div className="console-card source-card">
                <div className="console-card-header"><div><h2>线索来源分布</h2><p>共 {leads.length} 条线索</p></div></div>
                {leadSources.length === 0 && <div className="empty-search"><Users size={22} /><strong>暂无线索</strong><span>在「线索与客户」录入第一条线索</span></div>}
                {leadSources.map((row) => (
                  <div className="source-row" key={row.source}>
                    <span>{row.source}</span>
                    <div><span style={{ width: `${Math.round((row.count / leadSourceMax) * 100)}%` }} /></div>
                    <b>{row.count}</b>
                    <small>{Math.round((row.count / Math.max(leads.length, 1)) * 100)}%</small>
                  </div>
                ))}
              </div>
                          <OpsReportCard tasks={tasks} leads={leads} knowledgeCount={knowledge.length} contentCount={contentOutputs.length} />
            </section>
          )}

          {activeNav === "视频创作" && (
            <VideoStudio />
          )}

          {activeNav === "混剪工坊" && (
            <MixStudio />
          )}

          {activeNav === "数字人工坊" && <DigitalStudio />}

          {activeNav === "AI 办公" && <OfficeStudio />}

          {activeNav === "模型接入" && (
            <>
            <section className="channel-grid">
              <div className="console-card channel-card">
                <div className="console-card-header">
                  <div><h2>平台通道</h2><p>WorkBuddy 云端模型 · 匿名态配额有限，登录后更高</p></div>
                  <span className={`channel-badge ${user ? "ok" : "warn"}`}>{user ? `已登录 · ${user.name}` : "未登录"}</span>
                </div>
                <div className="channel-row"><span>任务是否走此通道</span><strong>{channel === "platform" ? "是 · 当前生效" : "否 · 备用"}</strong></div>
                <p className="channel-detail">{platformStatus ? platformStatus.detail : "点下方按钮实测一次（会真实发出极短请求，用于确认真实可用性）。"}</p>
                <div className="channel-actions">
                  <button type="button" className="button button-secondary" onClick={runPlatformProbe} disabled={probing !== null}>
                    {probing === "platform" ? <LoaderCircle size={14} className="spin" /> : <Gauge size={14} />}检测平台通道
                  </button>
                  {!user && <button type="button" className="button button-primary" onClick={() => setShowLogin(true)}><LogIn size={14} />登录提升配额</button>}
                  <button type="button" className="button button-ghost" onClick={() => switchChannel("platform")} disabled={channel === "platform"}>切到平台通道</button>
                </div>
              </div>

              <div className="console-card channel-card">
                <div className="console-card-header">
                  <div><h2>自定义通道</h2><p>填入自己的 OpenAI 兼容 Key，完全绕开平台配额</p></div>
                  <span className={`channel-badge ${channel === "custom" ? "ok" : ""}`}>{channel === "custom" ? "生效中" : "未启用"}</span>
                </div>
                <div className="channel-presets">
                  <span>快速选择服务商</span>
                  {[
                    { name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" },
                    { name: "硅基流动", baseUrl: "https://api.siliconflow.cn/v1", model: "deepseek-ai/DeepSeek-V3" },
                    { name: "Kimi", baseUrl: "https://api.moonshot.cn/v1", model: "moonshot-v1-8k" },
                    { name: "通义千问", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus" },
                  ].map((preset) => (
                    <button
                      key={preset.name}
                      type="button"
                      className={"channel-preset" + (providerForm.baseUrl === preset.baseUrl ? " active" : "")}
                      onClick={() => setProviderForm({ ...providerForm, baseUrl: preset.baseUrl, model: preset.model })}
                    >
                      {preset.name}
                    </button>
                  ))}
                </div>
                <label className="channel-field"><span>端点地址</span><input value={providerForm.baseUrl} onChange={(event) => setProviderForm({ ...providerForm, baseUrl: event.target.value })} onBlur={() => setProviderForm((prev) => ({ ...prev, baseUrl: canonicalBaseUrl(prev.baseUrl) }))} placeholder="https://api.deepseek.com/v1" /></label>
                {providerForm.baseUrl.trim() !== "" && canonicalBaseUrl(providerForm.baseUrl) !== providerForm.baseUrl.trim() && (
                  <p className="channel-hint">已自动校正为 <code>{canonicalBaseUrl(providerForm.baseUrl)}</code></p>
                )}
                <label className="channel-field"><span>API Key</span><input type="password" value={providerForm.apiKey} onChange={(event) => setProviderForm({ ...providerForm, apiKey: event.target.value })} placeholder="sk-..." autoComplete="off" /></label>
                <label className="channel-field"><span>模型名</span><input value={providerForm.model} onChange={(event) => setProviderForm({ ...providerForm, model: event.target.value })} placeholder="deepseek-chat" /></label>
                <p className="channel-detail">{customStatus ? customStatus.detail : "Key 只保存在本机浏览器，不上云不入库。DeepSeek 常用模型名：deepseek-chat（通用）、deepseek-reasoner（推理）。"}</p>
                <div className="channel-actions">
                  <button type="button" className="button button-secondary" onClick={runCustomProbe} disabled={probing !== null}>
                    {probing === "custom" ? <LoaderCircle size={14} className="spin" /> : <KeyRound size={14} />}验证连通
                  </button>
                  <button type="button" className="button button-primary" onClick={() => switchChannel("custom")} disabled={channel === "custom"}>启用此通道</button>
                  <button type="button" className="button button-ghost danger-button" onClick={resetCustomProvider}>清除</button>
                </div>
              </div>

              <div className="console-card channel-help">
                <h2>为什么会出现「服务繁忙 / 配额用尽」</h2>
                <p>AI 员工的每一步都要真实调用大模型。平台通道在匿名态下配额很紧，连续执行任务就会返回 429，步骤会被自动跳过。</p>
                <ul>
                  <li>登录 WorkBuddy 账号 —— 提升平台配额</li>
                  <li>或启用自定义通道 —— 用你自己的 Key，不受平台限制</li>
                  <li>通道修好后，到「任务中心」对失败任务点「重跑」即可补齐产出</li>
                  <li>配额受限时任务会快速失败并提示原因，不会长时间空转</li>
                  <li>视频通道（Seedance / OpenAI Video）在「视频创作」页右上角配置，与文本通道相互独立</li>
                </ul>
              </div>
            </section>
              <UsagePanel />
            </>
          )}

          {activeNav === "AI 创作" && (
            <section className="studio-layout">
              <div className="console-card studio-compose">
                <div className="console-card-header">
                  <div>
                    <h2>描述你想要的画面</h2>
                    <p>一句话即可，越具体越准：主体 + 场景 + 风格 + 光线</p>
                  </div>
                  <span className={"channel-badge " + (studioChannel.ready ? "ok" : "warn")}>{studioChannel.label}</span>
                </div>
                <textarea
                  className="studio-prompt"
                  value={studioPrompt}
                  onChange={(event) => setStudioPrompt(event.target.value)}
                  rows={5}
                  placeholder="例如：一只橘猫坐在洒满日光的窗台上，浅景深，写实摄影，暖色调"
                />
                <div className="studio-sizes">
                  {([
                    { key: "1024x1024", label: "方形 1:1" },
                    { key: "768x1024", label: "竖版 3:4" },
                    { key: "1024x768", label: "横版 4:3" },
                    { key: "720x1280", label: "长竖 9:16" },
                  ] as { key: ImageSize; label: string }[]).map((item) => (
                    <button
                      key={item.key}
                      type="button"
                      className={"studio-size" + (studioSize === item.key ? " active" : "")}
                      onClick={() => setStudioSize(item.key)}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
                <div className="studio-actions">
                  <button type="button" className="button" onClick={runGenerate} disabled={studioBusy}>
                    {studioBusy ? <LoaderCircle size={16} className="spin" /> : <ImagePlus size={16} />}
                    {studioBusy ? "正在生成…" : "生成图片"}
                  </button>
                  <button type="button" className="button button-secondary" onClick={() => setActiveNav("模型接入")}>
                    <Plug size={16} />通道设置
                  </button>
                </div>
                {studioError && <p className="studio-error">{studioError}</p>}
                {studioNotice && <p className="studio-notice">{studioNotice}</p>}
                <p className="studio-hint">{studioChannel.hint}</p>
                <div className="studio-presets">
                  {["产品主图", "社媒配图", "门店场景", "海报背景"].map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      onClick={() =>
                        setStudioPrompt((current) =>
                          current
                            ? current
                            : preset === "产品主图"
                              ? "白色背景的产品主图，居中构图，柔和顶光，商业摄影质感"
                              : preset === "社媒配图"
                                ? "适合朋友圈的配图，明亮通透，留白充足，现代简约风格"
                                : preset === "门店场景"
                                  ? "温馨的咖啡店内部场景，木质家具，午后阳光斜射，胶片质感"
                                  : "极简渐变海报背景，莫兰迪色系，柔和光晕，无文字",
                        )
                      }
                    >
                      + {preset}
                    </button>
                  ))}
                </div>
              </div>

              <div className="console-card studio-gallery">
                <div className="console-card-header">
                  <div>
                    <h2>本地作品库</h2>
                    <p>{artworks.length} 张作品 · 存在这台设备上，刷新不丢</p>
                  </div>
                  {artworks.length > 0 && (
                    <button type="button" className="icon-button" onClick={clearAllArtworks} title="清空作品库">
                      <Trash2 size={16} />
                    </button>
                  )}
                </div>
                {artworks.length === 0 && (
                  <div className="empty-search">
                    <Palette size={24} />
                    <strong>还没有作品</strong>
                    <span>写下画面描述，点「生成图片」就能出图</span>
                  </div>
                )}
                {artworks.length > 0 && (
                  <div className="studio-grid">
                    {artworks.map((item) => (
                      <figure className="studio-tile" key={item.id}>
                        <button type="button" className="studio-tile-image" onClick={() => setPreview(item)}>
                          <img src={item.src} alt={item.prompt.slice(0, 40)} loading="lazy" />
                        </button>
                        <figcaption>
                          <span title={item.prompt}>{item.prompt}</span>
                          <div>
                            <button type="button" onClick={() => downloadArtwork(item)} title="下载"><Download size={14} /></button>
                            <button type="button" onClick={() => removeArtworkItem(item)} title="删除"><Trash2 size={14} /></button>
                          </div>
                        </figcaption>
                      </figure>
                    ))}
                  </div>
                )}
              </div>
            </section>
          )}

          {preview && (
            <div className="studio-preview" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setPreview(null); }}>
              <div className="studio-preview-inner">
                <img src={preview.src} alt={preview.prompt} />
                <div className="studio-preview-bar">
                  <p>{preview.prompt}</p>
                  <div>
                    <span>{preview.model} · {preview.size}</span>
                    <button type="button" className="button button-secondary" onClick={() => downloadArtwork(preview)}><Download size={15} />下载</button>
                    <button type="button" className="button button-secondary" onClick={() => setPreview(null)}><X size={15} />关闭</button>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </main>

      {selectedTask && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelectedTask(null); }}>
          <div className="composer-modal task-detail-modal" role="dialog" aria-modal="true" aria-label="任务详情">
            <button type="button" className="icon-button modal-close" onClick={() => setSelectedTask(null)} aria-label="关闭"><X size={20} /></button>
            <span className="panel-kicker">TASK DETAIL · #{selectedTask.id}</span>
            <h2 className="task-detail-title">{selectedTask.title ?? "任务记录"}</h2>
            <p className="task-detail-goal">{selectedTask.goal}</p>
            <div className="task-detail-meta">
              <span className={`task-chip ${selectedTask.status === "done" ? "done" : selectedTask.status === "failed" ? "failed" : "partial"}`}>
                {selectedTask.status === "done" ? "已交付" : selectedTask.status === "failed" ? "失败" : selectedTask.status === "partial" ? "部分完成" : "执行中"}
              </span>
              <span>{selectedTask.progress}%</span>
              <span>{stepsDoneCount}/{selectedSteps.length || "?"} 步完成</span>
              {taskTokens > 0 && <span>{taskTokens.toLocaleString("zh-CN")} tokens</span>}
              <span>{new Date(selectedTask.created_at).toLocaleString("zh-CN", { hour12: false })}</span>
            </div>
            {taskError && <p className="task-error-note">{taskError}</p>}
            {taskSummary && (
              <div className="task-summary-block">
                <span>结论摘要</span>
                <p dangerouslySetInnerHTML={{ __html: renderStepOutput(taskSummary) }} />
              </div>
            )}
            <div className="task-detail-actions">
              <button type="button" className="button button-secondary" onClick={() => { const current = selectedTask; setSelectedTask(null); rerunTask(current); }}><RotateCcw size={14} />重跑任务</button>
              <button type="button" className="button button-secondary" disabled={selectedSteps.length === 0} onClick={copyTaskOutput}><ClipboardCopy size={14} />复制全部产出</button>
              <button type="button" className="button button-ghost danger-button" onClick={() => removeTask(selectedTask)}><Trash2 size={14} />删除记录</button>
            </div>
            <div className="task-detail-steps">
              {stepsLoading && <p className="task-empty-note">正在加载执行过程…</p>}
              {!stepsLoading && selectedSteps.length === 0 && <p className="task-empty-note">这个任务没有留下步骤记录（可能是历史数据或早期版本创建）。目标与状态仍可查看，重新跑一次会生成完整过程。</p>}
              {!stepsLoading && selectedSteps.map((step, index) => (
                <div className="task-detail-step" key={`${step.label}-${index}`}>
                  <div className="step-icon step-violet">{step.status === "done" ? <Check size={16} /> : <Bot size={16} />}</div>
                  <div className="task-step-body">
                    <strong>{index + 1}. {step.label}</strong>
                    <p>{step.action}</p>
                    {step.output ? <div className="step-result" dangerouslySetInnerHTML={{ __html: renderStepOutput(step.output) }} /> : <div className="step-result empty">该步骤没有产出{selectedTask.status === "failed" ? "（任务失败）" : ""}</div>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {showComposer && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowComposer(false); }}>
          <div className="composer-modal" role="dialog" aria-modal="true" aria-label="新建 AI 任务">
            <button type="button" className="icon-button modal-close" onClick={() => setShowComposer(false)} aria-label="关闭"><X size={20} /></button>
            <CommandDemo
              compact
              ownerName={user?.name ?? null}
              agents={agents}
              onNeedLogin={user ? undefined : () => setShowLogin(true)}
              onFinished={() => void load()}
              initialGoal={composerSeed?.goal}
              initialTemplateCode={composerSeed?.templateCode}
            />
          </div>
        </div>
      )}

      {showLogin && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowLogin(false); }}>
          <div className="composer-modal login-modal" role="dialog" aria-modal="true" aria-label="登录">
            <button type="button" className="icon-button modal-close" onClick={() => setShowLogin(false)} aria-label="关闭"><X size={20} /></button>
            <LoginPanel onSignedIn={() => { setShowLogin(false); onSignedIn(); }} />
          </div>
        </div>
      )}

      {showPalette && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowPalette(false); }}>
          <div className="composer-modal palette-modal" role="dialog" aria-modal="true" aria-label="全局搜索">
            <div className="palette-input-row">
              <Search size={17} />
              <input
                autoFocus
                aria-label="全局搜索"
                placeholder="搜索任务、客户线索、岗位模板、知识文档…"
                value={paletteQuery}
                onChange={(event) => setPaletteQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") setShowPalette(false);
                  if (event.key === "Enter" && paletteItems.length > 0) { paletteItems[0].run(); setShowPalette(false); }
                }}
              />
              <kbd>ESC</kbd>
            </div>
            <div className="palette-list">
              {paletteItems.length === 0 && <div className="palette-empty">没有匹配结果，换个关键词试试</div>}
              {paletteItems.map((item, index) => (
                <button type="button" key={`${item.module}-${item.label}-${index}`} className="palette-item" onClick={() => { item.run(); setShowPalette(false); }}>
                  <span className={`palette-module module-${["任务中心", "线索与客户", "模板中心", "企业知识库"].indexOf(item.module)}`}>{item.module}</span>
                  <span className="palette-text"><strong>{item.label}</strong><small>{item.sub}</small></span>
                  {index === 0 && <kbd>回车</kbd>}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {showLeadForm && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowLeadForm(false); }}>
          <div className="composer-modal form-modal" role="dialog" aria-modal="true" aria-label="新增线索">
            <button type="button" className="icon-button modal-close" onClick={() => setShowLeadForm(false)} aria-label="关闭"><X size={20} /></button>
            <span className="panel-kicker">NEW LEAD</span>
            <h2>录入新线索</h2>
            <div className="form-grid">
              <label>客户名称 *<input value={leadForm.name} maxLength={20} placeholder="例如：陈女士" onChange={(event) => setLeadForm({ ...leadForm, name: event.target.value })} /></label>
              <label>来源渠道<input value={leadForm.source} maxLength={20} placeholder="例如：抖音 / 企微 / 转介绍" onChange={(event) => setLeadForm({ ...leadForm, source: event.target.value })} /></label>
              <label>意向等级<select value={leadForm.intent} onChange={(event) => setLeadForm({ ...leadForm, intent: event.target.value })}>{INTENT_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}</select></label>
              <label>跟进人<input value={leadForm.owner} maxLength={12} placeholder="默认为当前用户" onChange={(event) => setLeadForm({ ...leadForm, owner: event.target.value })} /></label>
            </div>
            <label className="form-full">最新需求 *<textarea rows={3} maxLength={120} placeholder="客户的核心诉求，例如：想了解新品团购方案" value={leadForm.need} onChange={(event) => setLeadForm({ ...leadForm, need: event.target.value })} /></label>
            <div className="form-actions"><button type="button" className="button button-primary" onClick={submitLeadForm} disabled={formSaving === "lead"}>{formSaving === "lead" ? "保存中…" : "保存线索"}</button><button type="button" className="button button-ghost" onClick={() => setShowLeadForm(false)}>取消</button></div>
          </div>
        </div>
      )}

      {showKnowledgeForm && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowKnowledgeForm(false); }}>
          <div className="composer-modal form-modal" role="dialog" aria-modal="true" aria-label="录入知识">
            <button type="button" className="icon-button modal-close" onClick={() => setShowKnowledgeForm(false)} aria-label="关闭"><X size={20} /></button>
            <span className="panel-kicker">KNOWLEDGE</span>
            <h2>录入知识文档</h2>
            <p className="form-hint">录入后智能体在执行任务时会引用这些知识（产品手册、价格表、流程制度等）。</p>
            <div className="form-grid">
              <label>文档标题 *<input value={knowledgeForm.title} maxLength={40} placeholder="例如：2026 秋季产品价格表" onChange={(event) => setKnowledgeForm({ ...knowledgeForm, title: event.target.value })} /></label>
              <label>文档类型<select value={knowledgeForm.docType} onChange={(event) => setKnowledgeForm({ ...knowledgeForm, docType: event.target.value })}>{DOC_TYPE_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}</select></label>
            </div>
            <label className="form-full">文档内容 *（不少于 10 字）<textarea rows={8} maxLength={4000} placeholder="粘贴或输入知识内容…" value={knowledgeForm.content} onChange={(event) => setKnowledgeForm({ ...knowledgeForm, content: event.target.value })} /></label>
            <div className="form-meta">将自动切分为约 {Math.max(1, Math.ceil(knowledgeForm.content.replace(/\s/g, "").length / 300))} 个知识片段</div>
            <div className="form-actions"><button type="button" className="button button-primary" onClick={submitKnowledgeForm} disabled={formSaving === "knowledge"}>{formSaving === "knowledge" ? "保存中…" : "保存到知识库"}</button><button type="button" className="button button-ghost" onClick={() => setShowKnowledgeForm(false)}>取消</button></div>
          </div>
        </div>
      )}

      {docDetail && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setDocDetail(null); }}>
          <div className="composer-modal form-modal doc-modal" role="dialog" aria-modal="true" aria-label="知识详情">
            <button type="button" className="icon-button modal-close" onClick={() => setDocDetail(null)} aria-label="关闭"><X size={20} /></button>
            <span className="panel-kicker">{docDetail.doc_type} · {docDetail.chunks} 个知识片段</span>
            <h2>{docDetail.title}</h2>
            <p className="form-hint">录入于 {new Date(docDetail.created_at).toLocaleString("zh-CN", { hour12: false })} · 来源：{docDetail.source}</p>
            <pre className="doc-content">{docDetail.content ?? "（无内容）"}</pre>
            <div className="form-actions"><button type="button" className="button button-ghost danger-button" onClick={() => removeKnowledgeDoc(docDetail)}><Trash2 size={14} />删除此文档</button></div>
          </div>
        </div>
      )}

      {contentDetail && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setContentDetail(null); }}>
          <div className="composer-modal form-modal doc-modal" role="dialog" aria-modal="true" aria-label="内容详情">
            <button type="button" className="icon-button modal-close" onClick={() => setContentDetail(null)} aria-label="关闭"><X size={20} /></button>
            <span className="panel-kicker">{contentDetail.agent} · 云端产出</span>
            <h2>{contentDetail.title}</h2>
            <p className="form-hint">生成于 {new Date(contentDetail.created_at).toLocaleString("zh-CN", { hour12: false })}</p>
            <pre className="doc-content">{contentDetail.output}</pre>
            <div className="form-actions">
              <button type="button" className="button button-primary" onClick={() => copyText(contentDetail.output, "内容已复制，可直接粘贴使用")}><ClipboardCopy size={14} />复制全文</button>
              <button type="button" className="button button-secondary" onClick={() => { setPublishSource(`${contentDetail.title}-${contentDetail.created_at}`); setContentDetail(null); setActiveNav("聚合发布"); }}><Megaphone size={14} />去发布</button>
              <button type="button" className="button button-secondary" onClick={() => { setContentDetail(null); setShowComposer(true); }}><RotateCcw size={14} />基于此再生成</button>
              {contentDetail.demo && (
                <button type="button" className="button button-ghost danger-button" onClick={() => removeContentOutput(contentDetail)}><Trash2 size={14} />移除产出</button>
              )}
            </div>
          </div>
        </div>
      )}

      {agentEditing && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setAgentEditing(null); }}>
          <div className="composer-modal form-modal" role="dialog" aria-modal="true" aria-label="重命名智能体">
            <button type="button" className="icon-button modal-close" onClick={() => setAgentEditing(null)} aria-label="关闭"><X size={20} /></button>
            <span className="panel-kicker">RENAME AGENT</span>
            <h2>重命名智能体</h2>
            <p className="form-hint">名称会显示在任务分配、产出署名与通知中。</p>
            <label className="form-full">智能体名称<input value={agentEditing.name} maxLength={20} autoFocus onChange={(event) => setAgentEditing({ ...agentEditing, name: event.target.value })} /></label>
            <div className="form-actions"><button type="button" className="button button-primary" onClick={submitAgentRename}>保存名称</button><button type="button" className="button button-ghost" onClick={() => setAgentEditing(null)}>取消</button></div>
          </div>
        </div>
      )}

      {personaEditing && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setPersonaEditing(null); }}>
          <div className="composer-modal form-modal persona-modal" role="dialog" aria-modal="true" aria-label="编辑智能体人设">
            <button type="button" className="icon-button modal-close" onClick={() => setPersonaEditing(null)} aria-label="关闭"><X size={20} /></button>
            <span className="panel-kicker">AGENT PERSONA</span>
            <h2>编辑「{personaEditing.name}」的人设</h2>
            <p className="form-hint">人设决定这位 AI 员工怎么拆活、怎么交付、什么算合格。只对你自己账号生效，官方模板不受影响。</p>
            <div className="persona-meta">
              <span>岗位模板 · {personaEditing.templateName}</span>
              <span>{personaEditing.prompt.trim().length} 字</span>
              {customPromptOf(agents.find((item) => item.id === personaEditing.agentId)) ? <span className="persona-meta-custom">当前为自定义人设</span> : <span>当前为官方默认</span>}
            </div>
            <label className="form-full persona-field">
              <span>人设与工作方法</span>
              <textarea
                value={personaEditing.prompt}
                onChange={(event) => setPersonaEditing({ ...personaEditing, prompt: event.target.value })}
                rows={13}
                spellCheck={false}
                placeholder="建议写清：身份与负责的结果、先做什么后做什么、输出长什么样、什么算合格、绝对不能做什么。"
              />
            </label>
            <div className="persona-tools">
              <button type="button" className="button button-ghost persona-reset" onClick={resetPersona}><RotateCcw size={14} />恢复官方默认</button>
              <button type="button" className="text-link" onClick={() => setShowPersonaDefault((value) => !value)}>{showPersonaDefault ? "收起官方版本" : "对照官方版本"}</button>
            </div>
            {showPersonaDefault && (
              <div className="persona-baseline">
                <span>官方默认人设（只读）</span>
                <p>{personaEditing.baseline || "该岗位暂无官方默认人设，你的版本会直接生效。"}</p>
              </div>
            )}
            <div className="form-actions">
              <button type="button" className="button button-primary" onClick={savePersona} disabled={personaSaving}>{personaSaving ? "保存中…" : "保存人设"}</button>
              <button type="button" className="button button-ghost" onClick={() => setPersonaEditing(null)}>取消</button>
            </div>
          </div>
        </div>
      )}

      {showWecomForm && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowWecomForm(false); }}>
          <div className="composer-modal form-modal" role="dialog" aria-modal="true" aria-label="登记企微资产">
            <button type="button" className="icon-button modal-close" onClick={() => setShowWecomForm(false)} aria-label="关闭"><X size={20} /></button>
            <span className="panel-kicker">WECOM ASSET</span>
            <h2>登记企微资产</h2>
            <p className="form-hint">把团队已建好的企微智能表格 / 智能文档 / 待办链接登记进来，任务产出与跟进记录就能一键直达。</p>
            <div className="form-grid">
              <label>资产类型<select value={wecomForm.kind} onChange={(event) => setWecomForm({ ...wecomForm, kind: event.target.value })}>{["智能表格", "智能文档", "企微待办", "群聊"].map((kind) => <option key={kind} value={kind}>{kind}</option>)}</select></label>
              <label>资产标题 *<input value={wecomForm.title} maxLength={40} placeholder="例如：本周客户跟进表" onChange={(event) => setWecomForm({ ...wecomForm, title: event.target.value })} /></label>
            </div>
            <label className="form-full">说明<input value={wecomForm.summary} maxLength={80} placeholder="例如：高意向客户与跟进人实时回写" onChange={(event) => setWecomForm({ ...wecomForm, summary: event.target.value })} /></label>
            <label className="form-full">链接 *<input value={wecomForm.url} maxLength={300} placeholder="https://doc.weixin.qq.com/..." onChange={(event) => setWecomForm({ ...wecomForm, url: event.target.value })} /></label>
            <div className="form-actions"><button type="button" className="button button-primary" onClick={submitWecomForm} disabled={formSaving === "wecom"}>{formSaving === "wecom" ? "保存中…" : "保存资产"}</button><button type="button" className="button button-ghost" onClick={() => setShowWecomForm(false)}>取消</button></div>
          </div>
        </div>
      )}

      {followUpLead && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setFollowUpLead(null); }}>
          <div className="composer-modal form-modal followup-modal" role="dialog" aria-modal="true" aria-label="回填跟进结果">
            <button type="button" className="icon-button modal-close" onClick={() => setFollowUpLead(null)} aria-label="关闭"><X size={20} /></button>
            <span className="panel-kicker">FOLLOW-UP</span>
            <h2>回填跟进结果 · {followUpLead.name}</h2>
            <p className="form-hint">在企微里聊完回到系统记一笔：阶段与转化漏斗自动更新，下次作战包更准。</p>
            {kfMessages.length > 0 && (
              <div className="kf-chat">
                <div className="kf-chat-head">
                  <strong>企微对话（最近 {kfMessages.length} 条）</strong>
                  <span>同步自微信客服</span>
                </div>
                <div className="kf-chat-list">
                  {kfMessages.map((msg) => (
                    <div className={`kf-msg ${msg.direction}`} key={msg.id}>
                      <span className="kf-msg-who">{msg.direction === "in" ? "客户" : "AI"}</span>
                      <p>{msg.text}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div className="fu-history">
              <div className="fu-history-head">
                <strong>跟进记录（{followUps.length}）</strong>
                <button type="button" className="text-link" onClick={copyLeadBattlePack}><ClipboardCopy size={13} />复制跟进包</button>
              </div>
              {followUpLoading ? (
                <p className="fu-empty">读取中…</p>
              ) : followUps.length === 0 ? (
                <p className="fu-empty">还没有记录，在下面填第一笔吧。</p>
              ) : (
                followUps.map((item) => (
                  <div className="fu-item" key={item.id}>
                    <span className={`fu-result ${item.result === "已成交" ? "won" : item.result === "暂缓" ? "paused" : ""}`}>{item.result}</span>
                    <div>
                      <strong>{item.channel} · {new Date(item.created_at).toLocaleString("zh-CN", { hour12: false })}</strong>
                      {item.next_step && <p>下一步：{item.next_step}</p>}
                      {item.note && <p>{item.note}</p>}
                    </div>
                  </div>
                ))
              )}
            </div>
            <div className="form-grid">
              <label>跟进渠道<select value={followUpForm.channel} onChange={(event) => setFollowUpForm({ ...followUpForm, channel: event.target.value })}>{["企微", "电话", "面谈", "社群", "其他"].map((option) => <option key={option} value={option}>{option}</option>)}</select></label>
              <label>本次结果<select value={followUpForm.result} onChange={(event) => setFollowUpForm({ ...followUpForm, result: event.target.value })}>{["已联系", "已报价", "已预约", "已成交", "暂缓"].map((option) => <option key={option} value={option}>{option}</option>)}</select></label>
              <label>推进到阶段<select value={followUpStage} onChange={(event) => setFollowUpStage(event.target.value)}>{STAGE_FLOW.map((option) => <option key={option} value={option}>{option}</option>)}</select></label>
            </div>
            <label className="form-full">下一步动作 *<input value={followUpForm.next} maxLength={80} placeholder="例如：周三发报价单，周五电话确认" onChange={(event) => setFollowUpForm({ ...followUpForm, next: event.target.value })} /></label>
            <label className="form-full">沟通要点<textarea rows={2} maxLength={200} placeholder="客户原话、异议、关注点，下次跟进直接引用" value={followUpForm.note} onChange={(event) => setFollowUpForm({ ...followUpForm, note: event.target.value })} /></label>
            <div className="form-actions"><button type="button" className="button button-primary" onClick={submitFollowUp} disabled={formSaving === "followup"}>{formSaving === "followup" ? "保存中…" : "保存回填"}</button><button type="button" className="button button-ghost" onClick={() => setFollowUpLead(null)}>取消</button></div>
          </div>
        </div>
      )}

      {toast && <div className="console-toast">{toast}</div>}
      {loading && <div className="console-loading"><LoaderCircle size={18} className="spin" />正在读取云端数据…</div>}
    </div>
  );
}

function TaskTable({ tasks, onOpen, onRerun, onDelete }: { tasks: AnyTask[]; onOpen: (task: AnyTask) => void; onRerun: (task: AnyTask) => void; onDelete: (task: AnyTask) => void }) {
  return (
    <div className="task-list">
      {tasks.map((task) => (
        <div className="task-row" key={task.id} role="button" tabIndex={0} onClick={() => onOpen(task)} onKeyDown={(event) => { if (event.key === "Enter") onOpen(task); }}>
          <div className={`task-status-dot ${task.status === "done" ? "done" : task.status === "failed" ? "failed" : task.status === "partial" ? "partial" : "running"}`}>
            {task.status === "done" ? <Check size={14} /> : task.status === "failed" ? <CircleDot size={14} /> : task.status === "partial" ? <Clock3 size={14} /> : <Activity size={14} />}
          </div>
          <div className="task-main"><strong>{task.title ?? task.goal.slice(0, 24)}</strong><span>{(task as DemoTaskRow).domain ?? "综合业务"} · {new Date(task.created_at).toLocaleString("zh-CN", { hour12: false })}</span></div>
          <div className="task-progress"><div><span style={{ width: `${task.progress}%` }} /></div><small>{task.progress}%</small></div>
          <span className={`task-status-text ${task.status === "done" ? "done" : task.status === "partial" ? "partial" : ""}`}>{task.status === "done" ? "已交付" : task.status === "failed" ? "失败" : task.status === "partial" ? "部分完成" : "执行中"}</span>
          <div className="task-actions" onClick={(event) => event.stopPropagation()}>
            <button type="button" className="task-view-button" onClick={() => onOpen(task)}>查看产出<ChevronRight size={13} /></button>
            <button type="button" className="icon-button task-action-button" title="用同一目标重跑任务" onClick={() => onRerun(task)}><RotateCcw size={14} /></button>
            <button type="button" className="icon-button task-action-button danger" title="删除任务记录" onClick={() => onDelete(task)}><Trash2 size={14} /></button>
          </div>
        </div>
      ))}
      {tasks.length === 0 && <div className="empty-search"><Search size={22} /><strong>暂无任务</strong><span>点击「创建任务」发起第一个目标</span></div>}
    </div>
  );
}
