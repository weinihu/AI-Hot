import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowUpRight,
  BookOpenText,
  LineChart,
  Newspaper,
  Search,
} from "lucide-react";
import PillNav from "./PillNav";
import "./styles.css";

const ORIGINAL_FEED_ENDPOINTS = ["/api/original-feed?days=14&take=80&maxPages=8", "https://aihot.agflow.cc/api/original-feed?days=14&take=80&maxPages=8"];

const emptyArchive = {
  range: "同步中",
  latestDate: "同步中",
  days: 0,
  cards: 0,
  sources: 0,
  papers: 0,
  tools: 0,
  topScore: 0,
  topTypes: [],
  sourceRank: [],
  cadence: [],
};

const fallbackArchive = {
  range: "2026-05-31 至 2026-06-07",
  latestDate: "2026-06-07",
  days: 8,
  cards: 222,
  sources: 79,
  papers: 40,
  tools: 46,
  topScore: 94,
  topTypes: [
    { name: "模型", count: 113, note: "能力层持续高频更新" },
    { name: "API", count: 113, note: "接入层与平台策略同步变化" },
    { name: "智能体", count: 70, note: "检索、编程、审计方向集中出现" },
    { name: "AI Coding", count: 57, note: "真实工作流开始外溢" },
    { name: "算力基础设施", count: 43, note: "端侧与推理成本值得复盘" },
    { name: "论文", count: 40, note: "适合进入论文池继续跟踪" },
  ],
  sourceRank: [
    { name: "IT之家 RSS", count: 16 },
    { name: "Hugging Face Blog", count: 14 },
    { name: "Hacker News 热门", count: 10 },
    { name: "HuggingFace Papers", count: 8 },
    { name: "NVIDIA AI Blog", count: 5 },
  ],
  cadence: [
    { date: "05-31", count: 15 },
    { date: "06-01", count: 28 },
    { date: "06-02", count: 36 },
    { date: "06-03", count: 39 },
    { date: "06-04", count: 26 },
    { date: "06-05", count: 31 },
    { date: "06-06", count: 30 },
    { date: "06-07", count: 17 },
  ],
};

const fallbackCards = [
  {
    title: "我在田里雇了一名工程师，它叫 Codex",
    source: "X: 阿易 AI Notes",
    type: "工具项目",
    score: 94,
    date: "2026-06-07",
    fact: "北海道农民用 ChatGPT 和 Codex 处理病害识别、卫星数据、农场数据库和温室远程控制。",
    use: "判断 AI 编程是否已经进入低代码农业流程，而不只是开发者玩具。",
    next: "拆出一个 Windows 工作流任务，验证从输入到交付的完整链路。",
  },
  {
    title: "Her: Claude Code 会话分析工具",
    source: "Hugging Face Blog",
    type: "工具项目",
    score: 91,
    date: "2026-06-07",
    fact: "上传 jsonl 后重建 Claude Code 会话，标注部署、配置变更、隐私信息和高风险操作。",
    use: "适合审查真实开发会话，找到可复用的 agent 工作模式。",
    next: "检查接口、部署方式和本地隐私边界，再决定是否接入。",
  },
  {
    title: "Harness-1: 有状态搜索 20B 检索智能体",
    source: "MarkTechPost",
    type: "智能体",
    score: 88,
    date: "2026-06-07",
    fact: "UIUC 与 Chroma 联合推出强化学习训练的搜索智能体，面向长链路检索任务。",
    use: "评估检索智能体是否能替代部分人工资料搜索。",
    next: "核对 benchmark、训练数据和开源状态。",
  },
  {
    title: "OpenCV 5 发布，升级 DNN 引擎并原生支持大模型",
    source: "IT之家 RSS",
    type: "模型变化",
    score: 84,
    date: "2026-06-06",
    fact: "OpenCV 5 引入新的 DNN 能力，强化视觉模型部署和本地推理路径。",
    use: "判断端侧视觉项目是否需要升级依赖。",
    next: "检查迁移成本、算子兼容和性能报告。",
  },
  {
    title: "Persona Atlas: 开源人物思维映射工具",
    source: "Hugging Face Blog",
    type: "产品变化",
    score: 82,
    date: "2026-06-06",
    fact: "用开源方式组织人物画像、观点和知识图谱，适合内容研究和角色建模。",
    use: "可用于专题页人物库和研究对象追踪。",
    next: "试跑一次人物条目导入，确认结构是否适合 Bitable。",
  },
  {
    title: "PixelDiT 进入 CVPR 2026 最佳论文讨论",
    source: "NVIDIA AI Blog",
    type: "论文",
    score: 80,
    date: "2026-06-07",
    fact: "图像生成继续向高效 Transformer 和扩散模型结构演进。",
    use: "适合加入论文池，后续跟踪方法和实验设置。",
    next: "整理论文链接、代码和评测指标。",
  },
];

