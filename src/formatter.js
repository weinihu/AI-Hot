import { CATEGORY_ORDER, categoryLabel, normalizeCategory } from "./config.js";

export function toOriginalSiteItem(item, rank) {
  const normalized = normalizeItem(item);
  const score = normalized.score;
  return {
    ...normalized,
    rank,
    impactScore: score,
    impactReasons: [],
    priority: itemPriority(score),
    valueFactors: {
      actionability: 0,
      impact: 0,
      novelty: 0,
      credibility: 0,
    },
  };
}

export function buildDigest({ items, paperItems = [], analysis, analysisStatus }) {
  const groups = groupItemsByCategory(items);
  const lines = ["**AI HOT 原站日报**"];

  for (const [category, categoryItems] of groups) {
    lines.push("", `**${categoryLabel(category)}**`);
    categoryItems.forEach((item, index) => {
      lines.push(originalDigestItemLine(item, index));
    });
  }

  if (paperItems.length > 0) {
    lines.push("", "**论文精选**");
    paperItems.forEach((item, index) => {
      lines.push(originalDigestItemLine(item, index));
    });
  }

  if (groups.length === 0 && paperItems.length === 0) lines.push("", "暂无内容。");
  const formattedAnalysis = formatAnalysisForCard(analysis, analysisStatus);
  if (formattedAnalysis) lines.push("", "**今日总结**", formattedAnalysis);
  return lines.join("\n").trim();
}

export function buildFeishuCard({
  items,
  paperItems = [],
  analysis,
  analysisStatus,
  dailyUrl,
  publicBaseURL,
  startedAt,
}) {
  const groups = groupItemsByCategory(items);
  const elements = [];

  for (const [category, categoryItems] of groups) {
    appendFeishuSection(
      elements,
      `${categoryLabel(category)} · ${categoryItems.length} 条`,
      categoryItems.map(originalCardItemLine).join("\n\n"),
    );
  }

  if (elements.length === 0) {
    elements.push({ tag: "markdown", content: "暂无内容。" });
  }

  if (paperItems.length > 0) {
    appendFeishuSection(elements, `论文精选 · ${paperItems.length} 条`, paperItems.map(originalCardItemLine).join("\n\n"));
  }

  const formattedAnalysis = formatAnalysisForCard(analysis, analysisStatus);
  if (formattedAnalysis) {
    appendFeishuSection(elements, "今日总结", formattedAnalysis);
  }

  const knowledgeEntry = buildFeishuKnowledgeEntryElements({ dailyUrl, publicBaseURL, startedAt });
  if (knowledgeEntry.length > 0) {
    elements.push({ tag: "hr" });
    elements.push(...knowledgeEntry);
  }

  return {
    config: { wide_screen_mode: true },
    header: {
      template: "blue",
      title: { tag: "plain_text", content: "AI HOT 原站日报" },
    },
    elements,
  };
}

function appendFeishuSection(elements, title, content) {
  if (elements.length > 0) elements.push({ tag: "hr" });
  elements.push({
    tag: "markdown",
    content: [`**${title}**`, content].filter(Boolean).join("\n"),
  });
}

function buildFeishuKnowledgeEntryElements({ dailyUrl, publicBaseURL, startedAt }) {
  const url = dailyUrl || buildDailyArchiveURL(publicBaseURL, startedAt);
  if (!url) return [];
  return [
    {
      tag: "markdown",
      content: "**继续阅读**\n完整归档、历史检索、阶段复盘都在这里。",
    },
    {
      tag: "action",
      actions: [
        {
          tag: "button",
          text: { tag: "plain_text", content: "打开知识库入口" },
          type: "primary",
          url,
        },
      ],
    },
  ];
}

function buildDailyArchiveURL(publicBaseURL, startedAt) {
  const base = String(publicBaseURL || "").replace(/\/+$/, "");
  if (!base) return "";
  const date = startedAt ? formatDateKey(startedAt) : "";
  return date ? `${base}/daily?date=${date}` : base;
}

