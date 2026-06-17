import { categoryLabel, normalizeCategory } from "./config.js";
import { getFeishuTenantAccessToken } from "./feishu.js";
import {
  chunk,
  compactText,
  ensureSentence,
  formatBeijingTime,
  formatDateKey,
  hasAny,
  itemAction,
  itemIdentity,
  itemOneLineBrief,
  normalizeItem,
} from "./formatter.js";

const KNOWLEDGE_TABLE_NAME = "AI HOT 日报索引库";
const KNOWLEDGE_TABLE_DEFAULT_VIEW_NAME = "日报索引";
const KNOWLEDGE_TABLE_ID_KV_KEY = "bitable:daily_index_table_id";
const KNOWLEDGE_TABLE_VIEW_ID_KV_KEY = "bitable:daily_index_default_view_id";

const EXTRA_VIEW_NAMES_TO_REMOVE = new Set(["论文重点日", "组会候选日", "工具项目日", "月度回看"]);

const BITABLE_TEMPLATE_FIELD_NAMES = new Set(["新闻主题", "新闻日期", "推送新闻内容"]);
const BITABLE_FIELD_DEFINITIONS = [
  { field_name: "日期", type: 1 },
  { field_name: "今日一句话", type: 1 },
  { field_name: "今日重点", type: 1 },
  { field_name: "最新论文", type: 1 },
  { field_name: "工具项目", type: 1 },
  { field_name: "关键方向", type: 1 },
  { field_name: "知识卡片入口", type: 15 },
];

