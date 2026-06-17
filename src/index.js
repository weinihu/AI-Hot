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
import { renderDailyPage, renderHomePage, renderLibraryPage, renderReviewPage, renderStatusPage } from "./pages.js";

const SITE_SNAPSHOT_KV_KEY = "site_snapshot:v1";
const PUBLIC_BROWSER_CACHE_SECONDS = 60;
const PUBLIC_EDGE_CACHE_SECONDS = 10 * 60;
const PUBLIC_FEED_EDGE_CACHE_SECONDS = 5 * 60;
const PUBLIC_HTML_CACHE_VERSION = "2026-06-09-responsive-portal";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return jsonResponse({
        ok: true,
        service: "aihot-feishu-briefing",
        version: "2026-06-17-upstream-sync-coverage",
        cron: "29 13 * * *",
        timezone_note: "Trigger Beijing 21:29 = UTC 13:29; Feishu send waits until Beijing 21:30 if ready early.",
      });
    }

    if (url.pathname === "/debug-config") {
      if (!isAuthorized(request, env)) return unauthorized();
      const config = getConfig(env);
      return jsonResponse({
        ok: true,
        model: config.model,
        openAIBaseURL: config.openAIBaseURL,
        lookbackHours: config.lookbackHours,
        take: config.take,
        maxPages: config.maxPages,
        maxItems: config.maxItems,
        paperLookbackHours: config.paperLookbackHours,
        paperTake: config.paperTake,
        paperMaxPages: config.paperMaxPages,
        paperMaxItems: config.paperMaxItems,
        minScore: config.minScore,
        bitableMaxRecords: config.bitableMaxRecords,
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

    if (url.pathname === "/api/original-feed") {
      return publicJsonCachedResponse(request, ctx, async () => buildOriginalFeedPayload(url));
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
      if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return htmlResponse(renderDailyPage(null, "请选择有效日期。"), 400);
      return publicHtmlResponse(request, ctx, async () => {
        const archives = await getDailyArchives(env);
        const targetDate = date || archives[0]?.date || "";
        const archive = archives.find((item) => item.date === targetDate) || null;
        return renderDailyPage(archive, "", archives);
      });
    }

    if (url.pathname === "/run-now") {
      const adminError = requireAdminWrite(request, env);
      if (adminError) return adminError;
      try {
        return jsonResponse(await runBriefing(env, { source: "manual" }));
      } catch (error) {
        return jsonResponse({ ok: false, error: publicErrorMessage(error) }, 500);
      }
    }

    if (url.pathname === "/archive-now") {
      const adminError = requireAdminWrite(request, env);
      if (adminError) return adminError;
      try {
        return jsonResponse(await runBriefing(env, { source: "manual", skipFeishu: true }));
      } catch (error) {
        return jsonResponse({ ok: false, error: publicErrorMessage(error) }, 500);
      }
    }

    if (url.pathname === "/compact-legacy") {
      const adminError = requireAdminWrite(request, env);
      if (adminError) return adminError;
      try {
        const result = await compactLegacyBitableTables(env);
        await rebuildSiteSnapshot(env);
        return jsonResponse(result);
      } catch (error) {
        return jsonResponse({ ok: false, error: publicErrorMessage(error) }, 500);
      }
    }

    if (url.pathname === "/cleanup-index-views") {
      const adminError = requireAdminWrite(request, env);
      if (adminError) return adminError;
      try {
        return jsonResponse(await cleanupDailyIndexViews(env));
      } catch (error) {
        return jsonResponse({ ok: false, error: publicErrorMessage(error) }, 500);
      }
    }

    if (url.pathname === "/reset-index-library") {
      const adminError = requireAdminWrite(request, env);
      if (adminError) return adminError;
      try {
        return jsonResponse(await resetDailyIndexLibrary(env));
      } catch (error) {
        return jsonResponse({ ok: false, error: publicErrorMessage(error) }, 500);
      }
    }

    if (url.pathname === "/rebuild-site-snapshot") {
      const adminError = requireAdminWrite(request, env);
      if (adminError) return adminError;
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

    return htmlResponse(renderStatusPage(), 404);
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
  const originalDailyItems = dedupeItems(originalItems);
  const selectedItems = originalDailyItems.filter((item) => normalizeCategory(item.category) !== "paper");
  const originalPaperItems = originalDailyItems.filter((item) => normalizeCategory(item.category) === "paper");

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
  const supplementalPaperItems = selectScoredItems(rawPaperItems.map((item, index) => toOriginalSiteItem(item, index + 1)), {
    minScore: config.minScore,
    maxItems: config.paperMaxItems,
  });
  const paperItems = dedupeItems([...originalPaperItems, ...supplementalPaperItems]);

  const analysisItems = dedupeItems([...selectedItems, ...paperItems]);
  const analysisResult = await getBriefAnalysis(env, analysisItems, config, paperItems);
  const archiveItems = dedupeItems([
    ...originalItems,
    ...rawPaperItems.map((item, index) => toOriginalSiteItem(item, originalItems.length + index + 1)),
  ]);
  const bitableItems = archiveItems.slice(0, config.bitableMaxRecords);
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
  const bearer = request.headers.get("Authorization") || "";
  return bearer === `Bearer ${env.ADMIN_TOKEN}`;
}

function requireAdminWrite(request, env) {
  if (request.method !== "POST") return methodNotAllowed(["POST"]);
  if (!isAuthorized(request, env)) return unauthorized();
  return null;
}

function unauthorized() {
  return jsonResponse({ ok: false, error: "Unauthorized" }, 401);
}

function methodNotAllowed(methods) {
  return jsonResponse({ ok: false, error: "Method Not Allowed" }, 405, { Allow: methods.join(", ") });
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
  return snapshotArchives || [];
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

function jsonResponse(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...headers,
    },
  });
}

async function publicHtmlResponse(request, ctx, renderHtml) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: {
        "Allow": "GET, HEAD",
        "Cache-Control": "no-store",
      },
    });
  }

  const isHead = request.method === "HEAD";
  const cache = globalThis.caches?.default;
  const cacheUrl = publicHtmlCacheUrl(request.url);
  const cacheKey = new Request(cacheUrl, { method: "GET" });
  if (cache) {
    const cached = await cache.match(cacheKey);
    if (cached) {
      return new Response(isHead ? null : cached.body, {
        status: cached.status,
        headers: publicHtmlClientHeaders("HIT"),
      });
    }
  }

  const html = await renderHtml();
  const response = new Response(isHead ? null : html, {
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
    "Cache-Control": `public, max-age=${PUBLIC_BROWSER_CACHE_SECONDS}, must-revalidate`,
    "CDN-Cache-Control": `public, max-age=${PUBLIC_EDGE_CACHE_SECONDS}, stale-while-revalidate=60`,
    "Cloudflare-CDN-Cache-Control": `public, max-age=${PUBLIC_EDGE_CACHE_SECONDS}, stale-while-revalidate=60`,
    "X-AIHot-Cache": cacheStatus,
  };
}