function buildFeishuKnowledgeCardElements(items) {
  return selectPushKnowledgeCards(items).map((card) => ({
    tag: "column_set",
    flex_mode: "stretch",
    background_style: "grey",
    horizontal_spacing: "default",
    margin: "8px 0px 0px 0px",
    columns: [
      {
        tag: "column",
        width: "weighted",
        weight: 1,
        elements: [
          {
            tag: "markdown",
            content: [
              `**${escapeMarkdown(card.type)}｜${escapeMarkdown(card.priority)}｜${cardTitleMarkdown(card)}**`,
              `<font color='grey'>方向：${escapeMarkdown(card.topics)}</font>`,
              `事实：${escapeMarkdown(card.fact)}`,
              `用途：${escapeMarkdown(card.useCase)}`,
            ].join("\n"),
          },
        ],
      },
    ],
  }));
}

function cardTitleMarkdown(card) {
  return card.url ? `[${escapeMarkdown(card.title)}](${card.url})` : escapeMarkdown(card.title);
}

function selectPushKnowledgeCards(items) {
  const cards = items.map((item) => buildPushKnowledgeCard(normalizeItem(item)));
  const paper = cards.filter((card) => card.type === "论文候选");
  const tool = cards.filter((card) => card.type === "工具项目");
  const other = cards.filter((card) => card.type !== "论文候选" && card.type !== "工具项目");
  const selected = [];
  for (const card of [...paper.slice(0, 1), ...tool.slice(0, 1), ...other]) {
    if (selected.length >= 3) break;
    if (!selected.some((existing) => existing.identity === card.identity)) selected.push(card);
  }
  return selected;
}

function buildPushKnowledgeCard(item) {
  const category = normalizeCategory(item.category);
  const text = `${item.title} ${item.summary} ${item.source}`.toLowerCase();
  const type = inferPushKnowledgeType(category, text);
  return {
    identity: itemIdentity(item),
    title: compactText(item.title, 42),
    url: item.url,
    type,
    priority: inferPushKnowledgePriority(category, text),
    topics: inferPushKnowledgeTopics(item, category).join(" / "),
    fact: itemOneLineBrief(item),
    useCase: inferPushKnowledgeUseCase(type, category, text),
  };
}

function inferPushKnowledgeType(category, text) {
  if (category === "paper") return "论文候选";
  if (hasAny(text, ["api", "sdk", "接口", "接入", "mcp", "github", "开源", "codex", "copilot"])) return "工具项目";
  if (category === "ai-models") return "模型变化";
  if (category === "industry") return "行业观察";
  if (category === "tip") return "方法参考";
  return "资讯线索";
}

function inferPushKnowledgePriority(category, text) {
  if (category === "paper" && hasAny(text, ["benchmark", "dataset", "sota", "code", "github", "基准", "数据集", "代码"])) return "高";
  if (hasAny(text, ["openai", "anthropic", "google", "deepmind", "nvidia", "microsoft", "api", "sdk", "发布", "上线"])) return "高";
  if (category === "paper" || category === "ai-models" || category === "ai-products") return "中";
  return "低";
}

function inferPushKnowledgeTopics(item, category) {
  const text = `${item.title} ${item.summary} ${item.source}`.toLowerCase();
  const topics = [];
  const add = (topic, patterns) => {
    if (hasAny(text, patterns)) topics.push(topic);
  };
  add("智能体", ["agent", "智能体", "mcp", "tool use", "工具调用"]);
  add("RAG/知识库", ["rag", "retrieval", "vector", "向量", "检索", "知识库", "memory", "记忆"]);
  add("多模态", ["multimodal", "omni", "vision", "image", "video", "audio", "语音", "图像", "视频"]);
  add("AI Coding", ["codex", "copilot", "coding", "ide", "代码", "开发者", "developer"]);
  add("模型/API", ["model", "gpt", "gemini", "claude", "llama", "deepseek", "qwen", "模型", "api", "sdk"]);
  add("论文/评测", ["paper", "arxiv", "benchmark", "eval", "dataset", "sota", "论文", "基准", "评测", "数据集"]);
  add("算力基础设施", ["gpu", "nvidia", "blackwell", "cuda", "chip", "芯片", "算力", "数据中心"]);
  add("端侧AI", ["on-device", "local", "端侧", "本地运行", "手机", "pc", "windows", "apple"]);
  add("安全合规", ["security", "privacy", "safe", "governance", "安全", "隐私", "合规", "治理"]);
  add("具身智能", ["robot", "robotics", "fsd", "autonomous", "自动驾驶", "机器人", "具身"]);
  if (topics.length === 0) topics.push(categoryLabel(category));
  return [...new Set(topics)].slice(0, 3);
}

