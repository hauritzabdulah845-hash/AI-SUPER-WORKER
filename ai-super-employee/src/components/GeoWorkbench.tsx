import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownRight,
  ArrowUpRight,
  BookMarked,
  Check,
  ChevronDown,
  ClipboardCopy,
  Download,
  FileText,
  Globe2,
  LoaderCircle,
  Minus,
  Plus,
  Radar,
  Sparkles,
  Target,
  TestTube2,
  Trash2,
} from "lucide-react";
import {
  defaultGeoQuestions,
  generateGeoAssets,
  geoMarkdown,
  runGeoAudit,
  testBrandMention,
  type GeoAssetBundle,
  type GeoAuditResult,
  type GeoMentionTest,
} from "../cloud/geo";
import {
  expandKeywords,
  generateTopics,
  groupStats,
  parseSeedWords,
  topicsMarkdown,
  GEO_KEYWORD_INTENTS,
  type GeoExpandResult,
  type GeoKeywordIntent,
  type GeoKeywordPriority,
  type GeoTopic,
} from "../cloud/geokeywords";
import {
  libraryStats,
  loadLibrary,
  loadQuestions,
  mergeKeywords,
  mergeQuestionItems,
  parsePastedQuestions,
  removeKeyword,
  saveLibrary,
  saveQuestions,
  setPriority,
  toLibraryEntry,
  toQuestions,
  type GeoQuestionItem,
  type KeywordLibraryEntry,
} from "../cloud/keywordLibrary";
import { navToSlug } from "../nav";
import { getKnowledgeDoc, type KnowledgeRow } from "../cloud/api";
import { GeoMonitor } from "./GeoMonitor";
import { MAX_QUESTIONS, loadSnapshots, loadSnapshotsFor } from "../cloud/geomonitor";
import { friendlyError } from "../cloud/friendlyError";
import {
  firstIncompleteStep,
  geoStepStatus,
  overviewStats,
  pct,
} from "../cloud/geotrack";

const STEP_STORAGE_KEY = "ai-employee:geo-step";
const GEO_STEPS = ["资料体检", "拓词选题", "监测问题集", "监测与报告"] as const;

function readStoredStep(): number | null {
  try {
    const raw = Number(window.localStorage.getItem(STEP_STORAGE_KEY));
    return raw >= 1 && raw <= GEO_STEPS.length ? raw : null;
  } catch {
    return null;
  }
}

function formatOverviewTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
}

/** 概览条涨跌箭头：null（无上次）不显示，0 显示持平。 */
function DeltaMark({ delta }: { delta: number | null }) {
  if (delta === null) return null;
  if (Math.abs(delta) < 0.005) return <span className="geo-ov-delta flat"><Minus size={12} />持平</span>;
  const up = delta > 0;
  return (
    <span className={`geo-ov-delta ${up ? "up" : "down"}`}>
      {up ? <ArrowUpRight size={12} /> : <ArrowDownRight size={12} />}
      {Math.abs(delta * 100).toFixed(0)} 个百分点
    </span>
  );
}

interface GeoWorkbenchProps {
  knowledge: KnowledgeRow[];
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

/**
 * GEO 内容工作台：体检 → 生成可引用素材 → 提及率复测。
 * 所有调用走 askLLM（与任务执行同通道），资料来自知识库或手工粘贴。
 */
export function GeoWorkbench({ knowledge }: GeoWorkbenchProps) {
  const [brand, setBrand] = useState("");
  const [keywords, setKeywords] = useState("");
  const [material, setMaterial] = useState("");
  const [materialNote, setMaterialNote] = useState("");
  // 第 28 批：问题集逐条编辑 + 本机持久化（按品牌分键，打开页面自动恢复）。
  const [questionItems, setQuestionItems] = useState<GeoQuestionItem[]>(() => loadQuestions(""));
  const [pasteText, setPasteText] = useState("");
  // 第 28 批：词库（按品牌分键存本机）；brandKey 是当前存取用的品牌键，品牌输入失焦时切换并载入。
  const [brandKey, setBrandKey] = useState("");
  const [library, setLibrary] = useState<KeywordLibraryEntry[]>(() => loadLibrary(""));
  const [libraryOpen, setLibraryOpen] = useState(true);
  const [manualWord, setManualWord] = useState("");
  const [manualIntent, setManualIntent] = useState<GeoKeywordIntent>("咨询");
  const [manualPriority, setManualPriority] = useState<GeoKeywordPriority>("中");
  const [busy, setBusy] = useState<"" | "load" | "audit" | "assets" | "test" | "expand" | "topics" | "topic-one">("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [audit, setAudit] = useState<GeoAuditResult | null>(null);
  const [assets, setAssets] = useState<GeoAssetBundle | null>(null);
  const [seedText, setSeedText] = useState("");
  const [expanded, setExpanded] = useState<GeoExpandResult | null>(null);
  const [topics, setTopics] = useState<GeoTopic[]>([]);
  const [topicsDemo, setTopicsDemo] = useState(false);
  const [mentionTests, setMentionTests] = useState<GeoMentionTest[]>([]);
  // 第 27 批：分步导航。优先恢复上次停留步骤，否则定位第一个未完成步骤。
  const [activeStep, setActiveStep] = useState<number>(() => {
    const stored = readStoredStep();
    if (stored) return stored;
    const snapshotCount = loadSnapshots().length;
    return firstIncompleteStep(geoStepStatus({
      hasAudit: false,
      hasKeywordsOrTopics: false,
      questionCount: 0,
      snapshotCount,
    }));
  });
  const [snapshotsVersion, setSnapshotsVersion] = useState(0);
  const [selectedTopics, setSelectedTopics] = useState<number[]>([]);
  const [expandedTopics, setExpandedTopics] = useState<number[]>([]);
  const monitorRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    try {
      window.localStorage.setItem(STEP_STORAGE_KEY, String(activeStep));
    } catch {
      /* 隐私模式忽略 */
    }
  }, [activeStep]);

