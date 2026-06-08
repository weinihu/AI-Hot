import { clamp } from "./formatter.js";

export async function sendFeishu(env, content, card) {
  if (!env.FEISHU_WEBHOOK) {
    throw new Error("FEISHU_WEBHOOK is not configured.");
  }

  const payload = {
    msg_type: "interactive",
    card: card || {
      config: { wide_screen_mode: true },
      header: {
        template: "turquoise",
        title: { tag: "plain_text", content: "AI HOT 原站日报" },
      },
      elements: [{ tag: "markdown", content: clamp(content, 7800) }],
    },
  };

  if (env.FEISHU_SECRET) {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    payload.timestamp = timestamp;
    payload.sign = await signFeishu(timestamp, env.FEISHU_SECRET);
  }

  const response = await fetch(env.FEISHU_WEBHOOK, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  if (!response.ok || !isFeishuSuccess(text)) {
    throw new Error(`Feishu push failed: ${response.status} ${text.slice(0, 300)}`);
  }
}

export async function getFeishuTenantAccessToken(env) {
  const response = await fetch(
    "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        app_id: env.FEISHU_APP_ID,
        app_secret: env.FEISHU_APP_SECRET,
      }),
    },
  );
  const data = await response.json();
  if (!response.ok || data.code !== 0) {
    throw new Error(`Feishu tenant token failed: ${data.msg || response.status}`);
  }
  return data.tenant_access_token;
}

async function signFeishu(timestamp, secret) {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(`${timestamp}\n${secret}`);
  const key = await crypto.subtle.importKey("raw", keyData, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const signature = await crypto.subtle.sign("HMAC", key, new Uint8Array());
  return base64Encode(new Uint8Array(signature));
}

function base64Encode(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function isFeishuSuccess(text) {
  return /"StatusCode"\s*:\s*0|"code"\s*:\s*0|success|ok/i.test(text);
}