export async function syncFeishuBitable(env, items, meta) {
  const dateKey = formatDateKey(meta.startedAt);
  const archiveKey = dailyArchiveKVKey(dateKey);
  await putDailyArchive(env, archiveKey, items, meta);

  const hasConfig = env.FEISHU_APP_ID && env.FEISHU_APP_SECRET && env.FEISHU_BITABLE_APP_TOKEN;

  if (!hasConfig) {
    return {
      ok: false,
      skipped: true,
      reason: "Feishu Bitable is not configured.",
      archived: items.length,
      archiveKey,
      url: env.FEISHU_BITABLE_URL || "",
    };
  }

  const tenantAccessToken = await getFeishuTenantAccessToken(env);
  const target = await resolveKnowledgeTable(env, tenantAccessToken);
  if (!target.ok) {
    return {
      ...target,
      url: env.FEISHU_BITABLE_URL || "",
    };
  }

  const fieldEnsureResult = await ensureFeishuBitableFields(env, tenantAccessToken, target.tableId);
  if (!fieldEnsureResult.ok) {
    return {
      ...fieldEnsureResult,
      url: buildBitableTableUrl(env, target.tableId, target.viewId),
    };
  }
  const viewEnsureResult = await ensureKnowledgeViews(env, tenantAccessToken, target.tableId);

  const shouldWriteDailyRow = await shouldWriteDailyIndexRow(env, dateKey, target.tableId);
  const records = shouldWriteDailyRow
    ? [
        {
          fields: buildDailyBitableFields(items, {
            ...meta,
            archiveKey,
            dailyUrl: meta.dailyUrl,
            tableUrl: buildBitableTableUrl(env, target.tableId, target.viewId),
          }),
        },
      ]
    : [];

  if (records.length === 0) {
    return {
      ok: true,
      written: 0,
      skippedDuplicates: 1,
      archived: items.length,
      archiveKey,
      fieldsCreated: fieldEnsureResult.created,
      table: target.name,
      views: viewEnsureResult,
      url: buildBitableTableUrl(env, target.tableId, target.viewId),
    };
  }

  const url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${encodeURIComponent(
    env.FEISHU_BITABLE_APP_TOKEN,
  )}/tables/${encodeURIComponent(target.tableId)}/records/batch_create`;

  const chunks = chunk(records, 100);
  let written = 0;
  for (const batch of chunks) {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tenantAccessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ records: batch }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.code !== 0) {
      return {
        ok: false,
        code: data.code,
        error: data.msg || data.message || `Bitable write failed: ${response.status}`,
        url: buildBitableTableUrl(env, target.tableId, target.viewId),
      };
    }
    written += batch.length;
  }

  if (env.AIHOT_KV) {
    await env.AIHOT_KV.put(dailyIndexKVKey(dateKey, target.tableId), "1", { expirationTtl: 60 * 60 * 24 * 366 });
  }

  return {
    ok: true,
    written,
    skippedDuplicates: 0,
    archived: items.length,
    archiveKey,
    fieldsCreated: fieldEnsureResult.created,
    table: target.name,
    views: viewEnsureResult,
    url: buildBitableTableUrl(env, target.tableId, target.viewId),
  };
}

export async function prepareFeishuBitableSchema(env) {
  const hasConfig = env.FEISHU_APP_ID && env.FEISHU_APP_SECRET && env.FEISHU_BITABLE_APP_TOKEN;

  if (!hasConfig) {
    return { ok: true, skipped: true, created: 0, remaining: 0, needsRerun: false };
  }

  const tenantAccessToken = await getFeishuTenantAccessToken(env);
  const target = await resolveKnowledgeTable(env, tenantAccessToken);
  if (!target.ok) return target;
  const fieldResult = await ensureFeishuBitableFields(env, tenantAccessToken, target.tableId, { maxCreate: 32 });
  if (!fieldResult.ok) return fieldResult;
  const viewResult = await ensureKnowledgeViews(env, tenantAccessToken, target.tableId);
  return { ...fieldResult, table: target.name, tableId: target.tableId, viewId: target.viewId, views: viewResult };
}

export async function compactLegacyBitableTables(env) {
  const hasConfig = env.FEISHU_APP_ID && env.FEISHU_APP_SECRET && env.FEISHU_BITABLE_APP_TOKEN;
  if (!hasConfig) return { ok: false, skipped: true, reason: "Feishu Bitable is not configured." };

  const tenantAccessToken = await getFeishuTenantAccessToken(env);
  const target = await resolveKnowledgeTable(env, tenantAccessToken);
  if (!target.ok) return target;

  const fieldResult = await ensureFeishuBitableFields(env, tenantAccessToken, target.tableId, { maxCreate: 32 });
  if (!fieldResult.ok) return fieldResult;
  await ensureKnowledgeViews(env, tenantAccessToken, target.tableId);

  const sourceTablesResult = await listLegacySourceTables(env, tenantAccessToken, target.tableId);
  if (!sourceTablesResult.ok) return sourceTablesResult;

  const byDate = new Map();
  const sourceStats = [];
  for (const table of sourceTablesResult.tables) {
    const recordsResult = await listBitableRecords(env, tenantAccessToken, table.table_id);
    if (!recordsResult.ok) return recordsResult;
    sourceStats.push({ name: table.name || table.table_name, tableId: table.table_id, records: recordsResult.records.length });
    for (const record of recordsResult.records) {
      const item = legacyRecordToItem(record);
      if (!item.title) continue;
      const dateKey = legacyRecordDate(record.fields) || formatDateKey(new Date());
      if (!byDate.has(dateKey)) byDate.set(dateKey, []);
      byDate.get(dateKey).push(item);
    }
  }

  const indexRecords = [];
  let archived = 0;
  const skippedDates = [];
  const migratedDates = [];
  for (const [dateKey, rawItems] of [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const items = dedupeLegacyItems(rawItems);
    const archiveKey = dailyArchiveKVKey(dateKey);
    const startedAt = `${dateKey}T21:30:00+08:00`;
    await putDailyArchive(env, archiveKey, items, {
      startedAt,
      model: "legacy-import",
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      analysisText: "",
    });
    archived += items.length;

    if (!(await shouldWriteDailyIndexRow(env, dateKey, target.tableId))) {
      skippedDates.push(dateKey);
      continue;
    }

    indexRecords.push({
      fields: buildDailyBitableFields(items, {
        startedAt,
        model: "legacy-import",
        usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
        archiveKey,
        analysisText: "",
      }),
    });
    migratedDates.push(dateKey);
  }

  const written = indexRecords.length
    ? await createBitableRecords(env, tenantAccessToken, target.tableId, indexRecords)
    : { ok: true, written: 0 };
  if (!written.ok) return written;

  if (env.AIHOT_KV) {
    for (const dateKey of migratedDates) {
      await env.AIHOT_KV.put(dailyIndexKVKey(dateKey, target.tableId), "1", { expirationTtl: 60 * 60 * 24 * 366 });
    }
  }

  return {
    ok: true,
    targetTable: target.name,
    targetUrl: buildBitableTableUrl(env, target.tableId, target.viewId),
    sourceTables: sourceStats,
    dates: byDate.size,
    migratedDates,
    skippedDates,
    written: written.written,
    archived,
  };
}

export async function cleanupDailyIndexViews(env) {
  const hasConfig = env.FEISHU_APP_ID && env.FEISHU_APP_SECRET && env.FEISHU_BITABLE_APP_TOKEN;
  if (!hasConfig) return { ok: false, skipped: true, reason: "Feishu Bitable is not configured." };

  const tenantAccessToken = await getFeishuTenantAccessToken(env);
  const target = await resolveKnowledgeTable(env, tenantAccessToken);
  if (!target.ok) return target;

  const viewsResult = await listFeishuBitableViews(env, tenantAccessToken, target.tableId);
  if (!viewsResult.ok) return viewsResult;

  const deleted = [];
  const kept = [];
  const warnings = [];
  for (const view of viewsResult.views) {
    const name = view.view_name || view.name || "";
    const viewId = view.view_id || "";
    if (!EXTRA_VIEW_NAMES_TO_REMOVE.has(name)) {
      kept.push(name);
      continue;
    }
    const result = await deleteFeishuBitableView(env, tenantAccessToken, target.tableId, viewId);
    if (result.ok) deleted.push(name);
    else warnings.push(`${name}: ${result.error || "删除失败"}`);
  }

  return {
    ok: true,
    table: target.name,
    url: buildBitableTableUrl(env, target.tableId, target.viewId),
    deleted,
    kept,
    warnings,
  };
}

export async function getDailyIndexStatus(env) {
  const hasConfig = env.FEISHU_APP_ID && env.FEISHU_APP_SECRET && env.FEISHU_BITABLE_APP_TOKEN;
  if (!hasConfig) return { ok: false, skipped: true, reason: "Feishu Bitable is not configured." };

  const tenantAccessToken = await getFeishuTenantAccessToken(env);
  const target = await resolveKnowledgeTable(env, tenantAccessToken);
  if (!target.ok) return target;

  const fieldsResult = await listFeishuBitableFields(env, tenantAccessToken, target.tableId);
  if (!fieldsResult.ok) return fieldsResult;
  const recordsResult = await listBitableRecords(env, tenantAccessToken, target.tableId);
  if (!recordsResult.ok) return recordsResult;

  return {
    ok: true,
    table: target.name,
    tableId: target.tableId,
    viewId: target.viewId,
    url: buildBitableTableUrl(env, target.tableId, target.viewId),
    recordCount: recordsResult.records.length,
    fields: fieldsResult.fields.map((field) => field.field_name).filter(Boolean),
  };
}

export async function resetDailyIndexLibrary(env) {
  const hasConfig = env.FEISHU_APP_ID && env.FEISHU_APP_SECRET && env.FEISHU_BITABLE_APP_TOKEN;
  if (!hasConfig) return { ok: false, skipped: true, reason: "Feishu Bitable is not configured." };

  const tenantAccessToken = await getFeishuTenantAccessToken(env);
  const tablesResult = await listBitableTables(env, tenantAccessToken);
  if (!tablesResult.ok) return tablesResult;

  const namesToDelete = new Set(["AI HOT数据库", "AI HOT 数据库", "AI HOT 知识卡片库", "AI HOT知识卡片库", KNOWLEDGE_TABLE_NAME]);
  const deletedTables = [];
  const tableWarnings = [];
  for (const table of tablesResult.tables) {
    const name = table.name || table.table_name || "";
    if (!namesToDelete.has(name)) continue;
    const deleted = await deleteBitableTable(env, tenantAccessToken, table.table_id);
    if (deleted.ok) deletedTables.push(name);
    else tableWarnings.push(`${name}: ${deleted.error || "删除失败"}`);
  }

  const kvCleanup = await cleanupObsoleteKV(env);
  const target = await resolveKnowledgeTable(env, tenantAccessToken);
  if (!target.ok) return target;
  const rebuildPrep = await prepareDailyIndexTableForRebuild(env, tenantAccessToken, target.tableId);
  if (!rebuildPrep.ok) return rebuildPrep;
  const fieldResult = await ensureFeishuBitableFields(env, tenantAccessToken, target.tableId, { maxCreate: 32 });
  if (!fieldResult.ok) return fieldResult;
  await ensureKnowledgeViews(env, tenantAccessToken, target.tableId);

  const archives = await listDailyArchives(env);
  const records = archives.map((archive) => ({
    fields: buildDailyBitableFields(archiveToItems(archive), {
      startedAt: archive.date ? `${archive.date}T21:30:00+08:00` : archive.batchTime || new Date().toISOString(),
      analysisText: archive.analysis || "",
      dailyUrl: publicDailyUrl(env, archive.date),
    }),
  }));
  const written = records.length ? await createBitableRecords(env, tenantAccessToken, target.tableId, records) : { ok: true, written: 0 };
  if (!written.ok) return written;

  if (env.AIHOT_KV) {
    for (const archive of archives) {
      if (archive.date) {
        await env.AIHOT_KV.put(dailyIndexKVKey(archive.date, target.tableId), "1", { expirationTtl: 60 * 60 * 24 * 366 });
      }
    }
  }

  return {
    ok: true,
    deletedTables,
    tableWarnings,
    kvCleanup,
    rebuildPrep,
    rebuiltTable: target.name,
    url: buildBitableTableUrl(env, target.tableId, target.viewId),
    archiveDays: archives.length,
    written: written.written,
  };
}

async function resolveKnowledgeTable(env, tenantAccessToken) {
  if (env.FEISHU_KNOWLEDGE_TABLE_ID) {
    return {
      ok: true,
      tableId: env.FEISHU_KNOWLEDGE_TABLE_ID,
      viewId: "",
      name: KNOWLEDGE_TABLE_NAME,
    };
  }

  const cachedTableId = env.AIHOT_KV ? await env.AIHOT_KV.get(KNOWLEDGE_TABLE_ID_KV_KEY) : "";
  const cachedViewId = env.AIHOT_KV ? await env.AIHOT_KV.get(KNOWLEDGE_TABLE_VIEW_ID_KV_KEY) : "";
  if (cachedTableId) {
    return {
      ok: true,
      tableId: cachedTableId,
      viewId: cachedViewId || "",
      name: KNOWLEDGE_TABLE_NAME,
    };
  }

  const existing = await findBitableTableByName(env, tenantAccessToken, KNOWLEDGE_TABLE_NAME);
  if (existing.ok && existing.tableId) {
    await cacheKnowledgeTable(env, existing.tableId, existing.viewId);
    return existing;
  }
  if (!existing.ok) return existing;

  const created = await createKnowledgeTable(env, tenantAccessToken);
  if (!created.ok) {
    if (env.FEISHU_BITABLE_TABLE_ID) {
      return {
        ok: true,
        tableId: env.FEISHU_BITABLE_TABLE_ID,
        viewId: "",
        name: "旧表格（创建知识卡片库失败，临时回退）",
        warning: created.error,
      };
    }
    return created;
  }

  await cacheKnowledgeTable(env, created.tableId, created.viewId);
  return created;
}

async function cacheKnowledgeTable(env, tableId, viewId) {
  if (!env.AIHOT_KV) return;
  await env.AIHOT_KV.put(KNOWLEDGE_TABLE_ID_KV_KEY, tableId, { expirationTtl: 60 * 60 * 24 * 365 });
  if (viewId) await env.AIHOT_KV.put(KNOWLEDGE_TABLE_VIEW_ID_KV_KEY, viewId, { expirationTtl: 60 * 60 * 24 * 365 });
}

async function findBitableTableByName(env, tenantAccessToken, tableName) {
  let pageToken = "";
  do {
    const url = new URL(
      `https://open.feishu.cn/open-apis/bitable/v1/apps/${encodeURIComponent(env.FEISHU_BITABLE_APP_TOKEN)}/tables`,
    );
    url.searchParams.set("page_size", "100");
    if (pageToken) url.searchParams.set("page_token", pageToken);

    const response = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${tenantAccessToken}`,
        "Content-Type": "application/json",
      },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.code !== 0) {
      return {
        ok: false,
        code: data.code,
        error: data.msg || data.message || `Bitable table list failed: ${response.status}`,
      };
    }

    const items = Array.isArray(data.data?.items) ? data.data.items : [];
    const found = items.find((item) => item.name === tableName || item.table_name === tableName);
    if (found) {
      return {
        ok: true,
        tableId: found.table_id,
        viewId: found.default_view_id || "",
        name: tableName,
      };
    }
    pageToken = data.data?.has_more ? data.data?.page_token || data.data?.next_page_token || "" : "";
  } while (pageToken);

  return { ok: true, tableId: "", viewId: "", name: tableName };
}

async function createKnowledgeTable(env, tenantAccessToken) {
  const withFields = await createBitableTable(env, tenantAccessToken, {
    table: {
      name: KNOWLEDGE_TABLE_NAME,
      default_view_name: KNOWLEDGE_TABLE_DEFAULT_VIEW_NAME,
      fields: buildBitableFieldDefinitions(),
    },
  });
  if (withFields.ok) return withFields;

  const withoutFields = await createBitableTable(env, tenantAccessToken, {
    table: {
      name: KNOWLEDGE_TABLE_NAME,
      default_view_name: KNOWLEDGE_TABLE_DEFAULT_VIEW_NAME,
    },
  });
  if (withoutFields.ok) return withoutFields;

  return withFields;
}

async function createBitableTable(env, tenantAccessToken, body) {
  const url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${encodeURIComponent(env.FEISHU_BITABLE_APP_TOKEN)}/tables`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${tenantAccessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.code !== 0) {
    return {
      ok: false,
      code: data.code,
      error: data.msg || data.message || `Bitable table create failed: ${response.status}`,
    };
  }

  const table = data.data?.table || data.data || {};
  const tableId = table.table_id || data.data?.table_id || "";
  if (!tableId) return { ok: false, error: "Bitable table create returned no table_id." };
  return {
    ok: true,
    tableId,
    viewId: table.default_view_id || data.data?.default_view_id || "",
    name: KNOWLEDGE_TABLE_NAME,
  };
}

