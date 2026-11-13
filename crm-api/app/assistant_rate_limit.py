"""
Throttling `/assistant/ask`.

----------------------------------------------------------------------------------------------
WHY THIS NEEDS ITS OWN LIMITER RATHER THAN REUSING THE DRAFT ONE
----------------------------------------------------------------------------------------------
`check_ai_draft_rate_limit` allows 60 requests an hour per user, and each one is **a single**
model call. One assistant question is up to `MAX_STEPS` (6) model calls, because the loop runs
until the model stops asking for tools. Pointing the assistant at the draft limiter would
therefore permit 360 model calls an hour per user while appearing to apply the same budget.

So the numbers differ, and the shape differs too: three counters, not one.

| Counter | Default | What it stops |
|---|---|---|
| user / minute | 5 | A held-down Enter key, or a retry loop in a client |
| user / hour | 30 | One person grinding through a day's quota in ten minutes |
| org / hour | 200 | Twenty users each individually under their own limit |

The per-minute counter is the one that matters for *"handle rapid repeated requests"*: an hourly
limit alone lets somebody spend the whole hourly budget in fifteen seconds, which is both the
worst cost case and the worst case for the provider's own rate limits.

----------------------------------------------------------------------------------------------
IT CANNOT BE BYPASSED BY OPENING NEW THREADS
----------------------------------------------------------------------------------------------
**Every key is derived from the session's user id and organisation id. None of them contains a
thread id.** That is the whole defence, and it is defended by a test: a thread-scoped counter
would reset every time the UI's "New conversation" button was pressed, which is one click.

----------------------------------------------------------------------------------------------
IT FAILS CLOSED, UNLIKE THE TWO LIMITERS ALREADY HERE
----------------------------------------------------------------------------------------------
`login_rate_limit.py` and `check_ai_draft_rate_limit` both fail OPEN when Redis is unreachable,
and for them that is right: a login outage is worse than a throttling outage, and credentials
are still verified either way.

**This one fails closed, and the asymmetry is deliberate.** What is behind this limiter is not
a database read — it is up to six paid Anthropic calls per request. Failing open does not
degrade a feature, it removes the only ceiling on spend, at exactly the moment nobody is
watching. An hour of unmetered assistant traffic costs real money; an hour without the
assistant costs nobody anything, and every other part of the CRM keeps working.

**THE OPERATIONAL TRADE-OFF, STATED PLAINLY:** a Redis outage disables the assistant
completely. That is the intended behaviour, not a side effect. It is survivable because the
assistant is read-only and additive — nothing else in the CRM depends on it, and the data it
reads is reachable through the ordinary UI.

Recovery needs no restart. `cache.get_client` caches a redis-py client whose connection pool
reconnects on its own, so the first call after Redis returns succeeds and the ceiling is back.

A `TypeError` or `AttributeError` is still a bug in *this file* rather than an unavailable
dependency, so those are re-raised rather than reported as an outage.

----------------------------------------------------------------------------------------------
429 AND 503 MEAN DIFFERENT THINGS AND MUST NOT BE CONFLATED
----------------------------------------------------------------------------------------------
`limited` is the user's own fault and clears when their window rolls over → **429**.
`unavailable` is ours and clears when Redis comes back → **503**.

Reporting an outage as 429 would tell somebody they had exceeded a limit they had not touched,
and the honest retry advice is different in each case.
"""

from __future__ import annotations

import logging
from typing import Any, NamedTuple

from app import cache
from app.config import settings

logger = logging.getLogger("crm-api.assistant-rate-limit")

MINUTE_SECONDS = 60
HOUR_SECONDS = 3600

#: A fault in key construction is ours. Reporting it as "the limiter is unavailable" would hide
#: a real bug behind a message saying the system is coping. Same rule as `login_rate_limit.py`.
_PROGRAMMER_ERRORS = (TypeError, AttributeError, SyntaxError)


#: How long a caller is asked to wait when the limiter itself is down.
#:
#: Short, because a Redis blip is usually seconds and this is not a quota — making somebody
#: wait a minute for an outage that lasted two seconds is its own failure.
UNAVAILABLE_RETRY_SECONDS = 15


class RateLimitDecision(NamedTuple):
    #: The caller exceeded their own budget. Their fault, clears on its own → 429.
    limited: bool
    #: Which counter tripped, for the log line and the error body. None when not limited.
    scope: str | None
    retry_after_seconds: int
    #: The limiter could not run. OUR fault, clears when Redis returns → 503.
    #:
    #: Never set at the same time as `limited`: an unchecked request has not exceeded
    #: anything, and reporting it as a quota breach would be a lie about whose problem it is.
    unavailable: bool

    @property
    def allowed(self) -> bool:
        return not self.limited and not self.unavailable


