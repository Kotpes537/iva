// Out-of-band Telegram operations which stay responsive while Eve is busy.
// These commands do not call the model and do not create new Eve topics.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { execFile } from "node:child_process";
import { join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { TELEGRAM_SYNC_CHATS } from "../telegram-sync-config.mjs";
import { loadQueueFile, clearQueueFileKey, queueCount } from "./telegram-queue.mjs";
import { chatKeyOf, listChatStatuses } from "./run-status.mjs";
import { listReminders } from "../reminders/store.mjs";

const execFileAsync = promisify(execFile);
const MAX_REPLY = 3800;

function textOf(value) {
  return String(value ?? "").trim();
}

function localDate(timezone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone || "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function safeRead(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function walkFiles(root, result = []) {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return result;
  }
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === ".trash" || entry.name.startsWith(".")) continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) walkFiles(path, result);
    else if (entry.isFile()) result.push(path);
  }
  return result;
}

function parseMemory(vault, timezone) {
  const date = localDate(timezone);
  const files = walkFiles(vault);
  return {
    date,
    core: safeRead(join(vault, "CORE.md")),
    daily: safeRead(join(vault, "daily", `${date}.md`)),
    files: files.length,
    cards: files.filter((file) => file.split(/[\\/]/).includes("cards")).length,
  };
}

function clip(value, limit = MAX_REPLY) {
  const text = textOf(value);
  return text.length <= limit ? text : `${text.slice(0, limit - 80)}\n…\n[обрезано; полный файл сохранён на сервере]`;
}

function run(command, args, timeout = 8000) {
  return execFileAsync(command, args, { timeout, maxBuffer: 64 * 1024 })
    .then(({ stdout, stderr }) => ({ ok: true, stdout: textOf(stdout), stderr: textOf(stderr) }))
    .catch((error) => ({ ok: false, stdout: textOf(error.stdout), stderr: textOf(error.stderr || error.message) }));
}

function syncRows() {
  return TELEGRAM_SYNC_CHATS.map(([id, name]) => `• ${name}: ${id}`).join("\n");
}

function formatReminder(row) {
  const when = row.localTime || row.next_at || "без даты";
  const repeat = row.recurrenceLabel && row.recurrence !== "none" ? ` · ${row.recurrenceLabel}` : "";
  return `• #${row.id} — ${row.text}\n  ${when}${repeat}`;
}

