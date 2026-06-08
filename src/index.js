import { fetchAIHotItems, millisecondsUntilBeijingTime, validateAIHotResponse, waitForScheduledSendTime } from "./aihot.js";
import {
  buildBitableFieldDefinitions,
  buildBitableFields,
  buildDailyBitableFields,
  cleanupDailyIndexViews,
  compactLegacyBitableTables,
  dailyArchiveKVKey,
  getDailyIndexStatus,
  prepareFeishuBitableSchema,
  resetDailyIndexLibrary,
  selectMissingBitableFieldDefinitions,
  syncFeishuBitable,
} from "./bitable.js";
import { getConfig, normalizeCategory } from "./config.js";
import { sendFeishu } from "./feishu.js";
import {
  buildDigest,
  buildFeishuCard,
  dedupeItems,
  formatDateKey,
  rankInfluentialItems,
  repairMojibake,
  toOriginalSiteItem,
} from "./formatter.js";
import {
  getBriefAnalysis,
  openAIChatEndpointCandidates,
  openAIEndpointCandidates,
} from "./openai.js";

const SITE_SNAPSHOT_KV_KEY = "site_snapshot:v1";
const PUBLIC_BROWSER_CACHE_SECONDS = 60;
const PUBLIC_EDGE_CACHE_SECONDS = 10 * 60;
const PUBLIC_HTML_CACHE_VERSION = "2026-06-08-portal-curated-layout";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return jsonResponse({
        ok: true,
        service: "aihot-feishu-briefing",
        version: "2026-06-08-portal-curated-layout",
        cron: "29 13 * * *",
        timezone_note: "Trigger Beijing 21:29 = UTC 13:29; Feishu send waits until Beijing 21:30 if ready early.",
      });
    }

    if (url.pathname === "/debug-config") {
      if (!isAuthorized(request, env)) return unauthorized();
      return jsonResponse({
        ok: true,
        model: env.OPENAI_MODEL || "gpt-5.5",
        openAIBaseURL: env.OPENAI_BASE_URL || "https://api.openai.com/v1",
        hasOpenAIKey: Boolean(env.OPENAI_API_KEY),
        hasFeishuWebhook: Boolean(env.FEISHU_WEBHOOK),
        hasBitableApp: Boolean(env.FEISHU_APP_ID && env.FEISHU_APP_SECRET),
        hasBitableTable: Boolean(env.FEISHU_BITABLE_APP_TOKEN && env.FEISHU_BITABLE_TABLE_ID),
        hasKV: Boolean(env.AIHOT_KV),
      });
    }

    if (url.pathname === "/api/latest") {
      if (!isAuthorized(request, env)) return unauthorized();
      return jsonResponse((await getLatestDigest(env)) || { ok: true, message: "No digest yet." });
    }

    if (url.pathname === "/api/archive") {
      if (!isAuthorized(request, env)) return unauthorized();
      const date = url.searchParams.get("date") || "";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return jsonResponse({ ok: false, error: "date must be YYYY-MM-DD" }, 400);
      return jsonResponse((await getDailyArchive(env, date)) || { ok: true, message: "No archive for this date." });
    }

    if (url.pathname === "/api/index-status") {
      if (!isAuthorized(request, env)) return unauthorized();
      try {
        return jsonResponse(await getDailyIndexStatus(env));
      } catch (error) {
        return jsonResponse({ ok: false, error: publicErrorMessage(error) }, 500);
      }
    }

    if (url.pathname === "/") {
      return publicHtmlResponse(request, ctx, async () => renderHomePage(await getDailyArchives(env)));
    }

    if (url.pathname === "/library") {
      return publicHtmlResponse(request, ctx, async () => renderLibraryPage(await getDailyArchives(env), url));
    }

    if (url.pathname === "/review") {
      return publicHtmlResponse(request, ctx, async () => renderReviewPage(await getDailyArchives(env), url));
    }

    if (url.pathname === "/daily") {
      const date = url.searchParams.get("date") || "";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return htmlResponse(renderDailyPage(null, "请选择有效日期。"), 400);
      return publicHtmlResponse(request, ctx, async () => {
        const archives = await getDailyArchives(env);
        const archive = archives.find((item) => item.date === date) || null;
        return renderDailyPage(archive, "", archives);
      });
    }

    if (url.pathname === "/run-now") {
      if (!isAuthorized(request, env)) return unauthorized();
      try {
        return jsonResponse(await runBriefing(env, { source: "manual" }));
      } catch (error) {
        return jsonResponse({ ok: false, error: publicErrorMessage(error) }, 500);
      }
    }

    if (url.pathname === "/archive-now") {
      if (!isAuthorized(request, env)) return unauthorized();
      try {
        return jsonResponse(await runBriefing(env, { source: "manual", skipFeishu: true }));
      } catch (error) {
        return jsonResponse({ ok: false, error: publicErrorMessage(error) }, 500);
      }
    }

    if (url.pathname === "/compact-legacy") {
      if (!isAuthorized(request, env)) return unauthorized();
      try {
        const result = await compactLegacyBitableTables(env);
        await rebuildSiteSnapshot(env);
        return jsonResponse(result);
      } catch (error) {
        return jsonResponse({ ok: false, error: publicErrorMessage(error) }, 500);
      }
    }

    if (url.pathname === "/cleanup-index-views") {
      if (!isAuthorized(request, env)) return unauthorized();
      try {
        return jsonResponse(await cleanupDailyIndexViews(env));
      } catch (error) {
        return jsonResponse({ ok: false, error: publicErrorMessage(error) }, 500);
      }
    }

    if (url.pathname === "/reset-index-library") {
      if (!isAuthorized(request, env)) return unauthorized();
      try {
        return jsonResponse(await resetDailyIndexLibrary(env));
      } catch (error) {
        return jsonResponse({ ok: false, error: publicErrorMessage(error) }, 500);
      }
    }

    if (url.pathname === "/rebuild-site-snapshot") {
      if (!isAuthorized(request, env)) return unauthorized();
      try {
        const archives = await rebuildSiteSnapshot(env);
        return jsonResponse({
          ok: true,
          key: SITE_SNAPSHOT_KV_KEY,
          archives: archives.length,
          latestDate: archives[0]?.date || "",
          note: "公开页面已改为读取 site snapshot；这个端点只在手动回填或修复时使用。",
        });
      } catch (error) {
        return jsonResponse({ ok: false, error: publicErrorMessage(error) }, 500);
      }
    }

    return publicHtmlResponse(request, ctx, async () => renderHomePage(await getDailyArchives(env)));
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runBriefing(env, { source: "cron", scheduledTime: event.scheduledTime }));
  },
};

async function runBriefing(env, meta = {}) {
  const startedAt = new Date().toISOString();
  const config = getConfig(env);
  const schemaResult = await prepareFeishuBitableSchema(env);
  if (schemaResult.needsRerun) {
    const result = {
      ok: true,
      source: meta.source || "unknown",
      startedAt,
      finishedAt: new Date().toISOString(),
      schema: schemaResult,
      message:
        schemaResult.remaining > 0
          ? `已补充 ${schemaResult.created} 个多维表格字段，剩余 ${schemaResult.remaining} 个。请再次运行，直到字段补齐后再写入日报。`
          : `已补充最后 ${schemaResult.created} 个多维表格字段。请再次运行，下一次会正式写入日报。`,
    };
    await putLatestDigest(env, result);
    return result;
  }

  const since = new Date(Date.now() - config.lookbackHours * 60 * 60 * 1000).toISOString();
  const rawItems = await fetchAIHotItems({ since, take: config.take, maxPages: config.maxPages });
  const originalItems = rawItems.map((item, index) => toOriginalSiteItem(item, index + 1));
  const selectedItems = selectScoredItems(originalItems, {
    minScore: config.minScore,
    maxItems: config.maxItems,
    excludeCategory: "paper",
  });

  const paperSince = new Date(Date.now() - config.paperLookbackHours * 60 * 60 * 1000).toISOString();
  let rawPaperItems = [];
  try {
    rawPaperItems = await fetchAIHotItems({
      since: paperSince,
      take: config.paperTake,
      category: "paper",
      maxPages: config.paperMaxPages,
    });
  } catch (error) {
    rawPaperItems = [];
  }
  const paperItems = selectScoredItems(rawPaperItems.map((item, index) => toOriginalSiteItem(item, index + 1)), {
    minScore: config.minScore,
    maxItems: config.paperMaxItems,
  });

  const analysisItems = dedupeItems([...selectedItems, ...paperItems]);
  const analysisResult = await getBriefAnalysis(env, analysisItems, config, paperItems);
  const bitableItems = dedupeItems([...selectedItems, ...paperItems]).slice(0, config.bitableMaxRecords);
  const dailyUrl = `${config.publicBaseURL}/daily?date=${formatDateKey(startedAt)}`;
  const bitableResult = await syncFeishuBitable(env, bitableItems, {
    startedAt,
    checkedCount: rawItems.length,
    selectedCount: selectedItems.length,
    model: analysisResult.model || config.model,
    usage: analysisResult.usage,
    analysisText: analysisResult.text,
    analysisStatus: analysisResult,
    dailyUrl,
    minScore: config.minScore,
  });

  const digest = buildDigest({
    items: selectedItems,
    paperItems,
    analysis: analysisResult.text,
    analysisStatus: analysisResult,
    usage: analysisResult.usage,
    model: analysisResult.model || config.model,
    startedAt,
    checkedCount: rawItems.length,
    bitableResult,
    dailyUrl,
    publicBaseURL: config.publicBaseURL,
    minScore: config.minScore,
  });
  const feishuCard = buildFeishuCard({
    items: selectedItems,
    paperItems,
    analysis: analysisResult.text,
    analysisStatus: analysisResult,
    usage: analysisResult.usage,
    model: analysisResult.model || config.model,
    startedAt,
    checkedCount: rawItems.length,
    bitableResult,
    dailyUrl,
    publicBaseURL: config.publicBaseURL,
    minScore: config.minScore,
  });

  const sendWaitMs = await waitForScheduledSendTime(meta, config);
  if (!meta.skipFeishu) await sendFeishu(env, digest, feishuCard);

  const result = {
    ok: true,
    source: meta.source || "unknown",
    feishuSkipped: Boolean(meta.skipFeishu),
    startedAt,
    finishedAt: new Date().toISOString(),
    checked: rawItems.length,
    selected: selectedItems.length,
    papers: paperItems.length,
    sendWaitMs,
    minScore: config.minScore,
    analysis: analysisStatusForLatest(analysisResult),
    bitable: bitableResult,
    titles: analysisItems.map((item) => item.title),
    digest,
  };

  await putLatestDigest(env, result);
  await rebuildSiteSnapshot(env);
  return result;
}

function analysisStatusForLatest(analysisResult) {
  return {
    ok: analysisResult.ok === true,
    status: analysisResult.status || "unknown",
    fallback: Boolean(analysisResult.fallback),
    error: analysisResult.error || "",
    model: analysisResult.model || "",
    usage: analysisResult.usage || { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
  };
}

function selectScoredItems(items, { minScore, maxItems, excludeCategory = "" }) {
  const threshold = Number(minScore) || 0;
  return dedupeItems(items)
    .filter((item) => !excludeCategory || normalizeCategory(item.category) !== excludeCategory)
    .filter((item) => itemScore(item) >= threshold)
    .sort(compareScoredItems)
    .slice(0, maxItems);
}

function compareScoredItems(a, b) {
  const scoreDiff = itemScore(b) - itemScore(a);
  if (scoreDiff !== 0) return scoreDiff;
  return new Date(b.publishedAt || 0).getTime() - new Date(a.publishedAt || 0).getTime();
}

function itemScore(item) {
  const score = Number(item?.score ?? item?.impactScore);
  return Number.isFinite(score) ? score : 0;
}

function isAuthorized(request, env) {
  if (!env.ADMIN_TOKEN) return false;
  const url = new URL(request.url);
  const bearer = request.headers.get("Authorization") || "";
  return bearer === `Bearer ${env.ADMIN_TOKEN}` || url.searchParams.get("token") === env.ADMIN_TOKEN;
}

function unauthorized() {
  return jsonResponse({ ok: false, error: "Unauthorized" }, 401);
}

async function getLatestDigest(env) {
  if (!env.AIHOT_KV) return null;
  const text = await env.AIHOT_KV.get("latest_digest");
  return text ? JSON.parse(text) : null;
}

async function getDailyArchive(env, dateKey) {
  if (!env.AIHOT_KV) return null;
  const text = await env.AIHOT_KV.get(dailyArchiveKVKey(dateKey));
  return text ? repairArchiveText(JSON.parse(text)) : null;
}

async function getDailyArchives(env) {
  const snapshotArchives = await getSiteSnapshotArchives(env);
  if (snapshotArchives) return snapshotArchives;
  return rebuildSiteSnapshot(env);
}

async function getSiteSnapshotArchives(env) {
  if (!env.AIHOT_KV) return [];
  const text = await env.AIHOT_KV.get(SITE_SNAPSHOT_KV_KEY);
  if (!text) return null;
  try {
    const snapshot = JSON.parse(text);
    if (!snapshot || !Array.isArray(snapshot.archives)) return null;
    return normalizeArchiveList(snapshot.archives);
  } catch {
    return null;
  }
}

async function rebuildSiteSnapshot(env) {
  const archives = await listDailyArchivesFromKV(env);
  await putSiteSnapshot(env, archives);
  return archives;
}

async function listDailyArchivesFromKV(env) {
  if (!env.AIHOT_KV) return [];
  const archives = [];
  let cursor;
  do {
    const listed = await env.AIHOT_KV.list({ prefix: "archive:", cursor, limit: 1000 });
    for (const key of listed.keys || []) {
      const text = await env.AIHOT_KV.get(key.name);
      if (!text) continue;
      try {
        const archive = JSON.parse(text);
        if (archive && archive.date && Array.isArray(archive.cards)) archives.push(archive);
      } catch {
        // Ignore malformed archive entries.
      }
    }
    cursor = listed.list_complete ? undefined : listed.cursor;
  } while (cursor);
  return normalizeArchiveList(archives);
}

async function putSiteSnapshot(env, archives) {
  if (!env.AIHOT_KV) return;
  await env.AIHOT_KV.put(
    SITE_SNAPSHOT_KV_KEY,
    JSON.stringify({
      version: 1,
      generatedAt: new Date().toISOString(),
      archives: normalizeArchiveList(archives),
    }),
  );
}

function normalizeArchiveList(archives) {
  return (Array.isArray(archives) ? archives : [])
    .filter((archive) => archive && archive.date && Array.isArray(archive.cards))
    .map(repairArchiveText)
    .sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
}

function repairArchiveText(value) {
  if (typeof value === "string") return repairMojibake(value);
  if (Array.isArray(value)) return value.map(repairArchiveText);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, repairArchiveText(item)]));
  }
  return value;
}

async function putLatestDigest(env, value) {
  if (!env.AIHOT_KV) return;
  await env.AIHOT_KV.put("latest_digest", JSON.stringify(value), { expirationTtl: 60 * 60 * 24 * 30 });
}

