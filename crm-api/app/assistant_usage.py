"""
What the assistant costs, from the provider's own numbers.

----------------------------------------------------------------------------------------------
NOTHING HERE IS ESTIMATED
----------------------------------------------------------------------------------------------
Token counts come from Anthropic's `usage` block on each response, passed through
`ai-brain-service` untouched. They are never derived from string length: that is off by a wide,
model-dependent margin, and a usage page built on an estimate is worse than no usage page
because it looks authoritative while being wrong.

**COST IS ZERO UNTIL SOMEBODY CONFIGURES THE RATES.** `ASSISTANT_INPUT_COST_PER_MTOK` and
`ASSISTANT_OUTPUT_COST_PER_MTOK` default to 0, so `estimatedCost` reads 0 and `costConfigured`
reads false until the owner enters the rates from their own Anthropic invoice. Shipping a
hardcoded price would be inventing a number — published rates change, vary by plan, and the
figure would quietly become wrong without anything failing.

----------------------------------------------------------------------------------------------
THIS IS NOT BILLING
----------------------------------------------------------------------------------------------
One row per answered question and a grouped read. No invoices, no quotas, no reconciliation
against the provider's statement. The question it answers is *"is the assistant costing more
than we expected, and who is using it"* — enough to notice a problem, deliberately not enough
to charge anybody.

A usage write failing must never cost somebody their answer, for the same reason as the audit
log: the assistant is read-only and the data was already visible to the caller. Failures are
logged, not raised.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any

from bson import ObjectId

from app import db
from app.config import settings

logger = logging.getLogger("crm-api.assistant-usage")

COLLECTION = "assistantusage"

#: A million, as the unit provider pricing is quoted in.
TOKENS_PER_MTOK = 1_000_000


def empty_usage() -> dict[str, int]:
    return {
        "inputTokens": 0,
        "outputTokens": 0,
        "cacheReadTokens": 0,
        "cacheCreationTokens": 0,
        "modelCalls": 0,
    }


def accumulate(total: dict[str, int], turn_usage: dict[str, Any] | None) -> dict[str, int]:
    """
    Add one model call's usage to a running total.

    TOTAL AND NEVER RAISES. This runs inside the answer loop; a malformed or absent usage block
    must cost the accounting, not the answer. A missing `usage` still increments `modelCalls`,
    because the call demonstrably happened — recording zero calls would understate the thing
    this module exists to measure.
    """
    total["modelCalls"] = total.get("modelCalls", 0) + 1

    if not isinstance(turn_usage, dict):
        return total

    for key in ("inputTokens", "outputTokens", "cacheReadTokens", "cacheCreationTokens"):
        value = turn_usage.get(key)

        if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
            total[key] = total.get(key, 0) + value

    return total


def estimate_cost(usage: dict[str, int]) -> float:
    """
    Cost in the rates' own currency, or 0.0 when none are configured.

    Cache reads are billed at a fraction of the input rate and cache writes at a premium, and
    those multipliers differ by model. Rather than encode a ratio that would silently rot, this
    counts cache reads at the input rate and ignores the cache-creation premium — so a
    cache-heavy workload is OVER-estimated on reads and UNDER-estimated on writes. Named
    `estimatedCost` for that reason, and documented here rather than left for somebody to
    discover from a discrepancy against an invoice.
    """
    if not settings.assistant_input_cost_per_mtok and not settings.assistant_output_cost_per_mtok:
        return 0.0

    billable_input = (
        usage.get("inputTokens", 0)
        + usage.get("cacheReadTokens", 0)
        + usage.get("cacheCreationTokens", 0)
    )

    input_cost = (billable_input / TOKENS_PER_MTOK) * settings.assistant_input_cost_per_mtok
    output_cost = (
        usage.get("outputTokens", 0) / TOKENS_PER_MTOK
    ) * settings.assistant_output_cost_per_mtok

    return round(input_cost + output_cost, 6)


def cost_is_configured() -> bool:
    return bool(
        settings.assistant_input_cost_per_mtok or settings.assistant_output_cost_per_mtok
    )


async def ensure_assistant_usage_indexes() -> None:
    """
    Supports the only two reads: a summary for one organisation over a window, and the same
    grouped by user. Both filter on `(organizationId, createdAt)`.
    """
    await db.get_database()[COLLECTION].create_index(
        [("organizationId", 1), ("createdAt", -1)],
        name="assistant_usage_org_recent",
    )


async def record_usage(
    *,
    organization_id: Any,
    user_id: Any,
    thread_id: Any,
    usage: dict[str, int],
    stopped_early: bool = False,
) -> None:
    """One row per answered question. Logged and swallowed on failure."""
    try:
        await db.get_database()[COLLECTION].insert_one(
            {
                "organizationId": organization_id,
                "userId": user_id,
                "threadId": thread_id,
                "inputTokens": usage.get("inputTokens", 0),
                "outputTokens": usage.get("outputTokens", 0),
                "cacheReadTokens": usage.get("cacheReadTokens", 0),
                "cacheCreationTokens": usage.get("cacheCreationTokens", 0),
                "modelCalls": usage.get("modelCalls", 0),
                "estimatedCost": estimate_cost(usage),
                "stoppedEarly": bool(stopped_early),
                "createdAt": datetime.now(timezone.utc),
            }
        )
    except Exception as error:  # noqa: BLE001 - see the module docstring
        logger.error(
            "ASSISTANT_USAGE: failed to record usage for org=%s (%s). The question was "
            "answered; this row is missing.",
            organization_id, type(error).__name__,
        )


async def summarize(
    *, organization_id: Any, days: int = 30
) -> dict[str, Any]:
    """
    Totals for one organisation over a window, plus a per-user breakdown.

    ORGANISATION-SCOPED IN THE QUERY, never as a follow-up filter. The caller's organisation
    comes from their session, exactly as it does for every assistant tool — a usage page is
    still a view onto who-did-what and must not cross the boundary.
    """
    since = datetime.now(timezone.utc) - timedelta(days=max(1, min(int(days), 365)))
    match = {"organizationId": organization_id, "createdAt": {"$gte": since}}

    database = db.get_database()

    totals = {
        "requests": 0,
        "modelCalls": 0,
        "inputTokens": 0,
        "outputTokens": 0,
        "estimatedCost": 0.0,
    }
    per_user: dict[Any, dict[str, Any]] = {}

    # Summed in Python rather than with $group. The volume is one row per question and this
    # avoids a second aggregation shape to keep working under mongomock, which does not
    # implement every operator - the route tests run against it.
    async for row in database[COLLECTION].find(match):
        totals["requests"] += 1
        totals["modelCalls"] += row.get("modelCalls", 0) or 0
        totals["inputTokens"] += row.get("inputTokens", 0) or 0
        totals["outputTokens"] += row.get("outputTokens", 0) or 0
        totals["estimatedCost"] += row.get("estimatedCost", 0.0) or 0.0

        user_id = row.get("userId")
        bucket = per_user.setdefault(
            user_id,
            {"userId": str(user_id) if user_id else None, "requests": 0,
             "modelCalls": 0, "inputTokens": 0, "outputTokens": 0, "estimatedCost": 0.0},
        )
        bucket["requests"] += 1
        bucket["modelCalls"] += row.get("modelCalls", 0) or 0
        bucket["inputTokens"] += row.get("inputTokens", 0) or 0
        bucket["outputTokens"] += row.get("outputTokens", 0) or 0
        bucket["estimatedCost"] += row.get("estimatedCost", 0.0) or 0.0

    totals["estimatedCost"] = round(totals["estimatedCost"], 6)

    users = sorted(per_user.values(), key=lambda row: row["requests"], reverse=True)

    for user in users:
        user["estimatedCost"] = round(user["estimatedCost"], 6)

    return {
        "windowDays": days,
        "since": since.isoformat(),
        "totals": totals,
        "byUser": users,
        # So the UI can say "rates not configured" rather than displaying a confident 0.00.
        "costConfigured": cost_is_configured(),
        "averageModelCallsPerRequest": (
            round(totals["modelCalls"] / totals["requests"], 2) if totals["requests"] else 0
        ),
    }
