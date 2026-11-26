import { friendlyError } from "./cloud/friendlyError";
import { useCallback, useEffect, useState } from "react";
import {
  Activity,
  ArrowRight,
  ArrowUpRight,
  BarChart3,
  BookOpen,
  Bot,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleDot,
  Clock3,
  FileCheck2,
  FileText,
  Image,
  LoaderCircle,
  Menu,
  MessageSquareText,
  Phone,
  Play,
  Send,
  ShieldCheck,
  Sparkles,
  Target,
  Users,
  X,
  Zap,
} from "lucide-react";
import CommandDemo from "./components/CommandDemo";
import Console from "./components/Console";
import LoginPanel from "./components/LoginPanel";
import { cloud, getSessionUser, type SessionUser } from "./cloud/client";
import { insertLead } from "./cloud/api";
import { navToSlug } from "./nav";
import "./App.css";

const workflowItems = [
  {
    id: "content",
    number: "01",
    title: "内容生产",
    subtitle: "从灵感到多平台内容矩阵",
    icon: FileText,
    color: "violet",
    description: "基于品牌知识与业务目标，自动完成选题、文案、图像、视频与发布排期，让内容不再依赖单点人力。",
    outputs: ["7 天选题与内容日历", "多平台适配文案", "图文与短视频素材"],
  },
  {
    id: "growth",
    number: "02",
    title: "全域获客",
    subtitle: "从流量曝光到高意向线索",
    icon: Target,
    color: "orange",
    description: "连接经授权的媒体与渠道，识别互动意图、归集客户来源，让每条线索都带着上下文进入下一步。",
    outputs: ["渠道获客计划", "高意向线索识别", "客户画像与来源归因"],
  },
  {
    id: "sales",
    number: "03",
    title: "私域转化",
    subtitle: "从首次咨询到持续复购",
    icon: MessageSquareText,
    color: "green",
    description: "销售智能体结合客户历史与企业知识，完成咨询响应、客户分层、个性化回访，并在关键时刻转交人工。",
    outputs: ["个性化沟通建议", "客户分层与回访 SOP", "人工接管与审批提醒"],
  },
  {
    id: "insight",
    number: "04",
    title: "经营复盘",
    subtitle: "从结果数据到下一轮增长",
    icon: BarChart3,
    color: "blue",
    description: "自动汇总内容、渠道、客户与成交数据，定位转化断点，生成可执行的优化建议，形成自我迭代闭环。",
    outputs: ["全链路经营看板", "转化断点诊断", "下一轮行动建议"],
  },
];

const agentItems = [
  { name: "内容创作官", role: "品牌创意与内容", icon: Image, color: "violet" },
  { name: "获客增长官", role: "全域线索拓展", icon: Target, color: "orange" },
  { name: "私域销售官", role: "客户经营与跟进", icon: Users, color: "green" },
  { name: "企业知识官", role: "企业知识与流程", icon: BookOpen, color: "blue" },
  { name: "数据分析官", role: "经营分析与复盘", icon: BarChart3, color: "pink" },
];

const industries = [
  {
    id: "local",
    label: "本地生活",
    title: "让每一家门店，都拥有一支线上增长团队",
    description: "围绕新品、门店与会员运营，持续生产同城内容、承接咨询、促进到店，并激活老顾客复购。",
    goal: "提升门店曝光、到店与复购",
    flow: ["同城内容", "意向识别", "预约到店", "会员激活"],
    deliverables: ["同城短视频与笔记", "团购咨询话术", "会员回访计划"],
  },
  {
    id: "ecommerce",
    label: "电商零售",
    title: "从商品素材到成交客服，一体化提速",
    description: "批量生成商品图、带货脚本与详情内容，承接多平台客户咨询，并依据转化数据持续优化卖点。",
    goal: "提升内容产能与商品转化",
    flow: ["商品素材", "矩阵分发", "智能客服", "转化复盘"],
    deliverables: ["商品场景图", "带货短视频脚本", "客服知识库"],
  },
  {
    id: "education",
    label: "教育培训",
    title: "把课程优势，转化为持续招生能力",
    description: "自动生成课程宣传与学员案例，及时响应咨询，按需求分层跟进，完善从招生到课后的服务链路。",
    goal: "降低招生成本与服务压力",
    flow: ["课程包装", "招生获客", "学员跟进", "课后服务"],
    deliverables: ["课程内容矩阵", "咨询应答话术", "学员回访任务"],
  },
  {
    id: "beauty",
    label: "美业健康",
    title: "用专业内容与精细运营，沉淀长期客户",
    description: "围绕项目知识与真实服务场景生成内容，管理客户档案、预约与回访，让服务体验更一致。",
    goal: "提升预约率与客户生命周期价值",
    flow: ["案例内容", "咨询预约", "到店提醒", "周期回访"],
    deliverables: ["项目科普内容", "个性化预约话术", "客户关怀计划"],
  },
  {
    id: "home",
    label: "装修建材",
    title: "让长决策周期，也有持续而专业的跟进",
    description: "将案例、工艺与报价知识转化为内容和沟通依据，识别客户需求，自动安排阶段性跟进。",
    goal: "提升有效线索与签单效率",
    flow: ["案例展示", "需求诊断", "方案跟进", "签单复盘"],
    deliverables: ["案例内容包", "需求分析摘要", "跟进节奏建议"],
  },
];