function publicErrorMessage(error) {
  const message = error && error.message ? error.message : String(error);
  if (/invalid_api_key|Incorrect API key/i.test(message)) {
    return "OpenAI API Key 无效或当前 key 只能用于本机中转，Cloudflare 无法直接使用。";
  }
  return message.replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-***");
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

async function publicHtmlResponse(request, ctx, renderHtml) {
  if (request.method !== "GET") {
    return htmlResponse(await renderHtml());
  }

  const cache = globalThis.caches?.default;
  const cacheUrl = publicHtmlCacheUrl(request.url);
  const cacheKey = new Request(cacheUrl, { method: "GET" });
  if (cache) {
    const cached = await cache.match(cacheKey);
    if (cached) {
      return new Response(cached.body, {
        status: cached.status,
        headers: publicHtmlClientHeaders("HIT"),
      });
    }
  }

  const html = await renderHtml();
  const response = new Response(html, {
    status: 200,
    headers: publicHtmlClientHeaders("MISS"),
  });
  if (cache) {
    const cacheResponse = htmlResponse(html, 200, {
      "Cache-Control": `public, max-age=${PUBLIC_EDGE_CACHE_SECONDS}, s-maxage=${PUBLIC_EDGE_CACHE_SECONDS}, stale-while-revalidate=60`,
    });
    const put = cache.put(cacheKey, cacheResponse);
    if (ctx?.waitUntil) ctx.waitUntil(put);
    else await put;
  }
  return response;
}

function publicHtmlClientHeaders(cacheStatus) {
  return {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": `public, max-age=${PUBLIC_BROWSER_CACHE_SECONDS}, no-cache, must-revalidate`,
    "CDN-Cache-Control": `public, max-age=${PUBLIC_EDGE_CACHE_SECONDS}, stale-while-revalidate=60`,
    "Cloudflare-CDN-Cache-Control": `public, max-age=${PUBLIC_EDGE_CACHE_SECONDS}, stale-while-revalidate=60`,
    "X-AIHot-Cache": cacheStatus,
  };
}

function publicHtmlCacheUrl(rawUrl) {
  const url = new URL(rawUrl);
  for (const key of [...url.searchParams.keys()]) {
    if (/^utm_|^fbclid$|^gclid$|^_/.test(key)) url.searchParams.delete(key);
  }
  url.searchParams.set("_aihot_v", PUBLIC_HTML_CACHE_VERSION);
  return url.toString();
}

function htmlResponse(html, status = 200, headers = {}) {
  const responseHeaders = {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  };
  return new Response(html, {
    status,
    headers: responseHeaders,
  });
}

function renderHomePage(archives) {
  const safeArchives = Array.isArray(archives) ? archives.filter((archive) => archive && archive.date) : [];
  const cards = flattenArchiveCards(safeArchives);
  const latestDate = safeArchives[0]?.date || formatDateKey(new Date());
  const review = buildPeriodReview(safeArchives, 30);
  const latestArchive = safeArchives[0];
  const latestSummary = latestArchive ? dailyPageSummary(latestArchive) : "每天把 AI HOT 的精选内容整理成清爽日报，帮你快速扫过模型、产品、论文和行业变化。";
  const primaryTopics = review.topics.slice(0, 5).map((item) => item.name).join("、") || "论文、工具、模型、行业变化";
  const typeSummary = dailyPageCategories(cards).slice(0, 7);
  const latestCards = Array.isArray(latestArchive?.cards) ? latestArchive.cards.slice(0, 4) : [];
  const sourceCount = new Set(cards.map((card) => card.source).filter(Boolean)).size;
  const paperCount = cards.filter((card) => card.knowledge?.isPaper === "是" || /论文/.test(cardType(card))).length;
  const toolCount = cards.filter((card) => cardType(card) === "工具/项目候选").length;
  const recentCards = countArchiveCards(safeArchives.slice(0, 7));
  const previousCards = countArchiveCards(safeArchives.slice(7, 14));
  const delta = recentCards - previousCards;
  const dailyAverage = safeArchives.length ? Math.round(cards.length / safeArchives.length) : 0;
  const sourceRanks = topSourceCounts(cards, 5);
  const topCategory = typeSummary[0]?.name || "知识卡片";
  const activeDaysText = safeArchives.length
    ? `${safeArchives[safeArchives.length - 1].date} 至 ${safeArchives[0].date}`
    : "等待第一份归档";
  const latestHref = `/daily?date=${escapeAttribute(latestDate)}`;
  const latestTitle = latestCards[0]?.title ? compactPageText(latestCards[0].title, 34) : "今日重点等待归档";
  const topTopic = review.topics[0]?.name || "AI 方向";
  const secondTopic = review.topics[1]?.name || "工具项目";
  const latestCardCount = Array.isArray(latestArchive?.cards) ? latestArchive.cards.length : 0;
  const signalCards = topScoredCards(cards, 4);
  const leadSignal = signalCards[0] || latestCards[0] || null;
  const briefingCards = uniqueCards([leadSignal, ...signalCards, ...latestCards, ...cards]).slice(0, 8);
  const leadSignalTitle = leadSignal?.title ? compactPageText(leadSignal.title, 42) : "等待高价值线索";
  const leadSignalSource = leadSignal?.source ? compactPageText(leadSignal.source, 28) : "AI HOT";
  const leadSignalFact = leadSignal
    ? compactPageText(leadSignal.knowledge?.fact || leadSignal.summary || "打开最新归档查看完整条目。", 96)
    : "当日报生成后，这里会按上游分数和归档时间给出第一条值得追踪的线索。";
  const leadSignalHref = leadSignal?.archiveDate ? `/daily?date=${escapeAttribute(leadSignal.archiveDate)}` : latestHref;
  const cadenceCopy =
    safeArchives.length >= 14 && previousCards > 0
      ? `${delta >= 0 ? "本周新增比前一周期多" : "本周新增比前一周期少"} ${Math.abs(delta)} 张卡片，最新周期仍在持续沉淀。`
      : `最近 ${Math.min(7, safeArchives.length || 7)} 天新增 ${recentCards} 张卡片，归档覆盖 ${activeDaysText}。`;

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>AI HOT Daily</title>
  <style>${dailyPageCSS()}</style>
</head>
<body>
  <main class="shell homeShell">
    ${renderSiteNav("home", latestDate)}
    <section class="homeArtHero" aria-label="AI HOT 知识入口">
      <div class="heroCopyBlock">
        <p class="heroKicker">AI HOT 知识入口</p>
        <h1 class="heroHeadline">
          <span>AI HOT</span>
          <span>情报台</span>
        </h1>
        <p class="heroLead">${escapeHtml(latestDate)} 已沉淀 ${latestCardCount} 张卡片。先看今日主线、优先线索和最近节奏，再进入知识库、阶段复盘或单日归档继续追踪。</p>
        <div class="heroActionBar">
          <a class="primaryLink" href="/library">进入知识库</a>
          <a class="navButton" href="/review?days=30">查看阶段复盘</a>
          <a class="navButton" href="${latestHref}">打开最新日报</a>
        </div>
        <div class="heroMicroStats heroCapsules" aria-label="归档状态">
          <span><b>${safeArchives.length}</b> 天归档</span>
          <span><b>${cards.length}</b> 张卡片</span>
          <span><b>${sourceCount}</b> 个来源</span>
        </div>
      </div>
      <div class="heroPortalScene" aria-label="核心入口预览">
        <div class="portalWindow" aria-hidden="true">
          <div class="windowChrome"><i></i><i></i><i></i></div>
          <div class="windowBoard">
            <div class="windowBoardHeader">
              <span>${escapeHtml(latestDate)}</span>
              <strong>${latestCardCount} 张</strong>
            </div>
            ${renderHeroMiniBars(safeArchives.slice(0, 10))}
            ${renderHeroTopicRows(review.topics.slice(0, 4))}
            <div class="miniDock">
              <span>论文 ${paperCount}</span>
              <span>工具 ${toolCount}</span>
              <span>来源 ${sourceCount}</span>
            </div>
          </div>
        </div>
        <a class="floatEntry floatDaily" href="${latestHref}">
          <span>Daily</span>
          <strong>每日重点</strong>
          <p>${escapeHtml(compactPageText(latestTitle, 42))}</p>
        </a>
        <a class="floatEntry floatLibrary" href="/library">
          <span>Library</span>
          <strong>知识沉淀</strong>
          <p>${cards.length} 张卡片，按主题、来源和日期长期检索。</p>
        </a>
        <a class="floatEntry floatReview" href="/review?days=30">
          <span>Review</span>
          <strong>趋势复盘</strong>
          <p>${escapeHtml(compactPageText(review.summary, 54))}</p>
        </a>
      </div>
    </section>

    ${renderHomeBriefingDeck({
      date: latestDate,
      latestHref,
      latestArchive,
      cards: briefingCards,
      sourceCount,
      cadenceCopy,
    })}

    <section class="homeVisualSummary" aria-label="内容概览">
      <section class="visualTile trendTile">
        <div class="tileCopy">
          <span>最近 14 天</span>
          <h2>归档节奏</h2>
          <p>${escapeHtml(cadenceCopy)}</p>
        </div>
        ${renderTrendAreaChart(safeArchives.slice(0, 14))}
      </section>
      <section class="visualTile structureTile">
        <div class="tileCopy">
          <span>内容结构</span>
          <h2>${escapeHtml(topCategory)}</h2>
          <p>${escapeHtml(topTopic)}、${escapeHtml(secondTopic)} 是近期反复出现的方向。</p>
        </div>
        ${renderTypeSegments(typeSummary)}
      </section>
      <section class="visualTile sourceTile">
        <div class="tileCopy">
          <span>来源</span>
          <h2>${sourceCount} 个入口</h2>
          <p>优先保留能继续阅读和复盘的来源。</p>
        </div>
        ${renderSourceList(sourceRanks)}
      </section>
    </section>

    ${renderHomeChannelMatrix(typeSummary, cards)}

    <section class="homeSignalBoard" aria-label="高价值线索">
      <div class="signalNarrative">
        <span>Signal Board</span>
        <h2>先追踪最有价值的一条线索</h2>
        <p>当前优先级最高的是「${escapeHtml(leadSignalTitle)}」，来自 ${escapeHtml(leadSignalSource)}。${escapeHtml(leadSignalFact)}</p>
        <a class="primaryLink" href="${leadSignalHref}">查看这条线索</a>
      </div>
      <div class="signalQueue">
        ${renderHomeSignalQueue(signalCards)}
      </div>
    </section>

    ${renderHomeDailyRiver(safeArchives.slice(0, 10))}

    <section class="homeContentRibbon" aria-label="最新内容">
      <div class="ribbonIntro">
        <span>Latest</span>
        <h2>今天先看这些</h2>
        <p>${escapeHtml(compactPageText(latestSummary, 88))}</p>
      </div>
      <div class="ribbonCards">
        ${renderHomeLatestSignals(latestCards)}
      </div>
    </section>

    <section class="homeRouteGallery" aria-label="阅读入口">
      <a class="routePane routePrimary" href="/library">
        <span>Library</span>
        <strong>进入知识库</strong>
        <p>按关键词、日期和类型找回具体内容。</p>
      </a>
      <a class="routePane" href="/review?days=30">
        <span>Review</span>
        <strong>看阶段复盘</strong>
        <p>把多天内容压成趋势、论文池和工具池。</p>
      </a>
      <a class="routePane" href="${latestHref}">
        <span>Daily</span>
        <strong>读最新日报</strong>
        <p>${escapeHtml(latestDate)}，${latestCardCount} 张卡片。</p>
      </a>
    </section>

    <section class="homeFutureRibbon" aria-label="后续展望">
      <div>
        <span>Roadmap</span>
        <h2>把 ${cards.length} 张卡片继续做成研究入口</h2>
      </div>
      <div class="futureGrid">
        ${renderFutureCard("论文池", `${paperCount} 条论文线索`, "按方法、任务和复现价值拆分阅读队列", 72)}
        ${renderFutureCard("专题页", primaryTopics, "把反复出现的方向变成可分享的专题索引", 58)}
        ${renderFutureCard("周报月报", `${safeArchives.length} 天历史`, "把每天的碎片压成适合汇报的周期视图", 44)}
        ${renderFutureCard("语义检索", `${cards.length} 张卡片`, "用问题直接找答案，而不是只靠关键词", 36)}
      </div>
    </section>
  </main>
  <script>${dailyPageScript()}</script>
</body>
</html>`;
}

function renderLibraryPage(archives, url) {
  const safeArchives = Array.isArray(archives) ? archives.filter((archive) => archive && archive.date) : [];
  const cards = flattenArchiveCards(safeArchives);
  const latestDate = safeArchives[0]?.date || "";
  const categories = dailyPageCategories(cards);
  const dateOptions = safeArchives.map((archive) => ({
    date: archive.date,
    count: Array.isArray(archive.cards) ? archive.cards.length : 0,
  }));
  const cardHtml = cards.map((card) => renderKnowledgeCard(card, { showDate: true })).join("");
  const dateMin = safeArchives.length ? safeArchives[safeArchives.length - 1].date : "";
  const dateMax = latestDate;
  const sourceRanks = topSourceCounts(cards, 4);
  const sourceOptions = librarySourceOptions(cards);
  const librarySourceCount = new Set(cards.map((card) => card.source).filter(Boolean)).size;
  const paperCount = cards.filter((card) => card.knowledge?.isPaper === "是" || /论文/.test(cardType(card))).length;
  const toolCount = cards.filter((card) => cardType(card) === "工具/项目候选").length;
  const rangeText = safeArchives.length ? `${dateMin} 至 ${dateMax}` : "等待归档";
  const latestHeadline = cards[0]?.title ? compactPageText(cards[0].title, 34) : "等待第一条归档";

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>AI HOT 知识库</title>
  <style>${dailyPageCSS()}</style>
</head>
<body>
  <main class="shell">
    ${renderSiteNav("library", latestDate)}
    <header class="featureHero libraryFeatureHero" aria-label="知识库主视觉">
      <div class="featureHeroCopy">
        <p class="sectionLabel">检索入口</p>
        <h1>从 ${cards.length} 张卡片里找回具体线索</h1>
        <p class="muted">${escapeHtml(rangeText)}，覆盖 ${librarySourceCount || sourceRanks.length || 0} 个来源。先按方向、来源、类型缩小范围，再打开原文继续看。</p>
        <div class="heroActionBar">
          <a class="primaryLink" href="#libraryFinder">开始检索</a>
          <a class="navButton" href="/review?days=30">看 30 天复盘</a>
          <a class="navButton" href="/daily?date=${escapeAttribute(latestDate)}">最新归档</a>
        </div>
        <div class="heroMicroStats heroCapsules" aria-label="知识库状态">
          <span><b>${safeArchives.length}</b> 天</span>
          <span><b>${cards.length}</b> 张卡片</span>
          <span><b>${categories.length}</b> 类内容</span>
        </div>
      </div>
      ${renderLibraryHeroScene({ categories, sourceRanks, paperCount, toolCount, latestHeadline, dateMax })}
    </header>

    <section class="pageAtlas libraryAtlas" aria-label="知识库概览">
      <div class="atlasLead">
        <span>检索前概览</span>
        <h2>先看库里有什么，再决定怎么搜</h2>
        <p>${escapeHtml(rangeText)}，共 ${cards.length} 张知识卡片。当前更适合按方向、来源和类型快速缩小范围。</p>
      </div>
      <div class="atlasMetrics">
        ${renderHomeMetric("论文线索", paperCount, "适合继续阅读、复现和组内讨论")}
        ${renderHomeMetric("工具项目", toolCount, "适合试用、调研或加入观察清单")}
      </div>
      <div class="atlasPanel">
        <h3>类型分布</h3>
        ${renderTypeSegments(categories)}
      </div>
      <div class="atlasPanel">
        <h3>高频来源</h3>
        ${renderSourceList(sourceRanks)}
      </div>
    </section>

    <section class="rolePanel" aria-label="页面用途">
      <div class="roleCard">
        <span>搜索</span>
        <strong>我记得一个关键词</strong>
        <p>查标题、来源、方向、用途，适合快速找回某条信息。</p>
      </div>
      <div class="roleCard">
        <span>筛选</span>
        <strong>我只想看某类内容</strong>
        <p>按论文、工具、模型、行业观察筛选，减少阅读噪音。</p>
      </div>
      <div class="roleCard">
        <span>定位</span>
        <strong>我想回到某一天</strong>
        <p>按日期进入单日归档，适合从飞书日报继续深挖。</p>
      </div>
      <a class="roleCard roleLink" href="/review?days=30">
        <span>复盘</span>
        <strong>想看一段时间的变化</strong>
        <p>去阶段复盘看趋势、论文池和工具池。</p>
      </a>
    </section>

    <section class="finderPanel" id="libraryFinder" aria-label="检索">
      <div class="finderTop">
        <div class="search">
          <input id="searchInput" type="search" placeholder="搜索标题、来源、方向、用途" autocomplete="off" />
        </div>
        <select id="typeSelect" aria-label="类型筛选">
          <option value="all">全部类型</option>
          ${categories.map((item) => `<option value="${escapeAttribute(item.name)}">${escapeHtml(item.name)} (${item.count})</option>`).join("")}
        </select>
        <select id="sourceSelect" aria-label="来源筛选">
          <option value="all">全部来源</option>
          ${sourceOptions.map((item) => `<option value="${escapeAttribute(item.name)}">${escapeHtml(item.name)} (${item.count})</option>`).join("")}
        </select>
        <input id="startDate" type="date" min="${escapeAttribute(dateMin)}" max="${escapeAttribute(dateMax)}" aria-label="开始日期" />
        <input id="endDate" type="date" min="${escapeAttribute(dateMin)}" max="${escapeAttribute(dateMax)}" aria-label="结束日期" />
        <button type="button" id="clearFilters">重置</button>
      </div>
      <div class="dateRailWrap">
        <div class="dateRail" id="dateRail">
          <button class="active" type="button" data-date="all">全部日期</button>
          ${dateOptions.map((item) => `<button type="button" data-date="${escapeAttribute(item.date)}">${escapeHtml(item.date)} <span>${item.count}</span></button>`).join("")}
        </div>
      </div>
      <p class="resultLine"><span id="visibleCount">${cards.length}</span> 张卡片可见</p>
    </section>

    <section class="grid" id="cardGrid">${cardHtml}</section>
    <p class="empty" id="emptyState" hidden>没有匹配的卡片。</p>
  </main>
  <script>${dailyPageScript()}</script>
</body>
</html>`;
}

function renderReviewPage(archives, url) {
  const safeArchives = Array.isArray(archives) ? archives.filter((archive) => archive && archive.date) : [];
  const days = Math.max(1, Math.min(365, Number(url.searchParams.get("days")) || 30));
  const review = buildPeriodReview(safeArchives, days);
  const selectedArchives = safeArchives.slice(0, days);
  const selectedCards = flattenArchiveCards(selectedArchives);
  const selectedCategories = dailyPageCategories(selectedCards);
  const selectedSources = topSourceCounts(selectedCards, 4);
  const sampleCards = reviewSampleCards(review);
  const sampleHtml = sampleCards.map((card) => renderKnowledgeCard(card, { showDate: true })).join("");
  const latestDate = safeArchives[0]?.date || "";
  const reviewHeadline = reviewHeroHeadline(review);

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>AI HOT 阶段复盘</title>
  <style>${dailyPageCSS()}</style>
</head>
<body>
  <main class="shell reviewShell">
    ${renderSiteNav("review", latestDate)}
    <header class="featureHero reviewFeatureHero" aria-label="阶段复盘主视觉">
      <div class="featureHeroCopy">
        <p class="sectionLabel">复盘入口</p>
        <h1>${escapeHtml(reviewHeadline)}</h1>
        <p class="muted">${escapeHtml(review.summary)} 这里把多天归档压成方向、论文、工具和来源，不替代检索，而是帮你判断下一轮阅读重点。</p>
        <div class="rangeSwitch heroSwitch">
          <a class="${days === 7 ? "active" : ""}" href="/review?days=7">7 天</a>
          <a class="${days === 30 ? "active" : ""}" href="/review?days=30">30 天</a>
          <a class="${days === 90 ? "active" : ""}" href="/review?days=90">90 天</a>
        </div>
        <div class="heroMicroStats heroCapsules" aria-label="复盘状态">
          <span><b>${review.cardCount}</b> 张卡片</span>
          <span><b>${review.paperCount}</b> 条论文</span>
          <span><b>${review.toolCount}</b> 个工具</span>
        </div>
      </div>
      ${renderReviewHeroScene(review, selectedArchives)}
    </header>

    <section class="reviewIdentity" aria-label="页面区别">
      <div>
        <span>知识库</span>
        <strong>找具体信息</strong>
        <p>输入关键词，按日期和类型筛选，定位某一条内容。</p>
        <a href="/library">打开知识库</a>
      </div>
      <div class="active">
        <span>阶段复盘</span>
        <strong>看周期变化</strong>
        <p>把多天内容压成趋势、论文池、工具池和最近日报入口。</p>
      </div>
    </section>

    <section class="pageAtlas reviewAtlas" aria-label="周期趋势">
      <div class="atlasLead">
        <span>周期趋势</span>
        <h2>先看密度，再看方向</h2>
        <p>最近 ${review.daysCovered} 天共 ${review.cardCount} 张卡片，趋势图和类型分布用来决定下一轮阅读顺序。</p>
      </div>
      <div class="atlasPanel atlasTrend">
        <h3>归档走势</h3>
        ${renderTrendAreaChart(selectedArchives.slice(0, 14))}
      </div>
      <div class="atlasPanel">
        <h3>类型分布</h3>
        ${renderTypeSegments(selectedCategories)}
      </div>
      <div class="atlasPanel">
        <h3>来源集中度</h3>
        ${renderSourceList(selectedSources)}
      </div>
    </section>

    <section class="reviewPanel reviewOverview" aria-label="阶段概览">
      <div class="reviewHead">
        <div>
          <p class="sectionLabel">周期概览</p>
          <h2>最近 ${review.daysCovered} 天有什么变化</h2>
          <p class="muted">${escapeHtml(review.summary)}</p>
        </div>
      </div>
      <div class="reviewGrid">
        ${renderReviewMetric("归档天数", review.daysCovered)}
        ${renderReviewMetric("知识卡片", review.cardCount)}
        ${renderReviewMetric("最新论文", review.paperCount)}
        ${renderReviewMetric("工具项目", review.toolCount)}
      </div>
    </section>

    <section class="reviewDashboard" aria-label="复盘看板">
      <section class="reviewGlassBlock directionBlock">
        <div class="blockTitle">
          <p class="sectionLabel">方向温度</p>
          <h2>高频方向</h2>
        </div>
        ${renderTopicBars(review.topics)}
      </section>
      <section class="reviewGlassBlock">
        <div class="blockTitle">
          <p class="sectionLabel">阅读池</p>
          <h2>最新论文</h2>
        </div>
        ${renderCompactList(review.papers)}
      </section>
      <section class="reviewGlassBlock">
        <div class="blockTitle">
          <p class="sectionLabel">试用池</p>
          <h2>工具项目</h2>
        </div>
        ${renderCompactList(review.tools)}
      </section>
    </section>

    <section class="reviewTimeline" aria-label="最近日报">
      <div class="blockTitle">
        <p class="sectionLabel">日报入口</p>
        <h2>最近归档</h2>
        <p class="muted">需要展开某一天时，从这里进入单日卡片页；需要找某条内容时，回知识库搜索。</p>
      </div>
      <div class="dayList">
        ${renderReviewDayList(selectedArchives.slice(0, 12))}
      </div>
    </section>

    ${sampleHtml ? `<section class="reviewSamples" aria-label="复盘样本">
      <div class="blockTitle">
        <p class="sectionLabel">继续跟进</p>
        <h2>论文与工具样本</h2>
        <p class="muted">这里只放少量代表性条目，完整检索仍然回到知识库。</p>
      </div>
      <div class="grid reviewSampleGrid">${sampleHtml}</div>
    </section>` : ""}
  </main>
</body>
</html>`;
}

function flattenArchiveCards(archives) {
  const output = [];
  for (const archive of archives || []) {
    for (const card of archive.cards || []) {
      output.push({ ...card, archiveDate: archive.date });
    }
  }
  return output;
}

function buildPeriodReview(archives, days) {
  const selected = archives.slice(0, days);
  const cards = flattenArchiveCards(selected);
  const paperCards = cards.filter((card) => cardType(card) === "论文候选");
  const toolCards = cards.filter((card) => cardType(card) === "工具/项目候选");
  const sources = new Set(cards.map((card) => card.source).filter(Boolean));
  const topics = topTopicCounts(cards, 7);
  const topicText = topics.slice(0, 3).map((item) => item.name).join("、");
  const summaryParts = [];
  if (topicText) summaryParts.push(`主要方向集中在${topicText}`);
  if (paperCards.length) summaryParts.push(`沉淀${paperCards.length}条论文线索`);
  if (toolCards.length) summaryParts.push(`沉淀${toolCards.length}个工具/项目线索`);
  return {
    daysCovered: selected.length,
    cardCount: cards.length,
    paperCount: paperCards.length,
    toolCount: toolCards.length,
    sourceCount: sources.size,
    topics,
    papers: paperCards.slice(0, 5),
    tools: toolCards.slice(0, 5),
    summary: summaryParts.length ? `${summaryParts.join("，")}。` : "暂无足够归档形成阶段复盘。",
  };
}

function reviewHeroHeadline(review) {
  const topics = (review.topics || []).slice(0, 2).map((item) => item.name).filter(Boolean);
  if (topics.length) return `${review.daysCovered} 天复盘：${topics.join("、")}是主线`;
  return `${review.daysCovered} 天复盘：等待更多归档`;
}

function countArchiveCards(archives) {
  return (archives || []).reduce((total, archive) => total + (Array.isArray(archive.cards) ? archive.cards.length : 0), 0);
}

function topSourceCounts(cards, limit) {
  const counts = new Map();
  for (const card of cards || []) {
    const source = compactPageText(card.source || "未知来源", 32);
    counts.set(source, (counts.get(source) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([name, count]) => ({ name, count }));
}

function librarySourceOptions(cards) {
  const counts = new Map();
  for (const card of cards || []) {
    const source = String(card.source || "").trim();
    if (!source) continue;
    counts.set(source, (counts.get(source) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 24)
    .map(([name, count]) => ({ name, count }));
}

function topTopicCounts(cards, limit) {
  const counts = new Map();
  for (const card of cards || []) {
    const topics = String(card.knowledge?.topics || card.category || "")
      .split(/\s*\/\s*|、|,/)
      .map((item) => item.trim())
      .filter(Boolean);
    for (const topic of topics) counts.set(topic, (counts.get(topic) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([name, count]) => ({ name, count }));
}

function renderHomeMetric(label, value, note) {
  return `<div class="commandMetric">
    <span>${escapeHtml(label)}</span>
    <strong>${Number(value) || 0}</strong>
    <p>${escapeHtml(note)}</p>
  </div>`;
}

function renderLibraryHeroScene({ categories, sourceRanks, paperCount, toolCount, latestHeadline, dateMax }) {
  const topTypes = (categories || []).slice(0, 4);
  const topSources = (sourceRanks || []).slice(0, 3);
  return `<div class="featureScene libraryScene" aria-hidden="true">
    <div class="sceneSearchBar"><span></span><b>搜索标题、来源、方向、用途</b></div>
    <div class="sceneHeadline">
      <span>${escapeHtml(dateMax || "最新归档")}</span>
      <strong>${escapeHtml(latestHeadline)}</strong>
    </div>
    <div class="sceneStatGrid">
      <p><span>论文线索</span><b>${paperCount}</b></p>
      <p><span>工具项目</span><b>${toolCount}</b></p>
    </div>
    <div class="sceneTypeStack">${topTypes
      .map((item, index) => `<p style="--row:${index}"><span>${escapeHtml(item.name)}</span><b>${item.count}</b></p>`)
      .join("")}</div>
    <div class="sceneSourceDock">${topSources
      .map((item) => `<span>${escapeHtml(item.name)} · ${item.count}</span>`)
      .join("")}</div>
  </div>`;
}

function renderReviewHeroScene(review, archives) {
  return `<div class="featureScene reviewScene" aria-hidden="true">
    <div class="sceneHeadline">
      <span>${review.daysCovered} 天周期</span>
      <strong>${review.cardCount} 张卡片</strong>
    </div>
    ${renderHeroMiniBars((archives || []).slice(0, 10))}
    ${renderHeroTopicRows((review.topics || []).slice(0, 4))}
    <div class="sceneStatGrid">
      <p><span>论文</span><b>${review.paperCount}</b></p>
      <p><span>工具</span><b>${review.toolCount}</b></p>
    </div>
  </div>`;
}

function renderDailyHeroScene(archive, categories, sources) {
  const cards = Array.isArray(archive?.cards) ? archive.cards.slice(0, 2) : [];
  return `<div class="featureScene dailyScene" aria-hidden="true">
    <div class="sceneHeadline">
      <span>${escapeHtml(archive?.date || "单日归档")}</span>
      <strong>${cards.length ? escapeHtml(compactPageText(cards[0].title, 30)) : "等待内容归档"}</strong>
    </div>
    <div class="dailySceneCards">${cards
      .map((card) => `<p><span>${escapeHtml(cardType(card))}</span><b>${escapeHtml(compactPageText(card.title, 30))}</b></p>`)
      .join("")}</div>
    <div class="sceneTypeStack">${(categories || [])
      .slice(0, 3)
      .map((item, index) => `<p style="--row:${index}"><span>${escapeHtml(item.name)}</span><b>${item.count}</b></p>`)
      .join("")}</div>
    <div class="sceneSourceDock">${(sources || [])
      .slice(0, 2)
      .map((item) => `<span>${escapeHtml(item.name)} · ${item.count}</span>`)
      .join("")}</div>
  </div>`;
}

function renderHeroMiniBars(archives) {
  const list = [...(archives || [])].reverse();
  if (!list.length) return `<div class="miniBars miniBarsEmpty">等待归档</div>`;
  const counts = list.map((archive) => (Array.isArray(archive.cards) ? archive.cards.length : 0));
  const max = Math.max(...counts, 1);
  return `<div class="miniBars">${list
    .map((archive, index) => {
      const count = Array.isArray(archive.cards) ? archive.cards.length : 0;
      const height = Math.max(18, Math.round((count / max) * 100));
      return `<i style="--h:${height}%; --bar:${index}"><span>${escapeHtml(String(archive.date || "").slice(5))}</span></i>`;
    })
    .join("")}</div>`;
}

function renderHeroTopicRows(topics) {
  const list = Array.isArray(topics) ? topics.filter((topic) => topic && topic.name).slice(0, 4) : [];
  if (!list.length) {
    return `<div class="miniTopicRows"><p><span>方向等待归档</span><b>0</b></p></div>`;
  }
  const max = Math.max(...list.map((topic) => topic.count || 0), 1);
  return `<div class="miniTopicRows">${list
    .map((topic, index) => {
      const width = Math.max(16, Math.round(((topic.count || 0) / max) * 100));
      return `<p style="--w:${width}%; --row:${index}"><span>${escapeHtml(compactPageText(topic.name, 16))}</span><b>${topic.count || 0}</b><i></i></p>`;
    })
    .join("")}</div>`;
}

function renderTrendAreaChart(archives) {
  const list = [...(archives || [])].reverse();
  if (!list.length) return `<div class="trendEmpty">暂无趋势数据</div>`;
  const counts = list.map((archive) => (Array.isArray(archive.cards) ? archive.cards.length : 0));
  const max = Math.max(...counts, 1);
  const width = 360;
  const height = 150;
  const pad = 14;
  const step = list.length > 1 ? (width - pad * 2) / (list.length - 1) : width - pad * 2;
  const points = counts.map((count, index) => {
    const x = pad + index * step;
    const y = height - pad - (count / max) * (height - pad * 2);
    return { x, y, count, date: list[index].date };
  });
  const line = points.map((point, index) => `${index ? "L" : "M"}${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(" ");
  const area = `${line} L${points[points.length - 1].x.toFixed(1)} ${height - pad} L${points[0].x.toFixed(1)} ${height - pad} Z`;
  return `<div class="trendArea" role="img" aria-label="最近 ${list.length} 天归档趋势">
    <svg viewBox="0 0 ${width} ${height}" aria-hidden="true">
      <path class="trendFill" d="${area}"></path>
      <path class="trendLine" d="${line}"></path>
      ${points.map((point) => `<circle cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="4"><title>${escapeHtml(point.date)}：${point.count} 张</title></circle>`).join("")}
    </svg>
    <div class="trendTicks">${points.map((point) => `<span>${escapeHtml(String(point.date || "").slice(5))}</span>`).join("")}</div>
  </div>`;
}

function renderSourceList(sources) {
  if (!sources.length) return `<p class="muted small">暂无来源数据。</p>`;
  const max = Math.max(...sources.map((source) => source.count), 1);
  return `<ol class="sourceList">${sources
    .map((source) => {
      const width = Math.max(12, Math.round((source.count / max) * 100));
      return `<li>
        <div><strong>${escapeHtml(source.name)}</strong><span>${source.count} 张</span></div>
        <em><i style="width:${width}%"></i></em>
      </li>`;
    })
    .join("")}</ol>`;
}

function renderTypeSegments(types) {
  if (!types.length) return `<p class="muted small">暂无类型数据。</p>`;
  const total = types.reduce((sum, item) => sum + item.count, 0) || 1;
  return `<div class="typeSegments">
    <div class="segmentTrack">${types
      .slice(0, 7)
      .map((item, index) => {
        const width = Math.max(8, Math.round((item.count / total) * 100));
        return `<i style="width:${width}%; --slot:${index}"></i>`;
      })
      .join("")}</div>
    <div class="segmentLegend">${types
      .slice(0, 7)
      .map((item, index) => `<p><span style="--slot:${index}"></span><strong>${escapeHtml(item.name)}</strong><em>${item.count}</em></p>`)
      .join("")}</div>
  </div>`;
}

function renderTopicFocusCards(topics, cards) {
  if (!topics.length) return `<p class="muted small">暂无方向数据。</p>`;
  return topics
    .map((topic) => {
      const card = findTopicCard(cards, topic.name);
      const title = card ? compactPageText(card.title || "Untitled", 46) : "等待代表条目";
      const source = card ? compactPageText(card.source || "AI HOT", 24) : "AI HOT";
      const fact = card ? compactPageText(card.knowledge?.fact || card.summary || "", 68) : "下一次归档后会补充这个方向的代表内容。";
      const url = String(card?.url || "");
      const link = /^https?:\/\//.test(url) ? `<a href="${escapeAttribute(url)}" target="_blank" rel="noopener noreferrer">打开原文</a>` : "";
      return `<article class="topicCard">
        <div><span>${escapeHtml(topic.name)}</span><b>${topic.count}</b></div>
        <strong>${escapeHtml(title)}</strong>
        <p>${escapeHtml(fact)}</p>
        <footer><em>${escapeHtml(source)}</em>${link}</footer>
      </article>`;
    })
    .join("");
}

function findTopicCard(cards, topicName) {
  const needle = String(topicName || "").trim();
  if (!needle) return null;
  return (cards || []).find((card) => {
    const haystack = `${card.knowledge?.topics || ""} ${card.category || ""} ${card.title || ""}`;
    return haystack.includes(needle);
  });
}

function renderDailyRhythm(archives) {
  if (!archives.length) return `<p class="muted small">暂无归档节奏。</p>`;
  const max = Math.max(...archives.map((archive) => (Array.isArray(archive.cards) ? archive.cards.length : 0)), 1);
  return archives
    .map((archive) => {
      const count = Array.isArray(archive.cards) ? archive.cards.length : 0;
      const width = Math.max(10, Math.round((count / max) * 100));
      const type = dailyPageCategories(archive.cards || [])[0]?.name || "知识卡片";
      return `<a class="rhythmItem" href="/daily?date=${escapeAttribute(archive.date)}">
        <span>${escapeHtml(String(archive.date || "").slice(5))}</span>
        <strong>${count}</strong>
        <em>${escapeHtml(type)}</em>
        <i><b style="width:${width}%"></b></i>
      </a>`;
    })
    .join("");
}

function renderFutureCard(title, stat, body, progress) {
  const value = Math.max(8, Math.min(100, Number(progress) || 0));
  return `<p class="futureCard">
    <strong>${escapeHtml(title)}</strong>
    <span>${escapeHtml(stat)}</span>
    <em>${escapeHtml(body)}</em>
    <i aria-hidden="true"><b style="width:${value}%"></b></i>
  </p>`;
}

function renderReviewMetric(label, value) {
  return `<div class="metric"><b>${Number(value) || 0}</b><span>${escapeHtml(label)}</span></div>`;
}

function renderTopicBars(topics) {
  if (!topics.length) return `<p class="muted small">暂无方向数据。</p>`;
  const max = Math.max(...topics.map((item) => item.count), 1);
  return `<div class="bars">${topics
    .map((item) => {
      const width = Math.max(10, Math.round((item.count / max) * 100));
      return `<div class="barRow"><span>${escapeHtml(item.name)}</span><div><i style="width:${width}%"></i></div><b>${item.count}</b></div>`;
    })
    .join("")}</div>`;
}

function renderCompactList(cards) {
  if (!cards.length) return `<p class="muted small">暂无候选。</p>`;
  return `<ol class="compactList">${cards
    .map((card) => {
      const title = escapeHtml(compactPageText(card.title || "Untitled", 44));
      const date = escapeHtml(card.archiveDate || "");
      const url = String(card.url || "");
      const link = /^https?:\/\//.test(url) ? `<a href="${escapeAttribute(url)}" target="_blank" rel="noopener noreferrer">${title}</a>` : title;
      return `<li>${link}${date ? `<span>${date}</span>` : ""}</li>`;
    })
    .join("")}</ol>`;
}

function reviewSampleCards(review) {
  const seen = new Set();
  const output = [];
  for (const card of [...(review.papers || []), ...(review.tools || [])]) {
    const key = `${card.title || ""}::${card.url || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(card);
    if (output.length >= 6) break;
  }
  return output;
}

function renderReviewDayList(archives) {
  if (!archives.length) return `<p class="muted small">暂无日报归档。</p>`;
  return archives
    .map((archive) => {
      const cards = Array.isArray(archive.cards) ? archive.cards : [];
      const categories = dailyPageCategories(cards)
        .slice(0, 3)
        .map((item) => item.name)
        .join("、");
      const summary = compactPageText(dailyPageSummary(archive), 72);
      return `<a class="dayItem" href="/daily?date=${escapeAttribute(archive.date)}">
        <span>${escapeHtml(archive.date)}</span>
        <strong>${escapeHtml(summary)}</strong>
        <em>${cards.length} 张卡片${categories ? ` · ${escapeHtml(categories)}` : ""}</em>
      </a>`;
    })
    .join("");
}

function renderHomeSparkline(archives) {
  const list = [...(archives || [])].reverse();
  if (!list.length) return `<div class="sparklineEmpty">暂无数据</div>`;
  const counts = list.map((archive) => (Array.isArray(archive.cards) ? archive.cards.length : 0));
  const max = Math.max(...counts, 1);
  return `<div class="sparkline" aria-hidden="true">${list
    .map((archive, index) => {
      const count = counts[index];
      const height = Math.max(18, Math.round((count / max) * 100));
      return `<i style="height:${height}%" title="${escapeAttribute(archive.date)}：${count} 张"></i>`;
    })
    .join("")}</div>`;
}

function renderHomeTopicBars(topics) {
  if (!topics.length) return `<p class="muted small">暂无方向数据。</p>`;
  const max = Math.max(...topics.map((item) => item.count), 1);
  return `<div class="homeBars">${topics
    .slice(0, 6)
    .map((item) => {
      const width = Math.max(12, Math.round((item.count / max) * 100));
      return `<div class="homeBarRow"><span>${escapeHtml(item.name)}</span><b>${item.count}</b><em><i style="width:${width}%"></i></em></div>`;
    })
    .join("")}</div>`;
}

function renderHomeTypeBars(types) {
  if (!types.length) return `<p class="muted small">暂无类型数据。</p>`;
  const max = Math.max(...types.map((item) => item.count), 1);
  return `<div class="typeOrbit">${types
    .slice(0, 6)
    .map((item) => {
      const size = 36 + Math.round((item.count / max) * 42);
      return `<div class="typeBubble" style="--size:${size}px"><strong>${item.count}</strong><span>${escapeHtml(item.name)}</span></div>`;
    })
    .join("")}</div>`;
}

function renderHomeHeroItems(cards) {
  const list = Array.isArray(cards) ? cards.slice(0, 3) : [];
  if (!list.length) {
    return `<article class="mediaItem">
      <span>等待归档</span>
      <strong>日报生成后，这里会展示今日精选条目。</strong>
    </article>`;
  }
  return list
    .map((card) => {
      const type = cardType(card);
      const title = compactPageText(card.title || "Untitled", 44);
      const source = compactPageText(card.source || "AI HOT", 24);
      return `<article class="mediaItem">
        <span>${escapeHtml(type)}</span>
        <strong>${escapeHtml(title)}</strong>
        <em>${escapeHtml(source)}</em>
      </article>`;
    })
    .join("");
}

function renderHomeLatestSignals(cards) {
  if (!cards.length) return `<p class="muted small">暂无最新日报卡片。</p>`;
  return cards
    .map((card) => {
      const title = compactPageText(card.title || "Untitled", 42);
      const type = cardType(card);
      const fact = compactPageText(card.knowledge?.fact || card.summary || "", 70);
      const url = String(card.url || "");
      const link = /^https?:\/\//.test(url)
        ? `<a href="${escapeAttribute(url)}" target="_blank" rel="noopener noreferrer">原文</a>`
        : "";
      return `<article class="latestSignal">
        <span>${escapeHtml(type)}</span>
        <strong>${escapeHtml(title)}</strong>
        ${fact ? `<p>${escapeHtml(fact)}</p>` : ""}
        ${link}
      </article>`;
    })
    .join("");
}

function renderHomeBriefingDeck({ date, latestHref, latestArchive, cards, sourceCount, cadenceCopy }) {
  const list = Array.isArray(cards) ? cards.filter((card) => card && card.title).slice(0, 8) : [];
  const lead = list[0] || null;
  const picks = list.slice(1, 4);
  const stream = list.slice(4, 8);
  const summary = latestArchive ? dailyPageSummary(latestArchive) : "等待下一次日报归档后，这里会展示今日主线和高价值条目。";
  const cardCount = Array.isArray(latestArchive?.cards) ? latestArchive.cards.length : 0;
  const leadHref = homeCardHref(lead, latestHref);
  const leadScore = lead ? cardScoreValue(lead) : 0;
  const leadTitle = lead ? compactPageText(lead.title, 56) : "等待今日主线";
  const leadFact = lead
    ? compactPageText(lead.knowledge?.fact || lead.summary || "打开单日归档查看完整事实、用途和下一步。", 118)
    : "当日报生成后，这里会把真实高分内容放在首位。";
  const leadSource = lead ? compactPageText(lead.source || "AI HOT", 28) : "AI HOT";
  return `<section class="homeBriefingDeck" aria-label="今日情报台">
    <div class="briefingHeader">
      <div>
        <span>${escapeHtml(date || "最新归档")}</span>
        <h2>今天先判断三件事</h2>
      </div>
      <p>${escapeHtml(compactPageText(summary, 92))}</p>
    </div>
    <a class="briefLead" href="${leadHref}">
      <span>${escapeHtml(cardActionLabel(lead))}</span>
      <strong>${escapeHtml(leadTitle)}</strong>
      <p>${escapeHtml(leadFact)}</p>
      <footer>
        <em>${escapeHtml(leadSource)}</em>
        <b>${leadScore ? `${leadScore} 分` : escapeHtml(cardType(lead || {}))}</b>
      </footer>
    </a>
    <div class="briefPicks">
      ${picks.length ? picks.map((card) => renderHomeBriefPick(card, latestHref)).join("") : renderEmptyBriefPick()}
    </div>
    <aside class="briefStreamPanel" aria-label="连续更新">
      <div class="briefStreamTop">
        <span>Live Archive</span>
        <strong>${cardCount} 张卡片</strong>
        <p>${escapeHtml(cadenceCopy)}</p>
      </div>
      <ol class="briefStreamList">
        ${stream.length ? stream.map((card) => renderHomeBriefStreamItem(card, latestHref)).join("") : `<li class="emptyStreamLine"><span>等待更新</span><strong>暂无更多条目</strong><em>${escapeHtml(sourceCount || 0)} 个来源</em></li>`}
      </ol>
      <a class="briefStreamLink" href="${latestHref}">查看今日复盘</a>
    </aside>
  </section>`;
}

function renderHomeBriefPick(card, fallbackHref) {
  const href = homeCardHref(card, fallbackHref);
  const title = compactPageText(card.title || "Untitled", 42);
  const fact = compactPageText(card.knowledge?.fact || card.summary || "", 66);
  const source = compactPageText(card.source || "AI HOT", 24);
  return `<a class="briefPick" href="${href}">
    <span>${escapeHtml(cardActionLabel(card))}</span>
    <strong>${escapeHtml(title)}</strong>
    <p>${escapeHtml(fact || source)}</p>
    <em>${escapeHtml(source)}</em>
  </a>`;
}

function renderHomeBriefStreamItem(card, fallbackHref) {
  const href = homeCardHref(card, fallbackHref);
  const title = compactPageText(card.title || "Untitled", 34);
  const source = compactPageText(card.source || "AI HOT", 18);
  return `<li>
    <a href="${href}">
      <span>${escapeHtml(cardType(card))}</span>
      <strong>${escapeHtml(title)}</strong>
      <em>${escapeHtml(source)}</em>
    </a>
  </li>`;
}

function renderEmptyBriefPick() {
  return `<article class="briefPick emptyBriefPick">
    <span>等待归档</span>
    <strong>暂无精选条目</strong>
    <p>日报生成后会补充真实卡片。</p>
    <em>AI HOT</em>
  </article>`;
}

function renderHomeChannelMatrix(types, cards) {
  const list = Array.isArray(types) ? types.filter((item) => item && item.name).slice(0, 6) : [];
  const total = list.reduce((sum, item) => sum + (Number(item.count) || 0), 0) || 0;
  return `<section class="homeChannelMatrix" aria-label="方向频道">
    <div class="channelIntro">
      <span>Channels</span>
      <h2>把热点拆成可行动方向</h2>
      <p>${total ? `当前前 ${list.length} 个方向覆盖 ${total} 张卡片，每个频道都给出一个代表条目。` : "等待归档后，这里会按方向展示代表内容。"}</p>
      <a class="navButton" href="/library">按方向检索</a>
    </div>
    <div class="channelGrid">
      ${list.length ? list.map((item) => renderHomeChannelCard(item, cards)).join("") : renderEmptyChannelCards()}
    </div>
  </section>`;
}

function renderHomeChannelCard(item, cards) {
  const card = findTypeCard(cards, item.name);
  const href = homeCardHref(card, "/library");
  const title = card ? compactPageText(card.title || "Untitled", 36) : "等待代表条目";
  const fact = card ? compactPageText(card.knowledge?.fact || card.summary || "", 58) : "下一次归档后会补充这个方向的代表内容。";
  const percent = Math.max(8, Math.min(100, Math.round((Number(item.count) || 0) * 8)));
  return `<a class="channelCard" href="${href}">
    <div>
      <span>${escapeHtml(item.name)}</span>
      <b>${Number(item.count) || 0}</b>
    </div>
    <strong>${escapeHtml(title)}</strong>
    <p>${escapeHtml(fact)}</p>
    <i aria-hidden="true"><em style="width:${percent}%"></em></i>
  </a>`;
}

function renderEmptyChannelCards() {
  return `<article class="channelCard emptyChannel">
    <div><span>等待归档</span><b>0</b></div>
    <strong>暂无方向数据</strong>
    <p>日报归档后会按论文、工具、模型和行业观察拆分。</p>
    <i aria-hidden="true"><em style="width:12%"></em></i>
  </article>`;
}

function renderHomeDailyRiver(archives) {
  const list = Array.isArray(archives) ? archives.filter((archive) => archive && archive.date).slice(0, 10) : [];
  const total = countArchiveCards(list);
  return `<section class="homeDailyRiver" aria-label="最近归档河流">
    <div class="riverIntro">
      <span>Archive River</span>
      <h2>最近 ${list.length || 0} 天的归档节奏</h2>
      <p>${list.length ? `${total} 张卡片被整理成日期索引，适合从今天回看上一轮热点。` : "等待归档后，这里会展示最近日期和代表方向。"}</p>
    </div>
    <div class="riverRail">
      ${list.length ? list.map((archive) => renderHomeRiverDay(archive)).join("") : `<p class="muted small">暂无归档节奏。</p>`}
    </div>
  </section>`;
}

function renderHomeRiverDay(archive) {
  const cards = Array.isArray(archive.cards) ? archive.cards : [];
  const categories = dailyPageCategories(cards);
  const top = categories[0]?.name || "知识卡片";
  const summary = compactPageText(dailyPageSummary(archive), 54);
  return `<a class="riverDay" href="/daily?date=${escapeAttribute(archive.date)}">
    <span>${escapeHtml(String(archive.date || "").slice(5))}</span>
    <strong>${cards.length}</strong>
    <p>${escapeHtml(summary)}</p>
    <em>${escapeHtml(top)}</em>
  </a>`;
}

function uniqueCards(cards) {
  const seen = new Set();
  const output = [];
  for (const card of cards || []) {
    if (!card || !card.title) continue;
    const key = `${card.title || ""}::${card.url || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(card);
  }
  return output;
}

function findTypeCard(cards, typeName) {
  const needle = String(typeName || "");
  if (!needle) return null;
  return topScoredCards((cards || []).filter((card) => cardType(card) === needle), 1)[0] || null;
}

function homeCardHref(card, fallbackHref = "/library") {
  if (card?.archiveDate) return `/daily?date=${escapeAttribute(card.archiveDate)}`;
  return fallbackHref;
}

function cardActionLabel(card) {
  const type = cardType(card || {});
  const text = `${type} ${card?.knowledge?.useCase || ""} ${card?.knowledge?.nextStep || ""}`;
  if (/论文|复现|实验|方法/.test(text)) return "可复现";
  if (/工具|项目|产品|试用|API|开源/.test(text)) return "可试用";
  if (/模型|发布|能力|API/.test(text)) return "值得跟进";
  if (/融资|行业|监管|公司/.test(text)) return "行业观察";
  return "先读";
}

function topScoredCards(cards, limit) {
  return [...(cards || [])]
    .filter((card) => card && card.title)
    .sort((a, b) => {
      const scoreDiff = cardScoreValue(b) - cardScoreValue(a);
      if (scoreDiff !== 0) return scoreDiff;
      return new Date(b.publishedAt || 0).getTime() - new Date(a.publishedAt || 0).getTime();
    })
    .slice(0, limit);
}

function cardScoreValue(card) {
  const score = Number(card?.score ?? card?.impactScore);
  return Number.isFinite(score) ? Math.max(0, Math.min(100, Math.round(score))) : 0;
}

function signalPriorityLabel(score) {
  if (score >= 85) return "S 级";
  if (score >= 72) return "A 级";
  if (score >= 60) return "B 级";
  return "观察";
}

function renderHomeSignalQueue(cards) {
  if (!cards.length) {
    return `<article class="signalRow emptySignal">
      <span>等待归档</span>
      <strong>日报生成后，会按真实分数显示优先线索。</strong>
    </article>`;
  }
  return cards
    .map((card) => {
      const score = cardScoreValue(card);
      const href = card.archiveDate ? `/daily?date=${escapeAttribute(card.archiveDate)}` : "/library";
      const title = compactPageText(card.title || "Untitled", 46);
      const fact = compactPageText(card.knowledge?.fact || card.summary || card.source || "", 76);
      return `<a class="signalRow" href="${href}">
        <span>${escapeHtml(signalPriorityLabel(score))}</span>
        <strong>${escapeHtml(title)}</strong>
        <p>${escapeHtml(fact)}</p>
        <em>${escapeHtml(card.archiveDate || "")} · ${escapeHtml(cardType(card))}</em>
      </a>`;
    })
    .join("");
}

function renderDailyPage(archive, message, archives = []) {
  const safeMessage = escapeHtml(message || "");
  if (!archive || !Array.isArray(archive.cards)) {
    return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>AI HOT 日报</title>
  <style>${dailyPageCSS()}</style>
</head>
<body>
  <main class="shell">
    ${renderSiteNav("daily")}
    <section class="emptyPanel">
      <p class="sectionLabel">单日归档</p>
      <h1>没有找到这一天</h1>
      <p class="muted">${safeMessage || "没有找到这一天的归档。可以回到知识库总入口，按日期重新选择。"}</p>
      <a class="primaryLink" href="/library">打开知识库总入口</a>
    </section>
  </main>
</body>
</html>`;
  }

  const summary = dailyPageSummary(archive);
  const categories = dailyPageCategories(archive.cards);
  const cards = archive.cards.map((card) => renderKnowledgeCard(card)).join("");
  const dailySources = topSourceCounts(archive.cards, 4);
  const paperCount = archive.cards.filter((card) => card.knowledge?.isPaper === "是" || /论文/.test(cardType(card))).length;
  const toolCount = archive.cards.filter((card) => cardType(card) === "工具/项目候选").length;
  const dayNav = dailyArchiveNavigation(archive, archives);
  const latestDate = Array.isArray(archives) && archives[0]?.date ? archives[0].date : archive.date || "";
  const dailySourceCount = new Set(archive.cards.map((card) => card.source).filter(Boolean)).size;
  const priorityReads = topScoredCards(archive.cards, 3);
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>AI HOT 日报 ${escapeHtml(archive.date || "")}</title>
  <style>${dailyPageCSS()}</style>
</head>
<body>
  <main class="shell">
    ${renderSiteNav("daily", latestDate)}
    <header class="featureHero dailyFeatureHero" aria-label="单日归档主视觉">
      <div class="featureHeroCopy">
        <p class="sectionLabel">单日归档</p>
        <h1>${escapeHtml(archive.date || "AI HOT 日报")}</h1>
        <p class="muted">${escapeHtml(summary)}</p>
        <div class="heroActionBar">
          <a class="primaryLink" href="#cardGrid">阅读卡片</a>
          <a class="navButton" href="/library">回到总库</a>
          <a class="navButton" href="/review?days=30">30 天复盘</a>
        </div>
        <div class="heroMicroStats heroCapsules" aria-label="单日状态">
          <span><b>${archive.cards.length}</b> 张卡片</span>
          <span><b>${categories.length}</b> 类内容</span>
          <span><b>${dailySources.length}</b> 个主要来源</span>
        </div>
      </div>
      ${renderDailyHeroScene(archive, categories, dailySources)}
    </header>
    <section class="dailyReadOrder" aria-label="推荐阅读顺序">
      <div>
        <span>Reading Order</span>
        <h2>先看三条代表线索</h2>
        <p>按上游分数、时间和归档顺序挑出当天最适合先读的内容，完整卡片仍在下面保留。</p>
      </div>
      <div class="readOrderList">
        ${renderDailyReadOrder(priorityReads)}
      </div>
    </section>
    <section class="pageAtlas dailyAtlas" aria-label="单日阅读摘要">
      <div class="atlasLead">
        <span>今日覆盖</span>
        <h2>先按类型和来源排阅读顺序</h2>
        <p>${archive.cards.length} 张卡片来自 ${dailySourceCount} 个来源，下面保留完整条目、事实摘录和原文入口。</p>
      </div>
      <div class="atlasMetrics">
        ${renderHomeMetric("论文线索", paperCount, "适合继续跟进实验和方法")}
        ${renderHomeMetric("工具项目", toolCount, "适合试用、复盘或加入工具池")}
      </div>
      <div class="atlasPanel">
        <h3>类型分布</h3>
        ${renderTypeSegments(categories)}
      </div>
      <div class="atlasPanel">
        <h3>来源分布</h3>
        ${renderSourceList(dailySources)}
      </div>
    </section>
    <section class="dailyTools" aria-label="日期导航">
      <div>
        <a class="navButton" href="/library">回到总库</a>
        ${dayNav.newer ? `<a class="navButton" href="/daily?date=${escapeAttribute(dayNav.newer)}">更新一天</a>` : ""}
        ${dayNav.older ? `<a class="navButton" href="/daily?date=${escapeAttribute(dayNav.older)}">更早一天</a>` : ""}
      </div>
      <a class="primaryLink" href="/review?days=30">查看 30 天复盘</a>
    </section>
    <section class="toolbar" aria-label="筛选">
      <div class="search">
        <input id="searchInput" type="search" placeholder="搜索标题、来源、方向" autocomplete="off" />
      </div>
      <div class="segments" id="categoryFilters">
        <button class="active" type="button" data-filter="all">全部</button>
        ${categories.map((item) => `<button type="button" data-filter="${escapeAttribute(item.name)}">${escapeHtml(item.name)} <span>${item.count}</span></button>`).join("")}
      </div>
    </section>
    <section class="grid dailyCards" id="cardGrid">${cards}</section>
    <p class="empty" id="emptyState" hidden>没有匹配的卡片。</p>
  </main>
  <script>${dailyPageScript()}</script>
</body>
</html>`;
}

function renderDailyReadOrder(cards) {
  if (!cards.length) return `<p class="muted small">暂无可推荐条目。</p>`;
  const labels = ["快速了解", "深入跟进", "试用验证"];
  return cards
    .map((card, index) => {
      const title = compactPageText(card.title || "Untitled", 44);
      const source = compactPageText(card.source || "AI HOT", 28);
      const fact = compactPageText(card.knowledge?.fact || card.summary || "", 70);
      const url = /^https?:\/\//.test(String(card.url || ""))
        ? `<a href="${escapeAttribute(card.url)}" target="_blank" rel="noopener noreferrer">原文</a>`
        : "";
      return `<article class="readOrderItem">
        <span>${labels[index] || "继续阅读"}</span>
        <strong>${escapeHtml(title)}</strong>
        <p>${escapeHtml(fact || source)}</p>
        <div><em>${escapeHtml(source)}</em>${url}</div>
      </article>`;
    })
    .join("");
}

function renderSiteNav(active, latestDate = formatDateKey(new Date())) {
  const dailyHref = latestDate ? `/daily?date=${escapeAttribute(latestDate)}` : "/library";
  return `<nav class="siteNav" aria-label="站点导航">
    <a class="brandMark" href="/">AI HOT</a>
    <div class="navLinks">
      <a class="${active === "home" ? "active" : ""}" href="/">首页</a>
      <a class="${active === "library" ? "active" : ""}" href="/library">知识库</a>
      <a class="${active === "review" ? "active" : ""}" href="/review?days=30">阶段复盘</a>
      <a class="${active === "daily" ? "active" : ""}" href="${dailyHref}">最新归档</a>
    </div>
    <a class="navStatus" href="${dailyHref}" aria-label="查看最新归档">
      <span>最新</span>
      <b>${escapeHtml(latestDate || "等待归档")}</b>
    </a>
  </nav>`;
}

function dailyArchiveNavigation(archive, archives) {
  const list = Array.isArray(archives) ? archives.filter((item) => item?.date).sort((a, b) => String(b.date).localeCompare(String(a.date))) : [];
  const index = list.findIndex((item) => item.date === archive.date);
  return {
    newer: index > 0 ? list[index - 1].date : "",
    older: index >= 0 && index < list.length - 1 ? list[index + 1].date : "",
  };
}

function renderKnowledgeCard(card, options = {}) {
  const knowledge = card.knowledge || {};
  const rawType = cardType(card);
  const type = escapeHtml(rawType);
  const priority = escapeHtml(knowledge.priority || "中");
  const topics = escapeHtml(knowledge.topics || card.category || "");
  const title = escapeHtml(card.title || "Untitled");
  const fact = escapeHtml(knowledge.fact || card.summary || "");
  const useCase = escapeHtml(cleanDisplayText(knowledge.useCase || ""));
  const nextStep = escapeHtml(knowledge.nextStep || "");
  const source = escapeHtml(card.source || "");
  const date = escapeHtml(card.archiveDate || "");
  const url = String(card.url || "");
  const searchText = [card.title, card.source, card.category, rawType, knowledge.topics, knowledge.fact, knowledge.useCase]
    .filter(Boolean)
    .join(" ");
  const link = /^https?:\/\//.test(url) ? `<a class="sourceLink" href="${escapeAttribute(url)}" target="_blank" rel="noopener noreferrer">原文</a>` : "";
  return `<article class="card" data-type="${escapeAttribute(rawType)}" data-source="${escapeAttribute(card.source || "")}" data-date="${escapeAttribute(card.archiveDate || "")}" data-search="${escapeAttribute(searchText)}">
    <div class="meta"><span class="type">${type}</span><span class="priority">${priority}</span>${options.showDate && date ? `<a class="dateBadge" href="/daily?date=${date}">${date}</a>` : ""}</div>
    <h2>${title}</h2>
    ${topics ? `<p class="topics">${topics}</p>` : ""}
    ${fact ? `<p class="fact">${fact}</p>` : ""}
    <dl>
      ${useCase ? `<div><dt>用途</dt><dd>${useCase}</dd></div>` : ""}
      ${nextStep ? `<div><dt>下一步</dt><dd>${nextStep}</dd></div>` : ""}
    </dl>
    <footer>${source ? `<span>${source}</span>` : ""}${link}</footer>
  </article>`;
}

function dailyPageSummary(archive) {
  const cards = Array.isArray(archive.cards) ? archive.cards : [];
  const categories = dailyPageCategories(cards).slice(0, 3).map((item) => item.name).join("、");
  const first = cards[0]?.title ? `优先看「${compactPageText(cards[0].title, 30)}」` : "";
  const paperCount = cards.filter((card) => card.knowledge?.isPaper === "是" || card.knowledge?.type === "论文候选").length;
  const toolCount = cards.filter((card) => card.knowledge?.type === "工具/项目候选").length;
  const parts = [];
  if (categories) parts.push(`今日内容集中在${categories}`);
  if (first) parts.push(first);
  if (paperCount) parts.push(`有${paperCount}条论文线索`);
  if (toolCount) parts.push(`有${toolCount}个工具/项目线索`);
  if (parts.length) return `${parts.join("，")}。`;

  const clean = String(archive.analysis || "")
    .replace(/#{1,6}\s*/g, "")
    .replace(/(整体概况|主要动态|论文动态|工具动态|行业动态|今日重点|重点观察|产品动态|模型动态)[：:]\s*/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (clean && !/旧表|压缩迁移|legacy-import/i.test(clean)) return compactPageText(clean, 128);
  return "今日知识卡片已归档。";
}

function dailyPageCategories(cards) {
  const preferred = ["论文候选", "工具/项目候选", "模型变化", "产品变化", "行业观察", "方法参考", "资料线索"];
  const counts = new Map();
  for (const card of cards || []) {
    const type = cardType(card);
    counts.set(type, (counts.get(type) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => {
      const ai = preferred.indexOf(a[0]);
      const bi = preferred.indexOf(b[0]);
      if (ai !== -1 || bi !== -1) return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
      return b[1] - a[1] || a[0].localeCompare(b[0]);
    })
    .map(([name, count]) => ({ name, count }));
}

function cardType(card) {
  return cleanDisplayText(card?.knowledge?.type || card?.category || "知识卡片");
}

function compactPageText(text, maxLength) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  return clean.length > maxLength ? `${clean.slice(0, maxLength - 1)}...` : clean;
}

function cleanDisplayText(text) {
  return String(text || "").replace(/组会候选/g, "文献跟踪");
}

function dailyPageScript() {
  return `
    const input = document.getElementById("searchInput");
    const typeButtons = [...document.querySelectorAll("[data-filter]")];
    const dateButtons = [...document.querySelectorAll("[data-date]")];
    const typeSelect = document.getElementById("typeSelect");
    const sourceSelect = document.getElementById("sourceSelect");
    const startDate = document.getElementById("startDate");
    const endDate = document.getElementById("endDate");
    const clearFilters = document.getElementById("clearFilters");
    const visibleCount = document.getElementById("visibleCount");
    const cards = [...document.querySelectorAll(".card")];
    const empty = document.getElementById("emptyState");
    let activeType = "all";
    let activeDate = "all";

    function applyFilters() {
      const query = (input?.value || "").trim().toLowerCase();
      const from = startDate?.value || "";
      const to = endDate?.value || "";
      const selectedSource = sourceSelect?.value || "all";
      let visible = 0;
      for (const card of cards) {
        const cardDate = card.dataset.date || "";
        const matchesType = activeType === "all" || card.dataset.type === activeType;
        const matchesSource = selectedSource === "all" || card.dataset.source === selectedSource;
        const matchesDateButton = activeDate === "all" || cardDate === activeDate;
        const matchesStart = !from || !cardDate || cardDate >= from;
        const matchesEnd = !to || !cardDate || cardDate <= to;
        const matchesText = !query || (card.dataset.search || "").toLowerCase().includes(query);
        const show = matchesType && matchesSource && matchesDateButton && matchesStart && matchesEnd && matchesText;
        card.hidden = !show;
        if (show) visible += 1;
      }
      if (empty) empty.hidden = visible !== 0;
      if (visibleCount) visibleCount.textContent = String(visible);
    }

    input?.addEventListener("input", applyFilters);
    typeSelect?.addEventListener("change", () => {
      activeType = typeSelect.value || "all";
      applyFilters();
    });
    sourceSelect?.addEventListener("change", applyFilters);
    startDate?.addEventListener("change", applyFilters);
    endDate?.addEventListener("change", applyFilters);

    for (const button of typeButtons) {
      button.addEventListener("click", () => {
        activeType = button.dataset.filter || "all";
        for (const item of typeButtons) item.classList.toggle("active", item === button);
        applyFilters();
      });
    }
    for (const button of dateButtons) {
      button.addEventListener("click", () => {
        activeDate = button.dataset.date || "all";
        for (const item of dateButtons) item.classList.toggle("active", item === button);
        applyFilters();
      });
    }
    clearFilters?.addEventListener("click", () => {
      activeType = "all";
      activeDate = "all";
      if (input) input.value = "";
      if (typeSelect) typeSelect.value = "all";
      if (sourceSelect) sourceSelect.value = "all";
      if (startDate) startDate.value = "";
      if (endDate) endDate.value = "";
      for (const item of typeButtons) item.classList.toggle("active", item.dataset.filter === "all");
      for (const item of dateButtons) item.classList.toggle("active", item.dataset.date === "all");
      applyFilters();
    });
    applyFilters();
  `;
}

function dailyPageCSS() {
  return `
    :root {
      color-scheme: light;
      --bg: oklch(0.976 0.006 190);
      --surface: color-mix(in oklch, white 70%, transparent);
      --surface-strong: color-mix(in oklch, white 88%, transparent);
      --surface-2: color-mix(in oklch, oklch(0.94 0.014 190) 68%, transparent);
      --glass: color-mix(in oklch, white 58%, transparent);
      --glass-strong: color-mix(in oklch, white 74%, transparent);
      --ink: oklch(0.19 0.025 250);
      --muted: oklch(0.42 0.03 245);
      --faint: oklch(0.6 0.026 245);
      --line: color-mix(in oklch, white 56%, oklch(0.78 0.025 205));
      --accent: oklch(0.48 0.12 184);
      --accent-2: oklch(0.58 0.14 35);
      --accent-soft: color-mix(in oklch, var(--accent) 12%, white);
      --green: oklch(0.47 0.12 165);
      --green-soft: color-mix(in oklch, oklch(0.93 0.05 165) 72%, white);
      --amber: oklch(0.56 0.13 78);
      --amber-soft: color-mix(in oklch, oklch(0.95 0.05 83) 76%, white);
      --radius: 18px;
      --radius-small: 12px;
      --sticky: 20;
      --shadow: 0 18px 48px color-mix(in oklch, oklch(0.36 0.055 205) 14%, transparent);
      --shadow-soft: 0 8px 24px color-mix(in oklch, oklch(0.42 0.04 205) 10%, transparent);
    }
    * { box-sizing: border-box; }
    html { overflow-x: clip; }
    body {
      margin: 0;
      min-height: 100dvh;
      background:
        linear-gradient(180deg, oklch(0.992 0.004 190), oklch(0.958 0.014 190) 52%, oklch(0.986 0.005 170)),
        linear-gradient(90deg, color-mix(in oklch, var(--accent-2) 7%, transparent), color-mix(in oklch, var(--accent) 7%, transparent));
      background-attachment: fixed;
      color: var(--ink);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
      overflow-x: hidden;
      -webkit-font-smoothing: antialiased;
      text-rendering: optimizeLegibility;
      font-size: 16px;
    }
    body::before {
      content: "";
      position: fixed;
      inset: 0;
      pointer-events: none;
      z-index: -1;
      opacity: 0.38;
      background-image:
        linear-gradient(color-mix(in oklch, var(--line) 54%, transparent) 1px, transparent 1px),
        linear-gradient(90deg, color-mix(in oklch, var(--line) 48%, transparent) 1px, transparent 1px);
      background-size: 72px 72px;
      mask-image: linear-gradient(180deg, black 0%, transparent 78%);
    }
    @keyframes riseIn {
      from { opacity: 0.92; transform: translateY(14px) scale(0.992); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }
    @keyframes barGrow {
      from { transform: scaleY(0.25); opacity: 0.42; }
      to { transform: scaleY(1); opacity: 1; }
    }
    .siteNav,
    .top,
    .homeHeroCopy,
    .homeMedia,
    .homePulse,
    .homeInsight,
    .homeIntent,
    .homeLatest,
    .homeSignalBoard,
    .portalGrid,
    .homeShowcase,
    .homeRoadmap,
    .rolePanel,
    .finderPanel,
    .featureHero,
    .featureScene,
    .reviewIdentity,
    .reviewPanel,
    .reviewDashboard,
    .reviewTimeline,
    .reviewSamples,
    .dailyTools,
    .dailyReadOrder,
    .toolbar {
      animation: riseIn 520ms cubic-bezier(0.22, 1, 0.36, 1) both;
    }
    .homeMedia { animation-delay: 80ms; }
    .homePulse, .rolePanel, .reviewIdentity, .dailyTools { animation-delay: 120ms; }
    .homeInsight, .finderPanel, .reviewPanel, .toolbar { animation-delay: 180ms; }
    .homeIntent, .reviewDashboard { animation-delay: 240ms; }
    .homeLatest, .reviewTimeline { animation-delay: 300ms; }
    .portalGrid, .reviewSamples { animation-delay: 360ms; }
    .homeShowcase { animation-delay: 420ms; }
    .homeRoadmap { animation-delay: 480ms; }
    .shell { width: min(1220px, calc(100vw - 32px)); margin: 0 auto; padding: 22px 0 56px; }
    .siteNav {
      position: sticky;
      top: 12px;
      z-index: var(--sticky);
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      min-height: 56px;
      margin-bottom: 18px;
      padding: 8px 10px 8px 16px;
      border: 1px solid var(--line);
      border-radius: 999px;
      background: color-mix(in oklch, white 66%, transparent);
      box-shadow: var(--shadow-soft);
      backdrop-filter: blur(24px) saturate(1.4);
      -webkit-backdrop-filter: blur(24px) saturate(1.4);
    }
    .brandMark {
      display: inline-flex;
      align-items: center;
      min-height: 44px;
      color: var(--ink);
      font-weight: 800;
      font-size: 16px;
      letter-spacing: 0;
      padding: 0 8px;
    }
    .navLinks { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
    .navLinks a {
      display: inline-flex;
      align-items: center;
      min-height: 44px;
      padding: 0 14px;
      border-radius: 999px;
      color: var(--muted);
      font-size: 14px;
      font-weight: 650;
      transition: color 180ms ease, background 180ms ease, transform 180ms ease;
    }
    .navLinks a.active {
      color: var(--accent);
      background: var(--accent-soft);
    }
    .navLinks a:hover { background: color-mix(in oklch, white 60%, transparent); text-decoration: none; transform: translateY(-1px); }
    .top {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 24px;
      align-items: start;
      padding: 30px;
      border: 1px solid var(--line);
      border-radius: calc(var(--radius) + 8px);
      background: linear-gradient(135deg, color-mix(in oklch, white 72%, transparent), color-mix(in oklch, white 44%, transparent));
      box-shadow: var(--shadow);
      backdrop-filter: blur(28px) saturate(1.35);
      -webkit-backdrop-filter: blur(28px) saturate(1.35);
      margin-bottom: 16px;
    }
    .libraryHero { padding-top: 30px; }
    .sectionLabel { margin: 0 0 10px; font-size: 13px; color: var(--muted); font-weight: 750; }
    h1 { margin: 0; font-size: clamp(28px, 4vw, 44px); line-height: 1.08; letter-spacing: 0; text-wrap: balance; }
    h2 { margin: 0; font-size: 24px; line-height: 1.25; text-wrap: balance; }
    h3 { margin: 0 0 12px; font-size: 15px; line-height: 1.4; }
    .muted { color: var(--muted); margin: 10px 0 0; line-height: 1.7; max-width: 72ch; text-wrap: pretty; }
    .small { font-size: 13px; }
    .stats { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; align-items: start; }
    .stats span {
      border: 1px solid var(--line);
      background: color-mix(in oklch, white 62%, transparent);
      border-radius: 999px;
      padding: 8px 13px;
      font-size: 13px;
      color: var(--muted);
      white-space: nowrap;
      backdrop-filter: blur(18px);
      -webkit-backdrop-filter: blur(18px);
    }
    .stats b { color: var(--ink); margin-right: 3px; }
    .homeShell { width: min(1240px, calc(100vw - 32px)); }
    .homeHero {
      position: relative;
      min-height: min(590px, calc(100dvh - 154px));
      display: grid;
      grid-template-columns: minmax(0, 0.92fr) minmax(360px, 0.82fr);
      gap: 32px;
      align-items: center;
      padding: 38px 0 42px;
      overflow: hidden;
    }
    .homeHeroCopy {
      position: relative;
      z-index: 2;
      max-width: 720px;
    }
    .homeHero h1 {
      max-width: 680px;
      font-size: clamp(42px, 5.8vw, 68px);
      line-height: 1.03;
      letter-spacing: 0;
    }
    .homeLead {
      max-width: 58ch;
      margin: 18px 0 0;
      color: var(--muted);
      font-size: 17px;
      line-height: 1.75;
      text-wrap: pretty;
    }
    .homeActions {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-top: 26px;
    }
    .homeMedia {
      min-height: 416px;
      border: 1px solid var(--line);
      border-radius: calc(var(--radius) + 6px);
      background:
        linear-gradient(145deg, color-mix(in oklch, white 78%, transparent), color-mix(in oklch, white 48%, transparent)),
        linear-gradient(180deg, color-mix(in oklch, var(--accent-soft) 54%, transparent), transparent);
      box-shadow: var(--shadow);
      backdrop-filter: blur(26px) saturate(1.25);
      -webkit-backdrop-filter: blur(26px) saturate(1.25);
      padding: 22px;
      display: grid;
      grid-template-rows: auto auto minmax(0, 1fr) auto;
      gap: 16px;
      overflow: hidden;
    }
    .mediaTop,
    .mediaFoot {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 14px;
    }
    .mediaTop span,
    .mediaItem span,
    .portalTile span,
    .showcaseTrack span {
      width: fit-content;
      border-radius: 999px;
      background: var(--accent-soft);
      color: var(--accent);
      padding: 4px 9px;
      font-size: 12px;
      line-height: 1.35;
      font-weight: 750;
    }
    .mediaTop strong {
      color: var(--ink);
      font-size: 14px;
      font-weight: 800;
      letter-spacing: 0;
    }
    .mediaHeadline {
      border-bottom: 1px solid var(--line);
      padding-bottom: 16px;
    }
    .mediaHeadline p {
      color: var(--muted);
      font-size: 13px;
      font-weight: 750;
      margin-bottom: 8px;
    }
    .mediaHeadline h2 {
      font-size: clamp(22px, 2.6vw, 30px);
      line-height: 1.2;
    }
    .mediaFeed {
      display: grid;
      gap: 10px;
      align-content: start;
    }
    .mediaItem {
      min-height: 82px;
      border: 1px solid color-mix(in oklch, var(--line) 82%, transparent);
      border-radius: var(--radius-small);
      background: color-mix(in oklch, white 56%, transparent);
      padding: 13px;
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      grid-template-areas:
        "tag source"
        "title title";
      gap: 8px 12px;
      align-content: start;
    }
    .mediaItem span { grid-area: tag; }
    .mediaItem strong {
      grid-area: title;
      font-size: 16px;
      line-height: 1.45;
    }
    .mediaItem em {
      grid-area: source;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--faint);
      font-size: 12px;
      font-style: normal;
      text-align: right;
      align-self: center;
    }
    .mediaFoot {
      border-top: 1px solid var(--line);
      padding-top: 14px;
      color: var(--muted);
      font-size: 13px;
    }
    .homePulse {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 0.72fr)) minmax(360px, 1.15fr);
      gap: 14px;
      margin: -18px 0 18px;
    }
    .pulseMetric,
    .pulseChart,
    .homeInsight,
    .homeLatest {
      border: 1px solid var(--line);
      border-radius: calc(var(--radius) + 2px);
      background: linear-gradient(145deg, color-mix(in oklch, white 64%, transparent), color-mix(in oklch, white 38%, transparent));
      box-shadow: var(--shadow-soft);
      backdrop-filter: blur(22px) saturate(1.3);
      -webkit-backdrop-filter: blur(22px) saturate(1.3);
      padding: 20px;
    }
    .pulseMetric {
      min-height: 154px;
      display: grid;
      align-content: space-between;
      gap: 10px;
    }
    .pulseMetric span,
    .pulseChart span,
    .latestSignal span {
      width: fit-content;
      border-radius: 999px;
      background: var(--accent-soft);
      color: var(--accent);
      padding: 4px 9px;
      font-size: 12px;
      line-height: 1.35;
      font-weight: 750;
    }
    .pulseMetric strong {
      font-size: clamp(34px, 4vw, 48px);
      line-height: 0.95;
      font-variant-numeric: tabular-nums;
    }
    .pulseMetric p,
    .latestSignal p {
      color: var(--muted);
      font-size: 14px;
      line-height: 1.62;
      margin: 0;
    }
    .pulseChart {
      display: grid;
      gap: 16px;
      min-height: 154px;
    }
    .pulseChart strong {
      display: block;
      margin-top: 8px;
      font-size: 18px;
      line-height: 1.32;
    }
    .sparkline {
      height: 92px;
      display: flex;
      align-items: end;
      gap: 7px;
      padding-top: 10px;
    }
    .sparkline i {
      flex: 1;
      min-width: 7px;
      border-radius: 999px;
      background: linear-gradient(180deg, var(--accent-2), var(--accent));
      transform-origin: bottom;
      animation: barGrow 620ms cubic-bezier(0.22, 1, 0.36, 1) both;
      box-shadow: 0 6px 14px color-mix(in oklch, var(--accent) 18%, transparent);
    }
    .sparkline i:nth-child(2n) { animation-delay: 40ms; opacity: 0.88; }
    .sparkline i:nth-child(3n) { animation-delay: 80ms; opacity: 0.76; }
    .sparklineEmpty { color: var(--muted); font-size: 14px; }
    .homeInsight,
    .homeLatest {
      display: grid;
      grid-template-columns: minmax(0, 0.82fr) minmax(420px, 1.18fr);
      gap: 18px;
      align-items: stretch;
      margin-bottom: 18px;
    }
    .homeInsightCopy {
      display: grid;
      align-content: center;
    }
    .homeChartBoard {
      display: grid;
      grid-template-columns: minmax(0, 1.05fr) minmax(0, 0.95fr);
      gap: 12px;
    }
    .homeChartBoard section {
      min-width: 0;
      border-radius: var(--radius-small);
      background: color-mix(in oklch, white 52%, transparent);
      padding: 16px;
    }
    .homeBars {
      display: grid;
      gap: 10px;
    }
    .homeBarRow {
      display: grid;
      grid-template-columns: minmax(72px, 0.74fr) 28px minmax(0, 1fr);
      align-items: center;
      gap: 10px;
      font-size: 13px;
      color: var(--muted);
    }
    .homeBarRow span {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .homeBarRow b {
      color: var(--ink);
      font-variant-numeric: tabular-nums;
      text-align: right;
    }
    .homeBarRow em {
      height: 9px;
      border-radius: 999px;
      background: color-mix(in oklch, var(--accent-soft) 62%, white);
      overflow: hidden;
      font-style: normal;
    }
    .homeBarRow i {
      display: block;
      height: 100%;
      border-radius: 999px;
      background: linear-gradient(90deg, var(--accent-2), var(--accent));
    }
    .typeOrbit {
      min-height: 202px;
      display: flex;
      flex-wrap: wrap;
      align-content: center;
      align-items: center;
      gap: 10px;
    }
    .typeBubble {
      width: var(--size);
      min-width: 74px;
      height: var(--size);
      min-height: 74px;
      border-radius: 999px;
      border: 1px solid color-mix(in oklch, var(--accent) 24%, var(--line));
      background: radial-gradient(circle at 34% 28%, color-mix(in oklch, white 80%, transparent), color-mix(in oklch, var(--accent-soft) 68%, white));
      display: grid;
      place-items: center;
      align-content: center;
      text-align: center;
      gap: 2px;
      padding: 8px;
      box-shadow: 0 8px 18px color-mix(in oklch, var(--accent) 10%, transparent);
    }
    .typeBubble strong {
      font-size: 17px;
      line-height: 1;
      font-variant-numeric: tabular-nums;
    }
    .typeBubble span {
      max-width: 8ch;
      color: var(--muted);
      font-size: 11px;
      line-height: 1.25;
    }
    .homeLatest {
      grid-template-columns: minmax(300px, 0.65fr) minmax(0, 1.35fr);
    }
    .homeLatest .primaryLink { width: fit-content; margin-top: 18px; }
    .latestSignals {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
    }
    .latestSignal {
      min-height: 164px;
      border-radius: var(--radius-small);
      background: color-mix(in oklch, white 52%, transparent);
      padding: 15px;
      display: grid;
      gap: 8px;
      align-content: start;
    }
    .latestSignal strong {
      font-size: 15px;
      line-height: 1.48;
    }
    .latestSignal a {
      width: fit-content;
      min-height: 32px;
      display: inline-flex;
      align-items: center;
      align-self: end;
      font-size: 13px;
    }
    .homeIntent,
    .homeRoadmap {
      display: grid;
      grid-template-columns: minmax(0, 0.9fr) minmax(360px, 1.1fr);
      gap: 18px;
      align-items: stretch;
      margin-bottom: 18px;
    }
    .homeIntentCopy,
    .homePrinciples,
    .homeRoadmap,
    .homeShowcase {
      border: 1px solid var(--line);
      border-radius: calc(var(--radius) + 2px);
      background: linear-gradient(145deg, color-mix(in oklch, white 64%, transparent), color-mix(in oklch, white 40%, transparent));
      box-shadow: var(--shadow-soft);
      backdrop-filter: blur(22px) saturate(1.3);
      -webkit-backdrop-filter: blur(22px) saturate(1.3);
      padding: 22px;
    }
    .homePrinciples {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 12px;
    }
    .homePrinciples div {
      border-radius: var(--radius-small);
      background: color-mix(in oklch, white 52%, transparent);
      padding: 15px;
      display: grid;
      gap: 7px;
      align-content: start;
    }
    .homePrinciples strong,
    .portalTile strong,
    .showcaseTrack strong,
    .roadmapList strong {
      color: var(--ink);
      font-size: 17px;
      line-height: 1.35;
      letter-spacing: 0;
    }
    .homePrinciples span,
    .roadmapList span {
      color: var(--muted);
      font-size: 14px;
      line-height: 1.65;
    }
    .portalGrid {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      grid-auto-rows: minmax(190px, auto);
      gap: 14px;
      margin-bottom: 18px;
    }
    .portalTile {
      border: 1px solid var(--line);
      border-radius: calc(var(--radius) + 2px);
      background: linear-gradient(145deg, color-mix(in oklch, white 66%, transparent), color-mix(in oklch, white 38%, transparent));
      box-shadow: var(--shadow-soft);
      backdrop-filter: blur(22px) saturate(1.3);
      -webkit-backdrop-filter: blur(22px) saturate(1.3);
      padding: 20px;
      display: grid;
      gap: 10px;
      align-content: start;
      color: var(--ink);
      transition: transform 180ms ease, border-color 180ms ease, background 180ms ease;
    }
    .portalTile:hover {
      transform: translateY(-3px);
      border-color: color-mix(in oklch, var(--accent) 42%, var(--line));
      text-decoration: none;
      background: linear-gradient(145deg, color-mix(in oklch, white 74%, transparent), color-mix(in oklch, white 46%, transparent));
    }
    .portalTileLarge {
      grid-column: span 2;
      grid-row: span 2;
      min-height: 300px;
      align-content: end;
    }
    .portalTileLarge strong {
      font-size: clamp(26px, 3vw, 38px);
      line-height: 1.08;
      max-width: 12ch;
    }
    .portalTile p {
      color: var(--muted);
      font-size: 15px;
      line-height: 1.72;
      margin: 0;
      max-width: 52ch;
    }
    .homeShowcase {
      margin-bottom: 18px;
    }
    .showcaseTrack {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 12px;
      margin-top: 16px;
    }
    .showcaseTrack div {
      min-height: 158px;
      border-radius: var(--radius-small);
      background: color-mix(in oklch, white 52%, transparent);
      padding: 16px;
      display: grid;
      gap: 8px;
      align-content: start;
    }
    .showcaseTrack p {
      color: var(--muted);
      font-size: 14px;
      line-height: 1.62;
    }
    .homeRoadmap {
      grid-template-columns: minmax(280px, 0.7fr) minmax(0, 1.3fr);
    }
    .roadmapList {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
    }
    .roadmapList p {
      margin: 0;
      border-radius: var(--radius-small);
      background: color-mix(in oklch, white 52%, transparent);
      padding: 15px;
      display: grid;
      gap: 7px;
    }
    .rolePanel {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 12px;
      margin: 0 0 16px;
    }
    .roleCard {
      min-height: 150px;
      border: 1px solid var(--line);
      border-radius: var(--radius);
      background: linear-gradient(145deg, color-mix(in oklch, white 68%, transparent), color-mix(in oklch, white 42%, transparent));
      box-shadow: var(--shadow-soft);
      backdrop-filter: blur(20px) saturate(1.28);
      -webkit-backdrop-filter: blur(20px) saturate(1.28);
      padding: 18px;
      display: grid;
      align-content: start;
      gap: 8px;
      color: var(--ink);
      transition: transform 180ms ease, border-color 180ms ease, background 180ms ease;
    }
    .roleCard span,
    .reviewIdentity span {
      width: fit-content;
      border-radius: 999px;
      background: var(--accent-soft);
      color: var(--accent);
      padding: 4px 9px;
      font-size: 12px;
      line-height: 1.35;
      font-weight: 750;
    }
    .roleCard strong,
    .reviewIdentity strong {
      font-size: 17px;
      line-height: 1.35;
      letter-spacing: 0;
    }
    .roleCard p,
    .reviewIdentity p {
      color: var(--muted);
      font-size: 14px;
      line-height: 1.65;
      margin: 0;
    }
    .roleLink {
      border-color: color-mix(in oklch, var(--accent) 38%, var(--line));
      text-decoration: none;
    }
    .roleCard:hover,
    .roleLink:hover { transform: translateY(-2px); border-color: color-mix(in oklch, var(--accent) 32%, var(--line)); text-decoration: none; }
    .reviewShell { padding-bottom: 64px; }
    .reviewHero {
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: center;
    }
    .heroSwitch {
      justify-content: flex-end;
      align-self: center;
      min-width: 250px;
    }
    .reviewIdentity {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
      margin: 0 0 16px;
    }
    .reviewIdentity > div {
      border: 1px solid var(--line);
      border-radius: var(--radius);
      background: color-mix(in oklch, white 54%, transparent);
      box-shadow: var(--shadow-soft);
      backdrop-filter: blur(20px) saturate(1.28);
      -webkit-backdrop-filter: blur(20px) saturate(1.28);
      padding: 18px;
      display: grid;
      gap: 8px;
      align-content: start;
    }
    .reviewIdentity > div.active {
      border-color: color-mix(in oklch, var(--accent) 42%, var(--line));
      background: linear-gradient(145deg, color-mix(in oklch, var(--accent-soft) 72%, white), color-mix(in oklch, white 46%, transparent));
    }
    .reviewIdentity a {
      width: fit-content;
      min-height: 36px;
      display: inline-flex;
      align-items: center;
      color: var(--accent);
      font-size: 14px;
      font-weight: 750;
    }
    .dailyTools {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
      align-items: center;
      border: 1px solid var(--line);
      border-radius: var(--radius);
      background: var(--glass);
      box-shadow: var(--shadow-soft);
      backdrop-filter: blur(22px) saturate(1.3);
      -webkit-backdrop-filter: blur(22px) saturate(1.3);
      padding: 14px;
      margin: 0 0 16px;
    }
    .dailyTools > div { display: flex; gap: 8px; flex-wrap: wrap; }
    .navButton, .primaryLink {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 44px;
      border-radius: 999px;
      padding: 0 15px;
      font-size: 14px;
      font-weight: 700;
      transition: transform 180ms ease, background 180ms ease, border-color 180ms ease;
    }
    .navButton {
      border: 1px solid var(--line);
      background: color-mix(in oklch, white 54%, transparent);
      color: var(--muted);
    }
    .primaryLink {
      border: 1px solid color-mix(in oklch, var(--accent) 50%, var(--line));
      background: var(--accent-soft);
      color: var(--accent);
    }
    .navButton:hover, .primaryLink:hover { transform: translateY(-1px); text-decoration: none; }
    .emptyPanel {
      width: min(760px, 100%);
      border: 1px solid var(--line);
      background: var(--glass-strong);
      border-radius: calc(var(--radius) + 4px);
      box-shadow: var(--shadow);
      backdrop-filter: blur(26px) saturate(1.32);
      -webkit-backdrop-filter: blur(26px) saturate(1.32);
      padding: 30px;
      margin: 26px 0 0;
    }
    .emptyPanel .primaryLink { margin-top: 18px; }
    .reviewPanel {
      background: var(--glass);
      border: 1px solid var(--line);
      border-radius: calc(var(--radius) + 2px);
      box-shadow: var(--shadow-soft);
      backdrop-filter: blur(24px) saturate(1.35);
      -webkit-backdrop-filter: blur(24px) saturate(1.35);
      padding: 20px;
      margin: 0 0 16px;
    }
    .reviewOverview { margin-bottom: 16px; }
    .reviewHead {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 16px;
      align-items: start;
      margin-bottom: 14px;
    }
    .rangeSwitch { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
    .rangeSwitch a {
      display: inline-flex;
      align-items: center;
      min-height: 44px;
      border: 1px solid var(--line);
      background: color-mix(in oklch, white 58%, transparent);
      color: var(--muted);
      border-radius: 999px;
      padding: 0 13px;
      font-size: 13px;
      transition: background 180ms ease, color 180ms ease, transform 180ms ease;
    }
    .rangeSwitch a.active { border-color: color-mix(in oklch, var(--accent) 55%, var(--line)); background: var(--accent-soft); color: var(--accent); }
    .rangeSwitch a:hover { transform: translateY(-1px); text-decoration: none; }
    .reviewGrid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin-bottom: 16px; }
    .metric {
      border: 1px solid var(--line);
      background: color-mix(in oklch, white 56%, var(--accent-soft));
      border-radius: var(--radius-small);
      padding: 12px;
      min-height: 72px;
      display: grid;
      align-content: center;
      gap: 5px;
      backdrop-filter: blur(14px);
      -webkit-backdrop-filter: blur(14px);
    }
    .metric span { color: var(--muted); font-size: 12px; }
    .metric b { color: var(--ink); font-size: 28px; line-height: 1; }
    .insightGrid { display: grid; grid-template-columns: 1.1fr 1fr 1fr; gap: 14px; align-items: start; }
    .insightGrid section { min-width: 0; background: color-mix(in oklch, white 52%, transparent); border: 1px solid var(--line); border-radius: var(--radius-small); padding: 14px; backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px); }
    .reviewDashboard {
      display: grid;
      grid-template-columns: 1.15fr 1fr 1fr;
      gap: 14px;
      margin: 0 0 16px;
      align-items: stretch;
    }
    .reviewGlassBlock,
    .reviewTimeline,
    .reviewSamples {
      border: 1px solid var(--line);
      border-radius: calc(var(--radius) + 2px);
      background: linear-gradient(145deg, color-mix(in oklch, white 66%, transparent), color-mix(in oklch, white 40%, transparent));
      box-shadow: var(--shadow-soft);
      backdrop-filter: blur(24px) saturate(1.3);
      -webkit-backdrop-filter: blur(24px) saturate(1.3);
      padding: 18px;
    }
    .reviewGlassBlock { min-width: 0; }
    .directionBlock { min-height: 250px; }
    .blockTitle { margin-bottom: 14px; }
    .blockTitle h2 { font-size: 22px; }
    .reviewTimeline,
    .reviewSamples {
      margin-bottom: 16px;
    }
    .dayList {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
      gap: 10px;
    }
    .dayItem {
      min-height: 132px;
      border: 1px solid var(--line);
      border-radius: var(--radius-small);
      background: color-mix(in oklch, white 54%, transparent);
      padding: 14px;
      display: grid;
      gap: 7px;
      align-content: start;
      color: var(--ink);
      transition: transform 180ms ease, border-color 180ms ease, background 180ms ease;
      animation: riseIn 420ms cubic-bezier(0.22, 1, 0.36, 1) both;
    }
    .dayItem:hover {
      transform: translateY(-2px);
      border-color: color-mix(in oklch, var(--accent) 42%, var(--line));
      text-decoration: none;
      background: color-mix(in oklch, white 68%, transparent);
    }
    .dayItem span {
      color: var(--accent);
      font-size: 13px;
      line-height: 1.35;
      font-weight: 750;
    }
    .dayItem strong {
      font-size: 15px;
      line-height: 1.55;
      color: var(--ink);
    }
    .dayItem em {
      color: var(--muted);
      font-size: 13px;
      line-height: 1.5;
      font-style: normal;
    }
    .reviewSampleGrid {
      grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
    }
    .bars { display: grid; gap: 9px; }
    .barRow { display: grid; grid-template-columns: 82px minmax(0, 1fr) 24px; align-items: center; gap: 8px; font-size: 13px; color: var(--muted); }
    .barRow span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .barRow div { height: 8px; background: color-mix(in oklch, var(--accent-soft) 55%, var(--surface-2)); border-radius: 999px; overflow: hidden; }
    .barRow i { display: block; height: 100%; background: var(--accent); border-radius: 999px; }
    .barRow b { text-align: right; color: var(--muted); font-weight: 600; }
    .compactList { margin: 0; padding-left: 18px; display: grid; gap: 8px; }
    .compactList li { color: var(--muted); line-height: 1.55; font-size: 13px; padding-left: 2px; }
    .compactList span { display: block; color: var(--faint); margin-top: 2px; font-size: 12px; }
    .finderPanel {
      position: sticky;
      top: 84px;
      z-index: var(--sticky);
      background: color-mix(in oklch, white 58%, transparent);
      padding: 14px;
      border: 1px solid var(--line);
      border-radius: calc(var(--radius) + 4px);
      box-shadow: var(--shadow-soft);
      margin-bottom: 16px;
      backdrop-filter: blur(24px) saturate(1.35);
      -webkit-backdrop-filter: blur(24px) saturate(1.35);
    }
    .finderTop { display: grid; grid-template-columns: minmax(240px, 1fr) 170px 170px 150px 150px auto; gap: 10px; align-items: center; }
    .toolbar {
      display: grid;
      grid-template-columns: minmax(240px, 320px) minmax(0, 1fr);
      gap: 12px;
      align-items: start;
      margin-bottom: 16px;
    }
    .search input, select, input[type="date"] {
      width: 100%;
      height: 44px;
      border: 1px solid var(--line);
      border-radius: 999px;
      background: color-mix(in oklch, white 66%, transparent);
      color: var(--ink);
      padding: 0 15px;
      font: inherit;
      font-size: 15px;
      outline: none;
      backdrop-filter: blur(14px);
      -webkit-backdrop-filter: blur(14px);
    }
    .search input::placeholder { color: var(--muted); opacity: 1; }
    .search input:focus, select:focus, input[type="date"]:focus { border-color: var(--accent); box-shadow: 0 0 0 3px color-mix(in oklch, var(--accent) 18%, transparent); }
    #clearFilters {
      height: 44px;
      border: 1px solid color-mix(in oklch, var(--amber) 60%, var(--line));
      border-radius: 999px;
      background: color-mix(in oklch, white 62%, transparent);
      color: color-mix(in oklch, var(--amber) 85%, black);
      padding: 0 15px;
      font: inherit;
      font-size: 15px;
      cursor: pointer;
      transition: transform 180ms ease, background 180ms ease;
    }
    #clearFilters:hover { transform: translateY(-1px); background: color-mix(in oklch, white 76%, transparent); }
    .dateRailWrap { position: relative; min-width: 0; }
    .dateRailWrap::after {
      content: "";
      position: absolute;
      top: 8px;
      right: 0;
      bottom: 0;
      width: 54px;
      pointer-events: none;
      border-radius: 0 999px 999px 0;
      background: linear-gradient(90deg, transparent, color-mix(in oklch, white 82%, transparent));
    }
    .dateRail { display: flex; gap: 8px; overflow-x: auto; padding: 10px 54px 2px 0; scrollbar-width: thin; }
    .dateRail button {
      flex: none;
      min-height: 44px;
      border: 1px solid var(--line);
      border-radius: 999px;
      background: color-mix(in oklch, white 58%, transparent);
      color: var(--muted);
      padding: 0 14px;
      font: inherit;
      font-size: 13px;
      cursor: pointer;
      transition: background 180ms ease, color 180ms ease, transform 180ms ease;
    }
    .dateRail button span { color: var(--faint); margin-left: 3px; }
    .dateRail button.active { border-color: var(--accent); background: var(--accent-soft); color: var(--accent); font-weight: 700; }
    .dateRail button:hover { transform: translateY(-1px); }
    .resultLine { margin: 8px 0 0; color: var(--muted); font-size: 13px; }
    .segments { display: flex; flex-wrap: wrap; gap: 8px; }
    .segments button {
      min-height: 44px;
      border: 1px solid var(--line);
      border-radius: 999px;
      background: color-mix(in oklch, white 58%, transparent);
      color: var(--muted);
      padding: 0 14px;
      font: inherit;
      cursor: pointer;
      transition: background 180ms ease, color 180ms ease, transform 180ms ease;
    }
    .segments button span { color: var(--faint); margin-left: 4px; }
    .segments button.active {
      border-color: var(--accent);
      background: var(--accent-soft);
      color: var(--accent);
      font-weight: 700;
    }
    .segments button:hover { transform: translateY(-1px); }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(315px, 1fr)); gap: 12px; align-items: stretch; }
    .card {
      background: linear-gradient(145deg, color-mix(in oklch, white 70%, transparent), color-mix(in oklch, white 42%, transparent));
      border: 1px solid var(--line);
      border-radius: var(--radius);
      padding: 18px;
      min-height: 260px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      box-shadow: 0 8px 26px color-mix(in oklch, oklch(0.42 0.06 252) 8%, transparent);
      backdrop-filter: blur(22px) saturate(1.3);
      -webkit-backdrop-filter: blur(22px) saturate(1.3);
      transition: border-color 200ms ease, transform 200ms ease, background 200ms ease, box-shadow 200ms ease;
      animation: riseIn 480ms cubic-bezier(0.22, 1, 0.36, 1) both;
    }
    .grid .card:nth-child(2) { animation-delay: 40ms; }
    .grid .card:nth-child(3) { animation-delay: 80ms; }
    .grid .card:nth-child(4) { animation-delay: 120ms; }
    .grid .card:nth-child(5) { animation-delay: 160ms; }
    .grid .card:nth-child(6) { animation-delay: 200ms; }
    .grid .card:nth-child(7) { animation-delay: 240ms; }
    .grid .card:nth-child(8) { animation-delay: 280ms; }
    .card[hidden] { display: none; }
    .card:hover {
      border-color: color-mix(in oklch, var(--accent) 42%, var(--line));
      transform: translateY(-3px);
      box-shadow: 0 18px 42px color-mix(in oklch, oklch(0.42 0.07 252) 14%, transparent);
    }
    .meta { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
    .meta span {
      border-radius: 999px;
      padding: 4px 9px;
      font-size: 12px;
      line-height: 1.4;
      border: 1px solid transparent;
    }
    .type { background: var(--green-soft); color: var(--green); border-color: color-mix(in oklch, var(--green) 30%, var(--green-soft)); }
    .priority { background: var(--amber-soft); color: color-mix(in oklch, var(--amber) 85%, black); border-color: color-mix(in oklch, var(--amber) 28%, var(--amber-soft)); }
    .dateBadge {
      border: 1px solid var(--line);
      background: color-mix(in oklch, white 54%, transparent);
      color: var(--muted);
      border-radius: 999px;
      padding: 4px 9px;
      font-size: 12px;
      line-height: 1.4;
      font-weight: 600;
    }
    .card h2 { font-size: 17px; line-height: 1.48; margin: 0; }
    p { margin: 0; line-height: 1.68; font-size: 15px; }
    .topics { color: var(--muted); font-size: 13px; }
    .fact { color: var(--ink); }
    dl { margin: 0; display: grid; gap: 8px; }
    dl div { display: grid; grid-template-columns: 52px minmax(0, 1fr); gap: 8px; align-items: start; }
    dt { color: var(--faint); font-size: 13px; line-height: 1.6; }
    dd { margin: 0; color: var(--muted); font-size: 15px; line-height: 1.62; }
    footer {
      margin-top: auto;
      padding-top: 10px;
      border-top: 1px solid var(--line);
      display: flex;
      justify-content: space-between;
      gap: 10px;
      align-items: center;
      color: var(--muted);
      font-size: 13px;
    }
    footer span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    a { color: var(--accent); text-decoration: none; font-weight: 700; }
    a:hover { text-decoration: underline; }
    a:focus-visible,
    button:focus-visible,
    input:focus-visible,
    select:focus-visible {
      outline: 3px solid color-mix(in oklch, var(--accent) 32%, transparent);
      outline-offset: 3px;
    }
    .sourceLink { flex: none; }
    .empty { margin: 24px 0 0; color: #607086; }
    @media (max-width: 760px) {
      .shell { width: min(100vw - 20px, 1180px); padding-top: 12px; }
      .siteNav { position: static; align-items: flex-start; flex-direction: column; gap: 8px; border-radius: var(--radius); padding: 10px; }
      .brandMark { min-height: 34px; }
      .navLinks { justify-content: flex-start; }
      .navLinks a { min-height: 38px; padding: 0 11px; font-size: 13px; }
      .homeHero { grid-template-columns: 1fr; min-height: auto; gap: 18px; padding: 24px 0 28px; }
      .homeHero h1 { max-width: 100%; font-size: clamp(36px, 11.2vw, 46px); line-height: 1.03; }
      .homeLead { margin-top: 14px; font-size: 15.5px; line-height: 1.68; }
      .homeActions { gap: 8px; margin-top: 18px; }
      .navButton, .primaryLink { min-height: 42px; padding: 0 13px; }
      .homeMedia { min-height: auto; padding: 16px; gap: 12px; border-radius: var(--radius); grid-template-rows: auto; }
      .mediaTop, .mediaFoot { align-items: flex-start; flex-direction: column; gap: 8px; }
      .mediaHeadline { padding-bottom: 12px; }
      .mediaHeadline p { margin-bottom: 6px; }
      .mediaHeadline h2 { font-size: 20px; line-height: 1.26; }
      .mediaFeed { gap: 8px; }
      .mediaItem { min-height: auto; grid-template-columns: 1fr; grid-template-areas: "tag" "title" "source"; gap: 6px; padding: 12px; }
      .mediaItem:nth-child(n+3) { display: none; }
      .mediaItem strong { font-size: 15px; line-height: 1.42; }
      .mediaItem em { text-align: left; }
      .homePulse { grid-template-columns: 1fr; margin-top: 0; }
      .pulseMetric { min-height: 132px; }
      .homeInsight, .homeLatest { grid-template-columns: 1fr; }
      .homeChartBoard { grid-template-columns: 1fr; }
      .latestSignals { grid-template-columns: 1fr; }
      .homeIntent, .homeRoadmap { grid-template-columns: 1fr; }
      .homePrinciples, .showcaseTrack, .roadmapList { grid-template-columns: 1fr; }
      .portalGrid { grid-template-columns: 1fr; grid-auto-rows: auto; }
      .portalTileLarge { grid-column: auto; grid-row: auto; min-height: 230px; }
      .top { grid-template-columns: 1fr; padding: 22px; }
      .stats { justify-content: flex-start; }
      .rolePanel { grid-template-columns: 1fr; }
      .roleCard { min-height: auto; }
      .reviewHero { grid-template-columns: 1fr; }
      .heroSwitch { min-width: 0; justify-content: flex-start; }
      .reviewIdentity { grid-template-columns: 1fr; }
      .reviewHead { grid-template-columns: 1fr; }
      .rangeSwitch { justify-content: flex-start; }
      .reviewGrid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .insightGrid { grid-template-columns: 1fr; }
      .reviewDashboard { grid-template-columns: 1fr; }
      .finderPanel { position: static; }
      .finderTop { grid-template-columns: 1fr; }
      .toolbar { grid-template-columns: 1fr; }
      .grid { grid-template-columns: 1fr; }
      .dailyTools { align-items: stretch; flex-direction: column; }
      h1 { font-size: 26px; }
      p, dd { font-size: 16px; }
      .roleCard p, .reviewIdentity p, .dayItem strong { font-size: 15px; }
    }
    /* iOS-inspired visual polish shared by home, library, review, and daily pages. */
    :root {
      --bg: oklch(0.982 0.006 220);
      --surface: color-mix(in oklch, white 72%, transparent);
      --surface-strong: color-mix(in oklch, white 90%, transparent);
      --surface-2: color-mix(in oklch, oklch(0.94 0.018 220) 62%, white);
      --glass: color-mix(in oklch, white 68%, transparent);
      --glass-strong: color-mix(in oklch, white 82%, transparent);
      --ink: oklch(0.18 0.026 248);
      --muted: oklch(0.42 0.032 246);
      --faint: oklch(0.58 0.026 244);
      --line: color-mix(in oklch, oklch(0.74 0.025 226) 38%, white);
      --accent: oklch(0.54 0.13 205);
      --accent-2: oklch(0.66 0.13 58);
      --accent-3: oklch(0.56 0.12 155);
      --accent-soft: color-mix(in oklch, var(--accent) 13%, white);
      --warm-soft: color-mix(in oklch, var(--accent-2) 12%, white);
      --green-soft: color-mix(in oklch, var(--accent-3) 11%, white);
      --radius: 16px;
      --radius-small: 10px;
      --shadow: 0 18px 44px color-mix(in oklch, oklch(0.32 0.06 230) 14%, transparent);
      --shadow-soft: 0 8px 22px color-mix(in oklch, oklch(0.34 0.05 230) 10%, transparent);
    }
    body {
      background:
        radial-gradient(circle at 18% 8%, color-mix(in oklch, var(--accent) 12%, transparent), transparent 28rem),
        radial-gradient(circle at 84% 2%, color-mix(in oklch, var(--accent-2) 10%, transparent), transparent 26rem),
        linear-gradient(180deg, oklch(0.99 0.004 220), oklch(0.962 0.012 220) 48%, oklch(0.985 0.005 170));
      color: var(--ink);
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", "Microsoft YaHei", sans-serif;
    }
    body::before {
      opacity: 0.32;
      background-image:
        linear-gradient(color-mix(in oklch, var(--line) 48%, transparent) 1px, transparent 1px),
        linear-gradient(90deg, color-mix(in oklch, var(--line) 44%, transparent) 1px, transparent 1px);
      background-size: 80px 80px;
      mask-image: linear-gradient(180deg, black 0%, transparent 76%);
    }
    @keyframes softDrift {
      0%, 100% { transform: translate3d(0, 0, 0); }
      50% { transform: translate3d(0, -5px, 0); }
    }
    @keyframes sheen {
      from { transform: translateX(-120%); opacity: 0; }
      30% { opacity: 0.72; }
      to { transform: translateX(160%); opacity: 0; }
    }
    .shell { width: min(1240px, calc(100vw - 32px)); padding: 22px 0 72px; }
    .siteNav {
      min-height: 62px;
      margin-bottom: 22px;
      padding: 8px 10px 8px 14px;
      border-color: color-mix(in oklch, var(--line) 70%, white);
      border-radius: 20px;
      background: color-mix(in oklch, white 72%, transparent);
      box-shadow: var(--shadow-soft);
      isolation: isolate;
    }
    .brandMark {
      gap: 9px;
      font-size: 16px;
      font-weight: 820;
    }
    .brandMark::before {
      content: "";
      width: 10px;
      height: 10px;
      border-radius: 999px;
      background: linear-gradient(135deg, var(--accent), var(--accent-3));
      box-shadow: 0 0 0 5px color-mix(in oklch, var(--accent) 10%, transparent);
    }
    .navLinks a {
      min-height: 42px;
      color: var(--muted);
      font-size: 14px;
      font-weight: 720;
    }
    .navLinks a.active {
      color: var(--ink);
      background: color-mix(in oklch, white 82%, var(--accent-soft));
    }
    .navLinks a:hover {
      color: var(--ink);
      background: color-mix(in oklch, white 70%, transparent);
    }
    .navLinks {
      flex: 1;
      justify-content: center;
    }
    .navStatus {
      max-width: 100%;
      min-height: 42px;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      border: 1px solid color-mix(in oklch, var(--accent) 18%, white);
      border-radius: 999px;
      background: color-mix(in oklch, white 70%, transparent);
      color: var(--ink);
      padding: 0 12px;
      text-decoration: none;
      font-size: 12px;
      line-height: 1.2;
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
      overflow: hidden;
    }
    .navStatus span {
      color: var(--muted);
      font-weight: 700;
    }
    .navStatus b {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      font-weight: 760;
    }
    .sectionLabel {
      margin: 0 0 9px;
      color: var(--accent);
      font-size: 13px;
      line-height: 1.35;
      font-weight: 760;
    }
    h1 {
      color: var(--ink);
      font-size: clamp(32px, 4.4vw, 58px);
      line-height: 1.04;
      letter-spacing: 0;
    }
    h2 {
      color: var(--ink);
      font-size: clamp(22px, 2.2vw, 30px);
      line-height: 1.2;
      letter-spacing: 0;
    }
    h3 { color: var(--ink); font-size: 15px; font-weight: 760; }
    .muted {
      color: var(--muted);
      line-height: 1.72;
      text-wrap: pretty;
    }
    .top,
    .homeMedia,
    .pulseMetric,
    .pulseChart,
    .homeInsight,
    .homeLatest,
    .homeIntentCopy,
    .homePrinciples,
    .portalTile,
    .homeShowcase,
    .homeRoadmap,
    .roleCard,
    .reviewIdentity > div,
    .reviewPanel,
    .reviewGlassBlock,
    .reviewTimeline,
    .reviewSamples,
    .finderPanel,
    .dailyTools,
    .toolbar,
    .card,
    .emptyPanel {
      border-color: color-mix(in oklch, var(--line) 74%, white);
      border-radius: var(--radius);
      background:
        linear-gradient(145deg, color-mix(in oklch, white 78%, transparent), color-mix(in oklch, white 50%, transparent));
      box-shadow: var(--shadow-soft);
      backdrop-filter: blur(22px) saturate(1.25);
      -webkit-backdrop-filter: blur(22px) saturate(1.25);
    }
    .homeShell { width: min(1240px, calc(100vw - 32px)); }
    .homeHero {
      min-height: 610px;
      grid-template-columns: minmax(0, 0.86fr) minmax(410px, 0.94fr);
      gap: 34px;
      padding: 48px 0 42px;
      align-items: center;
    }
    .homeHeroCopy { max-width: 650px; }
    .homeHero h1 {
      max-width: 13ch;
      font-size: clamp(44px, 6vw, 74px);
      line-height: 0.98;
    }
    .homeLead {
      max-width: 54ch;
      margin-top: 20px;
      color: var(--muted);
      font-size: 18px;
      line-height: 1.78;
    }
    .homeActions { margin-top: 26px; gap: 10px; }
    .navButton,
    .primaryLink,
    .rangeSwitch a,
    #clearFilters,
    .dateRail button,
    .segments button {
      min-height: 44px;
      border-radius: 999px;
      touch-action: manipulation;
    }
    .primaryLink {
      border-color: color-mix(in oklch, var(--accent) 42%, var(--line));
      background: linear-gradient(180deg, color-mix(in oklch, var(--accent) 18%, white), color-mix(in oklch, var(--accent) 10%, white));
      color: color-mix(in oklch, var(--accent) 70%, black);
    }
    .navButton {
      background: color-mix(in oklch, white 66%, transparent);
      color: var(--muted);
    }
    .homeMedia {
      position: relative;
      min-height: 510px;
      overflow: hidden;
      padding: 24px;
      border-radius: 20px;
      background:
        linear-gradient(145deg, color-mix(in oklch, white 82%, transparent), color-mix(in oklch, white 52%, transparent)),
        radial-gradient(circle at 82% 18%, color-mix(in oklch, var(--accent) 16%, transparent), transparent 18rem);
    }
    .homeMedia::after {
      content: "";
      position: absolute;
      inset: 0;
      pointer-events: none;
      background: linear-gradient(110deg, transparent 12%, color-mix(in oklch, white 38%, transparent), transparent 42%);
      animation: sheen 6.4s cubic-bezier(0.22, 1, 0.36, 1) infinite;
    }
    .mediaTop,
    .mediaHeadline,
    .mediaFeed,
    .mediaFoot { position: relative; z-index: 1; }
    .mediaTop span,
    .mediaItem span,
    .portalTile span,
    .showcaseTrack span,
    .pulseMetric span,
    .pulseChart span,
    .latestSignal span,
    .roleCard span,
    .reviewIdentity span {
      background: color-mix(in oklch, var(--accent-soft) 82%, white);
      color: color-mix(in oklch, var(--accent) 72%, black);
      border: 1px solid color-mix(in oklch, var(--accent) 18%, white);
    }
    .mediaHeadline {
      padding-bottom: 18px;
      border-bottom: 1px solid color-mix(in oklch, var(--line) 74%, white);
    }
    .mediaHeadline h2 { font-size: clamp(25px, 3vw, 36px); }
    .mediaItem,
    .latestSignal,
    .homeChartBoard section,
    .homePrinciples div,
    .showcaseTrack div,
    .roadmapList p,
    .reviewGlassBlock,
    .metric,
    .insightGrid section {
      border: 1px solid color-mix(in oklch, var(--line) 70%, white);
      border-radius: 12px;
      background: color-mix(in oklch, white 68%, transparent);
    }
    .mediaItem {
      min-height: 96px;
      transition: transform 180ms ease, background 180ms ease;
    }
    .mediaItem:hover { transform: translateY(-2px); background: color-mix(in oklch, white 80%, transparent); }
    .homePulse {
      grid-template-columns: repeat(3, minmax(0, 0.7fr)) minmax(380px, 1.2fr);
      gap: 12px;
      margin: -12px 0 18px;
    }
    .pulseMetric,
    .pulseChart { min-height: 148px; padding: 18px; }
    .pulseMetric strong {
      color: var(--ink);
      font-size: clamp(38px, 4vw, 52px);
      font-weight: 820;
    }
    .pulseMetric p { color: var(--muted); }
    .sparkline i {
      background: linear-gradient(180deg, color-mix(in oklch, var(--accent) 85%, white), color-mix(in oklch, var(--accent-2) 82%, white));
      box-shadow: none;
    }
    .homeInsight,
    .homeLatest {
      grid-template-columns: minmax(0, 0.78fr) minmax(460px, 1.22fr);
      gap: 16px;
      padding: 22px;
      margin-bottom: 18px;
    }
    .homeChartBoard { gap: 12px; }
    .homeBarRow { grid-template-columns: minmax(82px, 0.75fr) 32px minmax(0, 1fr); }
    .homeBarRow em {
      height: 10px;
      background: color-mix(in oklch, var(--accent-soft) 78%, white);
    }
    .homeBarRow i {
      background: linear-gradient(90deg, var(--accent), var(--accent-3));
    }
    .typeBubble {
      border-color: color-mix(in oklch, var(--accent) 18%, white);
      background: radial-gradient(circle at 38% 30%, white, color-mix(in oklch, var(--accent-soft) 62%, white));
      box-shadow: none;
      animation: softDrift 6s ease-in-out infinite;
    }
    .typeBubble:nth-child(2n) { animation-delay: 600ms; }
    .latestSignals { gap: 12px; }
    .latestSignal {
      min-height: 174px;
      padding: 16px;
    }
    .latestSignal strong,
    .mediaItem strong,
    .portalTile strong,
    .showcaseTrack strong,
    .roadmapList strong,
    .roleCard strong,
    .reviewIdentity strong {
      color: var(--ink);
      font-weight: 780;
    }
    .homeIntent,
    .homeRoadmap {
      grid-template-columns: minmax(0, 0.78fr) minmax(420px, 1.22fr);
      gap: 16px;
      margin-bottom: 18px;
    }
    .homeIntentCopy,
    .homePrinciples,
    .homeRoadmap,
    .homeShowcase { padding: 22px; }
    .homePrinciples,
    .showcaseTrack,
    .roadmapList { gap: 12px; }
    .portalGrid {
      gap: 12px;
      grid-auto-rows: minmax(188px, auto);
      margin-bottom: 18px;
    }
    .portalTile {
      padding: 20px;
      min-width: 0;
    }
    .portalTile:hover,
    .roleCard:hover,
    .card:hover,
    .dayItem:hover {
      transform: translateY(-3px);
      background: color-mix(in oklch, white 78%, transparent);
      border-color: color-mix(in oklch, var(--accent) 30%, var(--line));
    }
    .portalTileLarge {
      min-height: 314px;
      background:
        linear-gradient(145deg, color-mix(in oklch, white 78%, transparent), color-mix(in oklch, var(--accent-soft) 54%, white));
    }
    .portalTileLarge strong {
      font-size: clamp(28px, 3.2vw, 42px);
      max-width: 10ch;
    }
    .top {
      padding: 28px;
      border-radius: 20px;
    }
    .stats span {
      background: color-mix(in oklch, white 70%, transparent);
      border-color: color-mix(in oklch, var(--line) 70%, white);
      color: var(--muted);
    }
    .rolePanel,
    .reviewIdentity,
    .reviewDashboard,
    .reviewGrid,
    .insightGrid {
      gap: 12px;
    }
    .finderPanel,
    .dailyTools,
    .toolbar,
    .reviewPanel,
    .reviewTimeline,
    .reviewSamples {
      padding: 18px;
      margin-bottom: 16px;
    }
    .search input,
    select,
    input[type="date"] {
      min-height: 46px;
      border-radius: 12px;
      background: color-mix(in oklch, white 76%, transparent);
      border-color: color-mix(in oklch, var(--line) 80%, white);
      color: var(--ink);
      font-size: 15px;
    }
    .search input::placeholder { color: color-mix(in oklch, var(--muted) 82%, white); }
    .dateRail button,
    .segments button,
    .rangeSwitch a,
    #clearFilters {
      border-color: color-mix(in oklch, var(--line) 76%, white);
      background: color-mix(in oklch, white 64%, transparent);
      color: var(--muted);
    }
    .dateRail button.active,
    .segments button.active,
    .rangeSwitch a.active {
      color: color-mix(in oklch, var(--accent) 72%, black);
      background: var(--accent-soft);
      border-color: color-mix(in oklch, var(--accent) 34%, var(--line));
    }
    .grid {
      grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
      gap: 14px;
    }
    .card {
      min-height: 360px;
      padding: 18px;
      transition: transform 180ms ease, background 180ms ease, border-color 180ms ease;
    }
    .meta span,
    .dateBadge {
      border-radius: 999px;
      background: color-mix(in oklch, var(--accent-soft) 78%, white);
      color: color-mix(in oklch, var(--accent) 70%, black);
    }
    .priority {
      background: color-mix(in oklch, var(--warm-soft) 84%, white);
      color: color-mix(in oklch, var(--accent-2) 72%, black);
    }
    .card h2 { font-size: 18px; line-height: 1.42; }
    p,
    dd { line-height: 1.68; }
    footer {
      border-top-color: color-mix(in oklch, var(--line) 76%, white);
    }
    @media (max-width: 980px) {
      .homeHero,
      .homeInsight,
      .homeLatest,
      .homeIntent,
      .homeRoadmap {
        grid-template-columns: 1fr;
      }
      .homePulse { grid-template-columns: repeat(2, minmax(0, 1fr)); margin-top: 0; }
      .pulseChart { grid-column: span 2; }
      .portalGrid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .portalTileLarge { grid-column: span 2; grid-row: auto; min-height: 260px; }
      .reviewDashboard { grid-template-columns: 1fr; }
      .finderTop { grid-template-columns: 1fr 1fr; }
    }
    @media (max-width: 760px) {
      .shell,
      .homeShell { width: calc(100vw - 24px); max-width: 1180px; padding-top: 14px; }
      .siteNav {
        position: static;
        border-radius: 18px;
        padding: 12px;
      }
      .navLinks { width: 100%; justify-content: flex-start; gap: 6px; }
      .navLinks a { min-height: 38px; padding: 0 11px; font-size: 13px; }
      .homeHero { padding: 30px 0 26px; gap: 20px; }
      .homeHero h1 { font-size: clamp(36px, 11vw, 48px); max-width: 100%; }
      .homeLead { font-size: 16px; line-height: 1.72; }
      .homeMedia { min-height: auto; padding: 16px; border-radius: 16px; }
      .homePulse { grid-template-columns: 1fr; }
      .pulseChart { grid-column: auto; }
      .homeChartBoard,
      .latestSignals,
      .homePrinciples,
      .showcaseTrack,
      .roadmapList,
      .rolePanel,
      .reviewIdentity,
      .reviewGrid,
      .insightGrid,
      .finderTop,
      .toolbar,
      .portalGrid {
        grid-template-columns: 1fr;
      }
      .portalTileLarge { grid-column: auto; min-height: 230px; }
      .top { grid-template-columns: 1fr; padding: 20px; }
      .stats { justify-content: flex-start; }
      .grid { grid-template-columns: 1fr; }
      .card { min-height: auto; }
    }
    /* Impeccable front page redesign: restrained, readable, and product-grade. */
    :root {
      --ink: oklch(0.17 0.022 248);
      --muted: oklch(0.4 0.028 246);
      --faint: oklch(0.58 0.024 242);
      --line: color-mix(in oklch, oklch(0.78 0.022 232) 46%, white);
      --accent: oklch(0.53 0.115 210);
      --accent-2: oklch(0.62 0.105 58);
      --accent-3: oklch(0.54 0.1 158);
      --accent-soft: color-mix(in oklch, var(--accent) 11%, white);
      --surface: color-mix(in oklch, white 82%, transparent);
      --surface-strong: color-mix(in oklch, white 94%, transparent);
      --radius: 14px;
      --radius-small: 10px;
      --shadow: 0 12px 30px color-mix(in oklch, oklch(0.32 0.05 235) 10%, transparent);
      --shadow-soft: 0 6px 16px color-mix(in oklch, oklch(0.32 0.05 235) 8%, transparent);
    }
    body {
      background:
        radial-gradient(circle at 12% 10%, color-mix(in oklch, var(--accent) 10%, transparent), transparent 30rem),
        radial-gradient(circle at 82% 0%, color-mix(in oklch, var(--accent-2) 8%, transparent), transparent 28rem),
        linear-gradient(180deg, oklch(0.992 0.002 235), oklch(0.968 0.01 228) 50%, oklch(0.99 0.002 235));
    }
    .homeShell {
      width: min(1260px, calc(100vw - 32px));
      padding-bottom: 84px;
    }
    .homeStage,
    .homeOverviewBlock,
    .homeOverview,
    .homeSignalMap,
    .homeLatestBlock,
    .homeEntryBlock,
    .homePath,
    .homeWorkflow,
    .homeFuture {
      animation: riseIn 560ms cubic-bezier(0.22, 1, 0.36, 1) both;
    }
    .homeStage {
      min-height: min(680px, calc(100dvh - 104px));
      display: grid;
      grid-template-columns: minmax(0, 0.86fr) minmax(420px, 0.92fr);
      gap: 40px;
      align-items: center;
      padding: 72px 0 54px;
    }
    .homeStageCopy {
      min-width: 0;
      max-width: 720px;
    }
    .brandLine {
      margin: 0 0 14px;
      color: color-mix(in oklch, var(--accent) 78%, black);
      font-size: 15px;
      line-height: 1.35;
      font-weight: 760;
    }
    .homeStage h1 {
      max-width: 12ch;
      font-size: clamp(50px, 6.5vw, 84px);
      line-height: 0.98;
      letter-spacing: 0;
      text-wrap: balance;
    }
    .homeStage .homeLead {
      max-width: 58ch;
      margin-top: 22px;
      color: var(--muted);
      font-size: 18px;
      line-height: 1.76;
    }
    .homeStage .homeActions {
      margin-top: 30px;
      gap: 10px;
    }
    .briefSurface {
      position: relative;
      min-width: 0;
      min-height: 520px;
      overflow: hidden;
      border: 1px solid color-mix(in oklch, var(--line) 72%, white);
      border-radius: 18px;
      background:
        radial-gradient(circle at 82% 16%, color-mix(in oklch, var(--accent) 13%, transparent), transparent 18rem),
        linear-gradient(145deg, color-mix(in oklch, white 88%, transparent), color-mix(in oklch, white 60%, transparent));
      box-shadow: var(--shadow);
      padding: 24px;
      display: grid;
      grid-template-rows: auto auto minmax(0, 1fr) auto;
      gap: 18px;
      backdrop-filter: blur(18px) saturate(1.18);
      -webkit-backdrop-filter: blur(18px) saturate(1.18);
    }
    .briefSurface .mediaItem strong,
    .latestSignal strong,
    .pathPane strong,
    .workflowTrack strong {
      text-wrap: balance;
    }
    .briefSurface::before {
      content: "";
      position: absolute;
      inset: 0;
      pointer-events: none;
      background:
        linear-gradient(180deg, color-mix(in oklch, white 42%, transparent), transparent 42%),
        linear-gradient(90deg, transparent, color-mix(in oklch, var(--accent) 8%, transparent), transparent);
    }
    .briefTop,
    .briefMain,
    .briefItems,
    .briefBottom {
      position: relative;
      z-index: 1;
    }
    .briefTop,
    .briefBottom {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 14px;
      color: var(--muted);
      font-size: 13px;
      font-weight: 720;
    }
    .briefTop span,
    .briefItems .mediaItem span,
    .overviewMetric span,
    .overviewChart span,
    .sectionIntro span,
    .pathPane span,
    .homeFuture > div > span {
      width: fit-content;
      border: 1px solid color-mix(in oklch, var(--accent) 16%, white);
      border-radius: 999px;
      background: color-mix(in oklch, var(--accent-soft) 82%, white);
      color: color-mix(in oklch, var(--accent) 72%, black);
      padding: 5px 9px;
      font-size: 12px;
      line-height: 1.35;
      font-weight: 760;
    }
    .briefTop strong {
      color: var(--ink);
      font-size: 14px;
      font-weight: 780;
    }
    .briefMain {
      padding-bottom: 18px;
      border-bottom: 1px solid color-mix(in oklch, var(--line) 72%, white);
    }
    .briefMain p {
      margin: 0 0 8px;
      color: var(--muted);
      font-size: 13px;
      font-weight: 720;
    }
    .briefMain h2 {
      max-width: 24ch;
      font-size: clamp(25px, 2.55vw, 34px);
      line-height: 1.16;
      overflow-wrap: anywhere;
      word-break: break-word;
    }
    .briefItems {
      display: grid;
      gap: 10px;
      align-content: start;
    }
    .briefItems .mediaItem {
      min-width: 0;
      min-height: 90px;
      border-color: color-mix(in oklch, var(--line) 76%, white);
      border-radius: 12px;
      background: color-mix(in oklch, white 70%, transparent);
      box-shadow: none;
      transition: transform 180ms ease, background 180ms ease, border-color 180ms ease;
    }
    .briefItems .mediaItem:hover {
      transform: translateY(-2px);
      background: color-mix(in oklch, white 84%, transparent);
      border-color: color-mix(in oklch, var(--accent) 24%, var(--line));
    }
    .briefBottom {
      min-width: 0;
      padding-top: 12px;
      border-top: 1px solid color-mix(in oklch, var(--line) 72%, white);
    }
    .briefBottom span {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .briefBottom a {
      color: color-mix(in oklch, var(--accent) 74%, black);
    }
    .homeOverviewBlock,
    .homeEntryBlock {
      margin-bottom: 18px;
    }
    .sectionIntroWide {
      max-width: 760px;
      margin-bottom: 16px;
    }
    .homeOverview {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 0.7fr)) minmax(360px, 1.2fr);
      gap: 12px;
    }
    .overviewMetric,
    .overviewChart,
    .homeSignalMap,
    .homeLatestBlock,
    .pathPane,
    .homeWorkflow,
    .homeFuture {
      border: 1px solid color-mix(in oklch, var(--line) 72%, white);
      border-radius: 16px;
      background: color-mix(in oklch, white 74%, transparent);
      box-shadow: var(--shadow-soft);
      backdrop-filter: blur(18px) saturate(1.16);
      -webkit-backdrop-filter: blur(18px) saturate(1.16);
    }
    .overviewMetric {
      min-height: 148px;
      padding: 18px;
      display: grid;
      align-content: space-between;
      gap: 12px;
    }
    .overviewMetric strong {
      color: var(--ink);
      font-size: clamp(38px, 4vw, 52px);
      line-height: 0.98;
      font-variant-numeric: tabular-nums;
    }
    .overviewMetric p {
      margin: 0;
      color: var(--muted);
      font-size: 14px;
      line-height: 1.58;
    }
    .overviewChart {
      min-height: 148px;
      padding: 18px;
      display: grid;
      gap: 12px;
    }
    .overviewChart strong {
      display: block;
      margin-top: 8px;
      color: var(--ink);
      font-size: 18px;
      line-height: 1.28;
    }
    .homeSignalMap {
      display: grid;
      grid-template-columns: minmax(280px, 0.62fr) minmax(0, 1.38fr);
      gap: 16px;
      align-items: stretch;
      padding: 22px;
      margin-bottom: 18px;
    }
    .sectionIntro {
      display: grid;
      align-content: center;
      gap: 12px;
    }
    .sectionIntro h2,
    .homeFuture h2 {
      font-size: clamp(26px, 3vw, 38px);
      line-height: 1.14;
    }
    .sectionIntro p,
    .homeFuture p {
      margin: 0;
      color: var(--muted);
      line-height: 1.72;
      max-width: 62ch;
    }
    .signalBoard {
      display: grid;
      grid-template-columns: minmax(0, 1.05fr) minmax(0, 0.95fr);
      gap: 12px;
    }
    .signalBoard section {
      min-width: 0;
      border: 1px solid color-mix(in oklch, var(--line) 72%, white);
      border-radius: 12px;
      background: color-mix(in oklch, white 66%, transparent);
      padding: 16px;
    }
    .homeLatestBlock {
      display: grid;
      grid-template-columns: minmax(280px, 0.68fr) minmax(0, 1.32fr);
      gap: 16px;
      padding: 22px;
      margin-bottom: 18px;
    }
    .homeLatestBlock .latestSignals {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
    }
    .homeLatestBlock .latestSignal {
      min-height: 172px;
      border-color: color-mix(in oklch, var(--line) 72%, white);
      border-radius: 12px;
      background: color-mix(in oklch, white 66%, transparent);
      box-shadow: none;
    }
    .homePath {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 12px;
    }
    .pathPane {
      min-height: 220px;
      padding: 20px;
      display: grid;
      align-content: end;
      gap: 10px;
      color: var(--ink);
      text-decoration: none;
      transition: transform 180ms ease, border-color 180ms ease, background 180ms ease;
    }
    .pathPanePrimary {
      background:
        radial-gradient(circle at 82% 18%, color-mix(in oklch, var(--accent) 15%, transparent), transparent 14rem),
        color-mix(in oklch, white 76%, transparent);
    }
    .pathPane:hover {
      transform: translateY(-3px);
      border-color: color-mix(in oklch, var(--accent) 28%, var(--line));
      background: color-mix(in oklch, white 84%, transparent);
      text-decoration: none;
    }
    .pathPane strong {
      color: var(--ink);
      font-size: clamp(24px, 2.8vw, 34px);
      line-height: 1.08;
    }
    .pathPane p {
      margin: 0;
      max-width: 30ch;
      color: var(--muted);
      font-size: 15px;
      line-height: 1.64;
    }
    .homeWorkflow {
      display: grid;
      grid-template-columns: minmax(280px, 0.58fr) minmax(0, 1.42fr);
      gap: 18px;
      align-items: stretch;
      padding: 22px;
      margin-bottom: 18px;
      overflow: hidden;
    }
    .workflowTrack {
      position: relative;
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 0;
      border: 1px solid color-mix(in oklch, var(--line) 72%, white);
      border-radius: 14px;
      background:
        linear-gradient(90deg, color-mix(in oklch, white 74%, transparent), color-mix(in oklch, white 52%, transparent)),
        radial-gradient(circle at 18% 20%, color-mix(in oklch, var(--accent) 10%, transparent), transparent 20rem);
    }
    .workflowTrack::before {
      content: "";
      position: absolute;
      left: 11%;
      right: 11%;
      top: 50%;
      height: 1px;
      background: linear-gradient(90deg, transparent, color-mix(in oklch, var(--accent) 28%, var(--line)), transparent);
      transform: translateY(-50%);
      pointer-events: none;
    }
    .workflowTrack article {
      position: relative;
      min-height: 232px;
      padding: 18px;
      display: grid;
      align-content: space-between;
      gap: 14px;
    }
    .workflowTrack article + article {
      border-left: 1px solid color-mix(in oklch, var(--line) 72%, white);
    }
    .workflowTrack article span {
      position: relative;
      z-index: 1;
      display: inline-flex;
      width: 46px;
      height: 46px;
      align-items: center;
      justify-content: center;
      border-radius: 999px;
      background: color-mix(in oklch, var(--surface-strong) 86%, transparent);
      color: color-mix(in oklch, var(--accent) 74%, black);
      font-size: 13px;
      font-weight: 780;
      box-shadow: 0 4px 12px color-mix(in oklch, oklch(0.32 0.05 235) 8%, transparent);
    }
    .workflowTrack article strong {
      color: var(--ink);
      font-size: 21px;
      line-height: 1.2;
    }
    .workflowTrack article p {
      margin: 0;
      color: var(--muted);
      font-size: 14px;
      line-height: 1.62;
    }
    .homeFuture {
      display: grid;
      grid-template-columns: minmax(280px, 0.72fr) minmax(0, 1.28fr);
      gap: 18px;
      align-items: stretch;
      padding: 22px;
    }
    .homeFuture > div:first-child {
      display: grid;
      align-content: center;
      gap: 12px;
    }
    .futureGrid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
    }
    .futureGrid p {
      margin: 0;
      border: 1px solid color-mix(in oklch, var(--line) 72%, white);
      border-radius: 12px;
      background: color-mix(in oklch, white 66%, transparent);
      padding: 16px;
      display: grid;
      gap: 8px;
    }
    .futureGrid strong {
      color: var(--ink);
      font-size: 17px;
      line-height: 1.32;
    }
    .futureGrid span {
      color: var(--muted);
      font-size: 14px;
      line-height: 1.58;
    }
    .sparkline i {
      background: linear-gradient(180deg, color-mix(in oklch, var(--accent) 86%, white), color-mix(in oklch, var(--accent-2) 82%, white));
      box-shadow: none;
    }
    .homeBarRow i {
      background: linear-gradient(90deg, var(--accent), var(--accent-3));
    }
    .typeBubble {
      border-color: color-mix(in oklch, var(--accent) 18%, white);
      background: radial-gradient(circle at 38% 30%, white, color-mix(in oklch, var(--accent-soft) 62%, white));
      box-shadow: none;
    }
    .top,
    .finderPanel,
    .reviewPanel,
    .reviewGlassBlock,
    .reviewTimeline,
    .reviewSamples,
    .dailyTools,
    .toolbar,
    .card,
    .emptyPanel,
    .roleCard,
    .reviewIdentity > div {
      border-radius: 16px;
      border-color: color-mix(in oklch, var(--line) 72%, white);
      background: color-mix(in oklch, white 74%, transparent);
      box-shadow: var(--shadow-soft);
    }
    .card {
      min-height: 348px;
      transition: transform 180ms ease, border-color 180ms ease, background 180ms ease;
    }
    .card:hover,
    .roleCard:hover,
    .dayItem:hover {
      transform: translateY(-3px);
      border-color: color-mix(in oklch, var(--accent) 28%, var(--line));
      background: color-mix(in oklch, white 84%, transparent);
    }
    @media (max-width: 1040px) {
      .homeStage,
      .homeSignalMap,
      .homeLatestBlock,
      .homeWorkflow,
      .homeFuture {
        grid-template-columns: 1fr;
      }
      .homeStage {
        min-height: auto;
        padding: 54px 0 34px;
      }
      .briefSurface { min-height: 480px; }
      .homeOverview { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .overviewChart { grid-column: span 2; }
    }
    @media (max-width: 760px) {
      .homeShell { width: calc(100vw - 24px); }
      .homeStage {
        gap: 22px;
        padding: 34px 0 24px;
      }
      .homeStage h1 {
        max-width: 100%;
        font-size: clamp(38px, 12vw, 52px);
        line-height: 1.02;
      }
      .homeStage .homeLead {
        font-size: 16px;
        line-height: 1.72;
      }
      .briefSurface {
        min-height: auto;
        padding: 16px;
        border-radius: 16px;
      }
      .briefMain h2 { font-size: clamp(21px, 6vw, 25px); max-width: 100%; line-height: 1.22; }
      .briefItems .mediaItem {
        grid-template-columns: 1fr;
        grid-template-areas: "tag" "title" "source";
      }
      .briefItems .mediaItem em { text-align: left; }
      .homeOverview,
      .signalBoard,
      .homeLatestBlock .latestSignals,
      .homePath,
      .workflowTrack,
      .futureGrid {
        grid-template-columns: 1fr;
      }
      .workflowTrack::before { display: none; }
      .workflowTrack article + article {
        border-left: 0;
        border-top: 1px solid color-mix(in oklch, var(--line) 72%, white);
      }
      .workflowTrack article {
        min-height: 170px;
      }
      .overviewChart { grid-column: auto; }
      .homeSignalMap,
      .homeLatestBlock,
      .homeWorkflow,
      .homeFuture {
        padding: 18px;
        border-radius: 16px;
      }
      .pathPane {
        min-height: 190px;
        border-radius: 16px;
      }
      .pathPane strong { font-size: 28px; }
    }
    .homeStagePro {
      grid-template-columns: minmax(0, 0.78fr) minmax(430px, 0.92fr);
      gap: 44px;
      padding-top: 62px;
    }
    .homeStagePro h1 {
      max-width: 11.5ch;
      font-size: clamp(42px, 5vw, 64px);
      line-height: 1.02;
    }
    .heroMicroStats {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 24px;
    }
    .heroMicroStats span {
      min-height: 34px;
      display: inline-flex;
      align-items: center;
      gap: 5px;
      border: 1px solid color-mix(in oklch, var(--line) 74%, white);
      border-radius: 999px;
      background: color-mix(in oklch, white 66%, transparent);
      color: var(--muted);
      padding: 0 11px;
      font-size: 13px;
      font-weight: 680;
    }
    .heroMicroStats b {
      color: var(--ink);
      font-variant-numeric: tabular-nums;
    }
    .todaySheet {
      grid-template-rows: auto auto auto minmax(0, 1fr) auto;
      min-height: 560px;
      border-radius: 20px;
      background:
        radial-gradient(circle at 78% 14%, color-mix(in oklch, var(--accent) 14%, transparent), transparent 17rem),
        radial-gradient(circle at 14% 92%, color-mix(in oklch, var(--accent-3) 10%, transparent), transparent 16rem),
        linear-gradient(145deg, color-mix(in oklch, white 88%, transparent), color-mix(in oklch, white 62%, transparent));
    }
    .todaySummary h2 {
      font-size: clamp(24px, 2.2vw, 31px);
      line-height: 1.18;
    }
    .todaySheetStats {
      position: relative;
      z-index: 1;
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 10px;
    }
    .todaySheetStats p {
      min-width: 0;
      border: 1px solid color-mix(in oklch, var(--line) 70%, white);
      border-radius: 12px;
      background: color-mix(in oklch, white 68%, transparent);
      padding: 12px;
      display: grid;
      gap: 6px;
    }
    .todaySheetStats span {
      color: var(--muted);
      font-size: 12px;
      font-weight: 720;
    }
    .todaySheetStats strong {
      color: var(--ink);
      font-size: clamp(20px, 2vw, 27px);
      line-height: 1;
      font-variant-numeric: tabular-nums;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .todayFeed .mediaItem:nth-child(n+3) { display: none; }
    .homeCommandCenter {
      margin-bottom: 18px;
    }
    .commandGrid {
      display: grid;
      grid-template-columns: minmax(0, 1.1fr) minmax(300px, 0.72fr) minmax(270px, 0.6fr);
      gap: 12px;
    }
    .commandPanel,
    .pageAtlas,
    .topicFocus,
    .dailyRhythm {
      border: 1px solid color-mix(in oklch, var(--line) 72%, white);
      border-radius: 16px;
      background: color-mix(in oklch, white 74%, transparent);
      box-shadow: var(--shadow-soft);
      backdrop-filter: blur(18px) saturate(1.16);
      -webkit-backdrop-filter: blur(18px) saturate(1.16);
    }
    .commandPanel {
      min-width: 0;
      padding: 18px;
    }
    .panelTitle {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 12px;
    }
    .panelTitle span,
    .atlasLead span,
    .topicCard div span {
      width: fit-content;
      border: 1px solid color-mix(in oklch, var(--accent) 16%, white);
      border-radius: 999px;
      background: color-mix(in oklch, var(--accent-soft) 82%, white);
      color: color-mix(in oklch, var(--accent) 72%, black);
      padding: 5px 9px;
      font-size: 12px;
      line-height: 1.35;
      font-weight: 760;
    }
    .panelTitle strong {
      color: var(--ink);
      font-size: 18px;
      line-height: 1.22;
      text-align: right;
    }
    .panelNote {
      margin-top: 10px;
      color: var(--muted);
      font-size: 13px;
      line-height: 1.5;
    }
    .trendArea svg {
      display: block;
      width: 100%;
      height: 150px;
      overflow: visible;
    }
    .trendFill {
      fill: color-mix(in oklch, var(--accent) 15%, white);
      opacity: 0.78;
    }
    .trendLine {
      fill: none;
      stroke: var(--accent);
      stroke-width: 3;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    .trendArea circle {
      fill: white;
      stroke: var(--accent);
      stroke-width: 2;
    }
    .trendTicks {
      display: flex;
      justify-content: space-between;
      gap: 6px;
      color: var(--faint);
      font-size: 11px;
      line-height: 1.3;
    }
    .trendEmpty {
      min-height: 150px;
      display: grid;
      place-items: center;
      color: var(--muted);
      font-size: 14px;
    }
    .metricPanel {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
    }
    .commandMetric {
      min-width: 0;
      border: 1px solid color-mix(in oklch, var(--line) 72%, white);
      border-radius: 12px;
      background: color-mix(in oklch, white 68%, transparent);
      padding: 14px;
      display: grid;
      align-content: space-between;
      gap: 9px;
    }
    .commandMetric span {
      color: var(--muted);
      font-size: 12px;
      font-weight: 760;
    }
    .commandMetric strong {
      color: var(--ink);
      font-size: clamp(30px, 3.2vw, 42px);
      line-height: 0.96;
      font-variant-numeric: tabular-nums;
    }
    .commandMetric p {
      color: var(--muted);
      font-size: 13px;
      line-height: 1.5;
    }
    .sourceList {
      list-style: none;
      margin: 0;
      padding: 0;
      display: grid;
      gap: 11px;
    }
    .sourceList li {
      min-width: 0;
      display: grid;
      gap: 7px;
    }
    .sourceList div {
      min-width: 0;
      display: flex;
      justify-content: space-between;
      gap: 10px;
      align-items: baseline;
    }
    .sourceList strong {
      flex: 1 1 auto;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--ink);
      font-size: 13px;
      line-height: 1.35;
    }
    .sourceList span {
      flex: none;
      color: var(--faint);
      font-size: 12px;
      font-variant-numeric: tabular-nums;
    }
    .sourceList em,
    .typeSegments .segmentTrack,
    .futureCard i,
    .rhythmItem i {
      display: block;
      width: 100%;
      height: 8px;
      border-radius: 999px;
      background: color-mix(in oklch, var(--accent-soft) 55%, white);
      overflow: hidden;
      font-style: normal;
    }
    .sourceList i,
    .futureCard b,
    .rhythmItem b {
      display: block;
      height: 100%;
      border-radius: inherit;
      background: linear-gradient(90deg, var(--accent), var(--accent-3));
    }
    .typeSegments {
      display: grid;
      gap: 14px;
    }
    .typeSegments .segmentTrack {
      display: flex;
      height: 16px;
      gap: 3px;
      background: color-mix(in oklch, white 62%, transparent);
      padding: 3px;
    }
    .segmentTrack i {
      min-width: 8px;
      border-radius: 999px;
      background: linear-gradient(90deg, var(--accent), var(--accent-3));
      filter: hue-rotate(calc(var(--slot) * 26deg));
    }
    .segmentLegend {
      display: grid;
      gap: 8px;
    }
    .segmentLegend p {
      display: grid;
      grid-template-columns: 12px minmax(0, 1fr) auto;
      align-items: center;
      gap: 8px;
      color: var(--muted);
      font-size: 13px;
      line-height: 1.35;
    }
    .segmentLegend p > span {
      width: 10px;
      height: 10px;
      border-radius: 999px;
      background: var(--accent);
      filter: hue-rotate(calc(var(--slot) * 26deg));
    }
    .segmentLegend strong {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-weight: 650;
    }
    .segmentLegend em {
      color: var(--ink);
      font-style: normal;
      font-variant-numeric: tabular-nums;
      font-weight: 760;
    }
    .topicFocus {
      padding: 22px;
      margin-bottom: 18px;
    }
    .topicFocusGrid {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 12px;
      margin-top: 16px;
    }
    .topicCard {
      min-width: 0;
      min-height: 226px;
      border: 1px solid color-mix(in oklch, var(--line) 72%, white);
      border-radius: 14px;
      background: color-mix(in oklch, white 68%, transparent);
      padding: 16px;
      display: grid;
      align-content: start;
      gap: 10px;
      transition: transform 180ms ease, background 180ms ease, border-color 180ms ease;
    }
    .topicCard:hover {
      transform: translateY(-3px);
      background: color-mix(in oklch, white 82%, transparent);
      border-color: color-mix(in oklch, var(--accent) 28%, var(--line));
    }
    .topicCard div {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
    }
    .topicCard b {
      color: var(--ink);
      font-variant-numeric: tabular-nums;
    }
    .topicCard strong {
      color: var(--ink);
      font-size: 17px;
      line-height: 1.36;
      text-wrap: balance;
    }
    .topicCard p {
      color: var(--muted);
      font-size: 14px;
      line-height: 1.62;
    }
    .topicCard footer {
      margin-top: auto;
      padding-top: 10px;
      border-top: 1px solid color-mix(in oklch, var(--line) 74%, white);
      display: flex;
      justify-content: space-between;
      gap: 10px;
      color: var(--faint);
      font-size: 12px;
    }
    .topicCard footer em {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-style: normal;
    }
    .dailyRhythm {
      display: grid;
      grid-template-columns: minmax(250px, 0.42fr) minmax(0, 1fr);
      gap: 18px;
      align-items: center;
      padding: 22px;
      margin-bottom: 18px;
    }
    .rhythmRail {
      display: grid;
      grid-template-columns: repeat(5, minmax(0, 1fr));
      gap: 10px;
    }
    .rhythmItem {
      min-width: 0;
      min-height: 118px;
      border: 1px solid color-mix(in oklch, var(--line) 72%, white);
      border-radius: 14px;
      background: color-mix(in oklch, white 68%, transparent);
      color: var(--ink);
      padding: 13px;
      display: grid;
      gap: 7px;
      align-content: start;
      text-decoration: none;
      transition: transform 180ms ease, background 180ms ease, border-color 180ms ease;
    }
    .rhythmItem:hover {
      transform: translateY(-2px);
      background: color-mix(in oklch, white 82%, transparent);
      text-decoration: none;
    }
    .rhythmItem span,
    .rhythmItem em {
      color: var(--muted);
      font-size: 12px;
      font-style: normal;
      line-height: 1.35;
    }
    .rhythmItem strong {
      font-size: 28px;
      line-height: 0.98;
      font-variant-numeric: tabular-nums;
    }
    .futureCard em {
      color: var(--muted);
      font-size: 13px;
      line-height: 1.55;
      font-style: normal;
    }
    .futureCard i {
      margin-top: 2px;
    }
    .pageAtlas {
      display: grid;
      grid-template-columns: minmax(260px, 0.72fr) minmax(220px, 0.56fr) minmax(280px, 0.92fr) minmax(260px, 0.72fr);
      gap: 12px;
      align-items: stretch;
      padding: 18px;
      margin: 0 0 16px;
    }
    .reviewAtlas {
      grid-template-columns: minmax(250px, 0.64fr) minmax(320px, 1fr) minmax(260px, 0.74fr) minmax(240px, 0.68fr);
    }
    .dailyAtlas {
      grid-template-columns: minmax(260px, 0.78fr) minmax(220px, 0.54fr) minmax(270px, 0.78fr) minmax(240px, 0.68fr);
    }
    .atlasLead,
    .atlasPanel,
    .atlasMetrics {
      min-width: 0;
      border: 1px solid color-mix(in oklch, var(--line) 70%, white);
      border-radius: 14px;
      background: color-mix(in oklch, white 64%, transparent);
      padding: 16px;
    }
    .atlasLead {
      display: grid;
      align-content: center;
      gap: 10px;
    }
    .atlasLead h2 {
      font-size: clamp(22px, 2.2vw, 30px);
    }
    .atlasLead p {
      color: var(--muted);
      line-height: 1.66;
    }
    .atlasMetrics {
      display: grid;
      gap: 10px;
    }
    .atlasMetrics .commandMetric {
      padding: 12px;
      background: color-mix(in oklch, white 70%, transparent);
    }
    .atlasMetrics .commandMetric strong {
      font-size: 30px;
    }
    .atlasPanel {
      display: grid;
      align-content: start;
      gap: 12px;
    }
    .atlasPanel h3 {
      margin: 0;
    }
    .atlasTrend .trendArea svg {
      height: 128px;
    }
    .homeStage,
    .homeOverviewBlock,
    .homeBriefingDeck,
    .homeChannelMatrix,
    .homeDailyRiver,
    .homeSignalMap,
    .homeSignalBoard,
    .topicFocus,
    .homeLatestBlock,
    .homeEntryBlock,
    .dailyRhythm,
    .dailyReadOrder,
    .homeWorkflow,
    .homeFuture,
    .pageAtlas {
      animation: riseIn 560ms cubic-bezier(0.22, 1, 0.36, 1) both;
    }
    .topicFocus { animation-delay: 180ms; }
    .dailyRhythm { animation-delay: 260ms; }
    @media (max-width: 1120px) {
      .commandGrid,
      .pageAtlas,
      .reviewAtlas,
      .dailyAtlas {
        grid-template-columns: 1fr 1fr;
      }
      .trendPanel,
      .atlasLead {
        grid-column: span 2;
      }
      .topicFocusGrid {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
      .dailyRhythm {
        grid-template-columns: 1fr;
      }
      .rhythmRail {
        grid-template-columns: repeat(5, minmax(0, 1fr));
      }
    }
    @media (max-width: 760px) {
      .homeStagePro {
        grid-template-columns: 1fr;
        padding-top: 32px;
      }
      .homeStagePro h1 {
        font-size: clamp(36px, 10.5vw, 46px);
      }
      .heroMicroStats {
        margin-top: 18px;
      }
      .todaySheetStats,
      .commandGrid,
      .metricPanel,
      .topicFocusGrid,
      .rhythmRail,
      .pageAtlas,
      .reviewAtlas,
      .dailyAtlas {
        grid-template-columns: 1fr;
      }
      .trendPanel,
      .atlasLead {
        grid-column: auto;
      }
      .topicFocus,
      .dailyRhythm,
      .pageAtlas {
        padding: 16px;
        border-radius: 16px;
      }
      .todayFeed .mediaItem:nth-child(n+3) {
        display: none;
      }
      .trendTicks span:nth-child(n+6) {
        display: none;
      }
      .rhythmRail {
        display: flex;
        overflow-x: auto;
        padding-bottom: 2px;
        scroll-snap-type: x mandatory;
      }
      .rhythmItem {
        flex: 0 0 150px;
        scroll-snap-align: start;
      }
    }
    /* Strong visual headers for the three functional pages. */
    .featureHero {
      position: relative;
      min-height: min(560px, calc(100dvh - 120px));
      display: grid;
      grid-template-columns: minmax(0, 0.86fr) minmax(420px, 0.92fr);
      gap: clamp(28px, 5vw, 72px);
      align-items: center;
      padding: clamp(44px, 5vw, 68px) 0 46px;
      isolation: isolate;
    }
    .featureHero::before {
      content: "";
      position: absolute;
      inset: -24px calc(50% - 50vw + 8px) -24px;
      z-index: -1;
      background:
        radial-gradient(circle at 76% 22%, color-mix(in oklch, var(--accent) 11%, transparent), transparent 26rem),
        radial-gradient(circle at 10% 12%, color-mix(in oklch, var(--accent-3) 9%, transparent), transparent 24rem),
        linear-gradient(112deg, oklch(0.965 0.014 188), oklch(0.982 0.006 220) 48%, oklch(0.93 0.03 226));
    }
    .featureHeroCopy {
      min-width: 0;
    }
    .featureHero h1 {
      max-width: 14.5ch;
      font-size: clamp(38px, 4.6vw, 60px);
      line-height: 1.14;
      letter-spacing: 0;
      color: var(--ink);
    }
    .libraryFeatureHero h1 {
      max-width: 12.8ch;
    }
    .dailyFeatureHero h1 {
      max-width: 13ch;
      font-variant-numeric: tabular-nums;
    }
    .featureHero .muted {
      max-width: 54ch;
      font-size: clamp(16px, 1.25vw, 19px);
      line-height: 1.76;
    }
    .featureScene {
      position: relative;
      min-height: 410px;
      border: 1px solid color-mix(in oklch, white 68%, var(--accent-soft));
      border-radius: 22px;
      background:
        linear-gradient(145deg, color-mix(in oklch, white 86%, transparent), color-mix(in oklch, white 52%, transparent)),
        radial-gradient(circle at 72% 18%, color-mix(in oklch, var(--accent) 14%, transparent), transparent 18rem);
      box-shadow: 0 18px 48px color-mix(in oklch, oklch(0.42 0.05 230) 13%, transparent);
      backdrop-filter: blur(24px) saturate(1.22);
      -webkit-backdrop-filter: blur(24px) saturate(1.22);
      padding: 24px;
      overflow: hidden;
      display: grid;
      align-content: space-between;
      gap: 16px;
      transform: rotate(-1.5deg);
    }
    .featureScene::before {
      content: "";
      position: absolute;
      inset: 0;
      pointer-events: none;
      background: linear-gradient(110deg, transparent 12%, color-mix(in oklch, white 36%, transparent), transparent 42%);
      opacity: 0.7;
      animation: portalSheen 8.5s cubic-bezier(0.22, 1, 0.36, 1) infinite;
    }
    .featureScene > * {
      position: relative;
      z-index: 1;
    }
    .sceneSearchBar {
      min-height: 46px;
      display: flex;
      align-items: center;
      gap: 10px;
      border-radius: 999px;
      background: color-mix(in oklch, white 70%, transparent);
      padding: 0 14px;
      color: var(--muted);
      font-size: 13px;
      font-weight: 720;
    }
    .sceneSearchBar span {
      width: 10px;
      height: 10px;
      flex: none;
      border-radius: 999px;
      background: var(--accent);
      box-shadow: 0 0 0 5px color-mix(in oklch, var(--accent) 12%, transparent);
    }
    .sceneHeadline {
      display: grid;
      gap: 10px;
    }
    .sceneHeadline span {
      width: fit-content;
      min-height: 28px;
      display: inline-flex;
      align-items: center;
      border-radius: 999px;
      background: color-mix(in oklch, var(--accent-soft) 82%, white);
      color: color-mix(in oklch, var(--accent) 72%, black);
      padding: 0 10px;
      font-size: 12px;
      font-weight: 760;
    }
    .sceneHeadline strong {
      color: var(--ink);
      font-size: clamp(26px, 2.8vw, 38px);
      line-height: 1.08;
      text-wrap: balance;
    }
    .sceneStatGrid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
    }
    .sceneStatGrid p,
    .sceneTypeStack p,
    .dailySceneCards p {
      margin: 0;
      border-radius: 14px;
      background: color-mix(in oklch, white 62%, transparent);
      padding: 13px;
    }
    .sceneStatGrid p {
      display: grid;
      gap: 8px;
    }
    .sceneStatGrid span,
    .dailySceneCards span {
      color: var(--muted);
      font-size: 12px;
      font-weight: 760;
    }
    .sceneStatGrid b {
      color: var(--ink);
      font-size: clamp(30px, 3.2vw, 44px);
      line-height: 0.95;
      font-variant-numeric: tabular-nums;
    }
    .sceneTypeStack,
    .dailySceneCards {
      display: grid;
      gap: 8px;
    }
    .sceneTypeStack p {
      position: relative;
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: center;
      gap: 12px;
      overflow: hidden;
    }
    .sceneTypeStack p::before {
      content: "";
      position: absolute;
      inset: 0;
      width: calc(32% + var(--row) * 13%);
      max-width: 86%;
      background: color-mix(in oklch, var(--accent-soft) 76%, transparent);
    }
    .sceneTypeStack span,
    .sceneTypeStack b {
      position: relative;
      min-width: 0;
      z-index: 1;
      color: var(--ink);
      font-size: 13px;
      font-weight: 720;
    }
    .sceneTypeStack span {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .sceneTypeStack b {
      font-variant-numeric: tabular-nums;
    }
    .sceneSourceDock {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    .sceneSourceDock span {
      min-height: 30px;
      display: inline-flex;
      align-items: center;
      border-radius: 999px;
      background: color-mix(in oklch, white 58%, transparent);
      color: color-mix(in oklch, var(--ink) 62%, white);
      padding: 0 11px;
      font-size: 12px;
      font-weight: 720;
    }
    .reviewScene .miniBars {
      min-height: 150px;
    }
    .dailySceneCards p {
      display: grid;
      gap: 7px;
    }
    .dailyScene .sceneHeadline strong {
      font-size: clamp(24px, 2.45vw, 34px);
      line-height: 1.12;
    }
    .dailySceneCards b {
      color: var(--ink);
      font-size: 16px;
      line-height: 1.35;
    }
    /* Homepage art direction inspired by iOS product storytelling. */
    .homeArtHero {
      position: relative;
      min-height: min(720px, calc(100dvh - 92px));
      display: grid;
      grid-template-columns: minmax(0, 0.92fr) minmax(460px, 0.88fr);
      gap: clamp(36px, 6vw, 82px);
      align-items: center;
      padding: clamp(44px, 6vw, 76px) 0 56px;
      isolation: isolate;
    }
    .homeArtHero::before {
      content: "";
      position: absolute;
      inset: -28px calc(50% - 50vw + 8px) -40px;
      z-index: -1;
      background:
        radial-gradient(circle at 78% 32%, color-mix(in oklch, var(--accent) 13%, transparent), transparent 32rem),
        radial-gradient(circle at 8% 18%, color-mix(in oklch, var(--accent-3) 12%, transparent), transparent 28rem),
        linear-gradient(110deg, oklch(0.9 0.045 188), oklch(0.94 0.024 214) 44%, oklch(0.89 0.048 250));
    }
    .homeArtHero::after {
      content: "";
      position: absolute;
      inset: auto calc(50% - 50vw) -1px;
      height: 120px;
      z-index: -1;
      background: linear-gradient(180deg, transparent, oklch(0.992 0.004 220));
    }
    .heroCopyBlock {
      min-width: 0;
    }
    .heroKicker {
      margin: 0 0 12px;
      color: color-mix(in oklch, var(--ink) 78%, var(--accent));
      font-size: 15px;
      line-height: 1.35;
      font-weight: 760;
    }
    .heroCopyBlock h1 {
      max-width: 9.6ch;
      color: var(--ink);
      font-size: clamp(44px, 5.4vw, 64px);
      line-height: 1.12;
      letter-spacing: 0;
      text-wrap: balance;
    }
    .heroHeadline span {
      display: block;
      white-space: nowrap;
    }
    .heroHeadline span:nth-child(2) {
      color: color-mix(in oklch, var(--ink) 84%, var(--accent));
    }
    .heroLead {
      max-width: 52ch;
      margin: 24px 0 0;
      color: color-mix(in oklch, var(--ink) 72%, white);
      font-size: clamp(16px, 1.35vw, 20px);
      line-height: 1.78;
      text-wrap: pretty;
    }
    .heroActionBar {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-top: 30px;
    }
    .heroActionBar .primaryLink,
    .heroActionBar .navButton {
      flex: 1 1 144px;
      min-height: 46px;
      padding: 0 18px;
      background: color-mix(in oklch, white 78%, transparent);
      border-color: color-mix(in oklch, var(--accent) 35%, white);
      box-shadow: none;
    }
    .heroActionBar .primaryLink {
      color: color-mix(in oklch, var(--accent) 78%, black);
      background: color-mix(in oklch, white 70%, var(--accent-soft));
    }
    .heroCapsules span {
      background: color-mix(in oklch, white 58%, transparent);
      border-color: color-mix(in oklch, white 66%, var(--accent-soft));
    }
    .heroPortalScene {
      position: relative;
      min-height: 500px;
      perspective: 1200px;
    }
    .portalWindow {
      position: absolute;
      inset: 42px 22px 46px 54px;
      z-index: 1;
      border: 1px solid color-mix(in oklch, var(--accent) 18%, white);
      border-radius: 24px;
      background:
        linear-gradient(145deg, color-mix(in oklch, white 60%, transparent), color-mix(in oklch, white 24%, transparent)),
        radial-gradient(circle at 72% 26%, color-mix(in oklch, var(--accent) 16%, transparent), transparent 20rem);
      box-shadow: 0 18px 48px color-mix(in oklch, oklch(0.46 0.07 230) 18%, transparent);
      transform: rotate(-4deg) rotateY(-9deg);
      transform-origin: center;
      backdrop-filter: blur(24px) saturate(1.22);
      -webkit-backdrop-filter: blur(24px) saturate(1.22);
      overflow: hidden;
    }
    .portalWindow::before {
      content: "";
      position: absolute;
      inset: 0;
      background:
        linear-gradient(100deg, transparent 8%, color-mix(in oklch, white 34%, transparent), transparent 38%),
        linear-gradient(180deg, color-mix(in oklch, white 22%, transparent), transparent 46%);
      opacity: 0.86;
      animation: portalSheen 8s cubic-bezier(0.22, 1, 0.36, 1) infinite;
    }
    .windowChrome {
      position: absolute;
      top: 28px;
      left: 28px;
      display: flex;
      gap: 10px;
    }
    .windowChrome i {
      width: 9px;
      height: 9px;
      border-radius: 999px;
      background: color-mix(in oklch, var(--accent) 28%, white);
    }
    .windowBoard {
      position: absolute;
      inset: 70px 28px 26px;
      display: grid;
      grid-template-rows: auto minmax(126px, 1fr) auto auto;
      gap: 12px;
    }
    .windowBoardHeader {
      display: flex;
      align-items: end;
      justify-content: space-between;
      gap: 16px;
      padding-bottom: 10px;
      border-bottom: 1px solid color-mix(in oklch, var(--accent) 18%, white);
    }
    .windowBoardHeader span {
      color: color-mix(in oklch, var(--ink) 54%, white);
      font-size: 13px;
      font-weight: 760;
      font-variant-numeric: tabular-nums;
    }
    .windowBoardHeader strong {
      color: var(--ink);
      font-size: clamp(28px, 3vw, 38px);
      line-height: 0.9;
      font-variant-numeric: tabular-nums;
    }
    .miniBars {
      min-height: 126px;
      display: flex;
      align-items: end;
      gap: 7px;
      padding: 16px 14px 28px;
      border-radius: 16px;
      background:
        linear-gradient(180deg, color-mix(in oklch, white 58%, transparent), color-mix(in oklch, white 30%, transparent)),
        linear-gradient(90deg, color-mix(in oklch, var(--accent) 9%, transparent), transparent);
      overflow: hidden;
    }
    .miniBars i {
      position: relative;
      flex: 1 1 0;
      min-width: 0;
      height: var(--h);
      border-radius: 999px 999px 5px 5px;
      background: linear-gradient(180deg, color-mix(in oklch, var(--accent) 86%, white), color-mix(in oklch, var(--accent-3) 72%, white));
      box-shadow: inset 0 1px 0 color-mix(in oklch, white 54%, transparent);
      transform-origin: bottom;
      animation: miniBarRise 680ms cubic-bezier(0.22, 1, 0.36, 1) both;
      animation-delay: calc(var(--bar) * 48ms);
    }
    .miniBars i span {
      position: absolute;
      left: 50%;
      bottom: -20px;
      transform: translateX(-50%);
      color: color-mix(in oklch, var(--ink) 48%, white);
      font-size: 10px;
      line-height: 1;
      font-style: normal;
      white-space: nowrap;
      font-variant-numeric: tabular-nums;
    }
    .miniBarsEmpty {
      place-items: center;
      color: var(--muted);
      font-size: 13px;
      align-items: center;
      justify-content: center;
    }
    .miniTopicRows {
      display: grid;
      gap: 7px;
    }
    .miniTopicRows p {
      position: relative;
      min-height: 30px;
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: center;
      gap: 12px;
      padding: 0 10px;
      border-radius: 10px;
      overflow: hidden;
      background: color-mix(in oklch, white 42%, transparent);
    }
    .miniTopicRows p::before {
      content: "";
      position: absolute;
      inset: 0 auto 0 0;
      width: var(--w);
      background: color-mix(in oklch, var(--accent-soft) 78%, transparent);
      border-radius: inherit;
      transform-origin: left;
      animation: miniRowFill 720ms cubic-bezier(0.22, 1, 0.36, 1) both;
      animation-delay: calc(var(--row) * 60ms);
    }
    .miniTopicRows span,
    .miniTopicRows b {
      position: relative;
      z-index: 1;
      min-width: 0;
      color: color-mix(in oklch, var(--ink) 72%, white);
      font-size: 12px;
      line-height: 1.2;
    }
    .miniTopicRows span {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-weight: 700;
    }
    .miniTopicRows b {
      color: var(--ink);
      font-variant-numeric: tabular-nums;
    }
    .miniTopicRows i {
      display: none;
    }
    .miniDock {
      display: flex;
      flex-wrap: wrap;
      gap: 7px;
    }
    .miniDock span {
      min-height: 28px;
      display: inline-flex;
      align-items: center;
      border-radius: 999px;
      background: color-mix(in oklch, white 48%, transparent);
      color: color-mix(in oklch, var(--ink) 60%, white);
      padding: 0 10px;
      font-size: 11px;
      font-weight: 760;
      font-variant-numeric: tabular-nums;
    }
    .windowLine {
      position: absolute;
      left: 34px;
      right: 34px;
      height: 1px;
      border-radius: 999px;
      background: color-mix(in oklch, var(--accent) 22%, white);
    }
    .lineA { top: 82px; }
    .lineB { bottom: 100px; }
    .lineC { bottom: 62px; width: 42%; right: auto; }
    .windowMetric {
      position: absolute;
      left: 44px;
      bottom: 132px;
      display: grid;
      gap: 2px;
      color: color-mix(in oklch, var(--ink) 62%, transparent);
    }
    .windowMetric.second {
      left: auto;
      right: 48px;
      bottom: 66px;
    }
    .windowMetric strong {
      color: var(--ink);
      font-size: 30px;
      line-height: 1;
      font-variant-numeric: tabular-nums;
    }
    .windowMetric span {
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
    }
    .floatEntry {
      position: absolute;
      z-index: 8;
      width: min(364px, 72%);
      min-height: 122px;
      border: 1px solid color-mix(in oklch, white 66%, var(--accent-soft));
      border-radius: 16px;
      background:
        linear-gradient(145deg, color-mix(in oklch, white 92%, transparent), color-mix(in oklch, white 66%, transparent)),
        radial-gradient(circle at 72% 24%, color-mix(in oklch, var(--accent-3) 13%, transparent), transparent 16rem);
      color: var(--ink);
      padding: 18px;
      display: grid;
      gap: 8px;
      align-content: start;
      box-shadow: 0 16px 36px color-mix(in oklch, oklch(0.42 0.05 230) 16%, transparent);
      backdrop-filter: blur(18px) saturate(1.22);
      -webkit-backdrop-filter: blur(18px) saturate(1.22);
      transition: transform 220ms ease, background 220ms ease;
      animation: floatIn 700ms cubic-bezier(0.22, 1, 0.36, 1) both, floatDrift 7s ease-in-out infinite;
    }
    .floatEntry:hover {
      text-decoration: none;
      background: color-mix(in oklch, white 86%, transparent);
    }
    .floatEntry span,
    .homeFutureRibbon > div > span,
    .ribbonIntro span,
    .routePane span,
    .tileCopy span {
      width: fit-content;
      height: fit-content;
      min-height: 28px;
      display: inline-flex;
      align-items: center;
      border-radius: 999px;
      background: color-mix(in oklch, var(--accent-soft) 82%, white);
      color: color-mix(in oklch, var(--accent) 72%, black);
      padding: 0 10px;
      font-size: 12px;
      line-height: 1.35;
      font-weight: 760;
    }
    .floatEntry strong {
      color: var(--ink);
      font-size: clamp(20px, 2.2vw, 27px);
      line-height: 1.16;
      text-wrap: balance;
    }
    .floatEntry p {
      color: var(--muted);
      font-size: 14px;
      line-height: 1.55;
    }
    .floatDaily {
      top: 50px;
      right: 0;
      transform: rotate(-2deg);
    }
    .floatLibrary {
      top: 206px;
      left: 8px;
      transform: rotate(-1.5deg);
      animation-delay: 90ms;
    }
    .floatReview {
      right: 10px;
      bottom: 50px;
      transform: rotate(2deg);
      animation-delay: 180ms;
    }
    @keyframes floatIn {
      from { opacity: 0.9; transform: translateY(14px) scale(0.99); }
      to { opacity: 1; }
    }
    @keyframes floatDrift {
      0%, 100% { translate: 0 0; }
      50% { translate: 0 -8px; }
    }
    @keyframes portalSheen {
      from { transform: translateX(-120%); opacity: 0; }
      35% { opacity: 0.7; }
      to { transform: translateX(120%); opacity: 0; }
    }
    @keyframes miniBarRise {
      from { opacity: 0.58; transform: scaleY(0.36); }
      to { opacity: 1; transform: scaleY(1); }
    }
    @keyframes miniRowFill {
      from { transform: scaleX(0.2); opacity: 0.22; }
      to { transform: scaleX(1); opacity: 1; }
    }
    .homeBriefingDeck {
      display: grid;
      grid-template-columns: minmax(0, 1.16fr) minmax(330px, 0.84fr);
      grid-template-areas:
        "head head"
        "lead stream"
        "picks stream";
      gap: 14px;
      margin: -4px 0 18px;
      align-items: stretch;
    }
    .briefingHeader {
      grid-area: head;
      min-width: 0;
      display: grid;
      grid-template-columns: minmax(250px, 0.58fr) minmax(0, 1fr);
      gap: 18px;
      align-items: end;
      padding: 0 4px 4px;
    }
    .briefingHeader div,
    .channelIntro,
    .riverIntro,
    .briefStreamTop {
      display: grid;
      gap: 10px;
      align-content: start;
    }
    .briefingHeader span,
    .channelIntro span,
    .riverIntro span,
    .briefStreamTop span {
      width: fit-content;
      min-height: 28px;
      display: inline-flex;
      align-items: center;
      border-radius: 999px;
      background: color-mix(in oklch, var(--accent-soft) 82%, white);
      color: color-mix(in oklch, var(--accent) 72%, black);
      padding: 0 10px;
      font-size: 12px;
      line-height: 1.35;
      font-weight: 760;
    }
    .briefingHeader h2,
    .channelIntro h2,
    .riverIntro h2 {
      font-size: clamp(26px, 3vw, 40px);
      line-height: 1.08;
      letter-spacing: 0;
    }
    .briefingHeader p,
    .channelIntro p,
    .riverIntro p,
    .briefStreamTop p {
      margin: 0;
      color: var(--muted);
      line-height: 1.68;
      text-wrap: pretty;
    }
    .briefLead,
    .briefPick,
    .briefStreamPanel,
    .channelCard,
    .riverDay {
      min-width: 0;
      border: 1px solid color-mix(in oklch, var(--line) 72%, white);
      border-radius: 16px;
      background: color-mix(in oklch, white 76%, transparent);
      color: var(--ink);
      text-decoration: none;
      transition: transform 180ms ease, border-color 180ms ease, background 180ms ease;
    }
    .briefLead:hover,
    .briefPick:hover,
    .channelCard:hover,
    .riverDay:hover {
      transform: translateY(-3px);
      border-color: color-mix(in oklch, var(--accent) 30%, var(--line));
      background: color-mix(in oklch, white 86%, transparent);
      text-decoration: none;
    }
    .briefLead {
      grid-area: lead;
      min-height: 330px;
      padding: 24px;
      display: grid;
      align-content: end;
      gap: 14px;
      background:
        radial-gradient(circle at 86% 18%, color-mix(in oklch, var(--accent) 13%, transparent), transparent 15rem),
        linear-gradient(145deg, color-mix(in oklch, white 84%, transparent), color-mix(in oklch, white 54%, transparent));
      box-shadow: var(--shadow-soft);
    }
    .briefLead span,
    .briefPick span {
      width: fit-content;
      min-height: 28px;
      display: inline-flex;
      align-items: center;
      border-radius: 999px;
      background: color-mix(in oklch, var(--warm-soft) 80%, white);
      color: color-mix(in oklch, var(--accent-2) 72%, black);
      padding: 0 10px;
      font-size: 12px;
      line-height: 1.35;
      font-weight: 800;
    }
    .briefLead strong {
      max-width: 18ch;
      color: var(--ink);
      font-size: clamp(28px, 3.6vw, 46px);
      line-height: 1.08;
      text-wrap: balance;
    }
    .briefLead p {
      max-width: 62ch;
      margin: 0;
      color: var(--muted);
      font-size: 15px;
      line-height: 1.68;
    }
    .briefLead footer {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      align-items: center;
      justify-content: space-between;
      padding-top: 14px;
      border-top: 1px solid color-mix(in oklch, var(--line) 74%, white);
    }
    .briefLead em,
    .briefLead b {
      color: var(--faint);
      font-size: 13px;
      font-style: normal;
      font-variant-numeric: tabular-nums;
    }
    .briefLead b {
      color: var(--ink);
      font-weight: 820;
    }
    .briefPicks {
      grid-area: picks;
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 12px;
    }
    .briefPick {
      min-height: 206px;
      padding: 16px;
      display: grid;
      gap: 10px;
      align-content: start;
    }
    .briefPick strong {
      color: var(--ink);
      font-size: 17px;
      line-height: 1.38;
      text-wrap: balance;
    }
    .briefPick p {
      margin: 0;
      color: var(--muted);
      font-size: 13px;
      line-height: 1.58;
    }
    .briefPick em {
      align-self: end;
      color: var(--faint);
      font-size: 12px;
      font-style: normal;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .briefStreamPanel {
      grid-area: stream;
      padding: 18px;
      display: grid;
      grid-template-rows: auto minmax(0, 1fr) auto;
      gap: 16px;
      background:
        linear-gradient(145deg, color-mix(in oklch, white 82%, transparent), color-mix(in oklch, white 56%, transparent)),
        radial-gradient(circle at 12% 10%, color-mix(in oklch, var(--accent-3) 10%, transparent), transparent 13rem);
      box-shadow: var(--shadow-soft);
    }
    .briefStreamTop strong {
      color: var(--ink);
      font-size: clamp(28px, 3vw, 40px);
      line-height: 1;
      font-variant-numeric: tabular-nums;
    }
    .briefStreamList {
      list-style: none;
      margin: 0;
      padding: 0;
      display: grid;
      gap: 10px;
      align-content: start;
    }
    .briefStreamList li,
    .briefStreamList a {
      min-width: 0;
    }
    .briefStreamList a,
    .briefStreamList .emptyStreamLine {
      min-height: 78px;
      display: grid;
      grid-template-columns: minmax(72px, 0.34fr) minmax(0, 1fr);
      grid-template-areas:
        "type title"
        "type source";
      gap: 4px 10px;
      align-content: center;
      border-radius: 12px;
      background: color-mix(in oklch, white 66%, transparent);
      padding: 12px;
      color: var(--ink);
      text-decoration: none;
    }
    .briefStreamList span {
      grid-area: type;
      color: var(--accent);
      font-size: 12px;
      font-weight: 760;
      align-self: start;
    }
    .briefStreamList strong {
      grid-area: title;
      min-width: 0;
      color: var(--ink);
      font-size: 14px;
      line-height: 1.42;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .briefStreamList em {
      grid-area: source;
      color: var(--faint);
      font-size: 12px;
      font-style: normal;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .briefStreamLink {
      min-height: 44px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: 999px;
      background: color-mix(in oklch, var(--accent) 12%, white);
      color: color-mix(in oklch, var(--accent) 70%, black);
      font-size: 14px;
      font-weight: 760;
      text-decoration: none;
    }
    .homeChannelMatrix,
    .homeDailyRiver {
      display: grid;
      grid-template-columns: minmax(260px, 0.36fr) minmax(0, 1fr);
      gap: 16px;
      align-items: stretch;
      margin: 0 0 18px;
      padding: 22px;
      border: 1px solid color-mix(in oklch, var(--line) 72%, white);
      border-radius: 18px;
      background: color-mix(in oklch, white 68%, transparent);
      box-shadow: var(--shadow-soft);
      backdrop-filter: blur(18px) saturate(1.16);
      -webkit-backdrop-filter: blur(18px) saturate(1.16);
    }
    .channelIntro .navButton {
      width: fit-content;
      margin-top: auto;
    }
    .channelGrid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 12px;
    }
    .channelCard {
      min-height: 216px;
      padding: 16px;
      display: grid;
      gap: 10px;
      align-content: start;
      background: color-mix(in oklch, white 74%, transparent);
    }
    .channelCard div {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
    .channelCard span {
      min-width: 0;
      color: var(--accent);
      font-size: 12px;
      font-weight: 800;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .channelCard b {
      color: var(--ink);
      font-variant-numeric: tabular-nums;
    }
    .channelCard strong {
      color: var(--ink);
      font-size: 16px;
      line-height: 1.38;
      text-wrap: balance;
    }
    .channelCard p {
      margin: 0;
      color: var(--muted);
      font-size: 13px;
      line-height: 1.58;
    }
    .channelCard i {
      display: block;
      width: 100%;
      height: 8px;
      margin-top: auto;
      border-radius: 999px;
      background: color-mix(in oklch, var(--accent-soft) 54%, white);
      overflow: hidden;
      font-style: normal;
    }
    .channelCard em {
      display: block;
      height: 100%;
      border-radius: inherit;
      background: linear-gradient(90deg, var(--accent), var(--accent-3));
    }
    .riverRail {
      display: grid;
      grid-template-columns: repeat(5, minmax(0, 1fr));
      gap: 10px;
    }
    .riverDay {
      min-height: 166px;
      padding: 14px;
      display: grid;
      gap: 8px;
      align-content: start;
      background: color-mix(in oklch, white 76%, transparent);
    }
    .riverDay span,
    .riverDay em {
      color: var(--muted);
      font-size: 12px;
      font-style: normal;
      font-variant-numeric: tabular-nums;
    }
    .riverDay strong {
      color: var(--ink);
      font-size: 34px;
      line-height: 0.98;
      font-variant-numeric: tabular-nums;
    }
    .riverDay p {
      margin: 0;
      color: var(--muted);
      font-size: 13px;
      line-height: 1.5;
    }
    .homeVisualSummary {
      display: grid;
      grid-template-columns: minmax(0, 1.18fr) minmax(320px, 0.82fr);
      gap: 16px;
      margin: 12px 0 18px;
      align-items: stretch;
    }
    .visualTile,
    .homeContentRibbon,
    .routePane,
    .homeFutureRibbon {
      border: 1px solid color-mix(in oklch, var(--line) 72%, white);
      border-radius: 18px;
      background: color-mix(in oklch, white 76%, transparent);
      box-shadow: var(--shadow-soft);
      backdrop-filter: blur(18px) saturate(1.16);
      -webkit-backdrop-filter: blur(18px) saturate(1.16);
    }
    .visualTile {
      min-width: 0;
      min-height: 300px;
      padding: 20px;
      display: grid;
      align-content: normal;
      gap: 18px;
    }
    .trendTile {
      grid-row: span 2;
      min-height: 420px;
      background:
        linear-gradient(145deg, color-mix(in oklch, white 80%, transparent), color-mix(in oklch, white 48%, transparent)),
        radial-gradient(circle at 82% 22%, color-mix(in oklch, var(--accent) 11%, transparent), transparent 18rem);
    }
    .structureTile,
    .sourceTile {
      min-height: 202px;
    }
    .trendTile .trendArea {
      align-self: end;
    }
    .trendTile .trendArea svg {
      height: 230px;
    }
    .tileCopy {
      display: grid;
      gap: 10px;
    }
    .tileCopy h2 {
      font-size: clamp(24px, 2.4vw, 34px);
      line-height: 1.1;
    }
    .tileCopy p {
      color: var(--muted);
      line-height: 1.65;
      max-width: 44ch;
    }
    .homeContentRibbon {
      display: grid;
      grid-template-columns: minmax(250px, 0.42fr) minmax(0, 1fr);
      gap: 18px;
      align-items: stretch;
      padding: 22px;
      margin-bottom: 18px;
    }
    .homeSignalBoard,
    .dailyReadOrder {
      border: 1px solid color-mix(in oklch, var(--line) 72%, white);
      border-radius: 18px;
      background:
        linear-gradient(145deg, color-mix(in oklch, white 82%, transparent), color-mix(in oklch, white 58%, transparent)),
        radial-gradient(circle at 92% 12%, color-mix(in oklch, var(--accent-3) 9%, transparent), transparent 18rem);
      box-shadow: var(--shadow-soft);
      backdrop-filter: blur(18px) saturate(1.16);
      -webkit-backdrop-filter: blur(18px) saturate(1.16);
    }
    .homeSignalBoard {
      display: grid;
      grid-template-columns: minmax(260px, 0.46fr) minmax(0, 1fr);
      gap: 16px;
      align-items: stretch;
      padding: 22px;
      margin-bottom: 18px;
    }
    .signalNarrative,
    .dailyReadOrder > div:first-child {
      min-width: 0;
      display: grid;
      align-content: center;
      gap: 12px;
    }
    .signalNarrative span,
    .dailyReadOrder > div:first-child span,
    .readOrderItem span {
      width: fit-content;
      min-height: 28px;
      display: inline-flex;
      align-items: center;
      border-radius: 999px;
      background: color-mix(in oklch, var(--accent-soft) 82%, white);
      color: color-mix(in oklch, var(--accent) 72%, black);
      padding: 0 10px;
      font-size: 12px;
      line-height: 1.35;
      font-weight: 760;
    }
    .signalNarrative h2,
    .dailyReadOrder h2 {
      font-size: clamp(26px, 2.8vw, 38px);
      line-height: 1.18;
    }
    .signalNarrative p,
    .dailyReadOrder > div:first-child p {
      margin: 0;
      color: var(--muted);
      line-height: 1.72;
      max-width: 54ch;
    }
    .signalQueue {
      display: grid;
      gap: 10px;
    }
    .signalRow {
      min-width: 0;
      min-height: 98px;
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      grid-template-areas:
        "badge title"
        "badge fact"
        "meta meta";
      gap: 7px 12px;
      align-content: center;
      border: 1px solid color-mix(in oklch, var(--line) 76%, white);
      border-radius: 14px;
      background: color-mix(in oklch, white 70%, transparent);
      color: var(--ink);
      padding: 14px;
      text-decoration: none;
      transition: transform 180ms ease, border-color 180ms ease, background 180ms ease;
    }
    .signalRow:hover {
      transform: translateY(-2px);
      border-color: color-mix(in oklch, var(--accent) 28%, var(--line));
      background: color-mix(in oklch, white 84%, transparent);
      text-decoration: none;
    }
    .signalRow span {
      grid-area: badge;
      min-width: 48px;
      min-height: 42px;
      display: inline-grid;
      place-items: center;
      border-radius: 12px;
      background: color-mix(in oklch, var(--warm-soft) 76%, white);
      color: color-mix(in oklch, var(--accent-2) 72%, black);
      font-size: 12px;
      font-weight: 820;
      white-space: nowrap;
    }
    .signalRow strong {
      grid-area: title;
      min-width: 0;
      color: var(--ink);
      font-size: 16px;
      line-height: 1.42;
    }
    .signalRow p {
      grid-area: fact;
      min-width: 0;
      margin: 0;
      color: var(--muted);
      font-size: 13px;
      line-height: 1.58;
    }
    .signalRow em {
      grid-area: meta;
      color: var(--faint);
      font-size: 12px;
      line-height: 1.35;
      font-style: normal;
      font-variant-numeric: tabular-nums;
    }
    .dailyReadOrder {
      display: grid;
      grid-template-columns: minmax(260px, 0.42fr) minmax(0, 1fr);
      gap: 16px;
      padding: 20px;
      margin-bottom: 16px;
    }
    .readOrderList {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 10px;
    }
    .readOrderItem {
      min-width: 0;
      min-height: 190px;
      display: grid;
      align-content: start;
      gap: 10px;
      border: 1px solid color-mix(in oklch, var(--line) 76%, white);
      border-radius: 14px;
      background: color-mix(in oklch, white 70%, transparent);
      padding: 15px;
    }
    .readOrderItem strong {
      color: var(--ink);
      font-size: 16px;
      line-height: 1.42;
    }
    .readOrderItem p {
      margin: 0;
      color: var(--muted);
      font-size: 13px;
      line-height: 1.6;
    }
    .readOrderItem div {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
      margin-top: auto;
    }
    .readOrderItem em,
    .readOrderItem a {
      color: var(--faint);
      font-size: 12px;
      line-height: 1.35;
      font-style: normal;
    }
    .readOrderItem a {
      color: var(--accent);
      font-weight: 760;
    }
    .ribbonIntro {
      display: grid;
      align-content: center;
      gap: 12px;
    }
    .ribbonIntro h2 {
      font-size: clamp(28px, 3vw, 42px);
      line-height: 1.08;
    }
    .ribbonIntro p {
      color: var(--muted);
      line-height: 1.7;
    }
    .ribbonCards {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
    }
    .homeRouteGallery {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 14px;
      margin-bottom: 18px;
    }
    .routePane {
      min-height: 220px;
      color: var(--ink);
      padding: 22px;
      display: grid;
      align-content: end;
      gap: 10px;
      text-decoration: none;
      transition: transform 180ms ease, background 180ms ease, border-color 180ms ease;
    }
    .routePane:hover {
      transform: translateY(-3px);
      background: color-mix(in oklch, white 86%, transparent);
      text-decoration: none;
      border-color: color-mix(in oklch, var(--accent) 30%, var(--line));
    }
    .routePrimary {
      background:
        radial-gradient(circle at 80% 18%, color-mix(in oklch, var(--accent) 14%, transparent), transparent 14rem),
        color-mix(in oklch, white 78%, transparent);
    }
    .routePane strong {
      color: var(--ink);
      font-size: clamp(26px, 2.8vw, 38px);
      line-height: 1.05;
      text-wrap: balance;
    }
    .routePane p {
      color: var(--muted);
      line-height: 1.62;
      max-width: 28ch;
    }
    .homeFutureRibbon {
      display: grid;
      grid-template-columns: minmax(240px, 0.42fr) minmax(0, 1fr);
      gap: 20px;
      align-items: center;
      padding: 22px;
      margin-bottom: 18px;
    }
    .homeFutureRibbon > div:first-child {
      display: grid;
      gap: 12px;
    }
    .homeFutureRibbon h2 {
      font-size: clamp(26px, 3vw, 38px);
      line-height: 1.1;
    }
    @media (max-width: 1040px) {
      .featureHero,
      .homeArtHero,
      .homeBriefingDeck,
      .briefingHeader,
      .homeVisualSummary,
      .homeContentRibbon,
      .homeSignalBoard,
      .homeChannelMatrix,
      .homeDailyRiver,
      .dailyReadOrder,
      .homeFutureRibbon {
        grid-template-columns: 1fr;
      }
      .featureHero {
        min-height: auto;
      }
      .featureScene {
        min-height: 360px;
        transform: none;
      }
      .trendTile {
        grid-row: auto;
        min-height: 340px;
      }
      .heroPortalScene {
        min-height: 500px;
      }
      .homeRouteGallery {
        grid-template-columns: 1fr;
      }
      .briefPicks,
      .channelGrid {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
      .riverRail {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
    }
    @media (max-width: 760px) {
      .featureHero {
        padding: 34px 0 28px;
        gap: 24px;
      }
      .featureHeroCopy {
        width: min(100%, calc(100vw - 48px));
        max-width: calc(100vw - 48px);
        overflow-wrap: anywhere;
      }
      .siteNav {
        position: relative;
        z-index: calc(var(--sticky) + 2);
        background: color-mix(in oklch, white 88%, transparent);
        box-shadow: 0 8px 20px color-mix(in oklch, oklch(0.36 0.05 230) 12%, transparent);
      }
      .navStatus {
        display: none;
      }
      .featureHero::before,
      .homeArtHero::before {
        top: 0;
      }
      .featureHero h1 {
        max-width: 100%;
        font-size: clamp(30px, 8.2vw, 38px);
        line-height: 1.16;
      }
      .featureHero .muted {
        max-width: 100%;
        font-size: 16px;
        line-height: 1.72;
        word-break: break-all;
      }
      .featureScene {
        min-height: auto;
        max-width: calc(100vw - 48px);
        border-radius: 18px;
        padding: 18px;
        gap: 13px;
      }
      .sceneHeadline strong {
        font-size: clamp(24px, 7vw, 30px);
        overflow-wrap: anywhere;
      }
      .sceneStatGrid {
        grid-template-columns: 1fr 1fr;
      }
      .sceneStatGrid b {
        font-size: 30px;
      }
      .dailySceneCards p:nth-child(n+3) {
        display: none;
      }
      .libraryScene .sceneTypeStack p:nth-child(n+4),
      .libraryScene .sceneSourceDock span:nth-child(n+3) {
        display: none;
      }
      .homeArtHero {
        min-height: auto;
        padding: 36px clamp(12px, 4vw, 18px) 28px;
        gap: 28px;
      }
      .heroCopyBlock {
        width: min(100%, calc(100vw - 72px));
        max-width: calc(100vw - 72px);
        overflow-wrap: anywhere;
      }
      .heroCopyBlock h1 {
        max-width: 100%;
        font-size: clamp(32px, 9.2vw, 42px);
        line-height: 1.16;
      }
      .heroLead {
        max-width: 100%;
        font-size: 16px;
        line-height: 1.72;
        word-break: break-all;
      }
      .heroActionBar {
        display: grid;
        width: 100%;
        max-width: 100%;
        grid-template-columns: 1fr;
        margin-top: 22px;
      }
      .heroActionBar .primaryLink {
        grid-column: auto;
      }
      .heroActionBar .primaryLink,
      .heroActionBar .navButton {
        width: 100%;
        justify-content: center;
        padding-inline: 12px;
      }
      .heroPortalScene {
        min-height: 440px;
      }
      .portalWindow {
        inset: 44px 14px 40px 18px;
        border-radius: 20px;
        transform: rotate(-3deg);
      }
      .windowBoard {
        inset: 62px 16px 18px;
        grid-template-rows: auto minmax(108px, 1fr) auto auto;
        gap: 10px;
      }
      .windowBoardHeader strong {
        font-size: 28px;
      }
      .miniBars {
        min-height: 108px;
        gap: 5px;
        padding: 14px 10px 24px;
        border-radius: 14px;
      }
      .miniBars i span {
        font-size: 9px;
      }
      .miniTopicRows p {
        min-height: 28px;
        padding: 0 9px;
      }
      .miniTopicRows p:nth-child(n+4) {
        display: none;
      }
      .miniDock span {
        min-height: 26px;
        padding: 0 9px;
      }
      .floatEntry {
        width: min(340px, 86%);
        min-height: 108px;
        padding: 15px;
      }
      .floatDaily {
        top: 28px;
        right: 0;
      }
      .floatLibrary {
        top: 154px;
        left: 0;
      }
      .floatReview {
        right: 0;
        bottom: 36px;
      }
      .windowMetric {
        display: none;
      }
      .trendTile {
        min-height: auto;
      }
      .trendTile .trendArea svg {
        height: 170px;
      }
      .homeVisualSummary,
      .homeBriefingDeck,
      .homeSignalBoard,
      .homeChannelMatrix,
      .homeDailyRiver,
      .briefPicks,
      .channelGrid,
      .readOrderList,
      .riverRail,
      .ribbonCards,
      .homeRouteGallery,
      .homeFutureRibbon {
        grid-template-columns: 1fr;
      }
      .visualTile,
      .briefLead,
      .briefStreamPanel,
      .homeChannelMatrix,
      .homeDailyRiver,
      .homeContentRibbon,
      .homeSignalBoard,
      .dailyReadOrder,
      .homeFutureRibbon {
        padding: 18px;
        border-radius: 16px;
      }
      .briefLead {
        min-height: 260px;
      }
      .briefLead strong {
        max-width: 100%;
        font-size: clamp(26px, 7.5vw, 34px);
      }
      .briefingHeader {
        gap: 12px;
      }
      .briefPicks,
      .riverRail {
        display: flex;
        overflow-x: auto;
        padding-bottom: 2px;
        scroll-snap-type: x mandatory;
      }
      .briefPick,
      .riverDay {
        flex: 0 0 78%;
        scroll-snap-align: start;
      }
      .channelCard {
        min-height: 190px;
      }
      .visualTile {
        min-height: auto;
      }
      .routePane {
        min-height: 190px;
        border-radius: 16px;
      }
    }
    @media (max-width: 760px) {
      .shell,
      .homeShell,
      .featureHero,
      .homeArtHero,
      .finderPanel,
      .pageAtlas,
      .dailyReadOrder,
      .homeBriefingDeck,
      .homeChannelMatrix,
      .homeDailyRiver {
        max-width: 100%;
        overflow-x: hidden;
      }
      .featureHeroCopy,
      .heroCopyBlock,
      .atlasLead,
      .blockTitle,
      .signalNarrative,
      .ribbonIntro,
      .channelIntro,
      .riverIntro {
        width: min(100%, calc(100vw - 48px)) !important;
        max-width: calc(100vw - 48px) !important;
      }
      .featureHero h1,
      .heroCopyBlock h1,
      .featureHero .muted,
      .heroLead,
      .muted,
      .card h2,
      .card p,
      .briefLead strong,
      .briefLead p,
      .briefPick strong,
      .briefPick p,
      .channelCard strong,
      .channelCard p,
      .latestSignal strong,
      .latestSignal p,
      .readOrderItem strong,
      .readOrderItem p,
      .sceneHeadline strong,
      .dailySceneCards b {
        max-width: calc(100vw - 48px);
        overflow-wrap: anywhere;
        word-break: break-word;
      }
      .featureHero .muted,
      .heroLead,
      .atlasLead p,
      .blockTitle .muted {
        width: min(100%, calc(100vw - 48px)) !important;
        max-width: calc(100vw - 48px) !important;
      }
      .heroPortalScene {
        min-height: 420px;
        max-width: 100%;
        overflow: hidden;
      }
      .portalWindow {
        inset: 64px 12px 28px 12px !important;
        transform: none !important;
        opacity: 0.72;
      }
      .floatEntry {
        width: calc(100% - 28px) !important;
        min-height: 104px;
        left: 14px !important;
        right: auto !important;
        transform: none !important;
      }
      .floatDaily { top: 22px !important; }
      .floatLibrary { top: 144px !important; }
      .floatReview { top: 266px !important; bottom: auto !important; }
      .floatEntry strong {
        font-size: clamp(20px, 6vw, 24px);
      }
      .floatEntry p {
        font-size: 13px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap !important;
      }
    }
    @supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
      .siteNav, .top, .homeIntentCopy, .homePrinciples, .homeRoadmap, .homeShowcase, .homePulse, .pulseMetric, .pulseChart, .homeInsight, .homeLatest, .latestSignal, .portalTile, .homeMedia, .dailyTools, .emptyPanel, .reviewPanel, .finderPanel, .card, .commandPanel, .pageAtlas, .topicFocus, .dailyRhythm, .portalWindow, .floatEntry, .visualTile, .homeBriefingDeck, .briefLead, .briefPick, .briefStreamPanel, .homeChannelMatrix, .channelCard, .homeDailyRiver, .riverDay, .homeContentRibbon, .homeSignalBoard, .dailyReadOrder, .routePane, .homeFutureRibbon, .featureScene {
        background: var(--surface-strong);
      }
    }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { scroll-behavior: auto !important; transition-duration: 0.01ms !important; animation-duration: 0.01ms !important; }
      .card:hover, .portalTile:hover, .dayItem:hover, .roleLink:hover, .navLinks a:hover, .navButton:hover, .primaryLink:hover, .rangeSwitch a:hover, .dateRail button:hover, .segments button:hover, #clearFilters:hover, .floatEntry:hover, .routePane:hover, .briefLead:hover, .briefPick:hover, .channelCard:hover, .riverDay:hover { transform: none; }
    }
  `;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/'/g, "&#39;");
}

export {
  buildDigest,
  buildBitableFieldDefinitions,
  buildBitableFields,
  buildDailyBitableFields,
  cleanupDailyIndexViews,
  compactLegacyBitableTables,
  getDailyIndexStatus,
  buildFeishuCard,
  resetDailyIndexLibrary,
  dailyArchiveKVKey,
  fetchAIHotItems,
  getBriefAnalysis,
  millisecondsUntilBeijingTime,
  openAIChatEndpointCandidates,
  openAIEndpointCandidates,
  rankInfluentialItems,
  repairMojibake,
  selectScoredItems,
  selectMissingBitableFieldDefinitions,
  toOriginalSiteItem,
  validateAIHotResponse,
};

function renderStatusPage() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>AI HOT Briefing</title>
  <style>
    body { margin: 0; font-family: Georgia, "Noto Serif SC", serif; background: #f5f3ee; color: #181713; }
    main { width: min(880px, calc(100vw - 32px)); margin: 0 auto; padding: 44px 0; }
    h1 { margin: 0 0 10px; font-size: 32px; }
    p { line-height: 1.7; color: #5f5a50; }
    code { background: #fffaf0; padding: 2px 6px; border: 1px solid #ddd2bf; border-radius: 6px; }
  </style>
</head>
<body>
  <main>
    <h1>AI HOT Briefing</h1>
    <p>Cloudflare Worker 已部署。当前版本以飞书多维表格为主界面，群消息只发概览和入口。</p>
    <p>健康检查：<code>/health</code></p>
  </main>
</body>
</html>`;
}
