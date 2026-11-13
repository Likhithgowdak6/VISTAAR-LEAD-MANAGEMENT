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

from bson import ObjectId

from app import db
from app.analytics_scope import AnalyticsScope
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


class MissingOrganizationScope(RuntimeError):
    """The caller's scope carries no usable organisation. Retrieval must not proceed."""


def _require_organization(scope: AnalyticsScope) -> ObjectId:
    """
    The organisation, or a refusal. Never a query that matches everything.

    WHY THIS EXISTS NOW AND DID NOT BEFORE. `resolve_analytics_scope` passes
    `organization_id` straight through without validating it, and MongoDB treats
    `{"organizationId": None}` as *matches documents where the field is null or absent* — not
    as "matches nothing".

    While retrieval enumerated conversations first, a missing organisation produced an empty
    conversation list and therefore an empty result: safe, but safe **by accident**. The admin
    path has no second filter, so that accident is gone and the guard has to be explicit.

    Raising rather than returning `[]` is deliberate. `retrieve_background` already catches
    everything and degrades to no background, so production fails safe either way — but a
    silent empty result would hide the bug, and a raised error names it in the logs and fails
    a test.
    """
    organization_id = getattr(scope, "organization_id", None)

    if isinstance(organization_id, ObjectId):
        return organization_id

    # A string id is the realistic malformed case: it comes from a token claim and reaches
    # Mongo as a *string*, which never equals a stored ObjectId — so the query silently
    # returns nothing rather than failing. Converted when valid, refused when not.
    try:
        return ObjectId(str(organization_id))
    except Exception as error:
        raise MissingOrganizationScope(
            "Retrieval refused: the caller's scope carries no usable organisation id."
        ) from error


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

        scope = resolve_tool_scope(context)
        organization_id = _require_organization(scope)

        if scope.assigned_to is None:
            # THE ADMIN PATH. A caller with `read_all` may read every conversation in the
            # organisation, so enumerating them first bought nothing except a cap: beyond
            # `MAX_SCOPED_CONVERSATIONS` the remainder became unreachable, silently. Filtering
            # messages on `organizationId` directly is the SAME boundary expressed in one
            # fewer step, and `SCAN_LIMIT` still bounds the work.
            #
            # Two things the enumeration used to provide must be replaced, and both are handled
            # after ranking by `_resolve_conversations`: display names, and the exclusion of
            # messages belonging to deleted conversations.
            rows = await self._organisation_messages(organization_id)
            visible: dict[Any, str] = {}
        else:
            # THE RESTRICTED PATH, unchanged. A staff member's slice is *defined* by which
            # conversations are assigned to them, so the list is the scope and there is no
            # equivalent shortcut. `MAX_SCOPED_CONVERSATIONS` still applies here, where it caps
            # one person's own assigned leads rather than a whole organisation.
            visible = await self._visible_conversations(scope, organization_id)

            if not visible:
                return []

            rows = await self._candidate_messages(organization_id, list(visible))

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

        wanted_count = max(1, min(top_k, 20))

        if scope.assigned_to is not None:
            # The restricted path already knows every conversation is live and named.
            return [
                self._to_passage(row, score, visible)
                for score, row in scored[:wanted_count]
            ]

        # OVER-FETCH, THEN FILTER. The admin path has not yet excluded deleted conversations,
        # so some top-scoring messages drop out here; taking only `wanted_count` candidates
        # would then return fewer passages than asked for. Three times covers any realistic
        # proportion of deleted threads without a second round trip.
        candidates = scored[: wanted_count * 3]
        names = await self._resolve_conversations(
            organization_id, [row.get("conversationId") for _, row in candidates]
        )

        passages = [
            self._to_passage(row, score, names)
            for score, row in candidates
            if row.get("conversationId") in names
        ]

        return passages[:wanted_count]

    async def _visible_conversations(
        self, scope: AnalyticsScope, organization_id: ObjectId
    ) -> dict[Any, str]:
        """
        The conversations a RESTRICTED caller may read, as `{_id: displayName}`.

        THE SCOPE GATE for anyone without `read_all`. The scope comes from `resolve_tool_scope`,
        the same function the tools use, so a staff member's retrieval cannot reach a
        colleague's thread. Restating the rule here would be a third copy of something that
        must not drift.
        """
        query: dict[str, Any] = {
            "organizationId": organization_id,
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

    async def _organisation_messages(
        self, organization_id: ObjectId
    ) -> list[dict[str, Any]]:
        """
        Every message in the organisation, most recent first, bounded by `SCAN_LIMIT`.

        ONLY REACHED WITH `read_all`. The organisation filter is the entire boundary here,
        which is why `_require_organization` runs before this is called: `{"organizationId":
        None}` matches documents where the field is null or absent, and without the
        conversation enumeration there is no second filter left to catch it.
        """
        cursor = (
            db.get_database()[MESSAGES]
            .find({"organizationId": organization_id})
            .sort("sentAt", -1)
            .limit(SCAN_LIMIT)
        )

        return [row async for row in cursor]

    async def _resolve_conversations(
        self, organization_id: ObjectId, conversation_ids: list[Any]
    ) -> dict[Any, str]:
        """
        Display names for the ranked candidates, and the deleted-conversation filter.

        Both jobs in one indexed query. A conversation that is deleted, or belongs to another
        organisation, simply does not come back — and `search` drops any message whose
        conversation is absent from this map. That is how the admin path keeps the
        `deletedAt: None` exclusion the enumeration used to provide.
        """
        unique = [cid for cid in dict.fromkeys(conversation_ids) if cid is not None]

        if not unique:
            return {}

        cursor = db.get_database()[CONVERSATIONS].find(
            {
                "_id": {"$in": unique},
                # Belt and braces: the messages were already organisation-filtered, but a
                # conversation id is a guessable 24-hex value and this costs one indexed field.
                "organizationId": organization_id,
                "deletedAt": None,
            },
            {"_id": 1, "displayName": 1},
        )

        return {row["_id"]: row.get("displayName") or "Unknown" async for row in cursor}

    async def _candidate_messages(
        self, organization_id: ObjectId, conversation_ids: list[Any]
    ) -> list[dict[str, Any]]:
        cursor = (
            db.get_database()[MESSAGES]
            .find(
                {
                    # Both filters, not just the conversation list: a conversation id is a
                    # guessable 24-hex value, and defence against a stale or wrong id list
                    # costs one indexed field.
                    "organizationId": organization_id,
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
