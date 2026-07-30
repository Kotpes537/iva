#!/usr/bin/env bash
set -euo pipefail

cd /root/iva
set -a
source .env
set +a

: "${TELEGRAM_BOT_TOKEN:?TELEGRAM_BOT_TOKEN is missing}"
: "${TELEGRAM_API_ID:?TELEGRAM_API_ID is missing}"
: "${TELEGRAM_API_HASH:?TELEGRAM_API_HASH is missing}"

LOCAL_BASE="http://127.0.0.1:8081"
BACKUP=".env.bak.local-bot-api.$(date +%Y%m%d-%H%M%S)"
cp -a .env "$BACKUP"
SWITCHED_TO_LOCAL=0

rollback() {
  local status=$?
  trap - ERR
  echo "Local Bot API switch failed; restoring cloud transport..." >&2
  if [[ "$SWITCHED_TO_LOCAL" == "1" ]]; then
    curl -fsS -X POST "$LOCAL_BASE/bot${TELEGRAM_BOT_TOKEN}/logOut" >/dev/null 2>&1 || true
  fi
  cp -a "$BACKUP" .env
  chmod 600 .env "$BACKUP"
  systemctl --user disable --now telegram-bot-api.service >/dev/null 2>&1 || true
  systemctl --user restart iva.service >/dev/null 2>&1 || true
  systemctl --user start iva-telegram-poll.service >/dev/null 2>&1 || true
  exit "$status"
}
trap rollback ERR

install -m 0644 deploy/telegram-bot-api.service /root/.config/systemd/user/telegram-bot-api.service
systemctl --user daemon-reload
systemctl --user enable --now telegram-bot-api.service

for _ in $(seq 1 30); do
  if systemctl --user is-active --quiet telegram-bot-api.service; then
    break
  fi
  sleep 1
done
systemctl --user is-active --quiet telegram-bot-api.service

systemctl --user stop iva-telegram-poll.service

# Telegram requires logging the bot out of the cloud endpoint before the first local login.
curl -fsS -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/logOut" | grep -q '"ok":true'

READY=0
for _ in $(seq 1 60); do
  if curl -fsS "$LOCAL_BASE/bot${TELEGRAM_BOT_TOKEN}/getMe" | grep -q '"ok":true'; then
    READY=1
    break
  fi
  sleep 1
done
if [[ "$READY" != "1" ]]; then
  echo "Local Bot API did not accept the bot. .env was not changed; backup: $BACKUP" >&2
  false
fi
SWITCHED_TO_LOCAL=1

upsert_env() {
  local key="$1" value="$2"
  if grep -q "^${key}=" .env; then
    sed -i "s|^${key}=.*|${key}=${value}|" .env
  else
    printf '%s=%s\n' "$key" "$value" >> .env
  fi
}

upsert_env TELEGRAM_BOT_API_URL "$LOCAL_BASE"
upsert_env TELEGRAM_BOT_FILE_URL "$LOCAL_BASE"
chmod 600 .env "$BACKUP"

systemctl --user restart iva.service iva-telegram-poll.service
systemctl --user restart iva-reminders.timer
systemctl --user is-active --quiet iva.service
systemctl --user is-active --quiet iva-telegram-poll.service
trap - ERR
echo "Local Telegram Bot API enabled. Backup: /root/iva/$BACKUP"
