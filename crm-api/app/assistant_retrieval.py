"""
Retrieval over historical CRM conversation text, for the assistant's background context.

----------------------------------------------------------------------------------------------
THE RISK THIS MODULE IS, BEFORE THE VALUE IT ADDS
----------------------------------------------------------------------------------------------
Every other path to conversation text goes through `conversation_access`, which enforces that a
staff member sees only their own assigned threads. **Retrieval is a second path to the same
text**, and it does not go through a tool — the result is injected straight into the model's
prompt as background.

So if retrieval were scoped to the organisation only, *"what did we agree about December?"*
would quietly return a colleague's conversation, the model would summarise it, and every Stage 1
guarantee would be bypassed by a feature that looks like a search box. Nothing would error.

**`search` therefore takes a `ToolContext` and applies the same scope resolver the tools use.**
It is not optional and there is no organisation-only variant to call by mistake.

----------------------------------------------------------------------------------------------
WHAT IS AND IS NOT IMPLEMENTED
----------------------------------------------------------------------------------------------
**Implemented: a replaceable retriever abstraction with a lexical backend.** `Retriever` is the
interface; `LexicalRetriever` scores on term overlap with a length normalisation, in pure
Python, with the scope applied as a MongoDB query filter so isolation uses the same mechanism as
everything else in this service.

**NOT implemented: dense/embedding retrieval.** The agreed plan was a local multilingual model
(`paraphrase-multilingual-MiniLM-L12-v2`, ~470 MB with torch) benchmarked before adoption.
`numpy`, `torch` and `sentence-transformers` are **not installed** in this service, and adding
them on the strength of an un-run benchmark — to a host that has already been memory-constrained
— is the decision that was explicitly deferred. `EmbeddingRetriever` is the seam where it goes:
implement `search`, register it, change `get_retriever`. Nothing else in the assistant changes.

Lexical retrieval is not a placeholder standing in for the real thing. For *"what did we agree
about the December date"* over WhatsApp threads it is a reasonable baseline, it handles the
mixed English/Hindi/transliterated text here without a model that was trained on any particular
one, and it is the honest thing to benchmark the dense version against.

----------------------------------------------------------------------------------------------
IT DOES NOT REPLACE LIVE QUERIES
----------------------------------------------------------------------------------------------
Retrieval answers "what was said before". It never answers "how many leads are hot" — that is a
live tool call against current data, and a stale indexed answer to a counting question would be
confidently wrong. The orchestrator passes retrieval output as *background*, clearly labelled,
and the tools remain the only source of facts.
"""

from __future__ import annotations

import math
import re
from collections import Counter
from datetime import datetime
from typing import Any, NamedTuple, Protocol

from app import db
from app.assistant_tools import ToolContext, resolve_tool_scope
from app.message_direction import is_inbound

CONVERSATIONS = "conversations"
MESSAGES = "messages"

#: Passages returned for one question. Enough to be useful, few enough that the model's context
#: stays dominated by live tool results rather than by history.
DEFAULT_TOP_K = 4

#: Characters of one passage. A WhatsApp message is usually well under this.
MAX_PASSAGE_CHARS = 600

#: Conversations the scope gate enumerates per question, most recently active first.
#:
#: A hard ceiling on a per-question query, not a product limit anybody chose. Documented at the
#: call site: beyond this, older history stops being retrievable.
MAX_SCOPED_CONVERSATIONS = 500

#: Messages scanned per question. Scoring is in-process, so this bounds the work — a studio with
#: 200k messages must not turn one question into a full-collection scan.
SCAN_LIMIT = 1500

#: Terms this common carry no signal and would dominate overlap scoring.
#:
#: English and romanised Hindi together, matching how the customers here actually write. The
#: list is deliberately short: an aggressive stop list on short WhatsApp messages removes the
#: message.
STOP_WORDS = frozenset(
    """
    a an and are as at be but by for from has have he her his i if in is it its me my of on
    or our she that the their them they this to too us was we were what when where which who
    will with you your
    hai hain ho hoga hu hum ka ke ki ko kya mai main me mera meri na nahi ne par pe se tha the
    to tum ye yeh
    """.split()
)

_WORD = re.compile(r"[a-z0-9ऀ-ॿ]+")


class Passage(NamedTuple):
    """One retrieved fragment, with enough provenance to cite it."""

    text: str
    conversation_id: str
    display_name: str
    message_id: str | None
    sent_at: str | None
    score: float
    speaker: str

    def render(self) -> str:
        when = f" on {self.sent_at[:10]}" if self.sent_at else ""

        return f"[{self.display_name}{when}] {self.speaker}: {self.text}"


def tokenize(text: Any) -> list[str]:
    """Lowercased word tokens, stop words dropped. Devanagari is kept as-is."""
    return [t for t in _WORD.findall(str(text or "").lower()) if t not in STOP_WORDS]


class Retriever(Protocol):
    """
    The seam a dense/embedding backend slots into.

    `search` takes the caller's `ToolContext` rather than an organisation id, for the same
    reason no tool takes one: it is the only way the permission scope can be guaranteed to come
    from the session.
    """

    async def search(
        self, *, query: str, context: ToolContext, top_k: int = DEFAULT_TOP_K
    ) -> list[Passage]:
        ...