function App() {
  const [query, setQuery] = useState("");
  const [feed, setFeed] = useState(() => buildHomeFeed([], { fallbackArchive: emptyArchive }));
  const [feedStatus, setFeedStatus] = useState({ label: "同步原站", state: "loading" });
  useRevealMotion();

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;

    async function loadOriginalFeed() {
      setFeedStatus({ label: "同步原站", state: "loading" });
      for (const endpoint of ORIGINAL_FEED_ENDPOINTS) {
        try {
          const response = await fetch(endpoint, { signal: controller.signal });
          if (!response.ok) throw new Error(`feed ${response.status}`);
          const payload = await response.json();
          if (!Array.isArray(payload.items) || payload.items.length === 0) throw new Error("feed empty");
          if (cancelled) return;
          setFeed(buildHomeFeed(payload.items, { generatedAt: payload.generatedAt }));
          setFeedStatus({ label: "原站更新", state: "ready" });
          return;
        } catch (error) {
          if (cancelled || controller.signal.aborted) return;
        }
      }
      setFeed(buildHomeFeed(fallbackCards, { fallbackArchive }));
      setFeedStatus({ label: "本地回退", state: "fallback" });
    }

    loadOriginalFeed();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, []);

  const filteredCards = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return feed.cards;
    return feed.cards.filter((card) =>
      `${card.title} ${card.source} ${card.type} ${card.fact} ${card.use} ${card.next}`.toLowerCase().includes(keyword),
    );
  }, [feed.cards, query]);

  return (
    <main className="pageShell">
      <HeroSection archive={feed.archive} cards={feed.cards} query={query} setQuery={setQuery} filteredCards={filteredCards} feedStatus={feedStatus} />
    </main>
  );
}

function useRevealMotion() {
  useEffect(() => {
    const targets = Array.from(document.querySelectorAll("[data-reveal]"));
    if (!targets.length) return undefined;

    const prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (prefersReduced || !("IntersectionObserver" in window)) {
      targets.forEach((target) => target.classList.add("is-visible"));
      return undefined;
    }

    const revealNearViewport = () => {
      for (const target of targets) {
        const rect = target.getBoundingClientRect();
        if (rect.top < window.innerHeight * 1.16 && rect.bottom > -40) target.classList.add("is-visible");
      }
    };

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.classList.add("is-visible");
          observer.unobserve(entry.target);
        }
      },
      { rootMargin: "0px 0px 18% 0px", threshold: 0.01 },
    );

    requestAnimationFrame(() => {
      document.documentElement.classList.add("motionReady");
      targets.forEach((target) => observer.observe(target));
      revealNearViewport();
    });
    const safetyTimer = window.setTimeout(revealNearViewport, 900);

    return () => {
      window.clearTimeout(safetyTimer);
      observer.disconnect();
      document.documentElement.classList.remove("motionReady");
    };
  }, []);
}

