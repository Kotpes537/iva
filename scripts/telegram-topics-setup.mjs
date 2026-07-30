#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const token = process.env.TELEGRAM_BOT_TOKEN;
const base = (process.env.TELEGRAM_BOT_API_URL || "https://api.telegram.org").replace(/\/$/, "");
const dataDir = process.env.ASSISTANT_DATA_DIR || join(process.cwd(), "data");
const topicsFile = join(dataDir, "telegram-topics.json");
const names = ["Документы", "Встречи", "Напоминания", "Память"];
const introductions = {
  Документы: "Документы готовы. Отправляйте сюда файлы и вопросы по их содержанию.",
  Встречи: "Встречи готовы. Отправляйте сюда аудио для транскрипции и подготовки протокола.",
  Напоминания: "Напоминания готовы. Созданные здесь напоминания вернутся в эту тему.",
  Память: "Память готова. Здесь удобно спрашивать, что сохранено, и добавлять важные факты.",
};
const chatId = String(process.env.TELEGRAM_ALLOWED_USER_IDS || "").split(/[\s,]+/u).find(Boolean);

if (!token) throw new Error("TELEGRAM_BOT_TOKEN is missing");
if (!chatId) throw new Error("TELEGRAM_ALLOWED_USER_IDS is missing");

async function tg(method, payload = {}) {
  const response = await fetch(`${base}/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000),
  });
  const body = await response.json().catch(() => ({}));
  return { ...body, httpStatus: response.status };
}

async function load() {
  try {
    const parsed = JSON.parse(await readFile(topicsFile, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : { version: 1, chats: {} };
  } catch {
    return { version: 1, chats: {} };
  }
}

async function save(value) {
  await mkdir(dirname(topicsFile), { recursive: true });
  await writeFile(topicsFile, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

const all = await load();
all.chats ??= {};
all.announced ??= {};
const known = all.chats[chatId] && typeof all.chats[chatId] === "object" ? all.chats[chatId] : {};
const announced =
  all.announced[chatId] && typeof all.announced[chatId] === "object" ? all.announced[chatId] : {};
all.chats[chatId] = known;
all.announced[chatId] = announced;

for (const name of names) {
  if (Number.isSafeInteger(Number(known[name])) && Number(known[name]) > 0) continue;
  const created = await tg("createForumTopic", { chat_id: Number(chatId), name });
  if (!created.ok) {
    console.error(JSON.stringify({ ok: false, name, status: created.httpStatus, error: created.description }));
    process.exit(1);
  }
  known[name] = created.result.message_thread_id;
  await save(all);
}

for (const name of names) {
  if (announced[name] === true) continue;
  const sent = await tg("sendMessage", {
    chat_id: Number(chatId),
    message_thread_id: Number(known[name]),
    text: introductions[name],
    disable_notification: true,
  });
  if (!sent.ok) {
    console.error(JSON.stringify({ ok: false, name, status: sent.httpStatus, error: sent.description }));
    process.exit(1);
  }
  announced[name] = true;
  await save(all);
}

await tg("sendMessage", {
  chat_id: Number(chatId),
  text: `Темы Iva готовы:\n${names.map((name) => `• ${name}`).join("\n")}`,
  disable_notification: true,
});

console.log(JSON.stringify({ ok: true, api_base: base, topics: known }, null, 2));
