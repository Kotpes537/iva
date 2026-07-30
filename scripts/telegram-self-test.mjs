#!/usr/bin/env node

const token = process.env.TELEGRAM_BOT_TOKEN;
const base = (process.env.TELEGRAM_BOT_API_URL || "https://api.telegram.org").replace(/\/$/, "");
const allowed = String(process.env.TELEGRAM_ALLOWED_USER_IDS || "")
  .split(/[\s,]+/u)
  .map((value) => Number(value))
  .filter((value) => Number.isSafeInteger(value) && value > 0);
const explicitChat = Number(process.env.TELEGRAM_SELF_TEST_CHAT_ID || "");
const chatId = Number.isSafeInteger(explicitChat) && explicitChat > 0 ? explicitChat : allowed[0];
const mode = process.argv[2] || "all";

if (!token) throw new Error("TELEGRAM_BOT_TOKEN is missing");
if (!chatId) throw new Error("Set TELEGRAM_SELF_TEST_CHAT_ID or TELEGRAM_ALLOWED_USER_IDS");
if (!new Set(["draft", "rich", "all"]).has(mode)) {
  throw new Error("Usage: telegram-self-test.mjs [draft|rich|all]");
}

async function call(method, payload) {
  const response = await fetch(`${base}/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000),
  });
  const body = await response.json().catch(() => ({}));
  return {
    method,
    ok: response.ok && body.ok === true,
    status: response.status,
    description: body.description,
  };
}

const results = [];
if (mode === "draft" || mode === "all") {
  results.push(
    await call("sendMessageDraft", {
      chat_id: chatId,
      draft_id: Math.max(1, Date.now() % 2147483647),
      text: "Проверка потокового ответа Iva...",
    }),
  );
}
if (mode === "rich" || mode === "all") {
  results.push(
    await call("sendRichMessage", {
      chat_id: chatId,
      disable_notification: true,
      rich_message: {
        markdown: "# Iva обновлена\n\n- Rich Messages: **работают**\n- Потоковые ответы: проверены отдельно",
      },
    }),
  );
}

console.log(JSON.stringify({ api_base: base, results }, null, 2));
if (results.some((result) => !result.ok)) process.exitCode = 1;
