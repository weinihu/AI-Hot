import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildDigest,
  buildDailyBitableFields,
  buildBitableFieldDefinitions,
  buildBitableFields,
  buildFeishuCard,
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
} from "../src/index.js";

test("UTF-8 Chinese content remains readable in docs, source, and assertions", () => {
  const expectations = [
    ["README.md", "轻量化 AI 资讯日报系统"],
    ["src/config.js", "模型发布/更新"],
    ["src/openai.js", "没有可分析的条目"],
    ["src/formatter.js", "AI HOT 原站日报"],
    ["src/bitable.js", "AI HOT 日报索引库"],
    ["src/index.js", "请选择有效日期"],
    ["tests/index.test.js", "某作者谈 AI 趋势观察"],
  ];

  const contents = expectations.map(([file, phrase]) => {
    const text = readFileSync(file, "utf8");
    assert.ok(text.includes(phrase), `${file} should contain readable Chinese phrase: ${phrase}`);
    return text;
  });

  const mojibakeFragments = [
    "杩" + "欐槸",
    "鏃" + "ユ姤",
    "鐭" + "ヨ瘑",
    "绱" + "㈠紩",
    "鍘" + "熺珯",
    "椋" + "炰功",
    "璁" + "烘枃",
    "浠" + "婃棩",
    "鎺" + "ㄩ€",
    "涓" + "昏",
  ];

  for (const [index, [file]] of expectations.entries()) {
    if (file === "tests/index.test.js") continue;
    for (const fragment of mojibakeFragments) {
      assert.ok(!contents[index].includes(fragment), `${file} should not contain mojibake fragment: ${fragment}`);
    }
  }
});

test("rankInfluentialItems favors actionable official platform changes over generic commentary", () => {
  const [top, second] = rankInfluentialItems([
    {
      id: "generic-opinion",
      title: "某作者谈 AI 趋势观察",
      source: "个人博客",
      category: "tip",
      summary: "这是一篇泛泛讨论行业情绪和长期趋势的文章，没有明确产品、接口或发布时间。",
      publishedAt: "2026-05-30T01:00:00.000Z",
    },
    {
      id: "official-api-release",
      title: "OpenAI releases Codex API for Windows automation",
      source: "OpenAI 官方博客",
      category: "ai-products",
      summary: "OpenAI 发布可直接接入的 Codex API，Windows 用户今天可以试用，影响开发者工具链和自动化流程。",
      publishedAt: "2026-05-30T02:00:00.000Z",
    },
  ]);

  assert.equal(top.id, "official-api-release");
  assert.ok(top.impactScore > second.impactScore);
  assert.deepEqual(Object.keys(top.valueFactors), ["actionability", "impact", "novelty", "credibility"]);
  assert.ok(top.valueFactors.actionability >= 20);
  assert.ok(top.valueFactors.credibility >= 20);
  assert.match(top.impactReasons.join(" / "), /今天可试用|可接入 API|官方发布|开发者工具链/);
});

test("buildDigest sends original-site daily content without scoring or model analysis noise", () => {
  const longSummary =
    "可直接接入的 Codex API 今天开放，影响 Windows 自动化和开发者工具链。后续还涉及权限、价格和企业内部流程改造，但这些细节应该放在原文里继续看。";
  const digest = buildDigest({
    items: [
      {
        id: "top",
        title: "OpenAI releases Codex API for Windows automation",
        source: "OpenAI 官方博客",
        category: "ai-products",
        summary: longSummary,
        url: "https://example.com/top",
        publishedAt: "2026-05-30T02:00:00.000Z",
      },
    ],
    paperItems: [
      {
        id: "paper-top",
        title: "WorldMemArena：评估多模态智能体记忆",
        source: "HuggingFace Daily Papers",
        category: "paper",
        summary: "该论文构建了一个用于评估多模态智能体记忆写入、维护、检索和使用能力的新基准。",
        url: "https://example.com/paper",
        publishedAt: "2026-05-30T00:00:00.000Z",
      },
    ],
    analysis: "整体概况：今天主要是开发者工具、智能体记忆和端侧能力相关消息。\n主要动态：Codex API 开放和 Windows 自动化会影响开发者工具链。\n论文动态：WorldMemArena 关注多模态智能体记忆评估。\n补充信息：需要点原文查看发布时间、实验设置和限制条件。",
    usage: { input_tokens: 100, output_tokens: 80, total_tokens: 180 },
    model: "gpt-5.5",
    startedAt: "2026-05-30T00:40:00.000Z",
    checkedCount: 20,
    bitableResult: { ok: true, written: 1, skippedDuplicates: 0, url: "https://example.com/base" },
    minScore: 0,
  });

  assert.ok(digest.startsWith("**AI HOT 原站日报**"));
  assert.match(digest, /产品发布\/更新/);
  assert.match(digest, /OpenAI releases Codex API/);
  assert.match(digest, /OpenAI 官方博客/);
  assert.match(digest, /可直接接入的 Codex API/);
  assert.match(digest, /说明：可直接接入的 Codex API 今天开放，影响 Windows 自动化和开发者工具链。/);
  assert.match(digest, /论文精选/);
  assert.match(digest, /WorldMemArena/);
  assert.match(digest, /今日总结/);
  assert.match(digest, /整体概况/);
  assert.match(digest, /主要动态/);
  assert.match(digest, /论文动态/);
  assert.match(digest, /补充信息/);
  assert.doesNotMatch(digest, /今日研判|核心判断|优先推荐|研究方向|组内建议|摘要：|…|内容过长|价值分|Tokens|运行信息|行动建议|今日判断|阈值/);
});

