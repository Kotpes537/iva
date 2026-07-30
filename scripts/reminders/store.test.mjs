import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("reminders keep the Telegram topic target", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "iva-reminders-"));
  process.env.ASSISTANT_DATA_DIR = dataDir;
  process.env.TELEGRAM_ALLOWED_USER_IDS = "193409109";

  try {
    const store = await import(`./store.mjs?test=${Date.now()}`);
    const reminder = store.addReminder({
      text: "Topic test",
      scheduledAt: "2099-01-02T10:00:00+03:00",
      userId: "193409109",
      chatId: "193409109",
      messageThreadId: 42,
    });

    assert.equal(reminder.chatId, "193409109");
    assert.equal(reminder.messageThreadId, 42);
    assert.equal(store.listReminders({ userId: "193409109" })[0]?.messageThreadId, 42);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