async function deleteBitableTable(env, tenantAccessToken, tableId) {
  if (!tableId) return { ok: false, error: "table_id is missing." };
  const url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${encodeURIComponent(
    env.FEISHU_BITABLE_APP_TOKEN,
  )}/tables/${encodeURIComponent(tableId)}`;
  const response = await fetch(url, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${tenantAccessToken}`,
      "Content-Type": "application/json",
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.code !== 0) {
    return {
      ok: false,
      code: data.code,
      error: data.msg || data.message || `Bitable table delete failed: ${response.status}`,
    };
  }
  return { ok: true };
}

async function prepareDailyIndexTableForRebuild(env, tenantAccessToken, tableId) {
  const recordsResult = await listBitableRecords(env, tenantAccessToken, tableId);
  if (!recordsResult.ok) return recordsResult;

  const recordIds = recordsResult.records.map((record) => record.record_id).filter(Boolean);
  const recordDeleteResult = await deleteBitableRecords(env, tenantAccessToken, tableId, recordIds);
  if (!recordDeleteResult.ok) return recordDeleteResult;

  const fieldsResult = await listFeishuBitableFields(env, tenantAccessToken, tableId);
  if (!fieldsResult.ok) return fieldsResult;

  const fieldsToKeep = new Set(["日期"]);
  const fieldWarnings = [];
  const deletedFields = [];
  for (const field of fieldsResult.fields) {
    const name = field.field_name || "";
    const fieldId = field.field_id || "";
    if (!name || fieldsToKeep.has(name)) continue;
    const deleted = await deleteFeishuBitableField(env, tenantAccessToken, tableId, fieldId);
    if (deleted.ok) deletedFields.push(name);
    else fieldWarnings.push(`${name}: ${deleted.error || "删除失败"}`);
  }

  return {
    ok: true,
    deletedRecords: recordDeleteResult.deleted,
    deletedFields,
    fieldWarnings,
  };
}