test("buildFeishuCard is a concise original-site daily card", () => {
  const items = [
    {
      id: "top",
      title: "OpenAI releases Codex API for Windows automation and local task execution workflows",
      source: "OpenAI 官方博客",
      category: "ai-products",
      summary:
        "可直接接入的 Codex API 今天开放，影响 Windows 自动化和开发者工具链。后续还涉及权限、价格和企业内部流程改造，但这些细节应该放在原文里继续看。",
      url: "https://example.com/top",
      publishedAt: "2026-05-30T02:00:00.000Z",
    },
  ];

  const card = buildFeishuCard({
    items,
    paperItems: [
      {
        id: "paper-top",
        title: "WorldMemArena：评估多模态智能体记忆",
        source: "HuggingFace Daily Papers",
        category: "paper",
        summary: "该论文构建了一个用于评估多模态智能体记忆写入、维护、检索和使用能力的新基准。",
        url: "https://example.com/paper",
        publishedAt: "2026-05-30T00:00:00.000Z",
      },
    ],
    analysis: "整体概况：今天主要是开发者工具、智能体记忆和端侧能力相关消息。\n主要动态：Codex API 开放和 Windows 自动化会影响开发者工具链。\n论文动态：WorldMemArena 关注多模态智能体记忆评估。\n补充信息：需要点原文查看发布时间、实验设置和限制条件。",
    usage: { input_tokens: 100, output_tokens: 80, total_tokens: 180 },
    model: "gpt-5.5",
    startedAt: "2026-05-30T00:40:00.000Z",
    checkedCount: 20,
    bitableResult: { ok: true, written: 1, skippedDuplicates: 0, url: "https://example.com/base" },
    dailyUrl: "https://aihot.agflow.cc/daily?date=2026-05-30",
    minScore: 0,
  });
  const cardText = JSON.stringify(card);
  const greySectionBlocks = card.elements.filter((element) => element.tag === "column_set" && element.background_style === "grey");
  const dividers = card.elements.filter((element) => element.tag === "hr");

  assert.equal(card.header.title.content, "AI HOT 原站日报");
  assert.equal(greySectionBlocks.length, 0);
  assert.ok(dividers.length >= 3);
  assert.match(cardText, /产品发布\/更新 · 1 条/);
  assert.match(cardText, /local task execution workflows/);
  assert.match(cardText, /OpenAI 官方博客/);
  assert.match(cardText, /可直接接入的 Codex API/);
  assert.match(cardText, /说明：可直接接入的 Codex API 今天开放，影响 Windows 自动化和开发者工具链。/);
  assert.match(cardText, /https:\/\/example.com\/top/);
  assert.match(cardText, /论文精选 · 1 条/);
  assert.match(cardText, /https:\/\/example.com\/paper/);
  assert.match(cardText, /今日总结/);
  assert.match(cardText, /整体概况/);
  assert.match(cardText, /主要动态/);
  assert.match(cardText, /论文动态/);
  assert.match(cardText, /补充信息/);
  assert.match(cardText, /https:\/\/aihot\.agflow\.cc\/daily\?date=2026-05-30/);
  assert.match(cardText, /继续阅读/);
  assert.match(cardText, /完整归档、历史检索、阶段复盘/);
  assert.match(cardText, /打开知识库入口/);
  assert.doesNotMatch(cardText, /事实：|用途：/);
  assert.doesNotMatch(cardText, /今日研判|核心判断|优先推荐|研究方向|组内建议|摘要：|…|内容过长|价值分|Tokens|运行信息|今日判断|洞察汇报|行动建议|阈值/);
});

