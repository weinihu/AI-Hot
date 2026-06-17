import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fetchAIHotItems } from "../src/aihot.js";

export default defineConfig({
  plugins: [react(), aihotFeedDevMiddleware()],
});

function aihotFeedDevMiddleware() {
  return {
    name: "aihot-feed-dev-middleware",
    configureServer(server) {
      server.middlewares.use("/api/original-feed", async (req, res) => {
        try {
          const requestUrl = new URL(req.url || "", "http://localhost");
          const payload = await buildOriginalFeedPayload(requestUrl.searchParams);
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.setHeader("Cache-Control", "public, max-age=60");
          res.end(JSON.stringify(payload, null, 2));
        } catch (error) {
          res.statusCode = 502;
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(JSON.stringify({ ok: false, error: error?.message || String(error) }));
        }
      });
    },
  };
}

async function buildOriginalFeedPayload(searchParams) {
  const days = numberParam(searchParams.get("days"), 14, 1, 30);
  const take = numberParam(searchParams.get("take"), 80, 10, 100);
  const maxPages = numberParam(searchParams.get("maxPages"), 8, 1, 10);
  const minScore = numberParam(searchParams.get("minScore"), 0, 0, 100);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const rawItems = await fetchAIHotItems({ since, take, maxPages });
  const items = rawItems
    .filter((item) => clampNumber(item.score, 0, 100) >= minScore)
    .slice(0, take * maxPages)
    .map((item, index) => ({ ...item, rank: index + 1 }));

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

function numberParam(value, fallback, min, max) {
  const n = Number(value || fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function clampNumber(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, Math.round(number)));
}
