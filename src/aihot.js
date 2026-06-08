const AIHOT_API = "https://aihot.virxact.com/api/public/items";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export async function fetchAIHotItems({ since, take, category, maxPages = 3 }) {
  const pageLimit = Math.max(1, Math.min(Number(maxPages) || 1, 10));
  const output = [];
  let cursor = "";

  for (let page = 1; page <= pageLimit; page += 1) {
    const data = await fetchAIHotPage({ since, take, category, cursor });
    validateAIHotResponse(data);
    output.push(...data.items);
    if (!data.hasNext || !data.nextCursor) break;
    cursor = data.nextCursor;
  }

  return output;
}

async function fetchAIHotPage({ since, take, category, cursor }) {
  const url = new URL(AIHOT_API);
  url.searchParams.set("mode", "selected");
  url.searchParams.set("since", since);
  url.searchParams.set("take", String(take));
  if (category) url.searchParams.set("category", category);
  if (cursor) url.searchParams.set("cursor", cursor);

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
  if (data.hasNext && typeof data.nextCursor !== "string") throw new Error("AI HOT schema error: nextCursor is required when hasNext is true.");

  data.items.forEach((item, index) => validateAIHotItem(item, index));
  return true;
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
