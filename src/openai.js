import { categoryLabel, normalizeCategory } from "./config.js";
import { completeBrief, groupItemsByCategory, itemOneLineBrief } from "./formatter.js";

const OPENAI_MAX_RETRY_ATTEMPTS = 3;
const OPENAI_RETRY_BASE_MS = 250;

export async function getBriefAnalysis(env, items, config, paperItems = []) {
  if (!env.OPENAI_API_KEY || items.length === 0) {
    return {
      ok: false,
      status: items.length === 0 ? "skipped" : "disabled",
      fallback: true,
      error: items.length === 0 ? "没有可分析的条目" : "OPENAI_API_KEY 未配置",
      text: fallbackAnalysis(items, paperItems),
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      model: config.model,
    };
  }

  try {
    const result = await analyzeWithOpenAI(env, items, config, paperItems);
    return {
      ok: true,
      status: "ok",
      fallback: false,
      error: "",
      ...result,
    };
  } catch (error) {
    return {
      ok: false,
      status: "failed",
      fallback: true,
      error: sanitizeOpenAIError(error),
      text: fallbackAnalysis(items, paperItems),
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      model: config.model,
    };
  }
}

function formatItemsForAnalysis(items) {
  if (!items.length) return "暂无论文候选。";
  return items.map(formatItemForAnalysis).join("\n\n");
}

function formatItemForAnalysis(item) {
  return [
    `#${item.rank || ""} ${item.title}`,
    `分类：${categoryLabel(item.category)}`,
    `来源：${item.source || "未知"}`,
    `说明：${itemOneLineBrief(item) || item.summary || ""}`,
  ].join("\n");
}

async function analyzeWithOpenAI(env, items, config, paperItems = []) {
  const prompt = [
    "你是一个认真负责的信息整理员，读者是实验室组内同学。",
    "请只基于下面 AI HOT 原站条目做朴素总结，不要编造，不要给分，不要提模型或 token。",
    "你的任务是老老实实概括今天有什么，不要装专家，不要给推荐，不要给研究方向，不要安排组内任务。",
    "输出严格使用 4 行，不要 Markdown 标题，不要编号：",
    "整体概况：一句话概括今天条目主要覆盖哪些方向。",
    "主要动态：一句话总结产品、行业或工具相关消息。",
    "论文动态：一句话总结论文候选里主要涉及的研究主题；没有论文就写暂无明显论文更新。",
    "补充信息：一句话说明还有哪些需要看原文确认的事实，比如实验设置、发布时间、限制条件。",
    "每行 35-95 个中文字符，具体、平实，不要使用大师、研判、建议、推荐、方向这类口吻。",
    "",
    "论文候选：",
    formatItemsForAnalysis(paperItems.length ? paperItems : items.filter((item) => normalizeCategory(item.category) === "paper")),
    "",
    "全部条目：",
    items
      .map(formatItemForAnalysis)
      .join("\n\n"),
  ].join("\n");

  const payload = JSON.stringify({
    model: config.model,
    input: prompt,
    max_output_tokens: config.maxOutputTokens,
  });

  let response;
  let lastError = "";
  for (const endpoint of openAIEndpointCandidates(config.openAIBaseURL)) {
    const result = await fetchOpenAIEndpointWithRetry(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: payload,
    });
    response = result.response;

    if (response.ok) break;

    lastError = formatOpenAIRequestError("OpenAI request", endpoint, response, result.errorText, result.attempts);
    if (!shouldTryOpenAIAlternative(response.status, result.errorText)) {
      throw new Error(lastError);
    }
  }

  if (!response || !response.ok) {
    for (const endpoint of openAIChatEndpointCandidates(config.openAIBaseURL)) {
      const result = await fetchOpenAIEndpointWithRetry(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: config.model,
          messages: [
            {
              role: "system",
              content:
                "你是给实验室组内同学看的信息整理员。只基于用户给出的条目做朴素事实总结，不要编造，不要给建议或推荐。",
            },
            { role: "user", content: prompt },
          ],
          max_tokens: config.maxOutputTokens,
          temperature: 0.2,
        }),
      });
      response = result.response;

      if (response.ok) {
        const data = await response.json();
        const text = extractChatCompletionText(data);
        if (!text) throw new Error("OpenAI chat returned empty analysis text.");
        return {
          text,
          usage: normalizeOpenAIUsage(data.usage),
          model: data.model || config.model,
        };
      }

      lastError = formatOpenAIRequestError("OpenAI chat request", endpoint, response, result.errorText, result.attempts);
      if (!shouldTryNextChatEndpoint(response.status, result.errorText)) {
        throw new Error(lastError);
      }
    }
  }

  if (!response || !response.ok) {
    throw new Error(lastError || "OpenAI request failed.");
  }

  const data = await response.json();
  const text = extractResponseText(data);
  if (!text) throw new Error("OpenAI returned empty analysis text.");
  return {
    text,
    usage: normalizeOpenAIUsage(data.usage),
    model: data.model || config.model,
  };
}