function publicHtmlCacheUrl(rawUrl) {
  const url = new URL(rawUrl);
  const originalParams = new URLSearchParams(url.search);
  url.search = "";
  if (url.pathname === "/daily") {
    const date = originalParams.get("date") || "";
    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) url.searchParams.set("date", date);
  } else if (url.pathname === "/review") {
    const days = Number(originalParams.get("days"));
    if ([7, 30, 90].includes(days)) url.searchParams.set("days", String(days));
  }
  url.searchParams.set("_aihot_v", PUBLIC_HTML_CACHE_VERSION);
  return url.toString();
}

async function buildOriginalFeedPayload(url) {
  const days = numberParam(url.searchParams.get("days"), 14, 1, 30);
  const take = numberParam(url.searchParams.get("take"), 80, 10, 100);
  const maxPages = numberParam(url.searchParams.get("maxPages"), 8, 1, 10);
  const minScore = numberParam(url.searchParams.get("minScore"), 0, 0, 100);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const rawItems = await fetchAIHotItems({ since, take, maxPages });
  const items = rawItems
    .map((item, index) => toOriginalSiteItem(item, index + 1))
    .filter((item) => itemScore(item) >= minScore)
    .slice(0, take * maxPages);

  return {
    ok: true,
    source: "aihot.virxact.com",
    generatedAt: new Date().toISOString(),
    since,
    days,
    take,
    maxPages,
    minScore,
    count: items.length,
    items,
  };
}

async function publicJsonCachedResponse(request, ctx, buildPayload) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: publicJsonHeaders("OPTIONS") });
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(JSON.stringify({ ok: false, error: "Method Not Allowed" }), {
      status: 405,
      headers: {
        ...publicJsonHeaders("BYPASS"),
        Allow: "GET, HEAD, OPTIONS",
      },
    });
  }

  const isHead = request.method === "HEAD";
  const cache = globalThis.caches?.default;
  const cacheKey = new Request(publicJsonCacheUrl(request.url), { method: "GET" });
  if (cache) {
    const cached = await cache.match(cacheKey);
    if (cached) {
      return new Response(isHead ? null : cached.body, {
        status: cached.status,
        headers: publicJsonHeaders("HIT"),
      });
    }
  }

  const payload = await buildPayload();
  const body = JSON.stringify(payload, null, 2);
  const response = new Response(isHead ? null : body, {
    status: 200,
    headers: publicJsonHeaders("MISS"),
  });

  if (cache) {
    const cacheResponse = new Response(body, {
      status: 200,
      headers: publicJsonHeaders("STORE"),
    });
    const put = cache.put(cacheKey, cacheResponse);
    if (ctx?.waitUntil) ctx.waitUntil(put);
    else await put;
  }

  return response;
}

function publicJsonHeaders(cacheStatus) {
  return {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": `public, max-age=${PUBLIC_BROWSER_CACHE_SECONDS}, must-revalidate`,
    "CDN-Cache-Control": `public, max-age=${PUBLIC_FEED_EDGE_CACHE_SECONDS}, stale-while-revalidate=60`,
    "Cloudflare-CDN-Cache-Control": `public, max-age=${PUBLIC_FEED_EDGE_CACHE_SECONDS}, stale-while-revalidate=60`,
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "X-AIHot-Cache": cacheStatus,
  };
}

function publicJsonCacheUrl(rawUrl) {
  const url = new URL(rawUrl);
  const originalParams = new URLSearchParams(url.search);
  url.search = "";
  for (const key of ["days", "take", "maxPages", "minScore"]) {
    const value = originalParams.get(key);
    if (value !== null) url.searchParams.set(key, value);
  }
  url.searchParams.set("_aihot_v", PUBLIC_HTML_CACHE_VERSION);
  return url.toString();
}

function numberParam(value, fallback, min, max) {
  const n = Number(value || fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
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
  publicHtmlCacheUrl,
  rankInfluentialItems,
  repairMojibake,
  selectScoredItems,
  selectMissingBitableFieldDefinitions,
  toOriginalSiteItem,
  validateAIHotResponse,
};
