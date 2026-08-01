#!/usr/bin/env node
// Daily, low-noise task-only alerts. Chat activity is intentionally excluded.
// Free-form due labels stay visible in the digest but are never guessed as dates.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const DATA_DIR = resolve(process.env.ASSISTANT_DATA_DIR ?? join(ROOT, "data"));
const TASKS_FILE = join(DATA_DIR, "tasks.json");
const STATE_FILE = join(DATA_DIR, "tasks-overdue-alert.json");
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT = process.env.TELEGRAM_DIGEST_CHAT_ID || (process.env.TELEGRAM_ALLOWED_USER_IDS || "").split(/[\s,]+/).find(Boolean);
const TZ = process.env.ASSISTANT_TIMEZONE || "Europe/Moscow";

function load(file, fallback) { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return fallback; } }
function saveAtomic(file, value) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + ".tmp-" + process.pid;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, file);
}
function dayKey(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}
function exactDue(task) {
  const raw = String(task?.dueAt ?? "").trim();
  if (!raw || !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw)) return null;
  const due = new Date(raw);
  return Number.isNaN(due.getTime()) ? null : due;
}
function lateLabel(due) {
  const days = Math.max(0, Math.floor((Date.now() - due.getTime()) / 86_400_000));
  return days === 0 ? "сегодня" : days + " дн.";
}
function localDayNumber(date) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const value = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return Math.floor(Date.UTC(Number(value.year), Number(value.month) - 1, Number(value.day)) / 86_400_000);
}
function startReminderDays(task) {
  if (task?.priority !== "high") return [];
  if (!Array.isArray(task?.startAlertDays)) return [7, 3, 1];
  return task.startAlertDays.filter((days) => Number.isInteger(days) && days >= 0 && days <= 30);
}
function keyFor(task, date, suffix = "") { return String(task.id) + ":" + date.toISOString() + suffix; }
async function send(text) {
  const response = await fetch("https://api.telegram.org/bot" + TOKEN + "/sendMessage", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT, text, link_preview_options: { is_disabled: true } }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.ok) throw new Error(body.description || "Telegram HTTP " + response.status);
}
async function main() {
  if (!TOKEN || !CHAT) throw new Error("Telegram digest destination is not configured");
  const now = new Date();
  const today = dayKey(now);
  const tasks = load(TASKS_FILE, []);
  const state = load(STATE_FILE, { alertedOn: {}, deadline48h: {}, startAlerts: {} });
  state.alertedOn ||= {}; state.deadline48h ||= {}; state.startAlerts ||= {};
  const open = tasks.filter((task) => !task.done);
  const overdue = open.map((task) => ({ task, due: exactDue(task) })).filter(({ due }) => due && due.getTime() <= now.getTime()).sort((a, b) => a.due.getTime() - b.due.getTime());
  const unsent = overdue.filter(({ task }) => state.alertedOn[String(task.id)] !== today);
  const upcoming = open.map((task) => ({ task, due: exactDue(task) })).filter(({ due }) => due && due.getTime() > now.getTime() && due.getTime() - now.getTime() <= 48 * 3_600_000).filter(({ task, due }) => !state.deadline48h[keyFor(task, due)]).sort((a, b) => a.due.getTime() - b.due.getTime());
  const starts = open.map((task) => ({ task, start: exactDue({ dueAt: task.startAt }) })).filter(({ task, start }) => start && start.getTime() >= now.getTime() && startReminderDays(task).includes(localDayNumber(start) - localDayNumber(now))).filter(({ task, start }) => !state.startAlerts[keyFor(task, start, ":" + (localDayNumber(start) - localDayNumber(now)))]).sort((a, b) => a.start.getTime() - b.start.getTime());
  if (!unsent.length && !upcoming.length && !starts.length) { console.log("task-alerts: no new alerts"); return; }
  const sections = [];
  if (unsent.length) sections.push("Просрочено\n" + unsent.slice(0, 10).map(({ task, due }) => "• [" + task.id + "] " + String(task.text).slice(0, 250) + " — просрочено: " + lateLabel(due)).join("\n"));
  if (upcoming.length) sections.push("Дедлайн в ближайшие 48 часов\n" + upcoming.slice(0, 10).map(({ task }) => "• [" + task.id + "] " + String(task.text).slice(0, 250)).join("\n"));
  if (starts.length) sections.push("Старт важных механик\n" + starts.slice(0, 10).map(({ task, start }) => "• [" + task.id + "] " + String(task.text).slice(0, 250) + " — старт через " + (localDayNumber(start) - localDayNumber(now)) + " дн.").join("\n"));
  await send("Задачи: сроки и старты\n\n" + sections.join("\n\n") + "\n\nОтметь выполненные или перенеси срок.");
  for (const { task } of unsent) state.alertedOn[String(task.id)] = today;
  for (const { task, due } of upcoming) state.deadline48h[keyFor(task, due)] = today;
  for (const { task, start } of starts) state.startAlerts[keyFor(task, start, ":" + (localDayNumber(start) - localDayNumber(now)))] = today;
  saveAtomic(STATE_FILE, state);
  console.log("task-alerts: overdue=" + unsent.length + " deadline48h=" + upcoming.length + " starts=" + starts.length);
}
main().catch((error) => { console.error("task-alerts: " + error.message); process.exit(1); });
