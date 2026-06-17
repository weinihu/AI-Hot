const AIHOT_FEED_API = "https://aihot.virxact.com/api/public/feed";
const AIHOT_LEGACY_ITEMS_API = "https://aihot.virxact.com/api/public/items";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export async function fetchAIHotItems({ since, take, category, maxPages = 3 }) {
  try {
    return await fetchAIHotFeedItems({ since, category, maxPages });
  } catch {
    return fetchLegacyAIHotItems({ since, take, category, maxPages });
  }
}

async function fetchAIHotFeedItems({ since, category, maxPages = 3 }) {
  const pageLimit = Math.max(1, Math.min(Number(maxPages) || 1, 10));
  const sinceMs = Date.parse(since || "");
  const output = [];
  let cursor = null;

  for (let page = 1; page <= pageLimit; page += 1) {
    const data = await fetchAIHotFeedPage({ category, cursor });
    const normalized = normalizeAIHotResponse(data);
    const pageItems = filterItemsSince(normalized.items, sinceMs);
    output.push(...pageItems);
    if (reachedSinceBoundary(normalized.items, sinceMs)) break;
    if (!normalized.hasNext || !normalized.nextCursor) break;
    cursor = normalized.nextCursor;
  }

  return output;
}

async function fetchLegacyAIHotItems({ since, take, category, maxPages = 3 }) {
  const pageLimit = Math.max(1, Math.min(Number(maxPages) || 1, 10));
  const output = [];
  let cursor = "";

  for (let page = 1; page <= pageLimit; page += 1) {
    const data = await fetchLegacyAIHotPage({ since, take, category, cursor });
    const normalized = normalizeAIHotResponse(data);
    output.push(...normalized.items);
    if (!normalized.hasNext || !normalized.nextCursor) break;
    cursor = normalized.nextCursor;
  }

  return output;
}

async function fetchAIHotFeedPage({ category, cursor }) {
  const url = new URL(AIHOT_FEED_API);
  url.searchParams.set("mode", "selected");
  if (category) url.searchParams.set("category", category);
  if (cursor?.at) url.searchParams.set("cursorAt", String(cursor.at));
  if (cursor?.id) url.searchParams.set("cursorId", cursor.id);

  return fetchJsonWithRetry(url);
}

async function fetchLegacyAIHotPage({ since, take, category, cursor }) {
  const url = new URL(AIHOT_LEGACY_ITEMS_API);
  url.searchParams.set("mode", "selected");
  url.searchParams.set("since", since);
  url.searchParams.set("take", String(take));
  if (category) url.searchParams.set("category", category);
  if (cursor) url.searchParams.set("cursor", cursor);

  return fetchJsonWithRetry(url);
}

function filterItemsSince(items, sinceMs) {
  if (!Number.isFinite(sinceMs)) return items;
  return items.filter((item) => itemTimeMs(item) >= sinceMs);
}

function reachedSinceBoundary(items, sinceMs) {
  return Number.isFinite(sinceMs) && items.length > 0 && items.every((item) => itemTimeMs(item) < sinceMs);
}

function itemTimeMs(item) {
  const value = new Date(item?.publishedAt || 0).getTime();
  return Number.isFinite(value) ? value : 0;
}

function normalizeAIHotResponse(data) {
  if (!data || typeof data !== "object") throw new Error("AI HOT schema error: response must be an object.");
  if (!Array.isArray(data.items)) throw new Error("AI HOT schema error: items must be an array.");
  const normalized = {
    items: data.items.map(normalizeAIHotItem),
    hasNext: Boolean(data.hasNext),
    nextCursor: data.nextCursor || null,
  };
  validateAIHotResponse(normalized);
  return normalized;
}

function normalizeAIHotItem(item) {
  const source = typeof item?.source === "string" ? item.source : item?.source?.name || item?.author || "AI HOT";
  const category = normalizeFeedCategory(item);
  return {
    id: String(item?.id || item?.url || item?.titleZh || item?.title || ""),
    title: String(item?.titleZh || item?.title || item?.title_en || "Untitled"),
    url: String(item?.url || ""),
    source: String(source || "AI HOT"),
    publishedAt: String(item?.publishedAt || publishedAtFromDateKey(item?.dateKey) || ""),
    summary: String(item?.summaryZh || item?.summary || item?.aiSelectedReason || ""),
    category,
    score: normalizedScore(item?.finalScore ?? item?.score ?? item?.qualityScore ?? item?.importance ?? item?.impactScore),
  };
}

