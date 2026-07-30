import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  addReminder,
  cancelReminder,
  listReminders,
  snoozeReminder,
} from "../../scripts/reminders/store.mjs";

function attributeValue(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === "string" ? value : value?.[0];
}

export default defineTool({
  description:
    "Управление настоящими Telegram-напоминаниями, которые доставляются по времени без участия модели. " +
    "add создаёт напоминание; list показывает активные; cancel отменяет; snooze переносит. " +
    "Для add передавай scheduledAt как точный ISO 8601 с часовым поясом, например " +
    "2026-07-18T18:30:00+03:00. Текущее время бери из системного промпта. " +
    "Если пользователь не указал время достаточно точно, сначала уточни и НЕ вызывай add. " +
    "Повторы: none, daily, weekdays, weekly, monthly, yearly, interval или custom. " +
    "Для interval нужен intervalMinutes; для custom нужен cron. После add всегда назови точные дату, время и повтор.",
  inputSchema: z.object({
    action: z.enum(["add", "list", "cancel", "snooze"]),
    text: z.string().min(1).max(3000).optional().describe("Текст нового напоминания"),
    scheduledAt: z
      .string()
      .optional()
      .describe("Первое срабатывание в ISO 8601 с явным часовым поясом"),
    recurrence: z
      .enum(["none", "daily", "weekdays", "weekly", "monthly", "yearly", "interval", "custom"])
      .optional(),
    cron: z.string().optional().describe("Cron-выражение для recurrence=custom"),
    intervalMinutes: z
      .number()
      .int()
      .min(1)
      .max(525600)
      .optional()
      .describe("Интервал в минутах для recurrence=interval"),
    timezone: z.string().optional().describe("IANA timezone; обычно не передавай, используется настройка Iva"),
    id: z.number().int().positive().optional().describe("ID для cancel/snooze"),
    minutes: z.number().int().min(1).max(525600).optional().describe("На сколько минут перенести"),
    includeInactive: z.boolean().optional().describe("Для list показать также историю"),
    limit: z.number().int().min(1).max(100).optional(),
  }),
  async execute(
    {
      action,
      text,
      scheduledAt,
      recurrence,
      cron,
      intervalMinutes,
      timezone,
      id,
      minutes,
      includeInactive,
      limit,
    },
    ctx,
  ) {
    try {
      const attributes = ctx.session.auth.current?.attributes ?? {};
      const currentUserId = attributeValue(attributes.user_id);
      const currentChatId = attributeValue(attributes.chat_id);
      const currentThreadId = attributeValue(attributes.message_thread_id);

      if (action === "add") {
        if (!text) return { ok: false, error: "Для add нужен text" };
        if (recurrence !== "custom" && !scheduledAt) {
          return { ok: false, error: "Для add нужен scheduledAt с точными датой, временем и часовым поясом" };
        }
        const reminder = addReminder({
          text,
          scheduledAt,
          recurrence: recurrence ?? "none",
          cron,
          intervalMinutes,
          timezone,
          userId: currentUserId,
          chatId: currentChatId,
          messageThreadId: currentThreadId,
        });
        return { ok: true, reminder };
      }

      if (action === "list") {
        const reminders = listReminders({
          includeInactive: includeInactive ?? false,
          limit: limit ?? 50,
          userId: currentUserId,
        });
        return { ok: true, count: reminders.length, reminders };
      }

      if (!id) return { ok: false, error: `Для ${action} нужен id` };
      if (action === "cancel") return { ok: true, reminder: cancelReminder(id, currentUserId) };
      if (!minutes) return { ok: false, error: "Для snooze нужны minutes" };
      return { ok: true, reminder: snoozeReminder(id, minutes, currentUserId) };
    } catch (error) {
      return { ok: false, error: String((error as Error).message ?? error).slice(0, 600) };
    }
  },
});
