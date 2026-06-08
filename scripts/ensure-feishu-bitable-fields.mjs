import { buildBitableFieldDefinitions } from "../src/index.js";

const requiredEnv = [
  "FEISHU_APP_ID",
  "FEISHU_APP_SECRET",
  "FEISHU_BITABLE_APP_TOKEN",
  "FEISHU_BITABLE_TABLE_ID",
];

for (const name of requiredEnv) {
  if (!process.env[name]) {
    throw new Error(`${name} is missing`);
  }
}

const appToken = process.env.FEISHU_BITABLE_APP_TOKEN;
const tableId = process.env.FEISHU_BITABLE_TABLE_ID;

const tenantToken = await getTenantAccessToken();
const existingNames = await listFieldNames(tenantToken);
const existing = new Set(existingNames);
const missing = buildBitableFieldDefinitions().filter((field) => !existing.has(field.field_name));

let created = 0;
for (const field of missing) {
  const result = await createField(tenantToken, field);
  if (result.created) created += 1;
}

console.log(
  JSON.stringify(
    {
      ok: true,
      existing: existingNames.length,
      missing: missing.length,
      created,
    },
    null,
    2,
  ),
);

async function getTenantAccessToken() {
  const response = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      app_id: process.env.FEISHU_APP_ID,
      app_secret: process.env.FEISHU_APP_SECRET,
    }),
  });
  const data = await response.json();
  if (!response.ok || data.code !== 0) {
    throw new Error(`tenant_access_token failed: ${data.msg || response.status}`);
  }
  return data.tenant_access_token;
}

async function listFieldNames(tenantToken) {
  const names = [];
  let pageToken = "";

  do {
    const url = new URL(
      `https://open.feishu.cn/open-apis/bitable/v1/apps/${encodeURIComponent(
        appToken,
      )}/tables/${encodeURIComponent(tableId)}/fields`,
    );
    url.searchParams.set("page_size", "100");
    if (pageToken) url.searchParams.set("page_token", pageToken);

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${tenantToken}`,
        "Content-Type": "application/json",
      },
    });
    const data = await response.json();
    if (!response.ok || data.code !== 0) {
      throw new Error(`list fields failed: ${data.msg || response.status}`);
    }

    for (const item of data.data?.items || []) {
      if (item.field_name) names.push(item.field_name);
    }
    pageToken = data.data?.has_more ? data.data?.page_token || data.data?.next_page_token || "" : "";
  } while (pageToken);

  return names;
}

async function createField(tenantToken, field) {
  const url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${encodeURIComponent(
    appToken,
  )}/tables/${encodeURIComponent(tableId)}/fields`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${tenantToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(field),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.code !== 0) {
    const message = data.msg || data.message || "";
    if (/FieldNameDuplicated|field name.*exist|already exists/i.test(message)) {
      return { created: false };
    }
    throw new Error(`create field ${field.field_name} failed: ${message || response.status}`);
  }
  return { created: true };
}
