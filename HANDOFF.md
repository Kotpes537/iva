# Iva: handoff for development

Updated: 2026-08-01

## Current snapshot

- GitHub destination: `https://github.com/Kotpes537/iva`
- Published branch: `codex/stage-v034`
- Iva version: `0.3.8`
- Current source commit before this document: `78b61a1`
- Server project path: `/root/iva`
- Runtime user: `root`
- Local HTTP port: `8723`; public domain and HTTPS are not required
- Time zone: `Europe/Minsk`
- Workflow storage: PostgreSQL via `WORKFLOW_POSTGRES_URL`
- Search provider: Tavily
- Active model provider: DeepSeek
- Active services: `iva.service`, `iva-telegram-poll.service`, `iva-telegram-userbot.service`

## What is implemented

### Iva and memory

- Layered Markdown vault with daily logs, cards, summaries and CORE.
- Nightly memory rollup, memory doctor, weekly/monthly/yearly timers.
- Incremental read-only sync of five explicitly configured work chats.
- PostgreSQL workflow tables are installed and checked.
- Vault backup uses a private GitHub repository `Kotpes537/iva-vault`.

### Telegram operations

The Telegram bridge now has out-of-band commands. They do not call the model and do not create new topics:

- `/health` — service, queue, active-turn and available-memory status.
- `/queue` — durable queue contents.
- `/queue clear` — clears only the current chat queue.
- `/chats` — five chats included in work-chat sync.
- `/sync` — starts the configured read-only memory sync.
- `/sync status` — last sync status and journal tail.
- `/reminders` — active reminders.
- `/memory` — vault and CORE status.
- `/memory today` — today's raw daily log.
- `/forget cards/path.md` — moves a card to `vault/.trash`, never deletes it permanently.

### Meeting protocols

`agent/skills/meeting-protocol/SKILL.md` defines the workflow for turning voice notes, audio, video and meeting documents into:

- summary;
- decisions;
- action items with owner, deadline and confidence;
- open questions;
- next step.

Unknown owners, deadlines and decisions must be marked `нужно уточнить`, never invented.

### Reliability

- Durable Telegram FIFO queue with at-least-once replay.
- Per-chat run status and stale-run protection.
- Early working status with Stop button.
- Provider errors are surfaced instead of leaving silent failures.
- Queue and health diagnostics work while the model is busy.

## Five work chats in the current sync

| Name | Chat ID |
|---|---:|
| AI assist | -5020893711 |
| CRM Еплюс | -5089442250 |
| Без ИА | -5094503913 |
| Клубы Евроопт | -5091064861 |
| КСО_рабочая группа | -5538028235 |

The list is defined in `scripts/telegram-sync-config.mjs` and is consumed by `scripts/memory/telegram-sync.ts`.

## Important commits

- `0eb0054` — upgrade to Iva v0.3.8 while preserving local customizations.
- `e539bad` — DeepSeek/geolocation/allowlist customization.
- `e05bb69` — `pohuy` skill.
- `648e7bd` — fixed Telegram sync systemd Node path.
- `78b61a1` — Telegram operations, memory controls and meeting protocol skill.

## Continue on another PC

```bash
git clone --branch codex/stage-v034 https://github.com/Kotpes537/iva.git
cd iva
```

Install dependencies and run checks:

```bash
npm install
npm run typecheck
npm run build
```

For local development, create `.env` from `.env.example` and supply keys separately. Never commit `.env`, Telegram bot tokens, Deepgram keys, model keys, Codex OAuth files, Telegram session files, PostgreSQL credentials or vault data.

## Deploying source changes to the VPS

Run on the VPS as the Iva user:

```bash
cd /root/iva
git fetch origin
git checkout codex/stage-v034
git pull --ff-only origin codex/stage-v034
export PATH=/root/.nvm/versions/node/v24.18.0/bin:/usr/local/bin:/usr/bin:/bin
npm install
npm run typecheck
npm run build
systemctl --user restart iva.service iva-telegram-poll.service
systemctl --user status iva.service iva-telegram-poll.service --no-pager
```

Do not delete `vault`, `data`, `.env`, Telegram sessions or PostgreSQL data during a code deploy.

## Diagnostics

```bash
iva status
iva doctor
journalctl --user -u iva.service -f
journalctl --user -u iva-telegram-poll.service -f
journalctl --user -u iva-telegram-sync.service -n 80 --no-pager -l
systemctl --user list-timers
```

## Backup and recovery

The pre-change server snapshot is stored on the VPS at:

`/root/iva-backups/pre-five-features-20260801-133030`

It contains the source/data/vault archive, `.env` and user systemd configuration. Its SHA-256 file is inside the same directory. This backup is intentionally not committed to GitHub.

The repository contains source and handoff documentation only. Runtime lock files such as `.memory.lock` and `.telegram-sync.lock` are intentionally untracked.

## Known boundaries

- Personal Telegram userbot is beta and uses a real Telegram account; keep the allowlist narrow and read-only where possible.
- A sync run reads at most 30 recent messages per configured chat and advances watermarks only after successful memory writes.
- The current VPS remains the source of truth for secrets, runtime state, vault and Telegram sessions.