async function deleteBitableRecords(env, tenantAccessToken, tableId, recordIds) {
  if (!recordIds.length) return { ok: true, deleted: 0 };
  const url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${encodeURIComponent(
    env.FEISHU_BITABLE_APP_TOKEN,
  )}/tables/${encodeURIComponent(tableId)}/records/batch_delete`;
  let deleted = 0;
  for (const batch of chunk(recordIds, 500)) {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tenantAccessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ records: batch }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.code !== 0) {
      return {
        ok: false,
        code: data.code,
        error: data.msg || data.message || `Bitable records delete failed: ${response.status}`,
      };
    }
    deleted += batch.length;
  }
  return { ok: true, deleted };
}

async function listLegacySourceTables(env, tenantAccessToken, targetTableId) {
  const tablesResult = await listBitableTables(env, tenantAccessToken);
  if (!tablesResult.ok) return tablesResult;
  const tables = tablesResult.tables.filter((table) => {
    const name = table.name || table.table_name || "";
    if (table.table_id === targetTableId) return false;
    return /AI HOT数据库|AI HOT 数据库|AI HOT 知识卡片库|AI HOT知识卡片库/.test(name);
  });
  return { ok: true, tables };
}

async function listBitableTables(env, tenantAccessToken) {
  const tables = [];
  let pageToken = "";
  do {
    const url = new URL(
      `https://open.feishu.cn/open-apis/bitable/v1/apps/${encodeURIComponent(env.FEISHU_BITABLE_APP_TOKEN)}/tables`,
    );
    url.searchParams.set("page_size", "100");
    if (pageToken) url.searchParams.set("page_token", pageToken);

    const response = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${tenantAccessToken}`,
        "Content-Type": "application/json",
      },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.code !== 0) {
      return {
        ok: false,
        code: data.code,
        error: data.msg || data.message || `Bitable table list failed: ${response.status}`,
      };
    }

    const items = Array.isArray(data.data?.items) ? data.data.items : [];
    tables.push(...items);
    pageToken = data.data?.has_more ? data.data?.page_token || data.data?.next_page_token || "" : "";
  } while (pageToken);
  return { ok: true, tables };
}

async function listBitableRecords(env, tenantAccessToken, tableId) {
  const records = [];
  let pageToken = "";
  do {
    const url = new URL(
      `https://open.feishu.cn/open-apis/bitable/v1/apps/${encodeURIComponent(
        env.FEISHU_BITABLE_APP_TOKEN,
      )}/tables/${encodeURIComponent(tableId)}/records`,
    );
    url.searchParams.set("page_size", "500");
    if (pageToken) url.searchParams.set("page_token", pageToken);

    const response = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${tenantAccessToken}`,
        "Content-Type": "application/json",
      },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.code !== 0) {
      return {
        ok: false,
        code: data.code,
        error: data.msg || data.message || `Bitable records list failed: ${response.status}`,
      };
    }

    const items = Array.isArray(data.data?.items) ? data.data.items : [];
    records.push(...items);
    pageToken = data.data?.has_more ? data.data?.page_token || data.data?.next_page_token || "" : "";
  } while (pageToken);
  return { ok: true, records };
}