export function createTelegramOps({ dataDir, vault, allowed, reply, tr }) {
  const queueFile = join(dataDir, "telegram-queue.json");
  const timezone = process.env.ASSISTANT_TIMEZONE || "Europe/Moscow";

  async function health() {
    const [iva, poll, userbot, sync] = await Promise.all([
      run("systemctl", ["--user", "is-active", "iva.service"]),
      run("systemctl", ["--user", "is-active", "iva-telegram-poll.service"]),
      run("systemctl", ["--user", "is-active", "iva-telegram-userbot.service"]),
      run("systemctl", ["--user", "show", "iva-telegram-sync.service", "-p", "ActiveState", "-p", "SubState", "-p", "Result"]),
    ]);
    const queue = await loadQueueFile(queueFile).catch(() => ({ document: { queues: {} } }));
    const available = safeRead("/proc/meminfo")?.match(/^MemAvailable:\s+(\d+)\s+kB$/m)?.[1];
    const activeTurns = listChatStatuses().filter(({ status }) => status?.status === "running").length;
    return [
      tr("🩺 Iva health", "🩺 Состояние Iva"),
      `Iva: ${iva.stdout || "ошибка"}`,
      `Telegram poll: ${poll.stdout || "ошибка"}`,
      `Telegram userbot: ${userbot.stdout || "ошибка"}`,
      `Sync: ${sync.stdout.replaceAll("\n", "; ") || "нет данных"}`,
      `Очередь: ${queueCount(queue.document)} сообщений`,
      `Активных ходов: ${activeTurns}`,
      available ? `Доступная память: ${Math.round(Number(available) / 1024)} МБ` : "Память: нет данных",
      "Команды восстановления: /queue clear, /new, /restart",
    ].join("\n");
  }

  async function queue(update, args) {
    const loaded = await loadQueueFile(queueFile);
    const document = loaded.document;
    const key = chatKeyOf(update.message.chat.id, update.message.message_thread_id);
    if (args[0] === "clear") {
      const count = queueCount(document, key);
      await clearQueueFileKey(queueFile, key);
      return tr(`Queue cleared: ${count} message(s).`, `Очередь текущего чата очищена: ${count} сообщ.`);
    }
    const entries = Object.entries(document.queues).filter(([, items]) => items.length);
    if (!entries.length) return tr("Queue is empty.", "Очередь пуста.");
    const lines = entries.map(([chatKey, items]) => `• ${chatKey}: ${items.length}`);
    return [tr("📥 Durable queue", "📥 Надёжная очередь"), ...lines, "", tr("/queue clear clears only this chat.", "/queue clear очищает только текущий чат.")].join("\n");
  }

  async function sync(args) {
    if (args[0] === "status") {
      const status = await run("systemctl", ["--user", "status", "iva-telegram-sync.service", "--no-pager", "-l"], 10000);
      const log = await run("journalctl", ["--user", "-u", "iva-telegram-sync.service", "-n", "8", "--no-pager", "-l"], 10000);
      return clip(`${status.stdout || status.stderr}\n\n${log.stdout || log.stderr}`);
    }
    const started = await run("systemctl", ["--user", "start", "--no-block", "iva-telegram-sync.service"]);
    if (!started.ok) return tr(`Sync failed to start: ${started.stderr}`, `Не удалось запустить синхронизацию: ${started.stderr}`);
    return tr("🔄 Sync started. It reads only the five configured chats and reports the result when finished.", "🔄 Синхронизацию запустил. Она читает только пять настроенных чатов и сообщит результат после завершения.");
  }

  function chats() {
    return [tr("📡 Configured work chats", "📡 Настроенные рабочие чаты"), syncRows(), "", tr("Use /sync to update memory or /sync status to inspect the last run.", "Используй /sync для обновления памяти или /sync status для последнего результата.")].join("\n");
  }

  function memory(args) {
    const info = parseMemory(vault, timezone);
    if (args[0] === "today") {
      return clip(info.daily ? `${tr("🧠 Memory for", "🧠 Память за")} ${info.date}\n\n${info.daily}` : `${info.date}: ${tr("no daily log yet", "дневного журнала ещё нет")}`);
    }
    const core = info.core ? clip(info.core, 1800) : tr("CORE.md is missing.", "CORE.md отсутствует.");
    return clip([
      tr("🧠 Memory status", "🧠 Состояние памяти"),
      `Vault: ${vault}`,
      `Файлов: ${info.files}; карточек: ${info.cards}`,
      `Сегодня: ${info.daily ? "есть дневной журнал" : "дневного журнала нет"}`,
      "",
      "CORE.md:",
      core,
      "",
      tr("/memory today shows the raw daily log. /forget cards/file.md moves one card to reversible .trash.", "/memory today показывает сырой дневной журнал. /forget cards/file.md обратимо перемещает карточку в .trash."),
    ].join("\n"));
  }

  function forget(args) {
    const requested = textOf(args.join(" ")).replace(/^\/+/, "");
    if (!requested) return tr("Specify a card path, for example /forget cards/project.md", "Укажи путь карточки, например /forget cards/project.md");
    if (!requested.startsWith("cards/") && !requested.startsWith("summaries/")) {
      return tr("Only cards/ and summaries/ can be moved. Daily logs and CORE.md stay untouched.", "Можно перемещать только cards/ и summaries/. Дневные журналы и CORE.md остаются нетронутыми.");
    }
    const source = resolve(vault, requested);
    const base = resolve(vault);
    if (!source.startsWith(`${base}/`) || !existsSync(source) || !statSync(source).isFile()) {
      return tr("Card not found.", "Карточка не найдена.");
    }
    const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
    const targetDir = join(vault, ".trash", stamp);
    mkdirSync(targetDir, { recursive: true, mode: 0o700 });
    const target = join(targetDir, requested.replaceAll("/", "__"));
    renameSync(source, target);
    return tr(`Moved to reversible trash: ${relative(vault, target)}`, `Переместил в обратимую корзину: ${relative(vault, target)}`);
  }

  function reminders(update) {
    try {
      const rows = listReminders({ userId: String(update.message.from.id), limit: 30 });
      if (!rows.length) return tr("No active reminders.", "Активных напоминаний нет.");
      return [tr("⏰ Active reminders", "⏰ Активные напоминания"), ...rows.map(formatReminder)].join("\n");
    } catch (error) {
      return tr(`Could not read reminders: ${error.message}`, `Не смог прочитать напоминания: ${error.message}`);
    }
  }

  async function handle(update) {
    const msg = update.message;
    const text = textOf(msg?.text);
    if (!msg || !text.startsWith("/")) return false;
    const parts = text.split(/\s+/);
    const command = parts[0].replace(/@\w+$/, "").toLowerCase();
    const args = parts.slice(1);
    if (!allowed.has(String(msg.from?.id))) return false;
    let result;
    if (command === "/health") result = await health();
    else if (command === "/queue") result = await queue(update, args);
    else if (command === "/chats") result = chats();
    else if (command === "/sync") result = await sync(args);
    else if (command === "/reminders") result = reminders(update);
    else if (command === "/memory") result = memory(args);
    else if (command === "/forget") result = forget(args);
    else return false;
    await reply(msg.chat.id, clip(result));
    return true;
  }

  return { handle };
}
