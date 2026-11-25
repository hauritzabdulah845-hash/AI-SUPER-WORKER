import { useState } from "react";
import {
  ClipboardCopy,
  Download,
  FileText,
  Globe2,
  LoaderCircle,
  Radar,
  Sparkles,
  Target,
  TestTube2,
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
  type GeoExpandResult,
  type GeoTopic,
} from "../cloud/geokeywords";
import { navToSlug } from "../nav";
import { getKnowledgeDoc, type KnowledgeRow } from "../cloud/api";
import { GeoMonitor } from "./GeoMonitor";
import { MAX_QUESTIONS } from "../cloud/geomonitor";

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
  const [questionsText, setQuestionsText] = useState("");
  const [busy, setBusy] = useState<"" | "load" | "audit" | "assets" | "test" | "expand" | "topics">("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [audit, setAudit] = useState<GeoAuditResult | null>(null);
  const [assets, setAssets] = useState<GeoAssetBundle | null>(null);
  const [seedText, setSeedText] = useState("");
  const [expanded, setExpanded] = useState<GeoExpandResult | null>(null);
  const [topics, setTopics] = useState<GeoTopic[]>([]);
  const [topicsDemo, setTopicsDemo] = useState(false);
  const [mentionTests, setMentionTests] = useState<GeoMentionTest[]>([]);

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
      if (!brand) setBrand(picked[0]?.title.slice(0, 16) ?? "");
      setNotice("资料已填入，点击「开始体检」。");
    } catch (err) {
      setError(err instanceof Error ? err.message : "资料载入失败");
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
      setError(err instanceof Error ? err.message : "体检失败");
    } finally {
      setBusy("");
    }
  };

  const runAssets = async () => {
    setBusy("assets");
    setError("");
    setNotice("");
    try {
      const result = await generateGeoAssets({ brand, keywords, material });
      setAssets(result);
      setNotice(`素材已生成：${result.facts.length} 条事实卡 · ${result.faq.length} 组 FAQ`);
      if (!questionsText) setQuestionsText(defaultGeoQuestions(brand, keywords).join("\n"));
    } catch (err) {
      setError(err instanceof Error ? err.message : "素材生成失败");
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
      setError(err instanceof Error ? err.message : "拓词失败");
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
      setNotice(`选题已生成：${result.topics.length} 条${result.demo ? "（模板降级演示）" : ""}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "选题生成失败");
    } finally {
      setBusy("");
    }
  };

  /** 把选题的目标问题一键填入监测问题集（选题→监测闭环）。 */
  const topicsToQuestions = () => {
    const lines = topics.map((topic) => topic.targetQuestion).filter(Boolean);
    if (!lines.length) { setError("选题还没有目标问题，先生成选题。"); return; }
    setQuestionsText(lines.join("\n"));
    setNotice(`已把 ${lines.length} 条选题目标问题填入监测问题集`);
  };

  /** 把高优先级长尾词回填为目标搜索词，再走现有素材生成。 */
  const keywordsToAssets = () => {
    const high = (expanded?.keywords ?? []).filter((item) => item.priority === "高").slice(0, 5);
    if (!high.length) { setError("暂无高优先级词，先拓词。"); return; }
    setKeywords(high.map((item) => item.word).join(", "));
    setNotice("高优先级词已回填为目标搜索词，点「生成 GEO 素材」继续");
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
      setError(err instanceof Error ? err.message : "提及测试失败");
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

  const questionList = questionsText.split("\n").map((item) => item.trim()).filter(Boolean);

  return (
    <section className="geo-layout">
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
            <input value={brand} onChange={(event) => setBrand(event.target.value)} placeholder="例如：山野茶饮" />
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
          {error && <p className="geo-error">{error}</p>}
          {notice && <p className="geo-notice">{notice}</p>}
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
          </div>
        )}
        {topics.length > 0 && (
          <div className="geo-topics">
            <div className="geo-topics-head">
              <h3>选题大纲（{topics.length} 条{topicsDemo ? " · 模板降级演示" : ""}）</h3>
              <button type="button" className="text-link" onClick={topicsToQuestions}>目标问题填入监测问题集</button>
            </div>
            {topics.map((topic, index) => (
              <div className="geo-topic-item" key={`${topic.title}-${index}`}>
                <strong>{index + 1}. {topic.title}</strong>
                <small>目标问题：{topic.targetQuestion || "—"}</small>
                <ul>{topic.sections.map((section) => <li key={section}>{section}</li>)}</ul>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="console-card geo-questions-card">
        <div className="console-card-header">
          <div>
            <h2><TestTube2 size={15} /> 监测问题集</h2>
            <p>连续监测必须用<b>同一组问题</b>，否则前后不可比。生成素材后会自动填入 5 条默认问法。</p>
          </div>
          <button
            type="button"
            className="button button-secondary"
            onClick={() => setQuestionsText(defaultGeoQuestions(brand, keywords).join("\n"))}
          >
            <Sparkles size={14} />填入默认问法
          </button>
        </div>
        <label className="geo-questions">
          测试问题（每行一条，最多 {MAX_QUESTIONS} 条）
          <textarea
            value={questionsText}
            onChange={(event) => setQuestionsText(event.target.value)}
            rows={5}
            placeholder="例如：现煮茶饮哪家比较靠谱？"
          />
        </label>
        <small className="geo-hint">
          共 {questionList.length} 条{questionList.length > MAX_QUESTIONS ? `（本次只用前 ${MAX_QUESTIONS} 条）` : ""}
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

      <GeoMonitor brand={brand} questions={questionList} />
    </section>
  );
}
