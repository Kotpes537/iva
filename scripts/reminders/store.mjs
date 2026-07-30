import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Cron } from "croner";

const DATA_DIR = resolve(process.env.ASSISTANT_DATA_DIR ?? "data");
const DB_FILE = join(DATA_DIR, "reminders", "reminders.sqlite");
const DEFAULT_TIMEZONE = process.env.ASSISTANT_TIMEZONE || "Europe/Moscow";

const RECURRENCES = new Set([
  "none",
  "daily",
  "weekdays",
  "weekly",
  "monthly",
  "yearly",
  "interval",
  "custom",
]);

function nowIso() {
  return new Date().toISOString();
}

function allowedUsers() {
  return (process.env.TELEGRAM_ALLOWED_USER_IDS ?? "")
    .split(/[,\s]+/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function normalizeThreadId(value) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function defaultTarget(overrides = {}) {
  const users = allowedUsers();
  const userId = overrides.userId || users[0];
  const chatId = overrides.chatId || process.env.TELEGRAM_DIGEST_CHAT_ID || userId;
  if (!userId || !chatId) {
    throw new Error("Не настроены TELEGRAM_ALLOWED_USER_IDS/TELEGRAM_DIGEST_CHAT_ID");
  }
  return {
    userId: String(userId),
    chatId: String(chatId),
    messageThreadId: normalizeThreadId(overrides.messageThreadId),
  };
}

function validateTimezone(timezone) {
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format(new Date());
    return timezone;
  } catch {
    throw new Error(`Некорректный часовой пояс: ${timezone}`);
  }
}

function openDb() {
  mkdirSync(dirname(DB_FILE), { recursive: true });
  const db = new DatabaseSync(DB_FILE);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      message_thread_id INTEGER,
      text TEXT NOT NULL,
      timezone TEXT NOT NULL,
      next_at TEXT,
      recurrence TEXT NOT NULL DEFAULT 'none',
      cron_expression TEXT,
      interval_minutes INTEGER,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_sent_at TEXT,
      send_count INTEGER NOT NULL DEFAULT 0,
      fail_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT
    );
    CREATE INDEX IF NOT EXISTS reminders_due_idx ON reminders(status, next_at);
    CREATE INDEX IF NOT EXISTS reminders_user_idx ON reminders(user_id, status);
  `);
  const columns = new Set(db.prepare("PRAGMA table_info(reminders)").all().map((row) => row.name));
  if (!columns.has("message_thread_id")) {
    db.exec("ALTER TABLE reminders ADD COLUMN message_thread_id INTEGER");
  }
  return db;
}

function parseScheduledAt(value, timezone) {
  if (!value || typeof value !== "string") throw new Error("Нужны точные дата и время scheduledAt");
  const trimmed = value.trim();
  if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(trimmed)) {
    const date = new Date(trimmed);
    if (!Number.isNaN(date.getTime())) return date;
  }

  let cron;
  try {
    cron = new Cron(trimmed, { timezone, paused: true });
    const date = cron.nextRun(new Date(Date.now() - 1000));
    cron.stop();
    if (date) return date;
  } catch {
    // Fall through to the user-facing error below.
  }
  throw new Error("scheduledAt должен быть ISO-датой с часовым поясом, например 2026-07-18T18:30:00+03:00");
}

function localParts(date, timezone) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    weekday: "short",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    weekday: String(parts.weekday).slice(0, 3).toUpperCase(),
  };
}

function cronNext(expression, timezone, after = new Date()) {
  let cron;
  try {
    cron = new Cron(expression, { timezone, paused: true });
    const next = cron.nextRun(after);
    cron.stop();
    return next;
  } catch (error) {
    try {
      cron?.stop();
    } catch {
      // No-op.
    }
    throw new Error(`Некорректное cron-расписание: ${error.message}`);
  }
}

function recurrenceCron(recurrence, firstDate, timezone, customCron) {
  if (recurrence === "none" || recurrence === "interval") return null;
  if (recurrence === "custom") {
    if (!customCron?.trim()) throw new Error("Для recurrence=custom нужен cron");
    const expression = customCron.trim();
    if (!cronNext(expression, timezone, new Date())) throw new Error("Cron-расписание не имеет будущих запусков");
    return expression;
  }

  const p = localParts(firstDate, timezone);
  const weekday = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 }[p.weekday];
  if (recurrence === "daily") return `${p.minute} ${p.hour} * * *`;
  if (recurrence === "weekdays") return `${p.minute} ${p.hour} * * 1-5`;
  if (recurrence === "weekly") return `${p.minute} ${p.hour} * * ${weekday}`;
  if (recurrence === "monthly") return `${p.minute} ${p.hour} ${p.day} * *`;
  if (recurrence === "yearly") return `${p.minute} ${p.hour} ${p.day} ${p.month} *`;
  throw new Error(`Неизвестный тип повтора: ${recurrence}`);
}

function formatLocal(iso, timezone = DEFAULT_TIMEZONE) {
  if (!iso) return null;
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: timezone,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(iso));
}

function recurrenceLabel(reminder) {
  const labels = {
    none: "однократно",
    daily: "каждый день",
    weekdays: "по будням",
    weekly: "каждую неделю",
    monthly: "каждый месяц",
    yearly: "каждый год",
    interval: `каждые ${reminder.interval_minutes} мин.`,
    custom: `по расписанию ${reminder.cron_expression}`,
  };
  return labels[reminder.recurrence] ?? reminder.recurrence;
}

function present(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    chatId: String(row.chat_id),
    messageThreadId: normalizeThreadId(row.message_thread_id),
    text: row.text,
    nextAt: row.next_at,
    localTime: formatLocal(row.next_at, row.timezone),
    timezone: row.timezone,
    recurrence: row.recurrence,
    recurrenceLabel: recurrenceLabel(row),
    cron: row.cron_expression,
    intervalMinutes: row.interval_minutes,
    status: row.status,
    sendCount: Number(row.send_count),
    lastSentAt: row.last_sent_at,
    failCount: Number(row.fail_count),
  };
}

export function addReminder({
  text,
  scheduledAt,
  recurrence = "none",
  cron,
  intervalMinutes,
  timezone = DEFAULT_TIMEZONE,
  chatId,
  userId,
  messageThreadId,
}) {
  const cleanText = String(text ?? "").trim();
  if (!cleanText) throw new Error("Текст напоминания пуст");
  if (cleanText.length > 3000) throw new Error("Текст напоминания длиннее 3000 символов");
  if (!RECURRENCES.has(recurrence)) throw new Error(`Неизвестный тип повтора: ${recurrence}`);
  timezone = validateTimezone(timezone);

  const target = defaultTarget({ chatId, userId, messageThreadId });
  const now = new Date();
  let firstDate;
  let expression = null;
  let interval = null;

  if (recurrence === "custom") {
    expression = recurrenceCron(recurrence, now, timezone, cron);
    firstDate = cronNext(expression, timezone, now);
  } else {
    firstDate = parseScheduledAt(scheduledAt, timezone);
    if (recurrence === "interval") {
      interval = Number(intervalMinutes);
      if (!Number.isInteger(interval) || interval < 1 || interval > 525600) {
        throw new Error("intervalMinutes должен быть целым числом от 1 до 525600");
      }
    } else {
      expression = recurrenceCron(recurrence, firstDate, timezone, cron);
    }

    if (firstDate.getTime() <= now.getTime()) {
      if (recurrence === "none") throw new Error("Время напоминания уже прошло");
      if (recurrence === "interval") firstDate = new Date(now.getTime() + interval * 60000);
      else firstDate = cronNext(expression, timezone, now);
    }
  }

  if (!firstDate) throw new Error("Не удалось вычислить следующее время напоминания");
  const createdAt = nowIso();
  const db = openDb();
  try {
    const result = db
      .prepare(
        `INSERT INTO reminders
          (chat_id,user_id,message_thread_id,text,timezone,next_at,recurrence,cron_expression,interval_minutes,status,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?, 'active', ?,?)`,
      )
      .run(
        target.chatId,
        target.userId,
        target.messageThreadId,
        cleanText,
        timezone,
        firstDate.toISOString(),
        recurrence,
        expression,
        interval,
        createdAt,
        createdAt,
      );
    return present(db.prepare("SELECT * FROM reminders WHERE id = ?").get(result.lastInsertRowid));
  } finally {
    db.close();
  }
}

export function listReminders({ includeInactive = false, limit = 50, userId: requestedUserId } = {}) {
  const { userId } = defaultTarget({ userId: requestedUserId });
  const db = openDb();
  try {
    const rows = includeInactive
      ? db
          .prepare("SELECT * FROM reminders WHERE user_id = ? ORDER BY id DESC LIMIT ?")
          .all(userId, Math.min(Math.max(Number(limit) || 50, 1), 200))
      : db
          .prepare(
            "SELECT * FROM reminders WHERE user_id = ? AND status = 'active' ORDER BY next_at ASC LIMIT ?",
          )
          .all(userId, Math.min(Math.max(Number(limit) || 50, 1), 200));
    return rows.map(present);
  } finally {
    db.close();
  }
}

export function getReminder(id) {
  const db = openDb();
  try {
    return db.prepare("SELECT * FROM reminders WHERE id = ?").get(Number(id)) ?? null;
  } finally {
    db.close();
  }
}

function trustedReminder(db, id, expectedUserId) {
  const row = db.prepare("SELECT * FROM reminders WHERE id = ?").get(Number(id));
  if (!row) throw new Error(`Напоминание ${id} не найдено`);
  if (expectedUserId && String(row.user_id) !== String(expectedUserId)) throw new Error("Нет доступа к напоминанию");
  return row;
}

export function cancelReminder(id, expectedUserId) {
  const db = openDb();
  try {
    const row = trustedReminder(db, id, expectedUserId);
    db.prepare("UPDATE reminders SET status='cancelled', next_at=NULL, updated_at=? WHERE id=?").run(nowIso(), row.id);
    return present(db.prepare("SELECT * FROM reminders WHERE id=?").get(row.id));
  } finally {
    db.close();
  }
}

export function snoozeReminder(id, minutes, expectedUserId) {
  const delay = Number(minutes);
  if (!Number.isInteger(delay) || delay < 1 || delay > 525600) throw new Error("Некорректное время переноса");
  const db = openDb();
  try {
    const row = trustedReminder(db, id, expectedUserId);
    const nextAt = new Date(Date.now() + delay * 60000).toISOString();
    db.prepare(
      "UPDATE reminders SET status='active', next_at=?, fail_count=0, last_error=NULL, updated_at=? WHERE id=?",
    ).run(nextAt, nowIso(), row.id);
    return present(db.prepare("SELECT * FROM reminders WHERE id=?").get(row.id));
  } finally {
    db.close();
  }
}

export function completeReminder(id, expectedUserId) {
  const db = openDb();
  try {
    const row = trustedReminder(db, id, expectedUserId);
    if (row.recurrence === "none") {
      db.prepare("UPDATE reminders SET status='completed', next_at=NULL, updated_at=? WHERE id=?").run(nowIso(), row.id);
    } else {
      db.prepare("UPDATE reminders SET updated_at=? WHERE id=?").run(nowIso(), row.id);
    }
    return present(db.prepare("SELECT * FROM reminders WHERE id=?").get(row.id));
  } finally {
    db.close();
  }
}

export function dueReminders(limit = 25) {
  const db = openDb();
  try {
    return db
      .prepare(
        "SELECT * FROM reminders WHERE status='active' AND next_at IS NOT NULL AND next_at <= ? ORDER BY next_at ASC LIMIT ?",
      )
      .all(nowIso(), Math.min(Math.max(Number(limit) || 25, 1), 100));
  } finally {
    db.close();
  }
}

export function markDelivered(id, telegramMessageId) {
  const db = openDb();
  try {
    const row = trustedReminder(db, id);
    const sentAt = nowIso();
    if (row.recurrence === "none") {
      db.prepare(
        `UPDATE reminders SET status='sent', next_at=NULL, last_sent_at=?, send_count=send_count+1,
         fail_count=0, last_error=NULL, updated_at=? WHERE id=?`,
      ).run(sentAt, sentAt, row.id);
    } else {
      const after = new Date(Math.max(Date.now(), new Date(row.next_at).getTime()) + 1000);
      const next =
        row.recurrence === "interval"
          ? new Date(after.getTime() + Number(row.interval_minutes) * 60000)
          : cronNext(row.cron_expression, row.timezone, after);
      if (!next) throw new Error("У повторяющегося напоминания нет следующего запуска");
      db.prepare(
        `UPDATE reminders SET status='active', next_at=?, last_sent_at=?, send_count=send_count+1,
         fail_count=0, last_error=NULL, updated_at=? WHERE id=?`,
      ).run(next.toISOString(), sentAt, sentAt, row.id);
    }
    return { ...present(db.prepare("SELECT * FROM reminders WHERE id=?").get(row.id)), telegramMessageId };
  } finally {
    db.close();
  }
}

export function markDeliveryFailed(id, error) {
  const db = openDb();
  try {
    const row = trustedReminder(db, id);
    const failures = Number(row.fail_count) + 1;
    const paused = failures >= 10;
    const retryMinutes = Math.min(2 ** Math.min(failures, 6), 60);
    const nextAt = paused ? null : new Date(Date.now() + retryMinutes * 60000).toISOString();
    db.prepare(
      "UPDATE reminders SET status=?, next_at=?, fail_count=?, last_error=?, updated_at=? WHERE id=?",
    ).run(paused ? "paused" : "active", nextAt, failures, String(error).slice(0, 500), nowIso(), row.id);
    return present(db.prepare("SELECT * FROM reminders WHERE id=?").get(row.id));
  } finally {
    db.close();
  }
}

export function reminderStats() {
  const db = openDb();
  try {
    const counts = db
      .prepare("SELECT status, COUNT(*) AS count FROM reminders GROUP BY status ORDER BY status")
      .all();
    return { database: DB_FILE, counts };
  } finally {
    db.close();
  }
}

export { DEFAULT_TIMEZONE, DB_FILE, formatLocal, recurrenceLabel };