test("original-site items preserve upstream score and minScore selection order", () => {
  const low = toOriginalSiteItem(
    {
      id: "low",
      title: "低分背景材料",
      source: "AI HOT",
      category: "industry",
      summary: "只作为背景了解。",
      url: "https://example.com/low",
      publishedAt: "2026-05-30T01:00:00.000Z",
      score: 42,
    },
    1,
  );
  const high = toOriginalSiteItem(
    {
      id: "high",
      title: "高分模型发布",
      source: "OpenAI 官方博客",
      category: "ai-models",
      summary: "模型能力和 API 接入都有变化。",
      url: "https://example.com/high",
      publishedAt: "2026-05-30T02:00:00.000Z",
      score: 88.4,
    },
    2,
  );

  const selected = selectScoredItems([low, high], { minScore: 60, maxItems: 10 });

  assert.equal(high.score, 88);
  assert.equal(high.impactScore, 88);
  assert.equal(high.priority, "S");
  assert.deepEqual(selected.map((item) => item.id), ["high"]);
});

test("repairMojibake repairs Latin-1-decoded UTF-8 archive text", () => {
  const original = "技巧与观点";
  const broken = String.fromCharCode(...new TextEncoder().encode(original));
  const sourceOriginal = "Hugging Face：Blog（RSS）";
  const sourceBroken = String.fromCharCode(...new TextEncoder().encode(sourceOriginal));

  assert.equal(repairMojibake(broken), original);
  assert.equal(repairMojibake(sourceBroken), sourceOriginal);
  assert.equal(repairMojibake("工具/项目候选"), "工具/项目候选");
});