function readRoute(): { view: "home" | "console"; nav: string } {
  const raw = window.location.hash.replace(/^#\/?/, "");
  const [segment, sub] = raw.split("/");
  if (segment === "console") return { view: "console", nav: sub || "overview" };
  return { view: "home", nav: "" };
}

function App() {
  const [route, setRoute] = useState(readRoute);
  const view = route.view;
  const [mobileMenu, setMobileMenu] = useState(false);
  const [activeWorkflow, setActiveWorkflow] = useState(0);
  const [activeIndustry, setActiveIndustry] = useState(0);
  const [user, setUser] = useState<SessionUser | null>(null);
  /** 会话查询完成前不要急着渲染登录墙，否则已登录用户会看到一闪而过的登录页。 */
  const [authReady, setAuthReady] = useState(false);
  const [showConsult, setShowConsult] = useState(false);

  const refreshUser = useCallback(async (force = false) => {
    setUser(await getSessionUser(force));
  }, []);

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "instant" });
  }, [view]);

  // hash 路由：支持刷新保持、深链分享、浏览器前进后退
  useEffect(() => {
    const onHashChange = () => setRoute(readRoute());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  useEffect(() => {
    const bootstrap = async () => {
      const url = new URL(window.location.href);
      const provider = url.searchParams.get("provider");
      const auth = cloud.auth as unknown as Record<string, (...args: unknown[]) => Promise<{ data: unknown; error: { message: string } | null }>>;

      if (url.searchParams.has("code") || url.searchParams.has("error")) {
        const handler = provider === "workbuddy"
          ? auth.handleWorkBuddyCallback
          : provider === "wechat"
            ? auth.handleWechatWebCallback
            : undefined;

        if (handler) {
          const { data, error } = await handler.call(cloud.auth);
          if (!error && data) {
            for (const key of ["code", "state", "provider"]) url.searchParams.delete(key);
            window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
          }
        }
      }

      await refreshUser();
      setAuthReady(true);
    };

    void bootstrap();
  }, [refreshUser]);

  const openConsole = () => {
    setMobileMenu(false);
    window.location.hash = `#/console/${navToSlug("AI 总控")}`;
  };

  const openConsoleAt = (label: string) => {
    setMobileMenu(false);
    window.location.hash = `#/console/${navToSlug(label)}`;
  };

  const handleNavChange = useCallback((label: string) => {
    const next = `#/console/${navToSlug(label)}`;
    if (window.location.hash !== next) window.history.replaceState(null, "", next);
  }, []);

  if (view === "console") {
    // 工作区数据全部归属到账号，没有身份就不进入工作区——这是多租户隔离的第一道门。
    if (!authReady) {
      return (
        <div className="console-gate">
          <div className="console-gate-boot">正在加载你的工作区…</div>
        </div>
      );
    }
    if (!user) {
      return (
        <div className="console-gate">
          <button type="button" className="console-gate-back" onClick={() => { window.location.hash = "#/"; }}>
            返回首页
          </button>
          <LoginPanel
            onSignedIn={() => void refreshUser(true)}
            reason="登录后进入你的专属工作区。任务、线索、知识库与智能体都按账号隔离存放，不同账号之间互不可见。"
          />
        </div>
      );
    }
    return (
      <Console
        onBack={() => { window.location.hash = "#/"; }}
        user={user}
        onSignedIn={() => void refreshUser(true)}
        initialNav={route.nav}
        onNavChange={handleNavChange}
      />
    );
  }

  const currentWorkflow = workflowItems[activeWorkflow];
  const CurrentWorkflowIcon = currentWorkflow.icon;
  const currentIndustry = industries[activeIndustry];

  return (
    <div className="site-shell">
      <header className="site-header">
        <div className="header-inner">
          <a href="#top" className="brand" aria-label="AI 超级员工首页">
            <span className="brand-mark"><Sparkles size={19} /></span>
            <span className="brand-copy"><strong>超级员工</strong><small>SUPER AGENT OS</small></span>
          </a>
          <nav className="desktop-nav" aria-label="主导航">
            <a href="#workflow">产品能力</a>
            <a href="#demo">交互演示</a>
            <a href="#industries">行业方案</a>
            <a href="#start">开始使用</a>
          </nav>
          <div className="header-actions">
            <button type="button" className="login-link" onClick={openConsole}>登录工作台</button>
            <button type="button" className="button button-primary header-cta" onClick={openConsole}>免费体验<ArrowUpRight size={16} /></button>
            <button type="button" className="icon-button mobile-menu-button" onClick={() => setMobileMenu(!mobileMenu)} aria-label="打开菜单">{mobileMenu ? <X size={21} /> : <Menu size={21} />}</button>
          </div>
        </div>
        {mobileMenu && (
          <nav className="mobile-nav" aria-label="移动端导航">
            <a href="#workflow" onClick={() => setMobileMenu(false)}>产品能力<ChevronRight size={17} /></a>
            <a href="#demo" onClick={() => setMobileMenu(false)}>交互演示<ChevronRight size={17} /></a>
            <a href="#industries" onClick={() => setMobileMenu(false)}>行业方案<ChevronRight size={17} /></a>
            <a href="#start" onClick={() => setMobileMenu(false)}>开始使用<ChevronRight size={17} /></a>
            <button type="button" className="button button-primary" onClick={openConsole}>进入工作台<ArrowRight size={16} /></button>
          </nav>
        )}
      </header>

      <main id="top">
        <section className="hero-section">
          <div className="hero-orb hero-orb-one" />
          <div className="hero-orb hero-orb-two" />
          <div className="container hero-grid">
            <div className="hero-copy">
              <div className="eyebrow"><span><Sparkles size={13} /></span>新一代企业级多智能体协作平台</div>
              <h1>把目标交给 AI，<br /><span>把结果带回企业。</span></h1>
              <p className="hero-description">不是又一个聊天工具，而是一支懂业务、会协作、能交付的 AI 团队。从内容、获客到成交与复盘，一个指令驱动完整工作流——目标、知识、执行与反馈在同一个系统里流动，不再跨工具断点。</p>
              <div className="hero-actions">
                <button type="button" className="button button-primary button-large" onClick={openConsole}>启动 AI 总控<ArrowRight size={18} /></button>
                <a href="#demo" className="button button-secondary button-large"><span className="play-icon"><Play size={14} fill="currentColor" /></span>观看协作演示</a>
              </div>
              <div className="hero-proof">
                <span><CheckCircle2 size={16} />无需编程</span>
                <span><CheckCircle2 size={16} />关键动作可审批</span>
                <span><CheckCircle2 size={16} />执行过程可追溯</span>
              </div>
            </div>
            <HeroDashboard onOpenConsole={openConsole} />
          </div>
          <div className="container hero-bottom-bar">
            <span>一个目标，调动整个 AI 团队</span>
            <div><i />内容创作</div><div><i />全域获客</div><div><i />私域销售</div><div><i />企业知识</div><div><i />数据洞察</div>
          </div>
        </section>

        <section className="section workflow-section" id="workflow">
          <div className="container">
            <div className="section-heading centered-heading">
              <span className="section-kicker">端到端工作流</span>
              <h2>增长不是一串动作，<br />而是一个持续进化的闭环。</h2>
              <p>不是更多工具，而是更少断点：四个环节共享同一套企业知识与任务上下文，每一步都为下一步积累价值。</p>
            </div>
            <div className="workflow-tabs" role="tablist" aria-label="业务工作流">
              {workflowItems.map((item, index) => {
                const Icon = item.icon;
                return <button type="button" role="tab" aria-selected={activeWorkflow === index} className={activeWorkflow === index ? "active" : ""} key={item.id} onClick={() => setActiveWorkflow(index)}><span className={`workflow-tab-icon step-${item.color}`}><Icon size={19} /></span><span><small>{item.number}</small><strong>{item.title}</strong></span>{index < workflowItems.length - 1 && <ChevronRight className="workflow-arrow" size={18} />}</button>;
              })}
            </div>
            <div className="workflow-detail">
              <div className="workflow-detail-copy">
                <span className={`workflow-large-icon step-${currentWorkflow.color}`}><CurrentWorkflowIcon size={27} /></span>
                <span className="workflow-subtitle">{currentWorkflow.subtitle}</span>
                <h3>{currentWorkflow.title}</h3>
                <p>{currentWorkflow.description}</p>
                <ul>{currentWorkflow.outputs.map((output) => <li key={output}><CheckCircle2 size={17} />{output}</li>)}</ul>
              </div>
              <div className="workflow-visual">
                <div className="workflow-visual-top"><span>环节 {currentWorkflow.number} · {currentWorkflow.title}</span><span className="live-badge"><i />实时协同</span></div>
                <div className="workflow-nodes">
                  {["理解业务目标", "调用知识与工具", "生成交付结果", "沉淀反馈数据"].map((node, index) => <div key={node} className={index === 2 ? "highlight" : ""}><span>{index + 1}</span><p>{node}</p>{index < 3 && <ChevronRight size={15} />}</div>)}
                </div>
                <div className="workflow-activity"><Activity size={16} /><span>所有执行记录已同步至任务审计</span><Check size={16} /></div>
              </div>
            </div>
          </div>
        </section>

        <section className="section demo-section" id="demo">
          <div className="container">
            <div className="section-heading split-heading demo-heading">
              <div><span className="section-kicker">交互演示</span><h2>现在，给它一个目标。</h2></div>
              <p>这不是播放录屏。输入你的业务目标，亲自体验 AI 总控如何组织团队、推进任务并交付结果。</p>
            </div>
            <CommandDemo onOpenConsole={openConsole} onNeedLogin={openConsole} />
          </div>
        </section>

        <section className="section agents-section">
          <div className="container">
            <div className="agent-strip">
              <div className="agent-strip-copy">
                <span className="section-kicker">AI 员工团队</span>
                <h2>一支随业务生长的 AI 员工团队。</h2>
                <p>每位 AI 员工都有明确岗位、专属知识与工作边界，在控制台里可以查看每个岗位的职责、技能与当前任务。</p>
              </div>
              <div className="agent-strip-list">
                {agentItems.map((agent) => {
                  const Icon = agent.icon;
                  return (
                    <span className="agent-strip-item" key={agent.name}>
                      <span className={`agent-card-icon step-${agent.color}`}><Icon size={17} /></span>
                      <span><strong>{agent.name}</strong><small>{agent.role}</small></span>
                    </span>
                  );
                })}
                <button type="button" className="button button-secondary" onClick={() => openConsoleAt("智能体团队")}>在控制台查看团队<ArrowUpRight size={16} /></button>
              </div>
            </div>
          </div>
        </section>

        <section className="section industries-section" id="industries">
          <div className="container">
            <div className="section-heading centered-heading"><span className="section-kicker">行业方案</span><h2>懂通用智能，更懂你的生意。</h2><p>以行业目标为起点，组合可落地的 AI 工作流，而不是从空白提示词开始。</p></div>
            <div className="industry-tabs" role="tablist" aria-label="行业方案">
              {industries.map((industry, index) => <button type="button" role="tab" aria-selected={activeIndustry === index} className={activeIndustry === index ? "active" : ""} key={industry.id} onClick={() => setActiveIndustry(index)}>{industry.label}</button>)}
            </div>
            <div className="industry-panel">
              <div className="industry-copy"><span className="industry-label">{currentIndustry.label} · AI 增长方案</span><h3>{currentIndustry.title}</h3><p>{currentIndustry.description}</p><div className="industry-goal"><Target size={18} /><span><small>核心业务目标</small><strong>{currentIndustry.goal}</strong></span></div><button type="button" className="button button-primary" onClick={() => openConsoleAt("模板中心")}>体验这个行业方案<ArrowRight size={16} /></button></div>
              <div className="industry-workflow"><span className="industry-workflow-label">推荐工作流</span><div className="industry-flow">{currentIndustry.flow.map((item, index) => <div key={item}><span>{index + 1}</span><strong>{item}</strong>{index < currentIndustry.flow.length - 1 && <ChevronRight size={16} />}</div>)}</div><div className="industry-deliverables"><span>典型交付</span>{currentIndustry.deliverables.map((item) => <div key={item}><FileCheck2 size={17} />{item}<Check size={15} /></div>)}</div></div>
            </div>
          </div>
        </section>

        <section className="final-cta-section" id="start">
          <div className="container final-cta">
            <div className="cta-decoration"><Sparkles size={34} /></div>
            <span className="section-kicker">开始使用</span>
            <h2>你的下一位员工，<br />不必只是一个聊天框。</h2>
            <p>从一个真实业务目标开始，让 AI 团队为你完成第一条工作流。</p>
            <div className="final-cta-actions">
              <button type="button" className="button button-primary button-large" onClick={openConsole}>免费开始使用<ArrowRight size={18} /></button>
              <button type="button" className="button button-ghost button-large consult-button" onClick={() => setShowConsult(true)}><Phone size={16} />预约 1 对 1 演示</button>
            </div>
            <span className="cta-note">无需注册 · 数据实时保存 · 云端同步</span>
            <p className="trust-line"><ShieldCheck size={15} />分级权限与人工审批 · 全链路日志与审计 · 私有知识与部署选择 · 开放模型与工具生态</p>
          </div>
        </section>
      </main>

      <footer className="site-footer">
        <div className="container footer-main">
          <div><a href="#top" className="brand"><span className="brand-mark"><Sparkles size={19} /></span><span className="brand-copy"><strong>超级员工</strong><small>SUPER AGENT OS</small></span></a><p>让企业目标，成为 AI 团队的交付结果。</p></div>
          <div className="footer-links"><div><strong>产品</strong><a href="#workflow">产品能力</a><a href="#demo">交互演示</a><a href="#top">工作台</a></div><div><strong>方案</strong><a href="#industries">行业方案</a><a href="#start">开始使用</a><button type="button" onClick={openConsole}>产品总控台</button></div><div><strong>开始</strong><button type="button" onClick={openConsole}>免费体验</button><button type="button" onClick={() => setShowConsult(true)}>预约演示</button><a href="#top">返回顶部</a></div></div>
        </div>
        <div className="container footer-bottom"><span>© 2026 SUPER AGENT OS 版权所有</span><span>AI 驱动 · 人类掌控 · 结果导向</span></div>
      </footer>

      {showConsult && <ConsultModal onClose={() => setShowConsult(false)} />}
    </div>
  );
}

function HeroDashboard({ onOpenConsole }: { onOpenConsole: () => void }) {
  const now = new Date();
  const weekdayCn = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][now.getDay()];
  const hour = now.getHours();
  const greeting = hour < 6 ? "夜深了" : hour < 12 ? "早上好" : hour < 14 ? "中午好" : hour < 18 ? "下午好" : "晚上好";

  return (
    <div className="hero-product-wrap">
      <div className="hero-dashboard">
        <div className="hero-dashboard-top"><div className="mini-brand"><Sparkles size={15} /><strong>AI 总控</strong></div><div className="mini-search">搜索任务或功能</div><div className="mini-user"><Bot size={14} /></div></div>
        <div className="hero-dashboard-body">
          <div className="hero-dash-greeting"><div><small>{now.getMonth() + 1} 月 {now.getDate()} 日 · {weekdayCn}</small><h3>{greeting}，AI 团队已准备好</h3><p>输入一个业务目标，团队会拆解步骤并推进交付。</p></div><span><Zap size={17} /></span></div>
          <button type="button" className="hero-command" onClick={onOpenConsole}><Sparkles size={16} /><span>输入你的业务目标，例如：为秋季新品制定一周增长计划…</span><i><ArrowUpRight size={16} /></i></button>
          <div className="hero-mini-metrics"><div><span>进行中任务</span><strong>—</strong><small><Activity size={12} />实时协作</small></div><div><span>今日已交付</span><strong>—</strong><small><CheckCircle2 size={12} />登录后查看</small></div><div><span>待你审批</span><strong>—</strong><small className="orange"><Clock3 size={12} />关键动作需确认</small></div></div>
          <div className="hero-active-task"><div className="hero-task-header"><div><CircleDot size={14} /><strong>示例任务：新品增长作战计划</strong></div><span>执行中</span></div><div className="hero-task-agents"><span className="task-agent violet"><FileText size={14} />内容创作<Check size={13} /></span><span className="task-connector" /><span className="task-agent orange"><Target size={14} />全域获客<Activity size={13} /></span><span className="task-connector" /><span className="task-agent muted"><Send size={14} />私域转化</span></div><div className="hero-task-progress"><span /></div></div>
          <div className="hero-pending-list"><span className="hero-pending-title">待你处理</span><div><ShieldCheck size={14} />待审批的群发与关键动作</div><div><Users size={14} />高意向线索待跟进</div><div><Activity size={14} />失败任务可一键重跑</div></div>
        </div>
      </div>
      <div className="hero-float-card float-delivery"><span><CheckCircle2 size={18} /></span><div><strong>有新交付等待查看</strong><small>登录后查看你的任务结果</small></div></div>
      <div className="hero-float-card float-saving"><span><Clock3 size={18} /></span><div><strong>待你处理</strong><small>审批与线索提醒集中呈现</small></div></div>
      <span className="demo-caption">界面示意 · 登录后查看你的真实数据</span>
    </div>
  );
}