function HeroSection({ archive, cards, query, setQuery, filteredCards, feedStatus }) {
  const hasQuery = query.trim().length > 0;
  const visibleCards = hasQuery ? filteredCards : cards;
  const isLoading = feedStatus.state === "loading" && cards.length === 0;
  const leadCard = visibleCards[0] || null;
  const dailyCards = visibleCards.slice(0, 3);
  const streamCards = visibleCards.slice(3, 9);
  const typeLeaders = archive.topTypes.slice(0, 3);
  const sourceLeaders = archive.sourceRank.slice(0, 3);
  const navItems = buildNavItems(archive.latestDate);
  const dailyHref = dailyHrefFor(archive.latestDate);
  const routes = [
    {
      icon: BookOpenText,
      title: "知识库",
      text: "检索卡片",
      href: "/library",
    },
    {
      icon: LineChart,
      title: "阶段复盘",
      text: "查看趋势",
      href: "/review",
    },
    {
      icon: Newspaper,
      title: "单日归档",
      text: "打开日报",
      href: dailyHref,
    },
  ];

  return (
    <section className="heroStage" id="signal" data-reveal>
      <header className="topBar" data-reveal style={{ "--stagger": "80ms" }}>
        <a className="brandWordmark" href="#signal" aria-label="AI HOT 首页">
          <span>AI HOT</span>
          <small>日报与检索</small>
        </a>
        <PillNav items={navItems} activeHref="#signal" className="heroPillNav" />
        <div className={`dateChip ${feedStatus.state}`}>
          <span>{feedStatus.label}</span>
          <b>{archive.latestDate}</b>
        </div>
      </header>

      <div className="heroGrid">
        <section className="dailyDesk" aria-label="今日 AI HOT 日报" data-reveal style={{ "--stagger": "150ms" }}>
          <div className="dailyIntro">
            <p className="smallLabel">原站精选 · {archive.latestDate}</p>
            <h1>
              <span>AI HOT</span>
              <span>情报台</span>
            </h1>
            <p>原站精选同步，先看最新线索，再进入知识库回查。</p>
          </div>

          <label className="heroSearch">
            <Search size={18} aria-hidden="true" />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索标题、来源、类型或下一步" />
          </label>

          <div className="signalStrip" aria-label="归档概览">
            <span><b>{archive.cards}</b>知识卡片</span>
            <span><b>{archive.sources}</b>来源</span>
            <span><b>{archive.papers}</b>论文</span>
            <span><b>{archive.tools}</b>工具</span>
          </div>

          <article className={`leadStory${leadCard ? "" : " is-loading"}`} data-reveal style={{ "--stagger": "430ms" }}>
            {leadCard ? (
              <>
                <div className="storyMeta">
                  <span>{leadCard.type}</span>
                  <span>{leadCard.source}</span>
                  <b>{leadCard.score}</b>
                </div>
                <h2>{leadCard.title}</h2>
                <p>{leadCard.fact}</p>
                <dl className="actionNotes">
                  <div>
                    <dt>判断</dt>
                    <dd>{leadCard.use}</dd>
                  </div>
                  <div>
                    <dt>下一步</dt>
                    <dd>{leadCard.next}</dd>
                  </div>
                </dl>
                <div className="storyActions">
                  <a className="textAction" href="/library">
                    进入知识库
                    <ArrowUpRight size={16} aria-hidden="true" />
                  </a>
                  {leadCard.url ? (
                    <a className="ghostAction" href={leadCard.url} target="_blank" rel="noreferrer">
                      打开原文
                    </a>
                  ) : null}
                </div>
              </>
            ) : (
              <>
                <div className="storyMeta">
                  <span>同步中</span>
                  <span>AI HOT</span>
                </div>
                <h2>正在读取原站精选</h2>
                <p>页面会优先展示原站最新队列，接口失败时才使用本地回退内容。</p>
                <div className="loadingBars" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </div>
              </>
            )}
          </article>
        </section>

        <aside className="searchDesk" aria-label="优先线索" data-reveal style={{ "--stagger": "220ms" }}>
          <PanelHeader title={hasQuery ? "匹配线索" : "优先阅读"} meta={hasQuery ? `${filteredCards.length} 条` : "原站前 3 条"} />
          <div className="resultList">
            {dailyCards.length ? dailyCards.map((card, index) => (
              <a className="resultItem" key={card.title} href={card.url || dailyHrefFor(card.date)} data-reveal style={{ "--stagger": `${340 + index * 70}ms` }}>
                <span>{displayRank(card, index)}</span>
                <div>
                  <strong>{card.title}</strong>
                  <small>{card.type} · {card.source}</small>
                </div>
                <b>{card.score}</b>
              </a>
            )) : (
              <div className="emptyResult">{isLoading ? "正在同步原站精选..." : "没有匹配线索，换一个关键词试试。"}</div>
            )}
          </div>
          <section className="compactInsight" aria-label="今日结构">
            <PanelHeader title="内容结构" meta={archive.cards ? `${archive.cards} 条` : "同步后生成"} />
            <div className="insightBlock">
              <span>高频方向</span>
              <div className="chipLine">
                {typeLeaders.map((item) => (
                  <a href="/library" key={item.name}>
                    <strong>{item.name}</strong>
                    <b>{item.count}</b>
                  </a>
                ))}
              </div>
            </div>
            <div className="insightBlock">
              <span>主要来源</span>
              <div className="sourceLine">
                {sourceLeaders.map((item) => (
                  <a href="/library" key={item.name}>
                    <strong>{item.name}</strong>
                    <b>{item.count}</b>
                  </a>
                ))}
              </div>
            </div>
          </section>
          <div className="miniRoutes" aria-label="常用入口">
            {routes.map((route, index) => {
              const Icon = route.icon;
              return (
                <a key={route.title} href={route.href} data-reveal style={{ "--stagger": `${560 + index * 55}ms` }}>
                  <Icon size={18} aria-hidden="true" />
                  <span>{route.title}</span>
                  <small>{route.text}</small>
                </a>
              );
            })}
          </div>
        </aside>
      </div>

      <BriefingStream cards={streamCards} total={visibleCards.length} hasQuery={hasQuery} isLoading={isLoading} />
    </section>
  );
}

