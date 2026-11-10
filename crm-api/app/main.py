"""
The Python CRM API.

PHASE 0 OF THE NODE -> PYTHON MIGRATION, and it serves exactly one module: health. The point is
not the endpoint - it is 89 lines in Node and nobody needed it rewritten. The point is proving
the path everything else will follow: FastAPI deployed beside the Node backend, Caddy routing by
path prefix, Python reading the same MongoDB and verifying the same sessions, and a rollback
that has actually been executed once rather than merely written down.

THE RESPONSES ARE BYTE-IDENTICAL TO NODE'S, deliberately. The React frontend is unchanged and
calls the same `/api/v1/health` it always has; it must not be able to tell which service
answered. That is the contract every later phase inherits, so it is established here where the
payload is four fields and getting it wrong costs nothing.

WHAT THIS SERVICE DELIBERATELY DOES NOT DO: no background jobs, no schedulers, no queue
consumers, no writes of any kind. The Node backend owns all thirteen runners and every write
path, and will keep owning them until individual modules are moved one at a time. Two services
running the same sweep would send a customer the same message twice.
"""

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app import cache, db
from app.errors import install_error_handlers
from app.request_context import RequestContextMiddleware
from app.routers import settings as settings_router
from app.routers import (
    ai_brain,
    ai_knowledge,
    analytics,
    call_outcome,
    calls,
    contacts,
    conversation_tags,
    conversations,
    followups,
    lead_sources,
    media,
    meta,
    notes,
    auth as auth_router,
    push,
    realtime,
    stages,
    starred_messages,
    tags,
    templates,
    users,
    whatsapp_accounts,
)
from app.config import settings

# The same value the Node backend reports. NOT a new name: this is the same API with a different
# implementation behind part of it, and a client that could distinguish them would be a client
# that breaks when the next module moves.
SERVICE_NAME = "wam-backend"

# THE PYTHON ROUTES ARE SPELLED EXACTLY AS THE PUBLIC API IS, and that is not cosmetic.
#
# Caddy's `handle` directive matches a path prefix and forwards it UNCHANGED - it does not strip
# it the way `handle_path` does. So a browser request for /api/v1/health arrives at this service
# still spelled /api/v1/health. Mounting these at a bare /health would 404 the instant Caddy
# started routing here, and the 404 would come from FastAPI rather than from anything that
# looked like a routing problem.
#
# Keeping the service's own paths identical to the public ones also means every later module
# moves by changing one Caddy line, with no per-route rewriting to get wrong.
API_PREFIX = "/api/v1"


@asynccontextmanager
async def lifespan(_: FastAPI):
    # In non-test environments (production / staging), starts all 13 background runners
    # ONLY when explicitly enabled via ENABLE_BACKGROUND_RUNNERS=true.
    # When running multi-worker Uvicorn (e.g. uvicorn --workers 4), runners are executed in
    # a dedicated single-instance worker container/process (`python -m app.worker`) to prevent
    # 4x runner duplication across worker processes.
    runners = None
    if settings.node_env != "test" and settings.enable_background_runners:
        from app.runners import create_all_runners

        runners = create_all_runners()
        await runners.start_all()

    yield

    if runners is not None:
        await runners.stop_all()

    await db.close()
    await cache.close()


app = FastAPI(
    title="Vistaar CRM API (Python)",
    # No docs in production: this is an internal API behind Caddy, and an auto-generated schema
    # browser is surface nobody asked for.
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
    lifespan=lifespan,
    # Parity with Express: unmounted trailing slash routes return 404 rather than 307 redirects.
    redirect_slashes=False,
)


# Before the error handlers read it. Node assigns the id in `requestContextMiddleware`, which
# is mounted ahead of every route for the same reason.
app.add_middleware(RequestContextMiddleware)

# Allowed origins for web and native Capacitor mobile app (https://localhost).
origin_cfg = str(getattr(settings, "frontend_origin", "") or "")
allowed_origins = [
    entry.strip()
    for entry in origin_cfg.split(",")
    if entry.strip()
]
for default_origin in (
    "https://localhost",
    "capacitor://localhost",
    "http://localhost:5173",
    "http://localhost:5174",
    "https://vistaarcrm.duckdns.org",
):
    if default_origin not in allowed_origins:
        allowed_origins.append(default_origin)

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["*"],
    expose_headers=["x-request-id", "content-disposition"],
)