function inferPushKnowledgeUseCase(type, category, text) {
  if (type === "论文候选") return "论文阅读 / 文献跟踪";
  if (type === "工具项目") return "工具试用 / 项目调研";
  if (category === "ai-models") return "模型选型 / 能力跟踪";
  if (category === "industry") return "趋势跟踪 / 背景材料";
  if (category === "tip") return "方法沉淀 / SOP 参考";
  if (hasAny(text, ["api", "sdk", "接口"])) return "接入评估 / Demo 验证";
  return "快速了解 / 后续检索";
}

function originalDigestItemLine(item, index) {
  const title = item.url ? `[${escapeMarkdown(item.title)}](${item.url})` : escapeMarkdown(item.title);
  const lines = [`${index + 1}. ${title}`];
  if (item.source) lines.push(`来源：${cleanInlineText(item.source)}`);
  const brief = itemOneLineBrief(item);
  if (brief) lines.push(`说明：${brief}`);
  return lines.join("\n");
}

function originalCardItemLine(item, index) {
  const title = item.url ? `[${escapeMarkdown(item.title)}](${item.url})` : escapeMarkdown(item.title);
  const lines = [`${index + 1}. ${title}`];
  if (item.source) lines.push(`来源：${cleanInlineText(item.source)}`);
  const brief = itemOneLineBrief(item);
  if (brief) lines.push(`说明：${brief}`);
  return lines.join("\n");
}

export function itemOneLineBrief(item) {
  return completeBrief(item.summary || item.title, 86);
}

export function completeBrief(text, maxLength) {
  const clean = cleanInlineText(text);
  if (!clean) return "";

  const firstSentence = clean.match(/^[^。！？!?]+[。！？!?]/)?.[0]?.trim();
  if (firstSentence && firstSentence.length <= maxLength) return firstSentence;

  const candidate = firstSentence || clean;
  const separators = ["。", "！", "？", "；", ";", "，", ",", "：", ":", "、"];
  let cutAt = -1;
  for (const separator of separators) {
    const index = candidate.lastIndexOf(separator, maxLength);
    if (index >= 24) cutAt = Math.max(cutAt, index);
  }

  if (cutAt >= 24) return ensureSentence(candidate.slice(0, cutAt));
  if (candidate.length <= maxLength) return ensureSentence(candidate);
  return ensureSentence(candidate.slice(0, maxLength).trim());
}

export function ensureSentence(text) {
  const clean = cleanInlineText(text).replace(/[，,；;：:、]+$/g, "");
  if (!clean) return "";
  return /[。！？!?]$/.test(clean) ? clean : `${clean}。`;
}