  // 词库与问题集随改随存本机（按当前品牌键）。
  useEffect(() => { saveLibrary(brandKey, library); }, [brandKey, library]);
  useEffect(() => { saveQuestions(brandKey, questionItems); }, [brandKey, questionItems]);

  /** 品牌键切换（输入失焦/知识库载入时）：载入该品牌的词库与问题集。 */
  const applyBrandKey = (nextBrand: string) => {
    const key = nextBrand.trim();
    if (key === brandKey) return;
    setBrandKey(key);
    setLibrary(loadLibrary(key));
    setQuestionItems(loadQuestions(key));
  };

  /** 合并一批问题入问题集并给出人话提示（去重、上限截断都明说）。 */
  const mergeIntoQuestions = (incoming: GeoQuestionItem[], label: string) => {
    const result = mergeQuestionItems(questionItems, incoming, MAX_QUESTIONS);
    setQuestionItems(result.items);
    const parts = [`${label}：新增 ${result.added} 条`];
    if (result.duplicates) parts.push(`重复跳过 ${result.duplicates} 条`);
    if (result.dropped) parts.push(`已达上限 ${MAX_QUESTIONS} 条，丢弃 ${result.dropped} 条`);
    parts.push(`问题集共 ${result.items.length} 条`);
    setNotice(parts.join("，"));
    return result;
  };

  // 概览条数据：填了品牌按品牌读本机快照，未填时读全部快照（展示最近一次的品牌）。
  const overviewSnapshots = useMemo(() => {
    void snapshotsVersion; // 监测跑完后由 GeoMonitor 回调 bump，触发重读本机快照
    return brand.trim() ? loadSnapshotsFor(brand) : loadSnapshots();
  }, [brand, snapshotsVersion]);
  const overview = useMemo(() => overviewStats(overviewSnapshots), [overviewSnapshots]);

  const loadFromKnowledge = async () => {
    if (!knowledge.length) {
      setError("知识库还没有资料，先到「企业知识库」导入产品手册或价格体系。");
      return;
    }
    setBusy("load");
    setError("");
    try {
      // listKnowledgeDocs 不带正文，逐份取最新 3 篇（合计控制在 1 万字内，够体检用）。
      const picked = knowledge.slice(0, 3);
      const docs = await Promise.all(picked.map((doc) => getKnowledgeDoc(doc.id)));
      const parts = docs
        .filter((doc): doc is KnowledgeRow => Boolean(doc?.content))
        .map((doc) => `【${doc.title}】\n${doc.content!.slice(0, 4000)}`);
      if (!parts.length) throw new Error("读取资料正文失败，请打开单篇资料确认内容。");
      setMaterial(parts.join("\n\n").slice(0, 12000));
      setMaterialNote(`已载入 ${parts.length} 份知识库资料（${picked.map((doc) => doc.title).join("、")}）`);
      if (!brand) {
        const inferred = picked[0]?.title.slice(0, 16) ?? "";
        setBrand(inferred);
        applyBrandKey(inferred);
      }
      setNotice("资料已填入，点击「开始体检」。");
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy("");
    }
  };

  const runAudit = async () => {
    setBusy("audit");
    setError("");
    setNotice("");
    try {
      const result = await runGeoAudit({ brand, keywords, material });
      setAudit(result);
      setNotice(`体检完成：${result.score} 分`);
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy("");
    }
  };

  const runAssets = async (keywordsOverride?: string) => {
    setBusy("assets");
    setError("");
    setNotice("");
    try {
      const result = await generateGeoAssets({ brand, keywords: keywordsOverride ?? keywords, material });
      setAssets(result);
      setNotice(`素材已生成：${result.facts.length} 条事实卡 · ${result.faq.length} 组 FAQ`);
      if (!questionItems.some((item) => item.text.trim())) {
        setQuestionItems(defaultGeoQuestions(brand, keywords).map((text) => ({ text })));
      }
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy("");
    }
  };