install_error_handlers(app)

# Phase 1. Mounted at the public path, because Caddy forwards the matched prefix unchanged.
app.include_router(
    starred_messages.router,
    prefix=f"{API_PREFIX}/starred-messages",
    tags=["starred-messages"],
)

# Phase 2. The STAGE routes move whole; only the TAG CATALOGUE moves.
#
# ATTACHING A TAG TO A CONVERSATION IS NOT HERE and must not be added until Phase 9. It lives at
# /conversations/:id/tags, reads the conversation through the conversations module's visibility
# rules, and writes the conversation document and an activity row inside ONE transaction. Caddy
# cuts over /api/v1/tags*, which does not match /api/v1/conversations/:id/tags - different
# prefix - so that route stays inside the /api/* block and keeps being served by Node.
#
# Registering these makes the routes answer on :5002. They are NOT public until the Caddy blocks
# are added, which is a separate, reviewed step.
app.include_router(stages.router, prefix=f"{API_PREFIX}/stages", tags=["stages"])
app.include_router(tags.router, prefix=f"{API_PREFIX}/tags", tags=["tags"])

# Phase 3. `/settings` is the owner's own organisation row - there is no id in the path, so the
# only organisation reachable is the one on the verified token.
#
# `/templates` carries THREE different permissions across its four routes: reading is
# messages.send so whoever answers the lead can reach for a saved quote, generating is
# ai.generate because it costs an LLM call, and writing is templates.manage because these go out
# verbatim under the studio's name. The gates are per route, as they are in Node.
app.include_router(settings_router.router, prefix=f"{API_PREFIX}/settings", tags=["settings"])
app.include_router(templates.router, prefix=f"{API_PREFIX}/templates", tags=["templates"])

# Phase 4. `/contacts` is the only path by which a customer's phone number leaves this backend.
# Reading a contact needs conversations.read and returns NO phone at all; revealing one needs
# client_pii.reveal, decrypts the AES-256-GCM envelope Node wrote, and writes an audit row whose
# metadata carries ids and a field name but never the number itself.
app.include_router(contacts.router, prefix=f"{API_PREFIX}/contacts", tags=["contacts"])

# `/users` writes `permissionOverrides`, which is the input to `resolve_user_permissions` - so a
# defect here changes authorization across every other route in the service. Disable and
# reset-password revoke refresh sessions in the SAME transaction as the status change: half of
# that pair leaves a departed employee working until their access token expires.
app.include_router(users.router, prefix=f"{API_PREFIX}/users", tags=["users"])

# Phase 5. Seven read-only routes, all gated on conversations.read and nothing stricter: every
# number is a count of conversations the caller can already open one at a time, and the scope
# narrows each query to exactly the set their inbox shows.
#
# /attention.csv is the SECOND path by which a customer phone number can leave this backend.
# It carries the same obligations as the first: the client_pii.reveal permission, and one audit
# entry per request when a number is actually decrypted.
app.include_router(analytics.router, prefix=f"{API_PREFIX}/analytics", tags=["analytics"])

# Phase 6. THE TRUST MODEL CHANGES HERE: this service now ISSUES access tokens rather than only
# verifying them, so a session created by /auth/login is read by Node's auth.middleware.ts on
# the very next Node-served request. Both sides must agree about the claim set, the SHA-256
# refresh-token hash and the cookie attributes - a disagreement is every user logged out with a
# correct password.
#
# Reuse of a rotated refresh token revokes the WHOLE FAMILY, not just the presented session:
# revoking one would leave a thief's newer token working.
app.include_router(auth_router.router, prefix=f"{API_PREFIX}/auth", tags=["auth"])

# Phase 7. `/push` registers handsets and reports configuration; it SENDS NOTHING - the FCM
# delivery path moves in Phase 8 with the reminder runner that calls it.
#
# `/realtime` can move WITHOUT its outbox runner because the fan-out is already cross-process:
# the publisher writes to the Redis channel `realtime:events` and both services subscribe. A
# client held by this service receives events Node publishes, and during the transition both
# hubs hold clients and both receive everything. Two deliverers is fan-out, not double-sending.
app.include_router(push.router, prefix=f"{API_PREFIX}/push", tags=["push"])
app.include_router(realtime.router, prefix=f"{API_PREFIX}/realtime", tags=["realtime"])

