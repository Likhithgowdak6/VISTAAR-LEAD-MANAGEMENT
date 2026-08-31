"""
The conversation graph - ported from vistaar-agent's app/agent/graph.py.

    entry
      │
      ▼
   qualify ──ask──────► send_question ──► END (wait for the lead's reply)
      │  │
      │  └─escalate──► escalate ──────► END (a human takes over)
      ▼ ready
  draft_response
      │
      ▼
  owner_approval  ◄─────────┐   <-- interrupt(): frozen until wam-crm-ai
      │                     │       reports what the human decided
      ├─ approve ─► dispatch_approved ─► END
      ├─ edit ────► revise_draft ───────┘
      └─ skip ────► skipped ─► END

Same shape as the original. What changed: the checkpoint store. The
original used Postgres because it was already running one for its own
lead/message tables. This service has no such tables, so it defaults to an
in-memory checkpointer (fine for local dev and tests - conversations are
forgotten on restart) and only reaches for Postgres when DATABASE_URL is
actually set, which is what you'd point at a small dedicated database in
production. Either way, this database holds nothing but "which step is
conversation X on" - no business data.
"""

import logging
import os
import threading

from langgraph.graph import END, START, StateGraph

from app import nodes
from app.config import settings
from app.state import ConversationState

log = logging.getLogger(__name__)


def _after_qualify(state: ConversationState) -> str:
    return {"ask": "send_question", "ready": "draft_response", "escalate": "escalate"}.get(
        state.get("decision", "ask"), "send_question"
    )


def _after_approval(state: ConversationState) -> str:
    return {
        "approve": "dispatch_approved",
        "edit": "revise_draft",
        "skip": "skipped",
    }.get(state.get("owner_verdict") or "skip", "skipped")


def build_graph():
    g = StateGraph(ConversationState)

    g.add_node("qualify", nodes.qualify)
    g.add_node("send_question", nodes.send_question)
    g.add_node("draft_response", nodes.draft_response)
    g.add_node("owner_approval", nodes.owner_approval)
    g.add_node("revise_draft", nodes.revise_draft)
    g.add_node("dispatch_approved", nodes.dispatch_approved)
    g.add_node("skipped", nodes.skipped)
    g.add_node("escalate", nodes.escalate)

    g.add_edge(START, "qualify")
    g.add_conditional_edges("qualify", _after_qualify)
    g.add_edge("send_question", END)
    g.add_edge("escalate", END)
    g.add_edge("draft_response", "owner_approval")
    g.add_conditional_edges("owner_approval", _after_approval)
    g.add_edge("revise_draft", "owner_approval")
    g.add_edge("dispatch_approved", END)
    g.add_edge("skipped", END)

    return g


_cache: dict = {"pid": None, "graph": None, "cm": None}
_lock = threading.Lock()


def _make_checkpointer():
    if not settings.database_url:
        from langgraph.checkpoint.memory import MemorySaver

        log.warning(
            "DATABASE_URL not set - using an in-memory checkpointer. "
            "Conversations paused for approval will be forgotten if this "
            "process restarts. Fine for local dev; set DATABASE_URL in "
            "production."
        )
        return MemorySaver(), None

    from langgraph.checkpoint.postgres import PostgresSaver
    from psycopg.rows import dict_row
    from psycopg_pool import ConnectionPool

    conninfo = settings.database_url.replace("postgresql+psycopg://", "postgresql://")
    pool = ConnectionPool(
        conninfo=conninfo,
        min_size=1,
        max_size=5,
        kwargs={"autocommit": True, "prepare_threshold": 0,
                "row_factory": dict_row, "connect_timeout": 5},
        check=ConnectionPool.check_connection,
        timeout=10,
        max_idle=300,
        open=True,
    )
    saver = PostgresSaver(pool)
    saver.setup()
    return saver, pool


def compiled():
    """The compiled graph for this process. Rebuilt if the process forked."""
    pid = os.getpid()
    cached = _cache["graph"]
    if cached is not None and _cache["pid"] == pid:
        return cached

    with _lock:
        if _cache["graph"] is not None and _cache["pid"] == pid:
            return _cache["graph"]

        saver, pool = _make_checkpointer()
        _cache.update(pid=pid, cm=pool, graph=build_graph().compile(checkpointer=saver))
        return _cache["graph"]


def thread_config(conversation_id: str) -> dict:
    return {"configurable": {"thread_id": f"conversation-{conversation_id}"}}


def pending_interrupt(conversation_id: str) -> dict | None:
    """What the graph is currently waiting on for this conversation, if anything."""
    snapshot = compiled().get_state(thread_config(conversation_id))
    if not snapshot.tasks:
        return None
    for task in snapshot.tasks:
        if task.interrupts:
            return task.interrupts[0].value
    return None