function cleanInlineText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function formatAnalysisForCard(analysis, analysisStatus) {
  const clean = String(analysis || "").replace(/\s+/g, " ").replace(/#{1,6}\s*/g, "").trim();
  const statusLine = formatAnalysisStatusLine(analysisStatus);
  const analysisLines = [];

  if (clean) {
    const labels = ["整体概况", "主要动态", "论文动态", "补充信息"];
    for (const label of labels) {
      const match = clean.match(new RegExp(`${label}[:：]\\s*([^。！？]+[。！？]?)`));
      if (match) analysisLines.push(`${label}：${completeBrief(match[1], 90)}`);
    }
    if (analysisLines.length < 2) analysisLines.push(completeBrief(clean, 260));
  }

  return [statusLine, ...analysisLines.slice(0, 4)].filter(Boolean).join("\n");
}

function formatAnalysisStatusLine(analysisStatus) {
  if (!analysisStatus || analysisStatus.ok !== false) return "";
  const label = ["skipped", "disabled"].includes(analysisStatus.status) ? "AI 分析未启用" : "AI 分析失败";
  const reason = compactText(analysisStatus.error || analysisStatus.reason || "", 70);
  return reason ? `${label}：本次今日总结使用规则摘要，原因：${reason}。` : `${label}：本次今日总结使用规则摘要。`;
}

export function rankInfluentialItems(items) {
  return items
    .map((item) => {
      const normalized = normalizeItem(item);
      const text = `${normalized.title} ${normalized.summary}`.toLowerCase();
      const source = String(normalized.source || "").toLowerCase();
      const category = normalizeCategory(item.category);
      const valueFactors = calculateValueFactors({ text, source, category, item: normalized });
      const impactReasons = buildImpactReasons(valueFactors, { text, source, category });
      const score =
        valueFactors.actionability +
        valueFactors.impact +
        valueFactors.novelty +
        valueFactors.credibility;

      return {
        ...item,
        impactScore: Math.min(Math.round(score), 100),
        impactReasons,
        valueFactors,
      };
    })
    .sort((a, b) => {
      if (b.impactScore !== a.impactScore) return b.impactScore - a.impactScore;
      return new Date(b.publishedAt || 0).getTime() - new Date(a.publishedAt || 0).getTime();
    });
}

function calculateValueFactors({ text, source, category, item }) {
  const sourceAndText = `${source} ${text}`;
  const actionability = clampScore(
    8 +
      scoreIf(hasAny(sourceAndText, ["api", "sdk", "接口", "接入", "plugin", "integration", "mcp"]), 8) +
      scoreIf(hasAny(sourceAndText, ["available", "now", "today", "try", "上线", "开放", "可用", "可以试用", "今天"]), 7) +
      scoreIf(hasAny(sourceAndText, ["codex", "agent", "智能体", "workflow", "自动化", "工具链", "developer"]), 6) +
      scoreIf(hasAny(sourceAndText, ["open source", "github", "开源", "下载", "template", "模板"]), 5) +
      categoryActionability(category),
    0,
    30,
  );

  const impact = clampScore(
    8 +
      scoreIf(hasAny(sourceAndText, ["openai", "anthropic", "google", "gemini", "deepmind"]), 7) +
      scoreIf(hasAny(sourceAndText, ["microsoft", "meta", "nvidia", "apple", "amazon", "xai"]), 5) +
      scoreIf(hasAny(sourceAndText, ["model", "模型", "platform", "平台", "infrastructure", "基础设施"]), 5) +
      scoreIf(hasAny(sourceAndText, ["windows", "chatgpt", "browser", "office", "enterprise", "企业"]), 4) +
      scoreIf(hasAny(sourceAndText, ["developer", "开发者", "agent", "智能体", "workflow", "工作流"]), 4) +
      categoryImpact(category),
    0,
    30,
  );

  const novelty = clampScore(
    6 +
      scoreIf(hasAny(sourceAndText, ["release", "launch", "发布", "推出", "上线", "announced", "新增"]), 6) +
      scoreIf(hasAny(sourceAndText, ["new", "first", "首次", "实时", "real-time", "multimodal", "omni"]), 5) +
      scoreIf(hasAny(sourceAndText, ["benchmark", "eval", "sota", "基准", "评测", "数据集"]), 4) +
      scoreIf(hasAny(sourceAndText, ["paper", "论文", "research", "arxiv", "研究"]), 3) +
      scoreIf(item.summary && item.summary.length > 110, 2),
    0,
    20,
  );

  const credibility = clampScore(
    7 +
      scoreIf(hasAny(source, ["官方", "openai", "anthropic", "google", "deepmind", "microsoft", "meta", "nvidia"]), 9) +
      scoreIf(hasAny(sourceAndText, ["官网", "blog", "博客", "research", "paper", "论文", "github", "rss"]), 4) +
      scoreIf(hasAny(sourceAndText, ["@openai", "@googleai", "@googleaidevs", "@gdb", "@geminiapp"]), 3) +
      scoreIf(Boolean(item.url), 2) +
      scoreIf(item.summary && item.summary.length > 60, 1),
    0,
    20,
  );

  return { actionability, impact, novelty, credibility };
}

function categoryActionability(category) {
  const values = {
    "ai-products": 5,
    "ai-models": 4,
    tip: 3,
    industry: 2,
    paper: 1,
    other: 1,
  };
  return values[category] || values.other;
}

function categoryImpact(category) {
  const values = {
    "ai-models": 5,
    "ai-products": 5,
    industry: 4,
    paper: 3,
    tip: 2,
    other: 1,
  };
  return values[category] || values.other;
}

function buildImpactReasons(valueFactors, { text, source, category }) {
  const reasons = [];
  const sourceAndText = `${source} ${text}`;

  if (valueFactors.actionability >= 24) reasons.push("今天可落地");
  else if (valueFactors.actionability >= 20) reasons.push("可行动");

  if (hasAny(sourceAndText, ["api", "sdk", "接口", "接入", "plugin", "integration"])) reasons.push("可接入 API");
  if (hasAny(sourceAndText, ["codex", "developer", "开发者", "workflow", "工作流", "自动化"])) reasons.push("开发者工具链");
  if (valueFactors.credibility >= 17) reasons.push("官方发布");
  else if (valueFactors.credibility >= 14) reasons.push("高可信来源");
  if (valueFactors.impact >= 25) reasons.push("平台级影响");
  if (valueFactors.novelty >= 17) reasons.push("新能力信号");

  if (reasons.length === 0) {
    const fallbackByCategory = {
      "ai-models": "模型能力变化",
      "ai-products": "产品体验变化",
      industry: "行业落地信号",
      paper: "研究路线信号",
      tip: "实践方法参考",
      other: "补充观察",
    };
    reasons.push(fallbackByCategory[category] || fallbackByCategory.other);
  }

  return [...new Set(reasons)].slice(0, 4);
}

export function itemAction(item) {
  const category = normalizeCategory(item.category);
  const text = `${item.title || ""} ${item.summary || ""}`.toLowerCase();
  if (category === "paper") return "先看结论和数据集，再决定是否读全文。";
  if (text.includes("api")) return "看接口文档、价格和限制，判断能否接入。";
  if (text.includes("codex") || text.includes("windows")) return "在 Windows 工作流里验证 1 个真实任务。";
  if (text.includes("benchmark") || text.includes("基准")) return "看评测维度，判断是否纳入技术观察。";
  if (category === "tip") return "提炼成团队 SOP 或提示词模板。";
  if (category === "industry") return "判断是否影响业务方向、监管风险或客户需求。";
  return "点开原文，确认发布时间、限制条件和是否可试用。";
}

function itemPriority(score) {
  if (score >= 85) return "S";
  if (score >= 72) return "A";
  if (score >= 60) return "B";
  return "C";
}

function itemImpact(item) {
  const category = normalizeCategory(item.category);
  const text = `${item.title || ""} ${item.summary || ""}`.toLowerCase();
  if (hasAny(text, ["api", "sdk", "接口", "接入", "plugin", "integration", "集成"])) {
    return "影响产品接入、内部工具和自动化流程，适合今天判断是否能落到自己的系统里。";
  }
  if (text.includes("windows") || text.includes("codex")) {
    return "开发者和自动化用户优先关注，可能改变本地电脑任务执行方式。";
  }
  if (text.includes("translate") || text.includes("翻译")) {
    return "语音、客服、会议和内容出海场景会直接受影响。";
  }
  if (text.includes("agent") || text.includes("智能体")) {
    return "智能体工作流和工具调用效率可能提升，适合评估接入成本。";
  }
  if (text.includes("api")) {
    return "可集成能力增强，适合判断是否能放进自己的产品或内部工具。";
  }

  const impactByCategory = {
    "ai-models": "影响模型选型、API 接入和自动化能力边界。",
    "ai-products": "影响产品体验、工作流替代和可直接试用的工具选择。",
    industry: "影响平台战略、行业落地、合规安全或商业化判断。",
    paper: "影响下一阶段技术路线，适合关注是否会产品化。",
    tip: "影响团队实践方法，适合转成流程、提示词或开发规范。",
    other: "作为补充信号，适合快速判断是否继续追踪。",
  };
  return impactByCategory[category] || impactByCategory.other;
}

export function normalizeItem(item) {
  return {
    id: repairMojibake(item.id || ""),
    title: repairMojibake(item.title || item.title_en || "Untitled"),
    url: repairMojibake(item.url || ""),
    source: repairMojibake(item.source || ""),
    publishedAt: repairMojibake(item.publishedAt || ""),
    summary: repairMojibake(item.summary || ""),
    category: repairMojibake(item.category || "other"),
    score: normalizedScore(item.score ?? item.impactScore),
  };
}

export function groupItemsByCategory(items) {
  const groups = new Map();
  for (const item of items) {
    const category = normalizeCategory(item.category);
    if (!groups.has(category)) groups.set(category, []);
    groups.get(category).push(item);
  }
  return CATEGORY_ORDER.filter((category) => groups.has(category)).map((category) => [
    category,
    groups.get(category),
  ]);
}

export function dedupeItems(items) {
  const seen = new Set();
  const unique = [];
  for (const item of items) {
    const id = itemIdentity(item);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    unique.push(item);
  }
  return unique;
}

export function itemIdentity(item) {
  return String(item.id || item.url || item.title || "");
}

export function repairMojibake(value) {
  const text = String(value ?? "");
  if (!looksLikeLatin1Mojibake(text)) return text;
  const chars = Array.from(text);
  if (chars.some((char) => char.codePointAt(0) > 255)) return text;
  const bytes = Uint8Array.from(chars.map((char) => char.codePointAt(0)));
  const decoded = new TextDecoder("utf-8").decode(bytes);
  if (decoded.includes("�")) return text;
  if (mojibakeSignalCount(decoded) < mojibakeSignalCount(text)) return decoded;
  return cjkCount(decoded) > cjkCount(text) ? decoded : text;
}

function looksLikeLatin1Mojibake(text) {
  return /[\u0080-\u009f]|[ÃÂâäåæçèéï][\u0080-\u00ff]/.test(text);
}

function cjkCount(text) {
  return (String(text || "").match(/[\u3400-\u9fff]/g) || []).length;
}

function mojibakeSignalCount(text) {
  return (String(text || "").match(/[\u0080-\u009fÃÂâäåæçèéï]/g) || []).length;
}

function normalizedScore(value) {
  const score = Number(value);
  return Number.isFinite(score) ? Math.max(0, Math.min(100, Math.round(score))) : 0;
}

export function hasAny(text, needles) {
  const haystack = String(text || "").toLowerCase();
  return needles.some((needle) => haystack.includes(String(needle).toLowerCase()));
}

function scoreIf(condition, score) {
  return condition ? score : 0;
}

function clampScore(value, min, max) {
  return Math.max(min, Math.min(max, Math.round(value)));
}

export function compactText(text, maxLength) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  return clean.length > maxLength ? `${clean.slice(0, maxLength - 1)}...` : clean;
}

export function chunk(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

export function clamp(text, maxLength) {
  return text.length > maxLength ? `${text.slice(0, maxLength - 20)}\n\n...内容过长，已截断。` : text;
}

function escapeMarkdown(value) {
  return String(value || "").replace(/\[/g, "\\[").replace(/\]/g, "\\]");
}

export function formatBeijingTime(value) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

export function formatDateKey(value) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(value));
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day}`;
}