function normalizeFeedCategory(item) {
  if (typeof item?.category === "string" && item.category.trim()) return item.category;
  const tags = Array.isArray(item?.aiTags)
    ? item.aiTags.map((tag) => (typeof tag === "string" ? tag : tag?.tag || "")).join(" ")
    : "";
  const text = `${item?.titleZh || item?.title || ""} ${item?.summaryZh || item?.summary || ""} ${tags}`.toLowerCase();
  if (hasAny(text, ["paper", "arxiv", "论文", "研究", "benchmark", "eval", "数据集"])) return "paper";
  if (hasAny(text, ["model", "llm", "gpt", "claude", "gemini", "kimi", "qwen", "minimax", "模型", "权重"])) return "ai-models";
  if (hasAny(text, ["api", "sdk", "agent", "coding", "github", "产品", "工具", "开源", "插件", "编码"])) return "ai-products";
  if (hasAny(text, ["融资", "收购", "上市", "监管", "政策", "公司", "行业", "估值", "裁员"])) return "industry";
  if (hasAny(text, ["技巧", "观点", "方法", "教程", "prompt", "提示词"])) return "tip";
  return "other";
}

function hasAny(text, patterns) {
  return patterns.some((pattern) => text.includes(pattern));
}

function publishedAtFromDateKey(dateKey) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(dateKey || "")) ? `${dateKey}T00:00:00.000+08:00` : "";
}

function normalizedScore(value) {
  const score = Number(value);
  return Number.isFinite(score) ? Math.max(0, Math.min(100, Math.round(score))) : 0;
}

async function fetchJsonWithRetry(url) {
  let lastError = "";
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const response = await fetch(url.toString(), {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json",
      },
    });

    if (response.ok) return response.json();

    lastError = `AI HOT request failed: ${response.status} ${response.statusText || "<none>"}`;
    if (!isRetryableAIHotStatus(response.status) || attempt === 3) break;
    await sleep(250 * attempt);
  }

  throw new Error(lastError);
}

export function validateAIHotResponse(data) {
  if (!data || typeof data !== "object") throw new Error("AI HOT schema error: response must be an object.");
  if (!Array.isArray(data.items)) throw new Error("AI HOT schema error: items must be an array.");
  if ("hasNext" in data && typeof data.hasNext !== "boolean") throw new Error("AI HOT schema error: hasNext must be boolean.");
  if (data.hasNext && !isValidCursor(data.nextCursor)) throw new Error("AI HOT schema error: nextCursor is required when hasNext is true.");

  data.items.forEach((item, index) => validateAIHotItem(item, index));
  return true;
}

function isValidCursor(cursor) {
  if (typeof cursor === "string" && cursor.trim()) return true;
  return Boolean(cursor && typeof cursor === "object" && typeof cursor.id === "string" && Number.isFinite(Number(cursor.at)));
}

function validateAIHotItem(item, index) {
  if (!item || typeof item !== "object") throw new Error(`AI HOT schema error: item ${index} must be an object.`);
  for (const field of ["id", "title", "url", "source", "publishedAt", "category"]) {
    if (typeof item[field] !== "string" || !item[field].trim()) {
      throw new Error(`AI HOT schema error: item ${index}.${field} must be a non-empty string.`);
    }
  }
  if (!Number.isFinite(Number(item.score))) throw new Error(`AI HOT schema error: item ${index}.score must be numeric.`);
}

function isRetryableAIHotStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForScheduledSendTime(meta, config) {
  if (meta.source !== "cron") return 0;
  const waitMs = Math.min(
    millisecondsUntilBeijingTime(new Date(), config.sendHourBeijing, config.sendMinuteBeijing),
    config.maxSendWaitMs,
  );
  if (waitMs > 0) await sleep(waitMs);
  return waitMs;
}

export function millisecondsUntilBeijingTime(nowValue, hour, minute) {
  const now = new Date(nowValue);
  if (Number.isNaN(now.getTime())) return 0;

  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const targetUtcMs = Date.UTC(
    Number(byType.year),
    Number(byType.month) - 1,
    Number(byType.day),
    Number(hour) - 8,
    Number(minute),
    0,
    0,
  );

  return Math.max(0, targetUtcMs - now.getTime());
}