# Phase 9. `/conversations/:id/notes` is the first module the visibility gate unblocks - every
# route begins by calling `load_visible_conversation_for_actor`, which is why notes sat in this
# phase from the start.
#
# TWO PERMISSION SYSTEMS APPLY AND THEY ARE NOT THE SAME QUESTION. The gate decides whether the
# caller can see the CONVERSATION; their ROLE decides which NOTES on it they can see. A
# manager's note about how a staff member handled a lead must not be readable by that staff
# member, even though they own the thread.
#
# NOTE: the Caddy cutover for `/api/v1/conversations*` moves the main conversation router AND
# every nested router with it - notes, tags, follow-ups, calls. They cannot be split by path.
app.include_router(
    notes.router,
    prefix=f"{API_PREFIX}/conversations/{{conversationId}}/notes",
    tags=["notes"],
)

# Phase 9. The SECOND router in Node's tag.routes.ts. The first (/api/v1/tags, the catalogue)
# went in Phase 2; this one waited for the visibility gate, run_in_transaction and the activity
# log.
#
# Two permissions apply and they are different questions: `crm.tags.manage` asks whether the
# caller may change tags at all, the gate asks whether they may touch THIS conversation. Note
# that no DEFAULT role can reach the gate's 403 here - every role holding crm.tags.manage also
# holds conversations.read_all. The branch is live only for a staff member granted tag
# management through a permission override.
app.include_router(
    conversation_tags.router,
    prefix=f"{API_PREFIX}/conversations/{{conversationId}}/tags",
    tags=["conversation-tags"],
)

# Phase 9. Calls come in TWO mounts and the flat one is the deployment trap.
#
# `/conversations/:id/calls` is nested and moves with the conversations Caddy block.
# `/api/v1/calls/:callId` is FLAT - gated by exactly the same conversation rules, but not under
# `/api/v1/conversations`. A cutover written as a single `/api/v1/conversations*` block moves the
# nested router and silently leaves these two routes on Node. They need their own
# `/api/v1/calls*` block in the SAME window, or a call opened in Python cannot be fetched back.
#
# Still on Node: POST /conversations/:id/call-outcome (conversationCallOutcomeRouter). It moves a
# reminder and recomputes the next-reminder hint, which live in modules/followups.
app.include_router(
    calls.conversation_router,
    prefix=f"{API_PREFIX}/conversations/{{conversationId}}/calls",
    tags=["calls"],
)
app.include_router(calls.router, prefix=f"{API_PREFIX}/calls", tags=["calls"])

# Phase 8's leftover, landed in Phase 9 because it needed the visibility gate and the activity
# log. Two mounts, like calls:
#
#   /conversations/:id/follow-ups   nested, moves with the conversations Caddy block
#   /api/v1/follow-ups              FLAT - needs its own `/api/v1/follow-ups*` block
#
# `/follow-ups/tasks` and `/follow-ups/sync` are LITERAL paths registered ahead of every
# `/{taskId}` route inside the router itself. FastAPI matches in registration order, so putting
# a parameterised route first would turn the Android device sync into a 400 about a malformed
# ObjectId - a failure nobody sees until an owner's phone stops ringing.
app.include_router(
    followups.conversation_router,
    prefix=f"{API_PREFIX}/conversations/{{conversationId}}/follow-ups",
    tags=["follow-ups"],
)
app.include_router(followups.router, prefix=f"{API_PREFIX}/follow-ups", tags=["follow-ups"])

# Phase 9. The THIRD router in Node's calls module, deferred until followups was ported because
# one owner answer moves three records: the call row, the conversation's stage AND AI mode, and
# the reminder.
#
# CONVERSATION-SCOPED, NOT CALL-SCOPED, which is why it is separate from PATCH /calls/:id/outcome.
# The owner frequently rings a lead from their own handset off the back of a reminder
# notification, so there is no call row to hang the answer on - this one creates it. A
# call-scoped route has no way in for that case, and the calls that mattered enough to be
# reminded about would be exactly the ones missing from the history.
app.include_router(
    call_outcome.router,
    prefix=f"{API_PREFIX}/conversations/{{conversationId}}/call-outcome",
    tags=["calls"],
)