async function fetchOpenAIEndpointWithRetry(endpoint, init) {
  let response;
  let errorText = "";
  for (let attempt = 1; attempt <= OPENAI_MAX_RETRY_ATTEMPTS; attempt += 1) {
    response = await fetch(endpoint, init);
    if (response.ok) return { response, errorText: "", attempts: attempt };

    errorText = await response.text();
    if (!isRetryableOpenAIStatus(response.status) || attempt === OPENAI_MAX_RETRY_ATTEMPTS) {
      return { response, errorText, attempts: attempt };
    }

    await sleep(openAIRetryDelayMs(attempt));
  }

  return { response, errorText, attempts: OPENAI_MAX_RETRY_ATTEMPTS };
}

function isRetryableOpenAIStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}

function openAIRetryDelayMs(attempt) {
  return OPENAI_RETRY_BASE_MS * 2 ** (attempt - 1);
}

function formatOpenAIRequestError(label, endpoint, response, errorText, attempts) {
  const status = response ? `${response.status} ${response.statusText || ""}`.trim() : "unknown";
  const suffix = attempts === 1 ? "attempt" : "attempts";
  return `${label} failed at ${endpoint} after ${attempts} ${suffix}: ${status} ${String(errorText || "").slice(0, 300)}`;
}

function shouldTryOpenAIAlternative(status, errorText) {
  return isRetryableOpenAIStatus(status) || shouldTryChatFallback(status, errorText);
}

function shouldTryNextChatEndpoint(status, errorText) {
  return isRetryableOpenAIStatus(status) || [404, 405].includes(status) || shouldTryChatFallback(status, errorText);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function openAIEndpointCandidates(baseURL) {
  const base = String(baseURL || "https://api.openai.com/v1").replace(/\/+$/, "");
  if (base.endsWith("/v1")) return [`${base}/responses`];
  return [`${base}/v1/responses`, `${base}/responses`];
}

export function openAIChatEndpointCandidates(baseURL) {
  const base = String(baseURL || "https://api.openai.com/v1").replace(/\/+$/, "");
  if (base.endsWith("/v1")) return [`${base}/chat/completions`];
  return [`${base}/v1/chat/completions`, `${base}/chat/completions`];
}

function shouldTryChatFallback(status, errorText) {
  if ([404, 405].includes(status)) return true;
  if (status === 403 && /<!doctype html|<html|cloudflare/i.test(errorText || "")) return true;
  if (status !== 400) return false;
  return /responses|unsupported|not found|unknown|invalid endpoint|不存在|不支持/i.test(errorText || "");
}

function extractResponseText(data) {
  if (typeof data.output_text === "string") return data.output_text.trim();
  const parts = [];
  for (const output of data.output || []) {
    for (const content of output.content || []) {
      if (typeof content.text === "string") parts.push(content.text);
    }
  }
  return parts.join("\n").trim();
}

function extractChatCompletionText(data) {
  return String(data?.choices?.[0]?.message?.content || "").trim();
}

function normalizeOpenAIUsage(usage) {
  if (!usage) return { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  return {
    input_tokens: usage.input_tokens ?? usage.prompt_tokens ?? 0,
    output_tokens: usage.output_tokens ?? usage.completion_tokens ?? 0,
    total_tokens: usage.total_tokens ?? 0,
  };
}

function fallbackAnalysis(items, paperItems = []) {
  if (items.length === 0) return "暂无内容可分析。";

  const categories = groupItemsByCategory(items)
    .map(([category, categoryItems]) => `${categoryLabel(category)} ${categoryItems.length} 条`)
    .join("，");
  const paperTitles = paperItems
    .slice(0, 2)
    .map((item) => completeBrief(item.title, 30).replace(/[。！？!?]$/g, ""))
    .join("、");
  const productItems = items.filter((item) => normalizeCategory(item.category) !== "paper").slice(0, 2);
  const productTitles = productItems
    .map((item) => completeBrief(item.title, 30).replace(/[。！？!?]$/g, ""))
    .join("、");

  return [
    `整体概况：今天条目主要集中在 ${categories || "少量分类"}。`,
    `主要动态：${productTitles ? `主要消息包括 ${productTitles}。` : "普通资讯数量不多，主要以论文和研究条目为主。"}`,
    `论文动态：${paperTitles ? `论文候选包括 ${paperTitles}。` : "暂无明显论文更新。"}`,
    "补充信息：具体实验设置、发布时间和可用限制仍需要点开原文确认。",
  ].join("\n");
}

function sanitizeOpenAIError(error) {
  const message = error && error.message ? error.message : String(error);
  if (/invalid_api_key|Incorrect API key/i.test(message)) {
    return "OpenAI API Key 无效或当前 key 不能从 Cloudflare 访问";
  }
  return message.replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-***");
}