def assistant_rate_limit_keys(user_id: Any, organization_id: Any) -> tuple[str, str, str]:
    """
    The three counters, in the order they are checked.

    NO THREAD ID APPEARS HERE and none ever should: the limit is on a person's spending, not on
    a conversation's. Keys carry opaque ObjectIds rather than email addresses, so unlike the
    login limiter's keys these are safe to appear in a log line.
    """
    return (
        f"assistant:ask:user-minute:{user_id}",
        f"assistant:ask:user-hour:{user_id}",
        f"assistant:ask:org-hour:{organization_id}",
    )


async def _increment_window(client, key: str, window_seconds: int) -> int:
    """
    INCR, then EXPIRE only on the first hit.

    Re-setting the TTL on every attempt would turn a fixed window into one that never expires
    while somebody keeps trying — the counter would stay above the limit indefinitely and lock
    the user out permanently. Copied deliberately from `login_rate_limit._increment_window`,
    which documents the same trap.
    """
    count = await client.incr(key)

    if count == 1:
        await client.expire(key, window_seconds)

    return count


async def check_assistant_rate_limit(
    *, user_id: Any, organization_id: Any
) -> RateLimitDecision:
    """
    Whether this question may proceed.

    ALL THREE COUNTERS ARE INCREMENTED whichever one trips. Stopping at the first breach would
    let a user sitting on their per-minute limit make unlimited *attempts* without those
    attempts counting toward the hourly budget — so a client retrying every second would be
    throttled per-minute forever while never exhausting the hour, and the organisation counter
    would never see the traffic at all.
    """
    if not settings.redis_url:
        # NO REDIS CONFIGURED IS ALSO UNAVAILABLE, not a deployment that opted out of limits.
        # `check_ai_draft_rate_limit` treats this as "no limiter, carry on" — correct for a
        # single model call, wrong for six. A deployment that can spend money on Anthropic but
        # cannot reach a counter should not be spending it.
        logger.warning(
            "ASSISTANT_RATE_LIMIT: no REDIS_URL configured; refusing assistant requests. "
            "The assistant cannot run without a counter behind it."
        )

        return RateLimitDecision(
            False, None, UNAVAILABLE_RETRY_SECONDS, unavailable=True
        )

    minute_key, user_hour_key, org_hour_key = assistant_rate_limit_keys(
        user_id, organization_id
    )

    try:
        # The try wraps ONLY the Redis round trips. Key construction above is ours.
        client = cache.get_client()
        minute_count = await _increment_window(client, minute_key, MINUTE_SECONDS)
        user_hour_count = await _increment_window(client, user_hour_key, HOUR_SECONDS)
        org_hour_count = await _increment_window(client, org_hour_key, HOUR_SECONDS)
    except _PROGRAMMER_ERRORS:
        raise
    except Exception as error:  # noqa: BLE001
        # FAILS CLOSED. See the module docstring: what is behind this limiter is paid model
        # calls, so an unenforced ceiling is worse than a paused feature.
        #
        # Only the exception TYPE is logged. The message can carry a Redis URL with
        # credentials in it, and this line is the one most likely to be read by somebody
        # pasting logs into a ticket.
        logger.error(
            "ASSISTANT_RATE_LIMIT: counter unavailable (%s); refusing assistant requests "
            "until it recovers.",
            type(error).__name__,
        )

        return RateLimitDecision(
            False, None, UNAVAILABLE_RETRY_SECONDS, unavailable=True
        )

    if minute_count > settings.assistant_rate_limit_per_minute:
        return RateLimitDecision(True, "minute", MINUTE_SECONDS, unavailable=False)

    if user_hour_count > settings.assistant_rate_limit_per_hour:
        return RateLimitDecision(True, "hour", HOUR_SECONDS, unavailable=False)

    if org_hour_count > settings.assistant_org_rate_limit_per_hour:
        return RateLimitDecision(True, "organisation", HOUR_SECONDS, unavailable=False)

    return RateLimitDecision(False, None, 0, unavailable=False)


#: What the user is told, per counter.
#:
#: Written for the person reading it, not for the log: "you" and a plain next step. The
#: organisation message deliberately does NOT say who used the budget — that would be reporting
#: a colleague's activity to anybody who hits the limit.
_MESSAGES = {
    "minute": (
        "You are asking faster than the assistant can keep up. Wait a moment and try again."
    ),
    "hour": (
        "You have reached your hourly limit for assistant questions. "
        "It resets within the hour."
    ),
    "organisation": (
        "Your organisation has reached its hourly limit for assistant questions. "
        "It resets within the hour."
    ),
}


def rate_limit_message(scope: str | None) -> str:
    return _MESSAGES.get(scope or "", _MESSAGES["hour"])


#: What the user is told when the limiter itself is down.
#:
#: NO INFRASTRUCTURE DETAIL. Not "Redis", not a host, not an exception name — the person
#: reading this cannot act on any of it, and an error string is a place operational detail
#: leaks to anyone who can open the network tab. What they can act on is: it is not their
#: fault, nothing else is broken, and trying again shortly will work.
UNAVAILABLE_MESSAGE = (
    "The assistant is temporarily unavailable. Everything else in the CRM is working "
    "normally — please try your question again in a few moments."
)
