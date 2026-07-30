export interface Reminder {
  id: number;
  chatId: string;
  messageThreadId: number | null;
  text: string;
  nextAt: string | null;
  localTime: string | null;
  timezone: string;
  recurrence: string;
  recurrenceLabel: string;
  cron: string | null;
  intervalMinutes: number | null;
  status: string;
  sendCount: number;
  lastSentAt: string | null;
  failCount: number;
}

export const DEFAULT_TIMEZONE: string;
export const DB_FILE: string;
export function formatLocal(iso: string | null, timezone?: string): string | null;
export function recurrenceLabel(reminder: Record<string, unknown>): string;
export function addReminder(input: {
  text: string;
  scheduledAt?: string;
  recurrence?: "none" | "daily" | "weekdays" | "weekly" | "monthly" | "yearly" | "interval" | "custom";
  cron?: string;
  intervalMinutes?: number;
  timezone?: string;
  chatId?: string;
  userId?: string;
  messageThreadId?: string | number;
}): Reminder;
export function listReminders(input?: { includeInactive?: boolean; limit?: number; userId?: string }): Reminder[];
export function getReminder(id: number): Record<string, unknown> | null;
export function cancelReminder(id: number, expectedUserId?: string): Reminder;
export function snoozeReminder(id: number, minutes: number, expectedUserId?: string): Reminder;
export function completeReminder(id: number, expectedUserId?: string): Reminder;
export function dueReminders(limit?: number): Array<Record<string, unknown>>;
export function markDelivered(id: number, telegramMessageId?: number): Reminder & { telegramMessageId?: number };
export function markDeliveryFailed(id: number, error: unknown): Reminder;
export function reminderStats(): { database: string; counts: Array<{ status: string; count: number }> };