function BriefingStream({ cards, total, hasQuery, isLoading }) {
  if (!cards.length && !isLoading) return null;
  return (
    <section className="briefingStream" aria-label={hasQuery ? "更多匹配线索" : "最新日报流"} data-reveal style={{ "--stagger": "620ms" }}>
      <PanelHeader title={hasQuery ? "更多匹配" : "最新日报流"} meta={isLoading ? "同步中" : `${total} 条`} />
      <div className="streamGrid">
        {cards.length ? cards.map((card, index) => {
          const href = card.url || dailyHrefFor(card.date);
          const external = /^https?:\/\//.test(href);
          return (
            <a className="streamItem" key={`${card.title}-${index}`} href={href} target={external ? "_blank" : undefined} rel={external ? "noreferrer" : undefined}>
              <span>{displayRank(card, index + 3)}</span>
              <div>
                <strong>{card.title}</strong>
                <p>{card.fact}</p>
                <small>{card.type} · {card.source}</small>
              </div>
              <b>{card.score}</b>
            </a>
          );
        }) : (
          Array.from({ length: 3 }, (_, index) => (
            <div className="streamItem streamSkeleton" key={index}>
              <span>{String(index + 4).padStart(2, "0")}</span>
              <div>
                <strong>等待原站返回</strong>
                <p>最新日报流会在同步完成后自动填充。</p>
              </div>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

function PanelHeader({ title, meta }) {
  return (
    <header className="panelHeader">
      <strong>{title}</strong>
      <span>{meta}</span>
    </header>
  );
}

function buildNavItems(latestDate) {
  return [
    { label: "日报", href: "#signal", ariaLabel: "查看今日日报" },
    { label: "知识库", href: "/library", ariaLabel: "打开知识库" },
    { label: "复盘", href: "/review", ariaLabel: "打开阶段复盘" },
    { label: "单日", href: dailyHrefFor(latestDate), ariaLabel: "打开最新单日归档" },
  ];
}

function dailyHrefFor(date) {
  return isDateKey(date) ? `/daily?date=${date}` : "/daily";
}

function isDateKey(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}

function displayRank(card, fallbackIndex) {
  const rank = Number(card?.rank);
  if (Number.isFinite(rank) && rank > 0) return String(rank).padStart(2, "0");
  return String(fallbackIndex + 1).padStart(2, "0");
}

function buildHomeFeed(items, { fallbackArchive, generatedAt } = {}) {
  const cards = (Array.isArray(items) ? items : [])
    .map(toHomeCard)
    .filter((card) => card.title)
    .sort(compareRecentCards);
  const uniqueDates = [...new Set(cards.map((card) => card.date).filter(Boolean))].sort((a, b) => b.localeCompare(a));
  const syncDate = generatedAt ? formatDateKey(generatedAt) : "";
  const latestDate = syncDate || uniqueDates[0] || fallbackArchive?.latestDate || formatDateKey(new Date());
  const topScore = cards.reduce((max, card) => Math.max(max, card.score), 0);
  const topTypes = countBy(cards, (card) => card.type).slice(0, 6);
  const sourceRank = countBy(cards, (card) => card.source).slice(0, 5);
  return {
    generatedAt,
    cards,
    archive: {
      range: uniqueDates.length ? `${uniqueDates[uniqueDates.length - 1]} 至 ${latestDate}` : fallbackArchive?.range || latestDate,
      latestDate,
      days: uniqueDates.length || fallbackArchive?.days || 0,
      cards: cards.length || fallbackArchive?.cards || 0,
      sources: new Set(cards.map((card) => card.source).filter(Boolean)).size || fallbackArchive?.sources || 0,
      papers: cards.filter((card) => /论文|paper/i.test(`${card.type} ${card.category}`)).length || fallbackArchive?.papers || 0,
      tools: cards.filter((card) => /工具|产品|API|Coding|ai-products/i.test(`${card.type} ${card.category}`)).length || fallbackArchive?.tools || 0,
      topScore: topScore || fallbackArchive?.topScore || 0,
      topTypes: topTypes.length ? topTypes : fallbackArchive?.topTypes || [],
      sourceRank: sourceRank.length ? sourceRank : fallbackArchive?.sourceRank || [],
    },
  };
}

function compareRecentCards(a, b) {
  const rankDiff = cardRank(a) - cardRank(b);
  if (rankDiff !== 0) return rankDiff;
  const timeDiff = itemTimeMs(b) - itemTimeMs(a);
  if (timeDiff !== 0) return timeDiff;
  return b.score - a.score;
}

function cardRank(card) {
  const rank = Number(card?.rank);
  return Number.isFinite(rank) && rank > 0 ? rank : Number.POSITIVE_INFINITY;
}

function itemTimeMs(item) {
  const value = new Date(item?.publishedAt || item?.date || 0).getTime();
  return Number.isFinite(value) ? value : 0;
}

function toHomeCard(item) {
  const title = text(item.title || item.title_en || "");
  const source = text(item.source || "AI HOT");
  const category = text(item.category || "");
  const type = text(item.type || categoryName(category));
  const summary = text(item.fact || item.summary || title);
  const publishedAt = text(item.publishedAt || item.date || "");
  return {
    title,
    source,
    type,
    category,
    url: text(item.url || ""),
    rank: Number(item.rank) || Number.POSITIVE_INFINITY,
    score: clampNumber(item.score ?? item.impactScore, 0, 100),
    date: item.date || formatDateKey(publishedAt || new Date()),
    publishedAt,
    fact: completeSentence(summary, 110),
    use: text(item.use || inferUse(category, type, title, summary)),
    next: text(item.next || inferNext(category, type, title, summary)),
  };
}

function categoryName(category) {
  const names = {
    "ai-models": "模型/API",
    "ai-products": "产品/工具",
    industry: "行业动态",
    paper: "论文",
    tip: "技巧观点",
    other: "资讯",
  };
  return names[category] || "资讯";
}

function inferUse(category, type, title, summary) {
  const body = `${category} ${type} ${title} ${summary}`.toLowerCase();
  if (body.includes("api") || body.includes("sdk") || body.includes("接口")) return "判断是否影响模型选型、接口接入或内部工具链。";
  if (body.includes("paper") || body.includes("论文") || category === "paper") return "评估是否进入论文池，后续跟踪方法、数据和代码。";
  if (body.includes("agent") || body.includes("智能体") || body.includes("codex")) return "判断智能体工作流是否值得接入现有任务。";
  if (category === "industry") return "判断平台策略、监管和商业化方向是否发生变化。";
  return "快速判断这条线索是否值得继续阅读和归档。";
}

function inferNext(category, type, title, summary) {
  const body = `${category} ${type} ${title} ${summary}`.toLowerCase();
  if (body.includes("github") || body.includes("开源")) return "打开原项目，检查部署方式、许可证和最近提交。";
  if (body.includes("api") || body.includes("sdk") || body.includes("接口")) return "核对文档、价格、限制和可接入场景。";
  if (body.includes("paper") || body.includes("论文") || category === "paper") return "保存论文链接，补充实验设置和评测指标。";
  return "打开原文确认时间、限制条件和后续跟进价值。";
}

function countBy(cards, getter) {
  const map = new Map();
  for (const card of cards) {
    const name = text(getter(card));
    if (!name) continue;
    map.set(name, (map.get(name) || 0) + 1);
  }
  return [...map.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "zh-CN"));
}

function text(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function completeSentence(value, maxLength) {
  const clean = text(value);
  if (clean.length <= maxLength) return clean;
  return `${clean.slice(0, maxLength - 1).trim()}…`;
}

function clampNumber(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function formatDateKey(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

createRoot(document.getElementById("root")).render(<App />);