  const runExpand = async () => {
    setBusy("expand");
    setError("");
    setNotice("");
    try {
      const seeds = parseSeedWords(seedText || keywords);
      const result = await expandKeywords({ brand, seedWords: seeds });
      setExpanded(result);
      setTopics([]);
      setNotice(`拓词完成：${result.keywords.length} 条长尾词${result.demo ? "（模板降级演示）" : ""}`);
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy("");
    }
  };

  const runTopics = async () => {
    if (!expanded?.keywords.length) { setError("请先拓词，再生成选题。"); return; }
    setBusy("topics");
    setError("");
    setNotice("");
    try {
      const result = await generateTopics({ brand, keywords: expanded.keywords });
      setTopics(result.topics);
      setTopicsDemo(result.demo);
      setSelectedTopics([]);
      setExpandedTopics([]);
      setNotice(`选题已生成：${result.topics.length} 条${result.demo ? "（模板降级演示）" : ""}`);
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy("");
    }
  };

  /** 把选题的目标问题批量合并入监测问题集（去重、遵守上限；第 28 批由覆盖改合并）。 */
  const topicsToQuestions = () => {
    const incoming = topics
      .filter((topic) => topic.targetQuestion.trim())
      .map((topic) => ({ text: topic.targetQuestion, intent: topic.intent }));
    if (!incoming.length) { setError("选题还没有目标问题，先生成选题。"); return; }
    setError("");
    mergeIntoQuestions(incoming, "选题目标问题导入");
  };

  /** 单条选题 → 生成素材：目标词带入素材生成，回到第 1 步看结果。 */
  const topicToAssets = (topic: GeoTopic) => {
    setKeywords(topic.keyword);
    setActiveStep(1);
    void runAssets(topic.keyword);
  };

  /** 单条选题 → 加入监测问题集：合并目标问题，去重、遵守上限。 */
  const topicToQuestion = (topic: GeoTopic) => {
    const question = topic.targetQuestion.trim();
    if (!question) { setError("这条选题还没有目标问题。"); return; }
    setError("");
    mergeIntoQuestions([{ text: question, intent: topic.intent }], "加入监测问题");
  };

  const toggleTopicSelected = (index: number) => {
    setSelectedTopics((prev) => (prev.includes(index) ? prev.filter((i) => i !== index) : [...prev, index]));
  };

  const toggleTopicExpanded = (index: number) => {
    setExpandedTopics((prev) => (prev.includes(index) ? prev.filter((i) => i !== index) : [...prev, index]));
  };

  const exportSelectedTopics = () => {
    const picked = topics.filter((_, index) => selectedTopics.includes(index));
    if (!picked.length) { setError("先勾选要导出的选题。"); return; }
    downloadMarkdown(
      `GEO选题-所选${picked.length}条-${new Date().toISOString().slice(0, 10)}.md`,
      topicsMarkdown({ brand, topics: picked, demo: topicsDemo }),
    );
    setNotice(`已导出所选 ${picked.length} 条选题`);
  };

  /** 概览条引导按钮：切到第 4 步并滚到监测区。 */
  const goToMonitor = () => {
    setActiveStep(4);
    window.setTimeout(() => monitorRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 60);
  };

  /** 把高优先级长尾词回填为目标搜索词，再走现有素材生成。 */
  const keywordsToAssets = () => {
    const high = (expanded?.keywords ?? []).filter((item) => item.priority === "高").slice(0, 5);
    if (!high.length) { setError("暂无高优先级词，先拓词。"); return; }
    setKeywords(high.map((item) => item.word).join(", "));
    setNotice("高优先级词已回填为目标搜索词，点「生成 GEO 素材」继续");
  };

  /* ---------- 第 28 批：词库管理 ---------- */

  /** 把本次拓词结果存入词库（去重合并，重复词保留较高优先级）。 */
  const saveExpandedToLibrary = () => {
    if (!expanded?.keywords.length) { setError("先拓词，再存入词库。"); return; }
    const seeds = parseSeedWords(seedText || keywords);
    const seed = seeds.length === 1 ? seeds[0] : undefined;
    const incoming = expanded.keywords.flatMap((item) => {
      const entry = toLibraryEntry(item, "expand", seed);
      return entry ? [entry] : [];
    });
    const result = mergeKeywords(library, incoming);
    setLibrary(result.entries);
    setError("");
    const parts = [`已存入词库：新增 ${result.added} 条`];
    if (result.merged) parts.push(`重复合并 ${result.merged} 条`);
    if (result.dropped) parts.push(`词库已满，丢弃 ${result.dropped} 条`);
    parts.push(`词库共 ${result.entries.length} 条`);
    setNotice(parts.join("，"));
  };

  /** 手动加词入词库。 */
  const addManualKeyword = () => {
    const entry = toLibraryEntry({ word: manualWord, intent: manualIntent, priority: manualPriority }, "manual");
    if (!entry) { setError("请先填写要加入词库的词。"); return; }
    const result = mergeKeywords(library, [entry]);
    setLibrary(result.entries);
    setManualWord("");
    setError("");
    setNotice(result.added ? `已加入词库：${entry.word}（共 ${result.entries.length} 条）` : `「${entry.word}」已在词库中，已合并`);
  };