const CONSULT_INDUSTRIES = ["本地生活", "电商零售", "教育培训", "美业健康", "装修建材", "其他行业"];

function ConsultModal({ onClose }: { onClose: () => void }) {
  const [form, setForm] = useState({ name: "", company: "", contact: "", industry: CONSULT_INDUSTRIES[0], goal: "" });
  const [state, setState] = useState<"idle" | "saving" | "done">("idle");
  const [error, setError] = useState("");

  const submit = async () => {
    if (!form.name.trim() || !form.contact.trim()) {
      setError("请填写称呼与联系方式，方便顾问联系你");
      return;
    }
    setError("");
    setState("saving");
    try {
      await insertLead({
        name: form.name.trim().slice(0, 20),
        source: form.industry,
        intent: "高意向",
        need: [
          "【官网预约演示】",
          `联系方式：${form.contact.trim()}`,
          form.company.trim() ? `公司：${form.company.trim()}` : "",
          form.goal.trim() ? `目标：${form.goal.trim()}` : "",
        ].filter(Boolean).join("｜"),
        owner: "待分配",
        channel: "官网预约",
      });
      setState("done");
    } catch (err) {
      setState("idle");
      setError(err instanceof Error ? friendlyError(err) : "提交失败，请稍后重试或直接进入工作台");
    }
  };

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="composer-modal form-modal consult-modal" role="dialog" aria-modal="true" aria-label="预约演示">
        <button type="button" className="icon-button modal-close" onClick={onClose} aria-label="关闭"><X size={20} /></button>
        {state === "done" ? (
          <div className="consult-done">
            <span><CheckCircle2 size={30} /></span>
            <h2>已收到，我们尽快联系你</h2>
            <p>预约信息已写入云端工作区，进入总控台「线索与客户」即可看到这条记录。</p>
            <div className="form-actions">
              <button type="button" className="button button-primary" onClick={() => { onClose(); window.location.hash = `#/console/${navToSlug("线索与客户")}`; }}>去总控台查看</button>
              <button type="button" className="button button-ghost" onClick={onClose}>留在官网</button>
            </div>
          </div>
        ) : (
          <>
            <span className="panel-kicker">预约演示</span>
            <h2>预约 1 对 1 产品演示</h2>
            <p className="form-hint">留下联系方式，我们会结合你的行业目标，演示一次从目标到交付的完整流程（约 30 分钟）。</p>
            <div className="form-grid">
              <label>称呼 *<input value={form.name} maxLength={20} placeholder="你的称呼" onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
              <label>公司 / 门店<input value={form.company} maxLength={30} placeholder="选填" onChange={(event) => setForm({ ...form, company: event.target.value })} /></label>
              <label>联系方式 *<input value={form.contact} maxLength={40} placeholder="手机号或微信号" onChange={(event) => setForm({ ...form, contact: event.target.value })} /></label>
              <label>所属行业<select value={form.industry} onChange={(event) => setForm({ ...form, industry: event.target.value })}>{CONSULT_INDUSTRIES.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
            </div>
            <label className="form-full">最想解决的问题<textarea rows={3} maxLength={120} placeholder="例如：门店内容更新太慢，咨询响应不及时" value={form.goal} onChange={(event) => setForm({ ...form, goal: event.target.value })} /></label>
            {error && <p className="form-error">{error}</p>}
            <p className="form-privacy">联系方式仅用于本次演示沟通，不会用于其他用途。</p>
            <div className="form-actions">
              <button type="button" className="button button-primary" disabled={state === "saving"} onClick={submit}>
                {state === "saving" ? <><LoaderCircle size={15} className="spin" />提交中…</> : <><Send size={15} />提交预约</>}
              </button>
              <button type="button" className="button button-ghost" onClick={onClose}>取消</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default App;
