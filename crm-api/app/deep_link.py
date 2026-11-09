"""
Links that take somebody from a WhatsApp notification to the exact record it is about.

A PORT OF backend/src/utils/deep-link.ts.

ONE BUILDER, NOT ONE PER NOTIFICATION. Two handlers composing their own URLs is how one of
them ends up pointing at a development host, or at a route that was renamed a month ago, and
nobody notices because the message still looks fine. Every notification link in this codebase
comes from here.

ORDINARY HTTPS LINKS, DELIBERATELY. The provider is Baileys, which speaks the WhatsApp Web
protocol and sends `{ text }` and nothing else — see baileys.provider.ts. Native interactive
buttons are a WhatsApp Business Cloud API feature needing approved templates and a different
provider entirely. WhatsApp clients linkify a bare https URL in message text, which gets the
same tap with none of that, so that is what these produce. They are NOT buttons and this file
does not pretend otherwise.

NOTHING SENSITIVE IN THE URL. A record id and nothing else: no token, no session, no phone
number, no name. The link opens the app, the app asks for a login if there is not one already,
and the server authorises the fetch exactly as it does for any other request. The id in the
URL grants nothing on its own — see the conversation routes, which scope every read by the
caller's organisation.
"""

import re
from typing import Any
from urllib.parse import urlparse

from app.config import settings

# Mongo ObjectId as it appears in a URL. Case-insensitive character class to avoid Defect 12.
_OBJECT_ID_PATTERN = re.compile(r"^[a-fA-F0-9]{24}$")

# Origins that are never the public web app, however they are ordered in config.
# `https://localhost` is in `FRONTEND_ORIGIN` because the Android build's WebView runs there —
# see capacitor.config.ts. A notification linking somebody to `https://localhost/...` opens
# nothing, so it is filtered out rather than relied on not being first.
# Includes both `[::1]` (Node URL.hostname) and `::1` (Python urlparse.hostname).
NON_PUBLIC_HOSTS: tuple[str, ...] = ("localhost", "127.0.0.1", "0.0.0.0", "[::1]", "::1")


def resolve_public_app_origin(config: Any = None) -> str | None:
    """
    The canonical public origin for links.

    DERIVED FROM `FRONTEND_ORIGIN` rather than from a new variable, because that list is already
    the deployment's statement about where the app lives and adding a second source of truth
    means one of them eventually goes stale. The first entry that is a real, reachable https
    origin wins.

    Returns None when nothing qualifies. Callers omit the link rather than guessing — a link to
    the wrong host is worse than no link, because it looks like it should work.
    """
    candidates: list[str] = []
    if config is not None:
        if isinstance(config, dict):
            raw = config.get("FRONTEND_ORIGIN")
            candidates = [str(o) for o in raw] if isinstance(raw, list) else []
        elif hasattr(config, "FRONTEND_ORIGIN"):
            raw = getattr(config, "FRONTEND_ORIGIN")
            candidates = [str(o) for o in raw] if isinstance(raw, list) else []
        elif hasattr(config, "frontend_origin"):
            raw = config.frontend_origin
            if isinstance(raw, list):
                candidates = [str(o) for o in raw]
            elif isinstance(raw, str):
                candidates = [o.strip() for o in raw.split(",") if o.strip()]
    else:
        raw = settings.frontend_origin
        if isinstance(raw, list):
            candidates = [str(o) for o in raw]
        elif isinstance(raw, str):
            candidates = [o.strip() for o in raw.split(",") if o.strip()]

    for candidate in candidates:
        try:
            parsed = urlparse(candidate)
        except Exception:
            continue

        # http is refused outright: these links travel through WhatsApp to a phone, and the app's
        # own refresh cookie is `Secure` — a plain-http link cannot work even if someone taps it.
        if parsed.scheme != "https":
            continue

        hostname = parsed.hostname
        if not hostname or hostname in NON_PUBLIC_HOSTS:
            continue

        port_str = f":{parsed.port}" if parsed.port else ""
        return f"{parsed.scheme}://{hostname}{port_str}"

    return None


def as_record_id(value: Any) -> str | None:
    """Narrow a possibly-ObjectId value to the string form, or None."""
    if value is None:
        return None
    text = str(value).strip()
    return text if _OBJECT_ID_PATTERN.match(text) else None


def build_conversation_deep_link(
    conversation_id: Any,
    *,
    config: Any = None,
) -> str | None:
    """
    Opens one lead's conversation in the inbox.

    `?conversation=<id>` on the root, because the frontend has NO ROUTER: navigation is
    `view` + `selectedId` state in AppShell, and the only established way into it from outside is
    a query parameter read once on load and then wiped from the address bar. That is exactly how
    the Meta OAuth callback already returns — see frontend/src/lib/meta-connect.ts — so this
    reuses a pattern the app already has rather than inventing a second one.

    None when the id is not a well-formed ObjectId, or when there is no public origin configured.
    """
    rec_id = as_record_id(conversation_id)
    origin = resolve_public_app_origin(config)
    if not rec_id or not origin:
        return None

    return f"{origin}/?conversation={rec_id}"


def build_reminder_deep_link(
    *,
    task_id: Any = None,
    conversation_id: Any = None,
    config: Any = None,
) -> str | None:
    """
    Opens the reminder itself, over the lead it is about.

    BOTH IDS, AND BOTH ARE USED. `conversation=<id>` opens the thread, which is the destination
    and the floor: it is what the link did before a reminder view existed, and it is what still
    happens if the reminder has since been completed or deleted. `reminder=<id>` opens
    ReminderDetailDialog over it, so a notification that said "follow up with Vaishu at 5" lands
    on that reminder rather than on a lead panel with five of them in a collapsed section.

    THE CONVERSATION ID IS NOT DECORATION in the second case either — it scopes the lookup. The
    app reads the lead's own follow-up list and picks this id out of it, so a reminder belonging
    to a different conversation than the link claims simply is not found.

    NONE FOR A PERSONAL REMINDER, deliberately. One with no `conversation_id` has no lead and no
    destination; linking it to the inbox root would be a tap that answers nothing.
    """
    base = build_conversation_deep_link(conversation_id, config=config)
    if not base:
        return None

    reminder_id = as_record_id(task_id)
    return f"{base}&reminder={reminder_id}" if reminder_id else base