async function createBitableRecords(env, tenantAccessToken, tableId, records) {
  const url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${encodeURIComponent(
    env.FEISHU_BITABLE_APP_TOKEN,
  )}/tables/${encodeURIComponent(tableId)}/records/batch_create`;
  const chunks = chunk(records, 100);
  let written = 0;
  for (const batch of chunks) {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tenantAccessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ records: batch }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.code !== 0) {
      return {
        ok: false,
        code: data.code,
        error: data.msg || data.message || `Bitable records create failed: ${response.status}`,
      };
    }
    written += batch.length;
  }
  return { ok: true, written };
}

async function ensureFeishuBitableFields(env, tenantAccessToken, tableId, options = {}) {
  const existingNamesResult = await listFeishuBitableFieldNames(env, tenantAccessToken, tableId);
  if (!existingNamesResult.ok) return existingNamesResult;

  const missingFields = selectMissingBitableFieldDefinitions(existingNamesResult.names);
  const createLimit = Number.isFinite(options.maxCreate) ? Math.max(0, Math.floor(options.maxCreate)) : missingFields.length;
  const fieldsToCreate = missingFields.slice(0, createLimit);
  for (const field of fieldsToCreate) {
    const created = await createFeishuBitableField(env, tenantAccessToken, tableId, field);
    if (!created.ok) return created;
  }

  return {
    ok: true,
    existing: existingNamesResult.names.length,
    created: fieldsToCreate.length,
    remaining: Math.max(0, missingFields.length - fieldsToCreate.length),
    needsRerun: fieldsToCreate.length < missingFields.length,
  };
}

async function listFeishuBitableFieldNames(env, tenantAccessToken, tableId) {
  const fieldsResult = await listFeishuBitableFields(env, tenantAccessToken, tableId);
  if (!fieldsResult.ok) return fieldsResult;
  return { ok: true, names: fieldsResult.fields.map((field) => field.field_name).filter(Boolean) };
}

async function listFeishuBitableFields(env, tenantAccessToken, tableId) {
  const fields = [];
  let pageToken = "";

  do {
    const url = new URL(
      `https://open.feishu.cn/open-apis/bitable/v1/apps/${encodeURIComponent(
        env.FEISHU_BITABLE_APP_TOKEN,
      )}/tables/${encodeURIComponent(tableId)}/fields`,
    );
    url.searchParams.set("page_size", "100");
    if (pageToken) url.searchParams.set("page_token", pageToken);

    const response = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${tenantAccessToken}`,
        "Content-Type": "application/json",
      },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.code !== 0) {
      return {
        ok: false,
        code: data.code,
        error: data.msg || data.message || `Bitable fields list failed: ${response.status}`,
      };
    }

    const items = Array.isArray(data.data?.items) ? data.data.items : [];
    fields.push(...items);
    pageToken = data.data?.has_more ? data.data?.page_token || data.data?.next_page_token || "" : "";
  } while (pageToken);

  return { ok: true, fields };
}

async function createFeishuBitableField(env, tenantAccessToken, tableId, field) {
  const url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${encodeURIComponent(
    env.FEISHU_BITABLE_APP_TOKEN,
  )}/tables/${encodeURIComponent(tableId)}/fields`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${tenantAccessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(field),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.code !== 0) {
    const message = data.msg || data.message || "";
    if (/FieldNameDuplicated|field name.*exist|already exists/i.test(message)) {
      return { ok: true, duplicate: true };
    }
    return {
      ok: false,
      code: data.code,
      error: message || `Bitable field create failed: ${response.status}`,
    };
  }

  return { ok: true };
}

async function deleteFeishuBitableField(env, tenantAccessToken, tableId, fieldId) {
  if (!fieldId) return { ok: false, error: "field_id is missing." };
  const url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${encodeURIComponent(
    env.FEISHU_BITABLE_APP_TOKEN,
  )}/tables/${encodeURIComponent(tableId)}/fields/${encodeURIComponent(fieldId)}`;
  const response = await fetch(url, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${tenantAccessToken}`,
      "Content-Type": "application/json",
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.code !== 0) {
    return {
      ok: false,
      code: data.code,
      error: data.msg || data.message || `Bitable field delete failed: ${response.status}`,
    };
  }
  return { ok: true };
}

async function ensureKnowledgeViews(env, tenantAccessToken, tableId) {
  const viewsResult = await listFeishuBitableViews(env, tenantAccessToken, tableId);
  if (!viewsResult.ok) {
    return {
      ok: false,
      error: viewsResult.error || "Bitable view setup failed.",
    };
  }
  return { ok: true, views: viewsResult.views.length };
}

async function listFeishuBitableViews(env, tenantAccessToken, tableId) {
  const views = [];
  let pageToken = "";

  do {
    const url = new URL(
      `https://open.feishu.cn/open-apis/bitable/v1/apps/${encodeURIComponent(
        env.FEISHU_BITABLE_APP_TOKEN,
      )}/tables/${encodeURIComponent(tableId)}/views`,
    );
    url.searchParams.set("page_size", "100");
    if (pageToken) url.searchParams.set("page_token", pageToken);

    const response = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${tenantAccessToken}`,
        "Content-Type": "application/json",
      },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.code !== 0) {
      return {
        ok: false,
        code: data.code,
        error: data.msg || data.message || `Bitable views list failed: ${response.status}`,
      };
    }

    const items = Array.isArray(data.data?.items) ? data.data.items : [];
    views.push(...items);
    pageToken = data.data?.has_more ? data.data?.page_token || data.data?.next_page_token || "" : "";
  } while (pageToken);

  return { ok: true, views };
}