test("OpenAI analysis failure is visible instead of silently falling back", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response("invalid_api_key sk-should-not-leak", { status: 401, statusText: "Unauthorized" });

  try {
    const items = [
      {
        id: "top",
        title: "OpenAI releases Codex API for Windows automation",
        source: "OpenAI 官方博客",
        category: "ai-products",
        summary: "OpenAI 发布可直接接入的 Codex API，Windows 用户今天可以试用。",
        publishedAt: "2026-05-30T02:00:00.000Z",
      },
    ];
    const analysis = await getBriefAnalysis(
      { OPENAI_API_KEY: "sk-test" },
      items,
      {
        model: "gpt-5.5",
        openAIBaseURL: "https://example.com",
        maxOutputTokens: 900,
      },
      [],
    );

    assert.equal(analysis.ok, false);
    assert.equal(analysis.status, "failed");
    assert.equal(analysis.fallback, true);
    assert.match(analysis.error, /OpenAI API Key 无效|OpenAI request failed/);
    assert.doesNotMatch(analysis.error, /sk-should-not-leak/);
    assert.match(analysis.text, /整体概况/);

    const card = buildFeishuCard({
      items,
      paperItems: [],
      analysis: analysis.text,
      analysisStatus: analysis,
    });

    assert.match(JSON.stringify(card), /AI 分析失败/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("openAIEndpointCandidates supports OpenAI-compatible gateways without /v1", () => {
  assert.deepEqual(openAIEndpointCandidates("https://agflow.cc"), [
    "https://agflow.cc/v1/responses",
    "https://agflow.cc/responses",
  ]);

  assert.deepEqual(openAIEndpointCandidates("https://agflow.cc/v1"), [
    "https://agflow.cc/v1/responses",
  ]);

  assert.deepEqual(openAIChatEndpointCandidates("https://agflow.cc"), [
    "https://agflow.cc/v1/chat/completions",
    "https://agflow.cc/chat/completions",
  ]);
});

test("OpenAI responses retries transient 5xx failures before chat fallback", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).endsWith("/responses")) {
      return new Response("temporary 502 from gateway", {
        status: 502,
        statusText: "Bad Gateway",
      });
    }
    return Response.json({
      model: "chat-fallback-model",
      choices: [
        {
          message: {
            content:
              "整体概况：模型网关短暂失败后，日报改用聊天端点完成总结。\n主要动态：条目仍按原始内容归纳。\n论文动态：暂无明显论文更新。\n补充信息：具体细节仍需查看原文确认。",
          },
        },
      ],
      usage: { prompt_tokens: 11, completion_tokens: 22, total_tokens: 33 },
    });
  };

  try {
    const analysis = await getBriefAnalysis(
      { OPENAI_API_KEY: "sk-test" },
      [
        {
          id: "top",
          title: "OpenAI releases Codex API for Windows automation",
          source: "OpenAI 官方博客",
          category: "ai-products",
          summary: "OpenAI 发布可直接接入的 Codex API，Windows 用户今天可以试用。",
          publishedAt: "2026-05-30T02:00:00.000Z",
        },
      ],
      {
        model: "gpt-test",
        openAIBaseURL: "https://example.com/v1",
        maxOutputTokens: 900,
      },
      [],
    );

    assert.equal(analysis.ok, true);
    assert.equal(analysis.fallback, false);
    assert.equal(analysis.model, "chat-fallback-model");
    assert.match(analysis.text, /模型网关短暂失败后/);
    assert.equal(calls.filter((url) => url.endsWith("/responses")).length, 3);
    assert.equal(calls.filter((url) => url.endsWith("/chat/completions")).length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchAIHotItems retries transient upstream 5xx failures", async () => {
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    if (attempts === 1) {
      return new Response("temporary upstream failure", { status: 520, statusText: "unknown" });
    }
    return Response.json({
      items: [
        {
          id: "paper",
          title: "Reliable paper feed",
          url: "https://example.com/paper",
          source: "AI HOT",
          publishedAt: "2026-05-30T00:00:00.000Z",
          category: "paper",
          score: 73,
        },
      ],
      hasNext: false,
    });
  };

  try {
    const items = await fetchAIHotItems({
      since: "2026-05-30T00:00:00.000Z",
      take: 10,
      category: "paper",
    });

    assert.equal(attempts, 2);
    assert.equal(items[0].title, "Reliable paper feed");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchAIHotItems follows AIHOT cursor pagination within maxPages", async () => {
  const originalFetch = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(new URL(url));
    if (urls.length === 1) {
      return Response.json({
        items: [
          {
            id: "one",
            title: "First page item",
            url: "https://example.com/one",
            source: "AI HOT",
            publishedAt: "2026-05-30T00:00:00.000Z",
            category: "ai-products",
            score: 81,
          },
        ],
        hasNext: true,
        nextCursor: "cursor-2",
      });
    }
    return Response.json({
      items: [
        {
          id: "two",
          title: "Second page item",
          url: "https://example.com/two",
          source: "AI HOT",
          publishedAt: "2026-05-30T01:00:00.000Z",
          category: "ai-models",
          score: 86,
        },
      ],
      hasNext: false,
    });
  };

  try {
    const items = await fetchAIHotItems({
      since: "2026-05-30T00:00:00.000Z",
      take: 10,
      maxPages: 3,
    });

    assert.equal(items.length, 2);
    assert.equal(urls.length, 2);
    assert.equal(urls[0].searchParams.has("cursor"), false);
    assert.equal(urls[1].searchParams.get("cursor"), "cursor-2");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("validateAIHotResponse rejects broken upstream schema", () => {
  assert.throws(
    () => validateAIHotResponse({ items: [{ id: "bad", title: "Missing fields", category: "paper", score: 70 }] }),
    /schema error: item 0\.url/,
  );
  assert.throws(
    () => validateAIHotResponse({ items: [], hasNext: true }),
    /nextCursor is required/,
  );
});

test("millisecondsUntilBeijingTime waits only before the configured Beijing send time", () => {
  assert.equal(
    millisecondsUntilBeijingTime("2026-06-06T13:29:30.000Z", 21, 30),
    30_000,
  );
  assert.equal(
    millisecondsUntilBeijingTime("2026-06-06T13:30:01.000Z", 21, 30),
    0,
  );
});

test("Bitable field definitions keep the daily index reader-facing", () => {
  const definitions = buildBitableFieldDefinitions();
  const names = definitions.map((field) => field.field_name);

  assert.ok(names.includes("日期"));
  assert.ok(names.includes("今日一句话"));
  assert.ok(names.includes("今日重点"));
  assert.ok(names.includes("最新论文"));
  assert.ok(names.includes("知识卡片入口"));
  assert.ok(!names.includes("组会候选"));
  assert.ok(!names.includes("总条数"));
  assert.ok(!names.includes("批次时间"));
  assert.ok(!names.includes("模型"));
  assert.ok(!names.includes("合计Tokens"));
  assert.equal(definitions.find((field) => field.field_name === "知识卡片入口").type, 15);

  const missing = selectMissingBitableFieldDefinitions([
    "新闻主题",
    "新闻日期",
    "推送新闻内容",
    "日期",
    "今日一句话",
  ]);
  const missingNames = missing.map((field) => field.field_name);

  assert.ok(missingNames.includes("最新论文"));
  assert.ok(missingNames.includes("知识卡片入口"));
  assert.ok(!missingNames.includes("新闻主题"));
  assert.ok(!missingNames.includes("日期"));
  assert.ok(!missingNames.includes("今日一句话"));
});

test("buildDailyBitableFields compacts many knowledge cards into one daily index row", () => {
  const fields = buildDailyBitableFields(
    [
      {
        id: "paper-top",
        title: "WorldMemArena：评估多模态智能体记忆能力",
        source: "HuggingFace Daily Papers",
        category: "paper",
        summary: "该论文构建了一个用于评估多模态智能体记忆写入、维护、检索和使用能力的新基准。",
        url: "https://example.com/paper",
        publishedAt: "2026-05-30T00:00:00.000Z",
      },
      {
        id: "tool-top",
        title: "OpenAI releases Codex API for Windows automation",
        source: "OpenAI 官方博客",
        category: "ai-products",
        summary: "OpenAI 发布可直接接入的 Codex API，Windows 用户今天可以试用。",
        url: "https://example.com/top",
        publishedAt: "2026-05-30T02:00:00.000Z",
      },
    ],
    {
      startedAt: "2026-05-30T13:30:00.000Z",
      model: "gpt-5.5",
      archiveKey: "archive:2026-05-30",
      analysisText: [
        "整体概况：今天主要是论文和工具更新。",
        "主要动态：OpenAI 发布 Codex API，Windows 用户今天可以试用。",
        "论文动态：WorldMemArena 用于评估多模态智能体记忆能力。",
        "补充信息：实验设置需要看原文确认。",
      ].join("\n"),
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    },
  );

  assert.equal(fields.日期, "2026-05-30");
  assert.equal(fields.今日一句话, "论文和工具更新。");
  assert.ok(!fields.今日一句话.includes("主要动态"));
  assert.match(fields.最新论文, /WorldMemArena/);
  assert.match(fields.工具项目, /Codex API/);
  assert.match(fields.关键方向, /智能体|AI Coding|模型\/API/);
  assert.equal(fields.知识卡片入口, undefined);
  assert.ok(!("总条数" in fields));
  assert.ok(!("模型" in fields));
});

test("buildDailyBitableFields synthesizes a terse fallback overview for the index table", () => {
  const fields = buildDailyBitableFields(
    [
      {
        id: "paper-top",
        title: "WorldMemArena：评估多模态智能体记忆能力",
        source: "HuggingFace Daily Papers",
        category: "paper",
        summary: "该论文构建了一个用于评估多模态智能体记忆写入、维护、检索和使用能力的新基准。",
        url: "https://example.com/paper",
        publishedAt: "2026-05-30T00:00:00.000Z",
      },
      {
        id: "tool-top",
        title: "OpenAI releases Codex API for Windows automation",
        source: "OpenAI 官方博客",
        category: "ai-products",
        summary: "OpenAI 发布可直接接入的 Codex API，Windows 用户今天可以试用。",
        url: "https://example.com/top",
        publishedAt: "2026-05-30T02:00:00.000Z",
      },
    ],
    {
      startedAt: "2026-05-30T13:30:00.000Z",
      model: "gpt-5.5",
      archiveKey: "archive:2026-05-30",
      analysisText: "legacy-import",
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    },
  );

  assert.ok(fields.今日一句话.length <= 64);
  assert.ok(!fields.今日一句话.includes("今日主线集中在"));
  assert.ok(!fields.今日一句话.includes("包含"));
  assert.match(fields.今日一句话, /先看|为主/);
});

test("buildBitableFields archives each item as a lightweight knowledge card", () => {
  const fields = buildBitableFields(
    {
      id: "paper-top",
      title: "WorldMemArena：评估多模态智能体记忆能力",
      source: "HuggingFace Daily Papers",
      category: "paper",
      summary: "该论文构建了一个用于评估多模态智能体记忆写入、维护、检索和使用能力的新基准。",
      url: "https://example.com/paper",
      publishedAt: "2026-05-30T00:00:00.000Z",
    },
    1,
    {
      startedAt: "2026-05-30T13:30:00.000Z",
      model: "gpt-5.5",
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    },
  );

  assert.equal(fields.知识类型, "论文候选");
  assert.equal(fields.是否论文, "是");
  assert.equal(fields.跟进状态, "未读");
  assert.equal(fields.跟进优先级, "高");
  assert.match(fields.一句话事实, /多模态智能体记忆/);
  assert.match(fields.方向标签, /智能体/);
  assert.match(fields.方向标签, /论文\/评测/);
  assert.match(fields.知识用途, /论文阅读/);
  assert.match(fields.适合对象, /研究同学/);
  assert.match(fields.跟进建议, /先看结论和数据集/);
  assert.equal(fields.信号, fields.一句话事实);
  assert.equal(fields.行动, fields.跟进建议);
});
