#!/usr/bin/env node
import {
  dueReminders,
  markDelivered,
  markDeliveryFailed,
  recurrenceLabel,
  reminderStats,
} from "./store.mjs";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ALLOWED = new Set(
  (process.env.TELEGRAM_ALLOWED_USER_IDS ?? "")
    .split(/[,\s]+/)
    .map((value) => value.trim())
    .filter(Boolean),
);
const API_BASE = (process.env.TELEGRAM_BOT_API_URL || "https://api.telegram.org").replace(/\/$/, "");
const API = `${API_BASE}/bot${TOKEN}`;

async function telegram(method, body) {
  const response = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok) throw new Error(result.description || `Telegram HTTP ${response.status}`);
  return result.result;
}

function keyboard(reminder) {
  const rows = [
    [
      { text: "✅ Готово", callback_data: `rem:done:${reminder.id}`, style: "success" },
      { text: "⏰ Через час", callback_data: `rem:snooze:60:${reminder.id}`, style: "primary" },
      { text: "🌅 Завтра", callback_data: `rem:snooze:1440:${reminder.id}`, style: "primary" },
    ],
  ];
  if (reminder.recurrence !== "none") {
    rows.push([
      { text: "🛑 Остановить повторы", callback_data: `rem:cancel:${reminder.id}`, style: "danger" },
    ]);
  }
  return { inline_keyboard: rows };
}

function messagePayload(reminder) {
  const due = new Date(reminder.next_at);
  const overdueMinutes = Math.max(0, Math.floor((Date.now() - due.getTime()) / 60000));
  const overdue = overdueMinutes >= 5 ? `\n\nЗадержка доставки: ${overdueMinutes} мин.` : "";
  const repeat = reminder.recurrence === "none" ? "" : `\nПовтор: ${recurrenceLabel(reminder)}`;
  const fallbackDate = new Intl.DateTimeFormat("ru-RU", {
    timeZone: reminder.timezone,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(due);
  const beforeDate = `⏰ Напоминание\n\n${String(reminder.text).slice(0, 3400)}\n\nКогда: `;
  const text = `${beforeDate}${fallbackDate}${repeat}${overdue}`;
  return {
    text,
    entities: [
      {
        type: "date_time",
        offset: beforeDate.length,
        length: fallbackDate.length,
        unix_time: Math.floor(due.getTime() / 1000),
        date_time_format: "wDt",
      },
    ],
  };
}

async function main() {
  if (!TOKEN) throw new Error("TELEGRAM_BOT_TOKEN не настроен");
  if (ALLOWED.size === 0) throw new Error("TELEGRAM_ALLOWED_USER_IDS пуст");

  if (process.argv.includes("--status")) {
    console.log(JSON.stringify(reminderStats()));
    return;
  }

  const due = dueReminders(25);
  if (due.length === 0) return;

  let sent = 0;
  let failed = 0;
  for (const reminder of due) {
    if (!ALLOWED.has(String(reminder.user_id))) {
      markDeliveryFailed(reminder.id, "Получатель отсутствует в TELEGRAM_ALLOWED_USER_IDS");
      failed++;
      continue;
    }
    try {
      const payload = messagePayload(reminder);
      const message = await telegram("sendMessage", {
        chat_id: reminder.chat_id,
        ...payload,
        ...(reminder.message_thread_id ? { message_thread_id: Number(reminder.message_thread_id) } : {}),
        reply_markup: keyboard(reminder),
        link_preview_options: { is_disabled: true },
      });
      markDelivered(reminder.id, message.message_id);
      sent++;
      console.log(`reminder ${reminder.id}: sent`);
    } catch (error) {
      markDeliveryFailed(reminder.id, error?.message ?? error);
      failed++;
      console.error(`reminder ${reminder.id}: ${error?.message ?? error}`);
    }
  }
  console.log(`reminders: ${sent} sent, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error("reminders-dispatch fatal:", error);
  process.exit(1);
});
