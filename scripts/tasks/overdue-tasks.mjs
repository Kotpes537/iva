#!/usr/bin/env node
// Daily, low-noise alert for tasks that have an exact ISO dueAt timestamp.
// Free-form due labels stay visible in the digest but are never guessed as overdue.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const DATA_DIR = resolve(process.env.ASSISTANT_DATA_DIR ?? join(ROOT, "data"));
const TASKS_FILE = join(DATA_DIR, "tasks.json");
const STATE_FILE = join(DATA_DIR, "tasks-overdue-alert.json");
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT = process.env.TELEGRAM_DIGEST_CHAT_ID || (process.env.TELEGRAM_ALLOWED_USER_IDS || "").split(/[\s,]+/).find(Boolean);
const TZ = process.env.ASSISTANT_TIMEZONE || "Europe/Moscow";

function load(file, fallback) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return fallback; }
}

function saveAtomic(file, value) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

function dayKey(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(date);
}

function exactDue(task) {
  const raw = String(task?.dueAt ?? "").trim();
  if (!raw || !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw)) return null;
  const due = new Date(raw);
  return Number.isNaN(due.getTime()) ? null : due;
}

function lateLabel(due) {
  const days = Math.max(0, Math.floor((Date.now() - due.getTime()) / 86_400_000));
  return days === 0 ? "сегодня" : `${days} дн.`;
}

async function send(text) {
  const response = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT, text, link_preview_options: { is_disabled: true } }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.ok) throw new Error(body.description || `Telegram HTTP ${response.status}`);
}

async function main() {
  if (!TOKEN || !CHAT) throw new Error("Telegram digest destination is not configured");
  const now = new Date();
  const today = dayKey(now);
  const tasks = load(TASKS_FILE, []);
  const state = load(STATE_FILE, { alertedOn: {} });
  const overdue = tasks
    .filter((task) => !task.done)
    .map((task) => ({ task, due: exactDue(task) }))
    .filter(({ due }) => due && due.getTime() <= now.getTime())
    .sort((a, b) => a.due.getTime() - b.due.getTime());
  const unsent = overdue.filter(({ task }) => state.alertedOn?.[String(task.id)] !== today);
  if (!unsent.length) {
    console.log("overdue-tasks: no new alerts");
    return;
  }
  const shown = unsent.slice(0, 10);
  const lines = shown.map(({ task, due }) => `• [${task.id}] ${String(task.text).slice(0, 250)} — просрочено: ${lateLabel(due)}`);
  if (unsent.length > shown.length) lines.push(`• Ещё ${unsent.length - shown.length} просроченных задач`);
  await send(`⚠️ Просроченные задачи\n\n${lines.join("\n")}\n\nОтметь выполненные или перенеси срок.`);
  state.alertedOn = state.alertedOn || {};
  for (const { task } of unsent) state.alertedOn[String(task.id)] = today;
  saveAtomic(STATE_FILE, state);
  console.log(`overdue-tasks: alerted ${unsent.length}`);
}

main().catch((error) => {
  console.error(`overdue-tasks: ${error.message}`);
  process.exit(1);
});
