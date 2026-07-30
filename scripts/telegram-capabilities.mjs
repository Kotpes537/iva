#!/usr/bin/env node

const token = process.env.TELEGRAM_BOT_TOKEN;
const base = (process.env.TELEGRAM_BOT_API_URL || "https://api.telegram.org").replace(/\/$/, "");

if (!token) throw new Error("TELEGRAM_BOT_TOKEN is missing");

const response = await fetch(`${base}/bot${token}/getMe`, { signal: AbortSignal.timeout(15000) });
const body = await response.json();
if (!response.ok || !body.ok) throw new Error(body.description || `Telegram HTTP ${response.status}`);

const bot = body.result;
console.log(
  JSON.stringify(
    {
      username: bot.username,
      has_topics_enabled: bot.has_topics_enabled === true,
      allows_users_to_create_topics: bot.allows_users_to_create_topics === true,
      supports_guest_queries: bot.supports_guest_queries === true,
      can_manage_bots: bot.can_manage_bots === true,
      api_base: base,
    },
    null,
    2,
  ),
);
