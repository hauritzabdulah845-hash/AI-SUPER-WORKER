import { useState } from "react";
import {
  ArrowUpRight,
  CheckCircle2,
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
import { getKnowledgeDoc, type KnowledgeRow } from "../cloud/api";

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
  const [busy, setBusy] = useState<"" | "load" | "audit" | "assets" | "test">("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [audit, setAudit] = useState<GeoAuditResult | null>(null);
  const [assets, setAssets] = useState<GeoAssetBundle | null>(null);
  const [tests, setTests] = useState<GeoMentionTest[] | null>(null);

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

  const runTests = async () => {
    setBusy("test");
    setError("");
    setNotice("");
    try {
      const questions = questionsText.split("\n").map((item) => item.trim()).filter(Boolean);
      const result = await testBrandMention({ brand, questions });
      setTests(result);
      const hit = result.filter((item) => item.mentioned).length;
      setNotice(`提及率测试完成：${hit}/${result.length}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "测试失败");
    } finally {
      setBusy("");
    }
  };

  const exportAll = () => {
    downloadMarkdown(
      `GEO工作台-${new Date().toISOString().slice(0, 10)}.md`,
      geoMarkdown({ brand, audit, assets, tests }),
    );
    setNotice("已导出 Markdown（体检 + 素材 + 提及率）");
  };

  const hitCount = tests ? tests.filter((item) => item.mentioned).length : 0;

  return (
    <section className="geo-layout">
      <div className="console-card geo-inputs">
        <div className="console-card-header">
          <div>
            <h2><Globe2 size={16} /> GEO 内容工作台</h2>
            <p>让 DeepSeek、豆包、Kimi 在回答用户问题时，主动提及并推荐你的企业：体检 → 生成可引用素材 → 提及率复测。</p>
          </div>
          <button type="button" className="button button-secondary" onClick={exportAll} disabled={!audit && !assets && !tests}>
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

      <div className="console-card geo-tests">
        <div className="console-card-header">
          <div>
            <h2><TestTube2 size={15} /> 提及率复测</h2>
            <p>用真实问法问模型，看它会不会主动提到你。修完素材再跑一次，就是可对比的基线。</p>
          </div>
          {tests && <strong className={`geo-rate ${hitCount === tests.length ? "good" : hitCount === 0 ? "low" : "mid"}`}>{hitCount}/{tests.length}</strong>}
        </div>
        <label className="geo-questions">
          测试问题（每行一条）
          <textarea value={questionsText} onChange={(event) => setQuestionsText(event.target.value)} rows={5} placeholder="生成素材后会自动填入 5 条默认问法，可自行增删。" />
        </label>
        <div className="geo-actions">
          <button type="button" className="button button-primary" onClick={() => void runTests()} disabled={busy !== ""}>
            {busy === "test" ? <LoaderCircle size={15} className="spin" /> : <TestTube2 size={15} />}跑提及率测试
          </button>
          {!tests && <small className="geo-hint">提示：平台通道有配额时，请到「模型接入」切换自定义通道再测。</small>}
        </div>
        {tests && (
          <div className="geo-test-list">
            {tests.map((item, index) => (
              <div className={`geo-test ${item.mentioned ? "hit" : "miss"}`} key={`${item.question}-${index}`}>
                <div>
                  {item.mentioned ? <CheckCircle2 size={15} /> : <Target size={15} />}
                  <strong>{item.question}</strong>
                  <em>{item.mentioned ? "已提及" : "未提及"}</em>
                </div>
                <p>{item.answer}</p>
              </div>
            ))}
            <p className="geo-hint">
              提及率 {hitCount}/{tests.length}。未提及时：把「品牌事实卡」补进官网/知识库，再用
              <ArrowUpRight size={12} /> 同样问题复测。
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
