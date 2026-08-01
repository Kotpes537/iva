#!/usr/bin/env python3
"""
Persistent HTTP proxy that owns ONE Telethon userbot session and exposes the
upstream chigwell/telegram-mcp tools over MCP streamable-HTTP for the iva agent.

Why this exists (hard-won lesson, do not "simplify" away):
- Exactly ONE process may own a given Telethon session. A second opener desyncs
  the MTProto session and crashes Telethon with TypeNotFoundError. So this proxy
  is the sole session owner; iva reaches it on demand over HTTP.

Design:
- Session-less boot. If no saved session exists yet, we seed an EMPTY StringSession
  so upstream's `_discover_accounts()` builds an unauthorized-but-connectable client
  instead of `sys.exit(1)`. The QR-login tools (Phase 1, onboarding.py) authorize
  that SAME live client in place, then persist the real session — no restart, no
  hot-swap of a different client.
- Bearer auth + bind 127.0.0.1 (single box; defense-in-depth on top of localhost).
- receive_updates defaults to True upstream, so Telethon's own loop auto-reconnects;
  we add a cheap EnsureConnected middleware as belt-and-suspenders.

Env:
  TELEGRAM_MCP_HOST   bind address        (default 127.0.0.1)
  TELEGRAM_MCP_PORT   bind port           (default 8724)
  TELEGRAM_MCP_TOKEN  bearer secret; every request must send `Authorization: Bearer <token>`
  TELEGRAM_API_ID / TELEGRAM_API_HASH     from my.telegram.org (required)
  TELEGRAM_SESSION_FILE  path to the SQLite session file
                         (default $ASSISTANT_DATA_DIR/telegram-userbot.session, else ./telegram-userbot.session)
"""
import os
import json
import re
import shutil
import sys
import time
from pathlib import Path
from typing import Optional, Union


async def _health_payload(client) -> dict[str, str]:
    """Report authorization from the proxy's existing Telethon client."""
    return {"state": "ready" if await client.is_user_authorized() else "unauthorized"}


def _fail(msg: str) -> None:
    print(f"telegram-userbot: {msg}", file=sys.stderr)
    sys.exit(1)


def _session_file() -> Path:
    explicit = os.getenv("TELEGRAM_SESSION_FILE")
    if explicit:
        return Path(explicit)
    data_dir = os.getenv("ASSISTANT_DATA_DIR")
    base = Path(data_dir) if data_dir else Path.cwd()
    return base / "telegram-userbot.session"


def _token_file() -> Path:
    # Anchored at <iva_root>/data so iva's connection (cwd = iva root) and this proxy
    # (cwd = services/telegram-userbot) resolve the SAME file: services/telegram-userbot/
    # serve.py → parents[2] = iva root. `iva userbot setup` writes it (0600).
    return Path(__file__).resolve().parents[2] / "data" / "telegram-userbot.token"


def _download_root() -> Path:
    """Private local destination for read-only large Telegram media downloads."""
    root = Path(__file__).resolve().parents[2]
    configured = Path(os.getenv("TELEGRAM_MCP_DOWNLOAD_DIR", "vault/telegram-media"))
    if not configured.is_absolute():
        configured = root / configured
    configured.mkdir(parents=True, mode=0o700, exist_ok=True)
    try:
        configured.chmod(0o700)
    except OSError:
        pass
    return configured.resolve()


def _download_limit() -> int:
    # A 2 GB default fits the current VPS better than Telegram's account limit.
    raw = os.getenv("TELEGRAM_MCP_MAX_DOWNLOAD_BYTES", str(2 * 1024 * 1024 * 1024))
    try:
        value = int(raw)
    except ValueError:
        value = 2 * 1024 * 1024 * 1024
    return max(1, min(value, 4 * 1024 * 1024 * 1024))


def _safe_download_name(raw: Optional[str], chat_id: Union[int, str], message_id: int) -> str:
    candidate = Path(str(raw or "")).name if raw else ""
    candidate = re.sub(r"[^0-9A-Za-zА-Яа-я._ -]+", "_", candidate).strip(" .")
    if not candidate:
        candidate = f"telegram_{chat_id}_{message_id}_{int(time.time())}"
    return candidate[:180]


def _resolve_token() -> str:
    env = os.getenv("TELEGRAM_MCP_TOKEN")
    if env:
        return env.strip()
    f = _token_file()
    return f.read_text().strip() if f.exists() else ""


def _seed_session_env() -> Path:
    """Point upstream at our SQLite session file (created empty if absent = onboarding).

    Must run BEFORE importing telegram_mcp.runtime, whose module-level
    `_discover_accounts()` reads the session env and `sys.exit(1)`s if unset.

    We use a FILE session (not a string): an unauthorized session can't be
    serialized to a non-empty StringSession, but a missing SQLite file is a valid
    empty unauthorized session, and Telethon persists the auth to it automatically
    on QR login — no manual save. Single owner ⇒ no "database is locked".
    """
    path = _session_file()
    path.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
    # Telethon appends ".session" to the name; strip it so we don't get ".session.session".
    name = str(path)
    if name.endswith(".session"):
        name = name[: -len(".session")]
    os.environ["TELEGRAM_SESSION_NAME"] = name
    return path


