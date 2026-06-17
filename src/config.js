export const CATEGORY_ORDER = ["ai-models", "ai-products", "industry", "paper", "tip", "other"];

export const CATEGORY_LABELS = {
  "ai-models": "模型发布/更新",
  "ai-products": "产品发布/更新",
  industry: "行业动态",
  paper: "论文研究",
  tip: "技巧与观点",
  other: "其他",
};

export function getConfig(env) {
  return {
    lookbackHours: numberEnv(env.AIHOT_LOOKBACK_HOURS, 24, 1, 168),
    take: numberEnv(env.AIHOT_TAKE, 50, 10, 100),
    maxPages: numberEnv(env.AIHOT_MAX_PAGES, 6, 1, 10),
    maxItems: numberEnv(env.AIHOT_MAX_ITEMS, 30, 1, 100),
    paperLookbackHours: numberEnv(env.AIHOT_PAPER_LOOKBACK_HOURS, 168, 24, 336),
    paperTake: numberEnv(env.AIHOT_PAPER_TAKE, 30, 5, 100),
    paperMaxPages: numberEnv(env.AIHOT_PAPER_MAX_PAGES, 6, 1, 10),
    paperMaxItems: numberEnv(env.AIHOT_PAPER_MAX_ITEMS, 5, 1, 10),
    minScore: numberEnv(env.AIHOT_MIN_SCORE, 60, 0, 100),
    bitableMaxRecords: numberEnv(env.AIHOT_BITABLE_MAX_RECORDS, 120, 1, 200),
    maxOutputTokens: numberEnv(env.OPENAI_MAX_OUTPUT_TOKENS, 900, 200, 3000),
    sendHourBeijing: numberEnv(env.AIHOT_SEND_HOUR_BEIJING, 21, 0, 23),
    sendMinuteBeijing: numberEnv(env.AIHOT_SEND_MINUTE_BEIJING, 30, 0, 59),
    maxSendWaitMs: numberEnv(env.AIHOT_MAX_SEND_WAIT_MS, 90_000, 0, 120_000),
    model: env.OPENAI_MODEL || "gpt-5.5",
    openAIBaseURL: (env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, ""),
    publicBaseURL: (env.PUBLIC_BASE_URL || "https://aihot-feishu-briefing.weinihu9527.workers.dev").replace(/\/+$/, ""),
  };
}

function numberEnv(value, fallback, min, max) {
  const n = Number(value || fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

export function normalizeCategory(category) {
  return CATEGORY_LABELS[category] ? category : "other";
}

export function categoryLabel(category) {
  return CATEGORY_LABELS[normalizeCategory(category)] || CATEGORY_LABELS.other;
}