# Phase 9. Media attachments:
#   POST /conversations/:id/media   nested, stages attachments for a conversation
#   GET  /messages/:id/media        flat, authenticated attachment streaming with security headers
app.include_router(
    media.conversation_router,
    prefix=f"{API_PREFIX}/conversations/{{conversationId}}/media",
    tags=["media"],
)
app.include_router(
    media.router,
    prefix=f"{API_PREFIX}/messages",
    tags=["media"],
)

# Phase 9. Core conversations routes:
#   GET    /conversations                  listing with stage/tag/status/search/classification filters
#   POST   /conversations                  manual lead creation
#   GET    /conversations/meta/ai-categories  selectable playbooks
#   GET    /conversations/:id              conversation detail + contact + account summary
#   GET    /conversations/:id/messages     cursor-paginated message listing
#   GET    /conversations/:id/activity     activity audit log
#   GET    /conversations/:id/lead-submissions form submissions
#   GET    /conversations/:id/summary      stored AI summary
#   POST   /conversations/:id/summary      regenerate summary
#   PATCH  /conversations/:id/assignment   assign conversation
#   PATCH  /conversations/:id/stage        change sales stage
#   PATCH  /conversations/:id/category     change AI playbook
#   DELETE /conversations/:id              soft delete
#   POST   /conversations/:id/restore      restore chat
#   POST   /conversations/:id/messages     enqueue outbound send
app.include_router(
    conversations.router,
    prefix=f"{API_PREFIX}/conversations",
    tags=["conversations"],
)

# Phase 9. Lead Sources: Google Sheets & Meta Lead Ads configuration (17 routes)
app.include_router(
    lead_sources.router,
    prefix=f"{API_PREFIX}/lead-sources",
    tags=["lead-sources"],
)

# Phase 9. Public Meta endpoints (Facebook OAuth callback & leadgen webhooks - 3 routes)
app.include_router(
    meta.router,
    prefix=f"{API_PREFIX}/meta",
    tags=["meta"],
)

# Phase 9. AI Knowledge Base: ground truths and constraints for AI drafts (6 routes)
app.include_router(
    ai_knowledge.router,
    prefix=f"{API_PREFIX}/ai/knowledge",
    tags=["ai-knowledge"],
)

# Phase 10. AI Brain: draft review, approvals, automation toggles, outcome classifier & proposals (9 routes)
app.include_router(
    ai_brain.router,
    prefix=f"{API_PREFIX}/ai-brain",
    tags=["ai-brain"],
)

# Phase 11. WhatsApp Accounts: numbers management, lifecycle, QR/pairing, sendable listing (11 routes)
app.include_router(
    whatsapp_accounts.router,
    prefix=f"{API_PREFIX}/whatsapp-accounts",
    tags=["whatsapp-accounts"],
)







@app.get(f"{API_PREFIX}/health")
async def liveness() -> dict:
    """
    Is the process up.

    Deliberately touches no dependency. Liveness answers "should this container be restarted",
    and restarting the API because Redis is down would take down the half that still works.
    Readiness below is where dependencies are reported.
    """
    return {
        "data": {"status": "ok", "service": SERVICE_NAME},
        "meta": {"environment": settings.node_env},
    }


@app.get(f"{API_PREFIX}/health/readiness")
async def readiness() -> JSONResponse:
    """
    Is it safe to send this service traffic.

    503 when it is not, matching the Node backend: a readiness probe that returns 200 while a
    dependency is down is a probe that cannot be used to gate anything.
    """
    mongodb = await db.get_status()
    redis = await cache.get_status()

    ready = bool(mongodb["ready"]) and bool(redis["ready"])

    return JSONResponse(
        status_code=200 if ready else 503,
        content={
            "data": {
                "status": "ready" if ready else "not_ready",
                "service": SERVICE_NAME,
                "dependencies": {"mongodb": mongodb, "redis": redis},
            },
            "meta": {"environment": settings.node_env},
        },
    )