class LexicalRetriever:
    """
    Term-overlap retrieval with inverse-document-frequency weighting.

    Not a vector search and not pretending to be. Rare terms score higher than common ones, and
    a long message does not outrank a short one merely by containing more words.
    """

    async def search(
        self, *, query: str, context: ToolContext, top_k: int = DEFAULT_TOP_K
    ) -> list[Passage]:
        terms = tokenize(query)

        if not terms:
            return []

        visible = await self._visible_conversations(context)

        if not visible:
            return []

        rows = await self._candidate_messages(context, list(visible))

        if not rows:
            return []

        documents = [(row, tokenize(row.get("body"))) for row in rows]
        documents = [(row, tokens) for row, tokens in documents if tokens]

        if not documents:
            return []

        idf = self._idf([tokens for _, tokens in documents])
        wanted = set(terms)

        scored: list[tuple[float, dict[str, Any]]] = []

        for row, tokens in documents:
            counts = Counter(tokens)
            overlap = wanted & counts.keys()

            if not overlap:
                continue

            # Length normalisation by sqrt, not by raw length: dividing by the token count
            # would make a two-word message beat a precise ten-word one on a single hit.
            score = sum(idf.get(term, 0.0) * (1 + math.log(counts[term])) for term in overlap)
            score /= math.sqrt(len(tokens)) or 1.0

            scored.append((score, row))

        scored.sort(key=lambda pair: pair[0], reverse=True)

        return [
            self._to_passage(row, score, visible)
            for score, row in scored[: max(1, min(top_k, 20))]
        ]

    async def _visible_conversations(self, context: ToolContext) -> dict[Any, str]:
        """
        The conversations this caller may read, as `{_id: displayName}`.

        THE SCOPE GATE. Resolved through `resolve_tool_scope`, the same function the tools use,
        so a staff member's retrieval cannot reach a colleague's thread. Restating the rule here
        would be a third copy of something that must not drift.
        """
        scope = resolve_tool_scope(context)

        query: dict[str, Any] = {
            "organizationId": scope.organization_id,
            "deletedAt": None,
        }

        if scope.assigned_to is not None:
            query["assignedTo"] = scope.assigned_to

        # SORTED, so the cap is the most recently active conversations rather than an
        # arbitrary 500. A studio with more than `MAX_SCOPED_CONVERSATIONS` leads would
        # otherwise have retrieval silently cover whichever ones the driver happened to return
        # — partial in a way nothing surfaces, and different between two identical questions.
        #
        # This is a KNOWN LIMITATION, not a solved problem: beyond this many conversations,
        # older history stops being retrievable. Recency is the right bias for "what did we
        # agree" and the live tools remain unaffected, but a dense backend over a real index
        # would remove the cap rather than order it.
        cursor = (
            db.get_database()[CONVERSATIONS]
            .find(query, {"_id": 1, "displayName": 1})
            .sort("lastMessageAt", -1)
            .limit(MAX_SCOPED_CONVERSATIONS)
        )

        return {row["_id"]: row.get("displayName") or "Unknown" async for row in cursor}

    async def _candidate_messages(
        self, context: ToolContext, conversation_ids: list[Any]
    ) -> list[dict[str, Any]]:
        cursor = (
            db.get_database()[MESSAGES]
            .find(
                {
                    # Both filters, not just the conversation list: a conversation id is a
                    # guessable 24-hex value, and defence against a stale or wrong id list
                    # costs one indexed field.
                    "organizationId": context.organization_id,
                    "conversationId": {"$in": conversation_ids},
                }
            )
            .sort("sentAt", -1)
            .limit(SCAN_LIMIT)
        )

        return [row async for row in cursor]

    @staticmethod
    def _idf(documents: list[list[str]]) -> dict[str, float]:
        total = len(documents)
        seen: Counter = Counter()

        for tokens in documents:
            seen.update(set(tokens))

        return {
            term: math.log(1 + (total - count + 0.5) / (count + 0.5))
            for term, count in seen.items()
        }

    @staticmethod
    def _to_passage(row: dict[str, Any], score: float, visible: dict[Any, str]) -> Passage:
        sent_at = row.get("sentAt") or row.get("createdAt")
        body = " ".join(str(row.get("body") or "").split())

        return Passage(
            text=body[:MAX_PASSAGE_CHARS],
            conversation_id=str(row.get("conversationId")),
            display_name=visible.get(row.get("conversationId"), "Unknown"),
            message_id=str(row.get("_id")) if row.get("_id") else None,
            sent_at=sent_at.isoformat() if isinstance(sent_at, datetime) else None,
            score=round(score, 4),
            speaker="customer" if is_inbound(row) else "us",
        )


_retriever: Retriever = LexicalRetriever()


def get_retriever() -> Retriever:
    """The single place a dense backend would be swapped in."""
    return _retriever


async def retrieve_background(
    *, query: str, context: ToolContext, top_k: int = DEFAULT_TOP_K
) -> str:
    """
    Retrieved history as one labelled block, or `""`.

    Returns a string rather than objects because the orchestrator's job is to hand the model
    *background*, not a second set of facts competing with the tools. Empty when nothing scores,
    so an irrelevant question adds no noise and costs no tokens.
    """
    try:
        passages = await get_retriever().search(query=query, context=context, top_k=top_k)
    except Exception:  # noqa: BLE001
        # Retrieval is an enhancement. A failure here must not take down a question that the
        # live tools could have answered perfectly well on their own.
        return ""

    return "\n".join(passage.render() for passage in passages)