def main() -> None:
    import asyncio

    # The SQLite session file holds the MTProto auth key (= full account access). Force
    # private perms on everything we create (0600 files / 0700 dirs) so a co-tenant on
    # the host can't read it — systemd's default umask is 022 (world-readable 0644).
    os.umask(0o077)

    host = os.getenv("TELEGRAM_MCP_HOST", "127.0.0.1")
    port = int(os.getenv("TELEGRAM_MCP_PORT", "8724"))
    token = _resolve_token()
    if not token:
        _fail("no proxy token — run `iva userbot setup` (writes data/telegram-userbot.token)")
    if not os.getenv("TELEGRAM_API_ID") or not os.getenv("TELEGRAM_API_HASH"):
        _fail("TELEGRAM_API_ID and TELEGRAM_API_HASH are required (create an app at my.telegram.org)")

    session_path = _seed_session_env()

    # Import AFTER seeding the session env — runtime builds `mcp` + the single
    # Telethon client; importing the tools package fires every @mcp.tool decorator.
    from telegram_mcp.runtime import (
        mcp,
        get_client,
        resolve_entity,
        _apply_exposed_tools_mode,
        ToolAnnotations,
    )
    import telegram_mcp.tools  # noqa: F401 — registers all tools with `mcp`

    # Honor TELEGRAM_EXPOSED_TOOLS (e.g. "read-only"); upstream normally does this in
    # its runner, which we bypass. Default "all".
    removed = _apply_exposed_tools_mode(mcp)
    if removed:
        print(f"telegram-userbot: read-only mode, pruned {len(removed)} write tools", file=sys.stderr)

    client = get_client()

    # Register onboarding tools AFTER pruning so QR login always works — you must be
    # able to connect the account even under read-only exposure.
    from onboarding import register_onboarding_tools

    register_onboarding_tools(mcp, client)

    # Enforce the anti-ban safety guide as server behavior (FloodWait compliance,
    # pacing, circuit-breaker) by wrapping the client's outbound methods in place.
    from guardrails import install_guardrails

    install_guardrails(client)

    # TOOL-LEVEL CHAT ALLOWLIST. This does not inspect HTTP request bodies: doing
    # that breaks MCP's streamable transport and can spin CPU. Instead, only the
    # required tools exist, and every content tool rejects a non-allowlisted chat.
    def allowed_chat_ids() -> set[str]:
        raw = os.getenv("TELEGRAM_MCP_ALLOWED_CHAT_IDS", "")
        return {value.strip() for value in raw.replace(";", ",").split(",") if value.strip()}

    discovery = os.getenv("TELEGRAM_MCP_DISCOVERY_ONLY", "0") == "1"
    content_tools = {
        "get_history", "list_messages", "get_messages", "get_message_context",
        "search_messages", "get_pinned_messages", "get_message_link",
        "get_media_info", "download_media", "list_inline_buttons",
        "get_message_read_by",
    }
    onboarding_tools = {"login_status", "qr_login_start", "qr_login_status", "qr_login_password"}
    permitted_tools = set(onboarding_tools) | set(content_tools)
    if discovery:
        permitted_tools |= {"get_chats", "list_chats"}

    for tool in list(mcp._tool_manager.list_tools()):
        if tool.name not in permitted_tools:
            mcp.remove_tool(tool.name)

    for name in content_tools:
        tool = mcp._tool_manager.get_tool(name)
        if not tool:
            continue
        original = tool.fn

        async def guarded(*args, __original=original, **kwargs):
            chat_id = kwargs.get("chat_id")
            if chat_id is None or str(chat_id) not in allowed_chat_ids():
                raise RuntimeError("Telegram MCP: chat is not in the configured allowlist")
            # Upstream accepts no account for a single session, but rejects an empty
            # string emitted by some MCP clients. Normalize it to the sole account.
            if kwargs.get("account") == "":
                kwargs["account"] = "default"
            # A bounded response is a hard safety boundary for the 2 GB VPS.
            # Reviews must never pull a whole chat into the model context.
            if name in {"get_history", "list_messages", "search_messages"}:
                try:
                    kwargs["limit"] = min(max(1, int(kwargs.get("limit", 20))), 30)
                except (TypeError, ValueError):
                    kwargs["limit"] = 20
            elif name == "get_messages":
                try:
                    kwargs["page_size"] = min(max(1, int(kwargs.get("page_size", 20))), 30)
                except (TypeError, ValueError):
                    kwargs["page_size"] = 20
            return await __original(*args, **kwargs)

        tool.fn = guarded

    # The upstream download_media tool is disabled in read-only exposure because it
    # writes to a client-selected path. This narrower tool is read-only with respect
    # to Telegram and writes only inside vault/telegram-media on this VPS.
    download_root = _download_root()
    max_download_bytes = _download_limit()

    class _DownloadLimitExceeded(Exception):
        pass

    @mcp.tool(
        annotations=ToolAnnotations(
            title="Download Telegram media to vault",
            openWorldHint=False,
            destructiveHint=False,
        )
    )
    async def download_media_to_vault(
        chat_id: Union[int, str],
        message_id: int,
        filename: Optional[str] = None,
        account: str = None,
    ) -> str:
        """
        Download a media attachment from an allowlisted Telegram chat into the
        server's vault/telegram-media directory. This tool never sends or edits
        Telegram messages. Use it when Bot API cannot download a file over 20 MB.
        The default maximum is 2 GiB and the file is streamed to disk.
        """
        if str(chat_id) not in allowed_chat_ids():
            return "Telegram MCP: chat is not in the configured allowlist."
        try:
            message_id = int(message_id)
        except (TypeError, ValueError):
            return "message_id must be an integer."
        if message_id <= 0:
            return "message_id must be positive."

        try:
            cl = get_client(account or "default")
            entity = await resolve_entity(chat_id, cl)
            msg = await cl.get_messages(entity, ids=message_id)
            if not msg or not msg.media:
                return "No media found in the specified message."

            declared_size = getattr(getattr(msg, "file", None), "size", None)
            if isinstance(declared_size, int) and declared_size > max_download_bytes:
                return (
                    f"File is too large: {declared_size} bytes; "
                    f"configured limit is {max_download_bytes} bytes."
                )

            free_bytes = shutil.disk_usage(download_root).free
            if isinstance(declared_size, int) and declared_size > int(free_bytes * 0.9):
                return "Not enough free disk space for a safe download."

            name = _safe_download_name(filename or getattr(getattr(msg, "file", None), "name", None), chat_id, message_id)
            target_prefix = (download_root / name).with_suffix("")

            def progress(current: int, total: int) -> None:
                if current > max_download_bytes or current > int(shutil.disk_usage(download_root).free * 0.9):
                    raise _DownloadLimitExceeded("download limit or free-space guard reached")

            downloaded = await cl.download_media(msg, file=str(target_prefix), progress_callback=progress)
            if not downloaded:
                return f"Download failed for message {message_id}."
            final_path = Path(downloaded).resolve(strict=True)
            if not final_path.is_relative_to(download_root):
                try:
                    final_path.unlink()
                except OSError:
                    pass
                return "Download failed: resulting path is outside the vault media directory."
            return json.dumps(
                {
                    "ok": True,
                    "path": str(final_path),
                    "size": final_path.stat().st_size,
                    "chat_id": str(chat_id),
                    "message_id": message_id,
                },
                ensure_ascii=False,
            )
        except _DownloadLimitExceeded as exc:
            return f"Download stopped by safety limit: {exc}"
        except Exception as exc:  # noqa: BLE001
            return f"download_media_to_vault failed: {type(exc).__name__}: {exc}"


    import uvicorn
    from starlette.middleware.base import BaseHTTPMiddleware
    from starlette.responses import JSONResponse

    expected = f"Bearer {token}"

    class BearerAuthMiddleware(BaseHTTPMiddleware):
        async def dispatch(self, request, call_next):
            if request.headers.get("authorization") != expected:
                return JSONResponse({"error": "unauthorized"}, status_code=401)
            return await call_next(request)

    class EnsureConnectedMiddleware(BaseHTTPMiddleware):
        async def dispatch(self, request, call_next):
            try:
                if not client.is_connected():
                    await client.connect()
            except Exception as exc:  # noqa: BLE001
                print(f"telegram-userbot: reconnect failed: {exc}", file=sys.stderr)
            return await call_next(request)

    async def health(_request):
        return JSONResponse(await _health_payload(client))

    async def amain() -> None:
        await client.connect()  # NOT .start() — that would prompt for interactive login
        authorized = await client.is_user_authorized()
        print(
            f"telegram-userbot: session {'authorized' if authorized else 'NOT authorized (onboarding mode)'}"
            f" [{session_path}]",
            file=sys.stderr,
        )

        mcp.settings.host = host
        mcp.settings.port = port
        # Bound to localhost + bearer-gated; the DNS-rebinding validator only adds
        # 421s for the loopback/host aliases iva uses, so disable it here.
        from mcp.server.transport_security import TransportSecuritySettings

        mcp.settings.transport_security = TransportSecuritySettings(
            enable_dns_rebinding_protection=False
        )

        app = mcp.streamable_http_app()
        app.add_route("/healthz", health, methods=["GET"])
        # add_middleware stacks outermost-last: BearerAuth runs first (reject before
        # we bother reconnecting), then EnsureConnected.
        app.add_middleware(EnsureConnectedMiddleware)
        app.add_middleware(BearerAuthMiddleware)

        print(f"telegram-userbot: listening on http://{host}:{port}/mcp", file=sys.stderr)
        config = uvicorn.Config(app, host=host, port=port, log_level="warning", lifespan="on")
        await uvicorn.Server(config).serve()

    import nest_asyncio

    nest_asyncio.apply()
    asyncio.run(amain())


if __name__ == "__main__":
    main()