  /** 词库单条 → 转监测问题（问法与选题目标问题同口径，带意图标签）。 */
  const libraryKeywordToQuestion = (entry: KeywordLibraryEntry) => {
    setError("");
    mergeIntoQuestions(toQuestions([entry]), "词库转监测问题");
  };

  /** 词库单条 → 生成选题（复用选题逻辑，追加进选题列表并去重）。 */
  const runTopicForKeyword = async (entry: KeywordLibraryEntry) => {
    setBusy("topic-one");
    setError("");
    setNotice("");
    try {
      const result = await generateTopics({ brand, keywords: [entry] });
      setTopics((prev) => {
        const seen = new Set(prev.map((topic) => topic.keyword));
        return [...prev, ...result.topics.filter((topic) => !seen.has(topic.keyword))];
      });
      if (result.demo) setTopicsDemo(true);
      setNotice(`选题已生成：${entry.word}${result.demo ? "（模板降级演示）" : ""}`);
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy("");
    }
  };

  const clearLibrary = () => {
    if (!library.length) return;
    if (!window.confirm(`确定清空当前品牌的词库（共 ${library.length} 条）？此操作不可恢复。`)) return;
    setLibrary([]);
    setNotice("词库已清空");
  };

  /* ---------- 第 28 批：问题集逐条编辑 ---------- */