async function createKnowledgeView(env, tenantAccessToken, tableId, viewName) {
  const url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${encodeURIComponent(
    env.FEISHU_BITABLE_APP_TOKEN,
  )}/tables/${encodeURIComponent(tableId)}/views`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${tenantAccessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      view_name: viewName,
      view_type: "grid",
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.code !== 0) {
    return {
      ok: false,
      code: data.code,
      error: data.msg || data.message || `Bitable view create failed: ${response.status}`,
    };
  }
  const view = data.data?.view || data.data || {};
  return { ok: true, viewId: view.view_id || data.data?.view_id || "" };
}

async function deleteFeishuBitableView(env, tenantAccessToken, tableId, viewId) {
  if (!viewId) return { ok: false, error: "view_id is missing." };
  const url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${encodeURIComponent(
    env.FEISHU_BITABLE_APP_TOKEN,
  )}/tables/${encodeURIComponent(tableId)}/views/${encodeURIComponent(viewId)}`;
  const response = await fetch(url, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${tenantAccessToken}`,
      "Content-Type": "application/json",
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.code !== 0) {
    return {
      ok: false,
      code: data.code,
      error: data.msg || data.message || `Bitable view delete failed: ${response.status}`,
    };
  }
  return { ok: true };
}

async function updateKnowledgeViewFilter(env, tenantAccessToken, tableId, viewId, filters, fieldsByName) {
  if (!viewId || !Array.isArray(filters) || filters.length === 0) return { ok: true };

  const conditions = [];
  for (const filter of filters) {
    const field = fieldsByName.get(filter.field);
    if (!field?.field_id) return { ok: false, error: `字段不存在：${filter.field}` };
    conditions.push({
      field_id: field.field_id,
      operator: filter.operator,
      value: JSON.stringify(filter.value),
    });
  }

  const url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${encodeURIComponent(
    env.FEISHU_BITABLE_APP_TOKEN,
  )}/tables/${encodeURIComponent(tableId)}/views/${encodeURIComponent(viewId)}`;
  const response = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${tenantAccessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      property: {
        filter_info: {
          conjunction: "and",
          conditions,
        },
      },
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.code !== 0) {
    return {
      ok: false,
      code: data.code,
      error: data.msg || data.message || `Bitable view filter update failed: ${response.status}`,
    };
  }
  return { ok: true };
}

async function putDailyArchive(env, archiveKey, items, meta) {
  if (!env.AIHOT_KV) return;
  const cards = items.map((item, index) => {
    const normalized = normalizeItem(item);
    const knowledge = buildKnowledgeCard(item);
    return {
      rank: index + 1,
      id: normalized.id,
      title: normalized.title,
      source: normalized.source,
      url: normalized.url,
      publishedAt: normalized.publishedAt,
      category: categoryLabel(normalized.category),
      score: normalized.score || item.impactScore || 0,
      impactScore: item.impactScore || normalized.score || 0,
      priority: item.priority || "",
      summary: normalized.summary,
      knowledge,
    };
  });
  await env.AIHOT_KV.put(
    archiveKey,
    JSON.stringify({
      date: formatDateKey(meta.startedAt),
      batchTime: formatBeijingTime(meta.startedAt),
      model: meta.model || "",
      usage: meta.usage || { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      analysis: meta.analysisText || "",
      cards,
    }),
  );
}

async function shouldWriteDailyIndexRow(env, dateKey, tableId) {
  if (!env.AIHOT_KV) return true;
  return !(await env.AIHOT_KV.get(dailyIndexKVKey(dateKey, tableId)));
}

export function dailyArchiveKVKey(dateKey) {
  return `archive:${dateKey}`;
}

function dailyIndexKVKey(dateKey, tableId) {
  return `bitable:daily-index:${tableId}:${dateKey}`;
}

async function filterBitableRowsByKV(env, items, dateKey, tableId) {
  if (!env.AIHOT_KV) return items;
  const output = [];
  for (const item of items) {
    const exists = await env.AIHOT_KV.get(bitableKVKey(item, dateKey, tableId));
    if (!exists) output.push(item);
  }
  return output;
}

function bitableKVKey(item, dateKey, tableId) {
  return `bitable:${tableId}:${dateKey}:${itemIdentity(item)}`;
}

function buildBitableTableUrl(env, tableId, viewId = "") {
  const baseUrl = env.FEISHU_BITABLE_URL || `https://ocnkwl2nqvlc.feishu.cn/base/${env.FEISHU_BITABLE_APP_TOKEN}`;
  const url = new URL(baseUrl);
  url.searchParams.set("table", tableId);
  if (viewId) url.searchParams.set("view", viewId);
  return url.toString();
}

async function cleanupObsoleteKV(env) {
  if (!env.AIHOT_KV) return { ok: true, skipped: true, deleted: 0 };
  let deleted = 0;
  for (const prefix of ["bitable:", "sent:"]) {
    let cursor;
    do {
      const listed = await env.AIHOT_KV.list({ prefix, cursor, limit: 1000 });
      await Promise.all(listed.keys.map((key) => env.AIHOT_KV.delete(key.name)));
      deleted += listed.keys.length;
      cursor = listed.list_complete ? undefined : listed.cursor;
    } while (cursor);
  }
  await env.AIHOT_KV.delete("latest_digest");
  deleted += 1;
  return { ok: true, deleted, keptPrefixes: ["archive:"] };
}

async function listDailyArchives(env) {
  if (!env.AIHOT_KV) return [];
  const archives = [];
  let cursor;
  do {
    const listed = await env.AIHOT_KV.list({ prefix: "archive:", cursor, limit: 1000 });
    for (const key of listed.keys) {
      const text = await env.AIHOT_KV.get(key.name);
      if (!text) continue;
      try {
        archives.push(JSON.parse(text));
      } catch {
        // Ignore malformed old archive entries.
      }
    }
    cursor = listed.list_complete ? undefined : listed.cursor;
  } while (cursor);
  return archives
    .filter((archive) => archive && archive.date && Array.isArray(archive.cards))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function archiveToItems(archive) {
  return (archive.cards || []).map((card) => ({
    id: card.id || card.url || card.title,
    title: card.title || "",
    source: card.source || "",
    url: card.url || "",
    publishedAt: card.publishedAt || "",
    summary: card.summary || card.knowledge?.fact || "",
    category: legacyCategoryToKey(card.category || card.knowledge?.type || ""),
  }));
}

function publicDailyUrl(env, dateKey) {
  const base = String(env.PUBLIC_BASE_URL || "https://aihot-feishu-briefing.weinihu9527.workers.dev").replace(/\/+$/, "");
  return `${base}/daily?date=${encodeURIComponent(dateKey || "")}`;
}

export function buildBitableFieldDefinitions() {
  return BITABLE_FIELD_DEFINITIONS.map((field) => ({ ...field }));
}

export function selectMissingBitableFieldDefinitions(existingNames) {
  const existing = new Set(existingNames);
  for (const name of BITABLE_TEMPLATE_FIELD_NAMES) existing.add(name);
  return buildBitableFieldDefinitions().filter((field) => !existing.has(field.field_name));
}

export function buildDailyBitableFields(items, meta) {
  const cards = items.map((item, index) => {
    const normalized = normalizeItem(item);
    const knowledge = buildKnowledgeCard(item);
    return {
      rank: index + 1,
      title: normalized.title,
      source: normalized.source,
      url: normalized.url,
      category: categoryLabel(normalized.category),
      ...knowledge,
    };
  });
  const paperCards = cards.filter((card) => card.isPaper === "是");
  const toolCards = cards.filter((card) => card.type === "工具/项目候选");
  const focusCards = selectIndexFocusCards(cards);
  const topicSummary = summarizeTopics(cards);

  return {
    日期: formatDateKey(meta.startedAt),
    今日一句话: dailyOverviewText(meta.analysisText, cards),
    今日重点: formatCardList(focusCards, 3),
    最新论文: formatCardList(paperCards, 3),
    工具项目: formatCardList(toolCards, 3),
    关键方向: topicSummary,
    知识卡片入口: meta.dailyUrl ? { link: meta.dailyUrl, text: "打开可视化卡片" } : undefined,
  };
}

function formatCardList(cards, limit) {
  if (!cards.length) return "";
  return cards
    .slice(0, limit)
    .map((card, index) => `${index + 1}. ${compactText(card.title, 42)}：${compactText(card.fact, 72)}`)
    .join("\n");
}

function selectIndexFocusCards(cards) {
  const selected = [];
  const add = (card) => {
    if (card && selected.length < 5 && !selected.some((item) => item.title === card.title)) selected.push(card);
  };
  add(cards.find((card) => card.isPaper === "是" && card.priority === "高"));
  add(cards.find((card) => card.type === "工具/项目候选"));
  for (const card of cards.filter((item) => item.priority === "高" || item.meetingValue === "高")) add(card);
  for (const card of cards) add(card);
  return selected;
}

function dailyOverviewText(analysisText, cards) {
  const overview = extractDailyOverview(analysisText);
  if (overview) return overview;
  return synthesizeDailyOverview(cards);
}

function extractDailyOverview(analysisText) {
  const raw = String(analysisText || "").trim();
  if (!raw || /旧表|压缩迁移|legacy-import/i.test(raw)) return "";

  const normalized = raw
    .replace(/\r\n?/g, "\n")
    .replace(/#{1,6}\s*/g, "")
    .replace(/\*\*/g, "")
    .trim();
  const inline = normalized.replace(/\s+/g, " ");
  const labeled = inline.match(
    /(?:整体概况|今日概况|今日一句话|一句话总结|一句话|概要|概况)\s*[:：]\s*(.*?)(?=\s*(?:主要动态|论文动态|补充信息)\s*[:：]|$)/,
  );
  if (labeled) return cleanDailyOverview(labeled[1]);

  const firstLine = normalized
    .split("\n")
    .map((line) => line.replace(/^[-*]\s*/, "").trim())
    .find(Boolean);
  return cleanDailyOverview(firstLine || "");
}

function cleanDailyOverview(text) {
  const clean = String(text || "")
    .replace(/^(整体概况|今日概况|今日一句话|一句话总结|一句话|概要|概况)\s*[:：]\s*/, "")
    .replace(/^(今天|今日)\s*(条目|内容|资讯|主线|重点)?\s*(主要)?\s*(是|为|集中在|覆盖|围绕|聚焦在|聚焦于)?\s*/, "")
    .replace(/^主线\s*(集中在|为|是)?\s*/, "")
    .replace(/^(主要)?(集中在|覆盖|围绕|聚焦在|聚焦于)\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
  return clean ? ensureSentence(compactText(clean, 64)) : "";
}

function synthesizeDailyOverview(cards) {
  const focus = selectIndexFocusCards(cards)[0];
  const topics = summarizeTopics(cards).split("、").filter(Boolean).slice(0, 3).join("、");
  const focusTitle = focus?.title ? compactTitle(focus.title, 28) : "";
  if (topics && focusTitle) return ensureSentence(`${topics}为主，先看「${focusTitle}」`);
  if (topics) return ensureSentence(`${topics}为主`);
  const fallback = cards[0]?.title ? ensureSentence(`先看「${compactTitle(cards[0].title, 34)}」`) : "";
  if (fallback) return fallback;
  return "归档已生成，可打开卡片查看。";
}

function compactTitle(title, maxLength) {
  return compactText(title, maxLength).replace(/[。！？!?]$/g, "");
}

function summarizeTopics(cards) {
  const counts = new Map();
  for (const card of cards) {
    for (const topic of String(card.topics || "").split("/").map((item) => item.trim()).filter(Boolean)) {
      counts.set(topic, (counts.get(topic) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([topic]) => topic)
    .join("、");
}

export function buildBitableFields(item, rank, meta) {
  const normalized = normalizeItem(item);
  const usage = meta.usage || { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  const knowledge = buildKnowledgeCard(item);
  return {
    日期: formatDateKey(meta.startedAt),
    分类: categoryLabel(normalized.category),
    知识类型: knowledge.type,
    方向标签: knowledge.topics,
    跟进优先级: knowledge.priority,
    组会价值: knowledge.meetingValue,
    跟进状态: knowledge.status,
    标题: normalized.title,
    一句话事实: knowledge.fact,
    知识用途: knowledge.useCase,
    适合对象: knowledge.audience,
    跟进建议: knowledge.nextStep,
    是否论文: knowledge.isPaper,
    来源: normalized.source,
    原文链接: normalized.url ? { link: normalized.url, text: compactText(normalized.title, 60) } : undefined,
    发布时间: normalized.publishedAt,
    排名: rank,
    批次时间: formatBeijingTime(meta.startedAt),
    价值分: item.impactScore || 0,
    推荐级别: item.priority || "原站",
    是否高价值: "原站精选",
    可行动性: item.valueFactors?.actionability || 0,
    影响范围: item.valueFactors?.impact || 0,
    稀缺性: item.valueFactors?.novelty || 0,
    可信度: item.valueFactors?.credibility || 0,
    信号: knowledge.fact,
    影响: knowledge.useCase,
    行动: knowledge.nextStep,
    摘要: normalized.summary,
    模型: meta.model || "",
    输入Tokens: usage.input_tokens,
    输出Tokens: usage.output_tokens,
    合计Tokens: usage.total_tokens,
  };
}

function legacyRecordToItem(record) {
  const fields = record.fields || {};
  const title = fieldText(fields, ["标题", "新闻主题", "Title"]);
  const summary = fieldText(fields, ["一句话事实", "摘要", "推送新闻内容", "信号", "说明"]);
  return {
    id: record.record_id,
    title,
    source: fieldText(fields, ["来源", "Source"]),
    url: fieldLink(fields, ["原文链接", "链接", "url"]),
    publishedAt: fieldText(fields, ["发布时间", "新闻日期"]),
    summary,
    category: legacyCategoryToKey(fieldText(fields, ["分类", "知识类型"])),
    impactScore: Number(fieldText(fields, ["价值分"])) || 0,
    priority: fieldText(fields, ["推荐级别"]) || "历史",
    valueFactors: {
      actionability: Number(fieldText(fields, ["可行动性"])) || 0,
      impact: Number(fieldText(fields, ["影响范围"])) || 0,
      novelty: Number(fieldText(fields, ["稀缺性"])) || 0,
      credibility: Number(fieldText(fields, ["可信度"])) || 0,
    },
  };
}

function legacyRecordDate(fields = {}) {
  const direct = fieldText(fields, ["日期"]);
  if (/^\d{4}-\d{2}-\d{2}$/.test(direct)) return direct;
  const slashDate = direct.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})/) || fieldText(fields, ["新闻日期"]).match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})/);
  if (slashDate) return `${slashDate[1]}-${slashDate[2].padStart(2, "0")}-${slashDate[3].padStart(2, "0")}`;
  const raw = fields["新闻日期"] ?? fields["发布时间"];
  if (typeof raw === "number") return formatDateKey(raw);
  const parsed = Date.parse(fieldText(fields, ["新闻日期", "发布时间"]));
  return Number.isNaN(parsed) ? "" : formatDateKey(parsed);
}

function legacyCategoryToKey(value) {
  const text = String(value || "");
  if (/论文|研究/.test(text)) return "paper";
  if (/模型/.test(text)) return "ai-models";
  if (/产品|工具项目|工具\/项目/.test(text)) return "ai-products";
  if (/行业/.test(text)) return "industry";
  if (/技巧|观点|方法/.test(text)) return "tip";
  return "other";
}

function fieldText(fields, names) {
  for (const name of names) {
    const value = fields[name];
    const text = fieldValueText(value);
    if (text) return text;
  }
  return "";
}

function fieldLink(fields, names) {
  for (const name of names) {
    const value = fields[name];
    if (!value) continue;
    if (typeof value === "string" && /^https?:\/\//.test(value)) return value;
    if (value && typeof value === "object") {
      if (typeof value.link === "string") return value.link;
      if (typeof value.url === "string") return value.url;
    }
    const text = fieldValueText(value);
    const match = text.match(/https?:\/\/\S+/);
    if (match) return match[0];
  }
  return "";
}

function fieldValueText(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(fieldValueText).filter(Boolean).join(" ").trim();
  if (typeof value === "object") {
    if (typeof value.text === "string") return value.text.trim();
    if (typeof value.name === "string") return value.name.trim();
    if (typeof value.value === "string") return value.value.trim();
    if (typeof value.link === "string") return value.link.trim();
  }
  return "";
}

function dedupeLegacyItems(items) {
  const seen = new Set();
  const output = [];
  for (const item of items) {
    const id = item.url || item.title;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    output.push(item);
  }
  return output;
}

function buildKnowledgeCard(item) {
  const normalized = normalizeItem(item);
  const category = normalizeCategory(normalized.category);
  const text = `${normalized.title} ${normalized.summary} ${normalized.source}`.toLowerCase();
  const topics = inferKnowledgeTopics(normalized, category);
  const priority = inferKnowledgePriority(item, category, text);

  return {
    type: inferKnowledgeType(category, text),
    fact: itemOneLineBrief(normalized) || ensureSentence(normalized.title),
    topics: topics.join(" / "),
    useCase: inferKnowledgeUseCase(category, text),
    audience: inferKnowledgeAudience(category, text),
    status: "未读",
    priority,
    nextStep: itemAction(normalized),
    meetingValue: inferMeetingValue(priority, category, text),
    isPaper: category === "paper" ? "是" : "否",
  };
}

function inferKnowledgeType(category, text) {
  if (category === "paper") return "论文候选";
  if (hasAny(text, ["api", "sdk", "接口", "接入", "mcp", "github", "开源", "codex", "copilot"])) {
    return "工具/项目候选";
  }
  if (category === "ai-models") return "模型变化";
  if (category === "ai-products") return "产品变化";
  if (category === "industry") return "行业观察";
  if (category === "tip") return "方法参考";
  return "资料线索";
}

function inferKnowledgeTopics(item, category) {
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
  add("开源项目", ["open source", "github", "开源"]);

  if (topics.length === 0) topics.push(categoryLabel(category));
  return [...new Set(topics)].slice(0, 4);
}

function inferKnowledgeUseCase(category, text) {
  if (category === "paper") return "论文阅读 / 文献跟踪 / 实验参考";
  if (hasAny(text, ["github", "open source", "开源", "repo", "repository"])) {
    return "代码复现 / 工具试用 / 项目调研";
  }
  if (hasAny(text, ["api", "sdk", "接口", "接入", "mcp", "integration"])) {
    return "接入评估 / Demo 验证 / 成本评估";
  }
  if (category === "ai-models") return "模型选型 / 能力跟踪 / 技术路线参考";
  if (category === "ai-products") return "工具试用 / 工作流改造 / 产品调研";
  if (category === "industry") return "趋势跟踪 / 立项背景 / 风险观察";
  if (category === "tip") return "方法沉淀 / SOP 优化 / 提示词参考";
  return "背景资料 / 后续检索 / 补充阅读";
}

function inferKnowledgeAudience(category, text) {
  if (category === "paper" || hasAny(text, ["paper", "arxiv", "benchmark", "eval", "dataset", "论文", "基准", "评测"])) {
    return "研究同学";
  }
  if (hasAny(text, ["api", "sdk", "codex", "copilot", "developer", "github", "接口", "开发者", "代码"])) {
    return "开发同学";
  }
  if (hasAny(text, ["product", "产品", "workflow", "工作流", "chatgpt", "gemini"])) {
    return "产品/工具使用同学";
  }
  if (category === "industry" || hasAny(text, ["投资", "监管", "企业", "market", "business"])) {
    return "方向负责人/调研同学";
  }
  return "全组快速了解";
}

function inferKnowledgePriority(item, category, text) {
  const score = item.impactScore || 0;
  if (score >= 85) return "高";
  if (category === "paper" && hasAny(text, ["benchmark", "dataset", "sota", "code", "github", "基准", "数据集", "代码"])) {
    return "高";
  }
  if (hasAny(text, ["openai", "anthropic", "google", "deepmind", "nvidia", "microsoft", "api", "sdk", "发布", "上线"])) {
    return "高";
  }
  if (score >= 60 || category === "paper" || category === "ai-models" || category === "ai-products") return "中";
  return "低";
}

function inferMeetingValue(priority, category, text) {
  if (priority === "高") return "高";
  if (category === "paper" || hasAny(text, ["benchmark", "eval", "dataset", "agent", "智能体", "基准", "评测", "数据集"])) {
    return "中";
  }
  if (category === "industry" || category === "tip") return "中";
  return "低";
}
