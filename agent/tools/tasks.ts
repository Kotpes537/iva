import { defineTool } from "eve/tools";
import { z } from "zod";
import { join } from "node:path";
import { acquireLock, loadJsonStrict, releaseLock, saveJsonAtomic } from "../lib/json-store.js";

// Хранилище задач — простой JSON-файл на диске app-runtime (на VPS переживает рестарты).
// Путь настраивается через ASSISTANT_DATA_DIR; по умолчанию ./data рядом с процессом.
const DATA_DIR = process.env.ASSISTANT_DATA_DIR ?? "data";
const FILE = join(DATA_DIR, "tasks.json");
const LOCK = `${FILE}.lock`;

type Priority = "low" | "med" | "high";
interface Task {
  id: number;
  text: string;
  priority: Priority;
  due: string | null;
  dueAt: string | null;
  startAt?: string | null;
  startAlertDays?: number[];
  done: boolean;
  createdAt: string;
}

function normalizeDueAt(value?: string): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw)) {
    throw new Error("dueAt должен быть ISO-датой с часовым поясом");
  }
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) throw new Error("dueAt содержит некорректную дату");
  return date.toISOString();
}

function normalizeStartAlertDays(value: number[] | undefined, startAt: string | null): number[] {
  if (!startAt) return [];
  const days = value === undefined ? [7, 3, 1] : value;
  return [...new Set(days)].sort((a, b) => b - a);
}

// Нет файла → []. Битый JSON — НЕ пустой список: loadJsonStrict откладывает бэкап и
// бросает (иначе следующий save молча уничтожил бы все задачи).
const load = () => loadJsonStrict<Task[]>(FILE, []);
const save = (tasks: Task[]) => saveJsonAtomic(FILE, tasks);

export default defineTool({
  description:
    "Управление списком задач пользователя. action=add добавляет задачу (нужен text); " +
    "list показывает задачи (по умолчанию незавершённые); update меняет поля задачи (нужен id); done отмечает задачу выполненной (нужен id); " +
    "remove удаляет задачу (нужен id).",
  inputSchema: z.object({
    action: z.enum(["add", "list", "update", "done", "remove"]),
    text: z.string().min(1).optional().describe("Текст задачи (для action=add)"),
    id: z.number().int().positive().optional().describe("ID задачи (для done/remove)"),
    priority: z.enum(["low", "med", "high"]).optional().describe("Приоритет (для add)"),
    due: z.string().optional().describe("Срок для показа пользователю (для add)"),
    dueAt: z.string().optional().describe("Точный срок в ISO 8601 с часовым поясом: алерт за 48 часов и просрочка"),
    startAt: z.string().optional().describe("Точная дата и время старта важной механики в ISO 8601 с часовым поясом"),
    startAlertDays: z.array(z.number().int().min(0).max(30)).max(6).optional()
      .describe("За сколько календарных дней напомнить о старте: например [7,3,1]. По умолчанию [7,3,1]"),
    includeDone: z.boolean().optional().describe("Показать и выполненные (для list)"),
  }),
  async execute({ action, text, id, priority, due, dueAt, startAt, startAlertDays, includeDone }) {
    // Мутации — под локом: параллельный ход (расписание + живой чат) на голом
    // load→mutate→save терял записи и дублировал id (id = max+1 от своей копии).
    let lockToken: string | null = null;
    if (action !== "list") {
      try {
        lockToken = await acquireLock(LOCK);
      } catch (e) {
        return { ok: false, error: `Задачи заняты другим ходом: ${(e as Error).message}` };
      }
    }
    try {
      return await run({ action, text, id, priority, due, dueAt, startAt, startAlertDays, includeDone });
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    } finally {
      if (lockToken !== null) releaseLock(LOCK, lockToken);
    }
  },
});

type Args = {
  action: "add" | "list" | "update" | "done" | "remove";
  text?: string;
  id?: number;
  priority?: Priority;
  due?: string;
  dueAt?: string;
  startAt?: string;
  startAlertDays?: number[];
  includeDone?: boolean;
};

async function run({ action, text, id, priority, due, dueAt, startAt, startAlertDays, includeDone }: Args) {
  const tasks = await load();

  switch (action) {
      case "add": {
        if (!text) return { ok: false, error: "Для add нужен text" };
        const nextId = tasks.reduce((m, t) => Math.max(m, t.id), 0) + 1;
        const task: Task = {
          id: nextId,
          text,
          priority: priority ?? "med",
          due: due ?? null,
          dueAt: normalizeDueAt(dueAt),
          startAt: normalizeDueAt(startAt),
          startAlertDays: normalizeStartAlertDays(startAlertDays, normalizeDueAt(startAt)),
          done: false,
          createdAt: new Date().toISOString(),
        };
        tasks.push(task);
        await save(tasks);
        return { ok: true, added: task, total: tasks.length };
      }
      case "list": {
        const items = includeDone ? tasks : tasks.filter((t) => !t.done);
        return { ok: true, count: items.length, tasks: items };
      }
      case "update": {
        if (!id) return { ok: false, error: "Для update нужен id" };
        const t = tasks.find((x) => x.id === id);
        if (!t) return { ok: false, error: `Задача ${id} не найдена` };
        if (text !== undefined) t.text = text;
        if (priority !== undefined) t.priority = priority;
        if (due !== undefined) t.due = due || null;
        if (dueAt !== undefined) t.dueAt = normalizeDueAt(dueAt);
        if (startAt !== undefined) t.startAt = normalizeDueAt(startAt);
        if (startAlertDays !== undefined || startAt !== undefined) {
          t.startAlertDays = normalizeStartAlertDays(startAlertDays ?? t.startAlertDays, t.startAt ?? null);
        }
        await save(tasks);
        return { ok: true, updated: t };
      }
      case "done": {
        if (!id) return { ok: false, error: "Для done нужен id" };
        const t = tasks.find((x) => x.id === id);
        if (!t) return { ok: false, error: `Задача ${id} не найдена` };
        t.done = true;
        await save(tasks);
        return { ok: true, done: t };
      }
      case "remove": {
        if (!id) return { ok: false, error: "Для remove нужен id" };
        const idx = tasks.findIndex((x) => x.id === id);
        if (idx === -1) return { ok: false, error: `Задача ${id} не найдена` };
        const [removed] = tasks.splice(idx, 1);
        await save(tasks);
        return { ok: true, removed, total: tasks.length };
      }
  }
}