  const updateQuestion = (index: number, patch: Partial<GeoQuestionItem>) => {
    setQuestionItems((prev) => prev.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  };

  const removeQuestionRow = (index: number) => {
    setQuestionItems((prev) => prev.filter((_, i) => i !== index));
  };

  const addQuestionRow = () => {
    if (questionItems.length >= MAX_QUESTIONS) {
      setError(`监测问题集已满（最多 ${MAX_QUESTIONS} 条），先删一条再加。`);
      return;
    }
    setError("");
    setQuestionItems((prev) => [...prev, { text: "" }]);
  };

  /** 批量粘贴导入：拆条后合并去重。 */
  const applyPaste = () => {
    const lines = parsePastedQuestions(pasteText);
    if (!lines.length) { setError("请先粘贴问题（每行一条）。"); return; }
    setError("");
    mergeIntoQuestions(lines.map((text) => ({ text })), "批量粘贴导入");
    setPasteText("");
  };

  /** 从词库高优先级词一键导入监测问题。 */
  const importHighKeywords = () => {
    const high = library.filter((entry) => entry.priority === "高");
    if (!high.length) { setError("词库里还没有高优先级词，先拓词并存入词库。"); return; }
    setError("");
    mergeIntoQuestions(toQuestions(high), "词库高优先级词导入");
  };

  /** 填入默认问法：第 28 批改为合并去重（原为覆盖）。 */
  const fillDefaultQuestions = () => {
    setError("");
    mergeIntoQuestions(defaultGeoQuestions(brand, keywords).map((text) => ({ text })), "默认问法");
  };

  const runMentionTest = async () => {
    setBusy("test");
    setError("");
    setNotice("");
    try {
      const results = await testBrandMention({ brand, questions: questionList });
      setMentionTests(results);
      const hit = results.filter((item) => item.mentioned).length;
      setNotice(`提及测试完成：${hit}/${results.length} 条命中`);
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy("");
    }
  };

  const exportAll = () => {
    downloadMarkdown(
      `GEO工作台-${new Date().toISOString().slice(0, 10)}.md`,
      geoMarkdown({ brand, audit, assets, tests: null }),
    );
    setNotice("已导出 Markdown（体检 + 素材）");
  };

  const questionList = questionItems.map((item) => item.text.trim()).filter(Boolean);
  const libStats = libraryStats(library);

  const stepStatus = geoStepStatus({
    hasAudit: audit !== null,
    hasKeywordsOrTopics: Boolean(expanded?.keywords.length) || topics.length > 0 || library.length > 0,
    questionCount: questionList.length,
    snapshotCount: overviewSnapshots.length,
  });

  return (
    <section className="geo-layout">
      {/* 第 27 批：顶部数据概览条（常驻，先看数据再填表） */}
      <div className="console-card geo-overview">
        {overview ? (
          <>
            <div className="geo-ov-item">
              <small>最新提及率</small>
              <strong>{pct(overview.mentionRate)}</strong>
              <DeltaMark delta={overview.mentionDelta} />
            </div>
            <div className="geo-ov-item">
              <small>首位率</small>
              <strong>{pct(overview.firstPosRate)}</strong>
              <DeltaMark delta={overview.firstPosDelta} />
            </div>
            {overview.competitorRank !== null && (
              <div className="geo-ov-item">
                <small>竞品名次</small>
                <strong>第 {overview.competitorRank} 名</strong>
                <span className="geo-ov-sub">共 {overview.competitorCount + 1} 个品牌</span>
              </div>
            )}
            <div className="geo-ov-item">
              <small>被引用信源</small>
              <strong>{overview.sourceCount} 个</strong>
              <span className="geo-ov-sub">最新一次监测</span>
            </div>
            <div className="geo-ov-item">
              <small>最近监测</small>
              <strong className="geo-ov-time">{formatOverviewTime(overview.latestAt)}</strong>
              <span className="geo-ov-sub">{overview.brand} · 共 {overview.runs} 次</span>
            </div>
          </>
        ) : (
          <div className="geo-ov-empty">
            <span>还没有监测数据。先完成资料体检与问题集，跑一次监测建立基线，这里会显示提及率、首位率与竞品名次。</span>
            <button type="button" className="button button-primary" onClick={goToMonitor}>先跑一次监测建立基线</button>
          </div>
        )}
      </div>

      {/* 第 27 批：分步导航（一次只显一张卡，概览条常驻） */}
      <div className="geo-steps" role="tablist" aria-label="GEO 工作步骤">
        {GEO_STEPS.map((label, index) => {
          const step = index + 1;
          const done = stepStatus[index];
          return (
            <button
              type="button"
              key={label}
              role="tab"
              aria-selected={activeStep === step}
              className={`geo-step${activeStep === step ? " active" : ""}${done ? " done" : ""}`}
              onClick={() => setActiveStep(step)}
            >
              <span className="geo-step-no">{done ? <Check size={13} /> : step}</span>
              {label}
            </button>
          );
        })}
      </div>

      {error && <p className="geo-error geo-global-msg">{error}</p>}
      {notice && <p className="geo-notice geo-global-msg">{notice}</p>}

      <div className="geo-step-panel" hidden={activeStep !== 1}>
      <div className="console-card geo-inputs">
        <div className="console-card-header">
          <div>
            <h2><Globe2 size={16} /> GEO 内容工作台</h2>
            <p>让 DeepSeek、豆包、Kimi 在回答用户问题时，主动提及并推荐你的企业：体检 → 生成可引用素材 → 提及率复测。</p>
          </div>
          <button type="button" className="button button-secondary" onClick={exportAll} disabled={!audit && !assets}>
            <Download size={15} />导出
          </button>
        </div>

        <div className="geo-form">
          <label>
            品牌 / 企业名称
            <input value={brand} onChange={(event) => setBrand(event.target.value)} onBlur={() => applyBrandKey(brand)} placeholder="例如：山野茶饮" />
          </label>
          <label>
            目标搜索词（逗号分隔）
            <input value={keywords} onChange={(event) => setKeywords(event.target.value)} placeholder="例如：现煮茶饮, 杭州下午茶" />
          </label>
          <label className="geo-material">
            企业资料（可直接粘贴，或从知识库载入）
            <textarea
              value={material}
              onChange={(event) => setMaterial(event.target.value)}
              rows={7}
              placeholder="产品、价格、案例、服务流程……资料越具体，体检与素材越准。"
            />
            <span className="geo-material-foot">
              <small>{materialNote || `已输入 ${material.length} 字`}</small>
              <button type="button" className="text-link" onClick={() => void loadFromKnowledge()} disabled={busy !== ""}>
                {busy === "load" ? <LoaderCircle size={13} className="spin" /> : <FileText size={13} />}从知识库载入最新 3 份
              </button>
            </span>
          </label>
          <div className="geo-actions">
            <button type="button" className="button button-primary" onClick={() => void runAudit()} disabled={busy !== ""}>
              {busy === "audit" ? <LoaderCircle size={15} className="spin" /> : <Radar size={15} />}开始体检
            </button>
            <button type="button" className="button button-secondary" onClick={() => void runAssets()} disabled={busy !== ""}>
              {busy === "assets" ? <LoaderCircle size={15} className="spin" /> : <Sparkles size={15} />}生成 GEO 素材
            </button>
          </div>
        </div>
      </div>

      {audit && (
        <div className="console-card geo-audit">
          <div className="console-card-header">
            <div><h2>AI 可发现性体检</h2><p>{audit.summary}</p></div>
            <strong className={`geo-score ${audit.score >= 80 ? "good" : audit.score >= 60 ? "mid" : "low"}`}>{audit.score}</strong>
          </div>
          <div className="geo-dimensions">
            {audit.dimensions.map((item) => (
              <div className="geo-dimension" key={item.key}>
                <span><strong>{item.label}</strong><b>{item.score}</b></span>
                <i><em style={{ width: `${Math.max(4, item.score)}%` }} /></i>
                <small>{item.note}</small>
              </div>
            ))}
          </div>
          {audit.issues.length > 0 && (
            <div className="geo-issues">
              <h3>问题清单</h3>
              {audit.issues.map((item, index) => (
                <div className={`geo-issue sev-${item.severity === "高" ? "high" : item.severity === "低" ? "low" : "mid"}`} key={`${item.title}-${index}`}>
                  <em>{item.severity}</em>
                  <span><strong>{item.title}</strong><small>{item.detail}</small></span>
                </div>
              ))}
            </div>
          )}
          {audit.quickWins.length > 0 && (
            <div className="geo-quickwins">
              <h3>快赢动作</h3>
              <ol>{audit.quickWins.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}</ol>
            </div>
          )}
        </div>
      )}

      {assets && (
        <div className="console-card geo-assets">
          <div className="console-card-header">
            <div><h2><Sparkles size={15} /> 可引用素材</h2><p>{assets.summary}</p></div>
            <button
              type="button"
              className="text-link"
              onClick={() => {
                const text = [
                  ...assets.facts.map((item) => `- ${item}`),
                  "",
                  ...assets.faq.flatMap((item) => [`**${item.q}**`, item.a, ""]),
                ].join("\n");
                void copyText(text).then((ok) => setNotice(ok ? "素材已复制到剪贴板" : "复制失败，请手动选择"));
              }}
            >
              <ClipboardCopy size={14} />一键复制
            </button>
          </div>

          <div className="geo-facts">
            <h3>品牌事实卡</h3>
            <div>{assets.facts.map((item, index) => <span key={`${item}-${index}`}>{item}</span>)}</div>
          </div>

          <div className="geo-faq">
            <h3>FAQ（AI 可整段引用）</h3>
            {assets.faq.map((item, index) => (
              <div className="geo-faq-item" key={`${item.q}-${index}`}>
                <strong><Target size={13} />{item.q}</strong>
                <p>{item.a}</p>
              </div>
            ))}
          </div>

          {assets.bullets.length > 0 && (
            <div className="geo-bullets">
              <h3>补全语料的问题清单</h3>
              <div>{assets.bullets.map((item, index) => <span key={`${item}-${index}`}>{item}</span>)}</div>
            </div>
          )}
        </div>
      )}
      </div>

      <div className="geo-step-panel" hidden={activeStep !== 2}>
      <div className="console-card geo-keywords-card">
        <div className="console-card-header">
          <div>
            <h2><Target size={15} /> 拓词与选题</h2>
            <p>种子词 → 长尾词（按咨询/选型/对比/教程/避坑分组）→ 选题大纲。借鉴抓词 GEO 的生产侧打法：先摸清「用户会问什么」，再决定写什么。</p>
          </div>
          <button
            type="button"
            className="button button-secondary"
            onClick={() => downloadMarkdown(`GEO选题-${new Date().toISOString().slice(0, 10)}.md`, topicsMarkdown({ brand, topics, demo: topicsDemo }))}
            disabled={!topics.length}
          >
            <Download size={14} />导出选题
          </button>
        </div>
        <label className="geo-questions">
          种子词（逗号分隔，留空则用上方目标搜索词）
          <input value={seedText} onChange={(event) => setSeedText(event.target.value)} placeholder="例如：现煮茶饮, 下午茶" />
        </label>
        <div className="geo-actions">
          <button type="button" className="button button-primary" onClick={() => void runExpand()} disabled={busy !== ""}>
            {busy === "expand" ? <LoaderCircle size={15} className="spin" /> : <Sparkles size={15} />}拓词
          </button>
          <button type="button" className="button button-secondary" onClick={() => void runTopics()} disabled={busy !== "" || !expanded?.keywords.length}>
            {busy === "topics" ? <LoaderCircle size={15} className="spin" /> : <FileText size={15} />}生成选题
          </button>
          <button type="button" className="text-link" onClick={keywordsToAssets} disabled={!expanded?.keywords.length}>
            高优先级词回填素材生成
          </button>
          <button type="button" className="text-link" onClick={() => { window.location.hash = `#/console/${navToSlug("内容工厂")}`; }}>
            去内容工厂生产
          </button>
        </div>
        {expanded && (
          <div className="geo-keyword-groups">
            {groupStats(expanded.groups).map((stat) => {
              const group = expanded.groups.find((item) => item.intent === stat.intent);
              if (!group?.keywords.length) return null;
              return (
                <div className="geo-keyword-group" key={stat.intent}>
                  <h3>{stat.intent}（{stat.count} 条{stat.high ? ` · 高优先级 ${stat.high}` : ""}）</h3>
                  <div>
                    {group.keywords.map((item) => (
                      <span key={item.word} className={item.priority === "高" ? "geo-kw high" : "geo-kw"}>{item.word}</span>
                    ))}
                  </div>
                </div>
              );
            })}
            {expanded.demo && <p className="geo-hint">本次为模板降级演示（模型不可用），词表仅作占位，请人工校准。</p>}
            <div className="geo-actions">
              <button type="button" className="button button-secondary" onClick={saveExpandedToLibrary}>
                <BookMarked size={15} />存入词库（{expanded.keywords.length} 条）
              </button>
            </div>
          </div>
        )}
        {topics.length > 0 && (
          <div className="geo-topics">
            <div className="geo-topics-head">
              <h3>选题大纲（{topics.length} 条{topicsDemo ? " · 模板降级演示" : ""}）</h3>
              <div className="geo-topics-tools">
                <label className="geo-topic-all">
                  <input
                    type="checkbox"
                    checked={selectedTopics.length === topics.length && topics.length > 0}
                    onChange={(event) => setSelectedTopics(event.target.checked ? topics.map((_, i) => i) : [])}
                  />
                  全选
                </label>
                <button type="button" className="text-link" onClick={exportSelectedTopics} disabled={!selectedTopics.length}>
                  导出所选{selectedTopics.length ? `（${selectedTopics.length}）` : ""}
                </button>
                <button type="button" className="text-link" onClick={topicsToQuestions}>目标问题填入监测问题集</button>
              </div>
            </div>
            <ul className="geo-topic-list">
              {topics.map((topic, index) => {
                const open = expandedTopics.includes(index);
                return (
                  <li className="geo-topic-row" key={`${topic.title}-${index}`}>
                    <div className="geo-topic-main">
                      <input
                        type="checkbox"
                        aria-label={`勾选选题 ${topic.title}`}
                        checked={selectedTopics.includes(index)}
                        onChange={() => toggleTopicSelected(index)}
                      />
                      <span className="geo-topic-no">{index + 1}</span>
                      <span className="geo-topic-text">
                        <strong>{topic.title}</strong>
                        <small>目标问题：{topic.targetQuestion || "—"}</small>
                      </span>
                      <em className="geo-topic-intent">{topic.intent}</em>
                      <button
                        type="button"
                        className="text-link geo-topic-toggle"
                        aria-expanded={open}
                        onClick={() => toggleTopicExpanded(index)}
                      >
                        大纲<ChevronDown size={13} className={open ? "geo-chevron open" : "geo-chevron"} />
                      </button>
                    </div>
                    {open && (
                      <ul className="geo-topic-sections">
                        {topic.sections.map((section) => <li key={section}>{section}</li>)}
                      </ul>
                    )}
                    <div className="geo-topic-actions">
                      <button type="button" className="text-link" onClick={() => topicToAssets(topic)} disabled={busy !== ""}>
                        生成素材
                      </button>
                      <button
                        type="button"
                        className="text-link"
                        onClick={() => { window.location.hash = `#/console/${navToSlug("内容工厂")}`; }}
                      >
                        去内容工厂
                      </button>
                      <button type="button" className="text-link" onClick={() => topicToQuestion(topic)}>
                        加入监测问题
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {/* 第 28 批：词库（可管理资产，按品牌存本机） */}
        <div className="geo-library">
          <div className="geo-library-head">
            <button
              type="button"
              className="text-link geo-library-toggle"
              aria-expanded={libraryOpen}
              onClick={() => setLibraryOpen((open) => !open)}
            >
              <BookMarked size={14} />
              词库（{libStats.total} 条{libStats.high ? ` · 高优先级 ${libStats.high}` : ""}）
              <ChevronDown size={13} className={libraryOpen ? "geo-chevron open" : "geo-chevron"} />
            </button>
            <button type="button" className="text-link" onClick={clearLibrary} disabled={!library.length}>
              清空词库
            </button>
          </div>
          {libraryOpen && (
            <>
              <div className="geo-library-add">
                <input
                  value={manualWord}
                  onChange={(event) => setManualWord(event.target.value)}
                  placeholder="手动加词，例如：茶饮加盟费用"
                  aria-label="手动加词"
                />
                <select
                  value={manualIntent}
                  onChange={(event) => setManualIntent(event.target.value as GeoKeywordIntent)}
                  aria-label="意图"
                >
                  {GEO_KEYWORD_INTENTS.map((intent) => <option key={intent} value={intent}>{intent}</option>)}
                </select>
                <select
                  value={manualPriority}
                  onChange={(event) => setManualPriority(event.target.value as GeoKeywordPriority)}
                  aria-label="优先级"
                >
                  {(["高", "中", "低"] as GeoKeywordPriority[]).map((p) => <option key={p} value={p}>{p}优先级</option>)}
                </select>
                <button type="button" className="button button-secondary" onClick={addManualKeyword}>
                  <Plus size={14} />加入词库
                </button>
              </div>
              {library.length === 0 ? (
                <p className="geo-hint">词库还是空的。拓词后点「存入词库」，或在上方手动加词；词库按品牌存在本机浏览器，换品牌自动切换。</p>
              ) : (
                GEO_KEYWORD_INTENTS.map((intent) => {
                  const rows = library.filter((entry) => entry.intent === intent);
                  if (!rows.length) return null;
                  return (
                    <div className="geo-library-group" key={intent}>
                      <h3>{intent}（{rows.length} 条）</h3>
                      <ul className="geo-library-list">
                        {rows.map((entry) => (
                          <li className="geo-library-row" key={entry.word}>
                            <span className="geo-library-word">
                              <strong>{entry.word}</strong>
                              <small>{entry.source === "manual" ? "手动" : "拓词"}{entry.seed ? ` · 种子词 ${entry.seed}` : ""}</small>
                            </span>
                            <select
                              value={entry.priority}
                              onChange={(event) => setLibrary((prev) => setPriority(prev, entry.word, event.target.value as GeoKeywordPriority))}
                              aria-label={`${entry.word} 优先级`}
                            >
                              {(["高", "中", "低"] as GeoKeywordPriority[]).map((p) => <option key={p} value={p}>{p}优先级</option>)}
                            </select>
                            <span className="geo-library-actions">
                              <button type="button" className="text-link" onClick={() => libraryKeywordToQuestion(entry)}>
                                转监测问题
                              </button>
                              <button type="button" className="text-link" onClick={() => void runTopicForKeyword(entry)} disabled={busy !== ""}>
                                {busy === "topic-one" ? <LoaderCircle size={13} className="spin" /> : null}生成选题
                              </button>
                              <button
                                type="button"
                                className="text-link geo-library-del"
                                aria-label={`删除词条 ${entry.word}`}
                                onClick={() => setLibrary((prev) => removeKeyword(prev, entry.word))}
                              >
                                <Trash2 size={13} />删除
                              </button>
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  );
                })
              )}
            </>
          )}
        </div>
      </div>
      </div>

      <div className="geo-step-panel" hidden={activeStep !== 3}>
      <div className="console-card geo-questions-card">
        <div className="console-card-header">
          <div>
            <h2><TestTube2 size={15} /> 监测问题集</h2>
            <p>连续监测必须用<b>同一组问题</b>，否则前后不可比。生成素材后会自动填入 5 条默认问法。问题集按品牌存在本机浏览器，打开页面自动恢复。</p>
          </div>
          <button
            type="button"
            className="button button-secondary"
            onClick={fillDefaultQuestions}
          >
            <Sparkles size={14} />填入默认问法
          </button>
        </div>
        <div className="geo-q-tools">
          <button type="button" className="text-link" onClick={importHighKeywords}>
            从词库高优先级词导入
          </button>
          <button type="button" className="text-link" onClick={topicsToQuestions}>
            从选题目标问题导入
          </button>
        </div>
        {questionItems.length === 0 ? (
          <p className="geo-hint">还没有监测问题。点「填入默认问法」、从词库/选题导入，或在下方添加一条。</p>
        ) : (
          <ul className="geo-q-list">
            {questionItems.map((item, index) => (
              <li className="geo-q-row" key={index}>
                <span className="geo-q-no">{index + 1}</span>
                <input
                  value={item.text}
                  onChange={(event) => updateQuestion(index, { text: event.target.value })}
                  placeholder="例如：现煮茶饮哪家比较靠谱？"
                  aria-label={`第 ${index + 1} 条监测问题`}
                />
                <select
                  value={item.intent ?? ""}
                  onChange={(event) => updateQuestion(index, { intent: (event.target.value || undefined) as GeoKeywordIntent | undefined })}
                  aria-label={`第 ${index + 1} 条问题意图`}
                >
                  <option value="">无意图</option>
                  {GEO_KEYWORD_INTENTS.map((intent) => <option key={intent} value={intent}>{intent}</option>)}
                </select>
                <button
                  type="button"
                  className="text-link geo-q-del"
                  aria-label={`删除第 ${index + 1} 条问题`}
                  onClick={() => removeQuestionRow(index)}
                >
                  <Trash2 size={13} />删除
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="geo-actions">
          <button type="button" className="button button-secondary" onClick={addQuestionRow} disabled={questionItems.length >= MAX_QUESTIONS}>
            <Plus size={14} />添加一条
          </button>
        </div>
        <details className="geo-q-paste">
          <summary>批量粘贴导入（每行一条，自动拆条去重）</summary>
          <textarea
            value={pasteText}
            onChange={(event) => setPasteText(event.target.value)}
            rows={4}
            placeholder={"现煮茶饮哪家比较靠谱？\n杭州下午茶多少钱？"}
            aria-label="批量粘贴问题"
          />
          <div className="geo-actions">
            <button type="button" className="button button-secondary" onClick={applyPaste}>导入粘贴的问题</button>
          </div>
        </details>
        <small className="geo-hint">
          共 {questionList.length} 条（上限 {MAX_QUESTIONS} 条）。监测逐条串行调用模型，问题越多耗时越长、配额消耗越大，建议 10-20 条。
        </small>
        <div className="geo-actions">
          <button type="button" className="button button-secondary" onClick={() => void runMentionTest()} disabled={busy !== ""}>
            {busy === "test" ? <LoaderCircle size={15} className="spin" /> : <TestTube2 size={15} />}快速提及测试（含来源）
          </button>
        </div>
        {mentionTests.length > 0 && (
          <div className="geo-mention-results">
            {mentionTests.map((item, index) => (
              <div className="geo-mention-item" key={`${item.question}-${index}`}>
                <strong>{item.mentioned ? "✅" : "❌"} {item.question}</strong>
                <p>{item.answer}</p>
                <small>来源：{item.sources?.length ? item.sources.join("、") : "模型未给出处"}</small>
              </div>
            ))}
          </div>
        )}
      </div>
      </div>

      <div className="geo-step-panel" hidden={activeStep !== 4} ref={monitorRef}>
        <GeoMonitor
          brand={brand}
          questions={questionList}
          onSnapshot={() => setSnapshotsVersion((v) => v + 1)}
        />
      </div>
    </section>
  );
}
