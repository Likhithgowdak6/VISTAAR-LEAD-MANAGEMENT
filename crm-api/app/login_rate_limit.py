"""
Login throttling.

A PORT OF backend/src/modules/auth/login-rate-limit.service.ts.

TWO COUNTERS, NOT ONE, and they answer different questions:

  `auth:login:ip:<ip>`                 20 per 15 minutes — one address hammering the service
  `auth:login:email-ip:<email>:<ip>`    5 per 15 minutes — one address guessing one account

An IP-only limit lets an office of twenty people lock each other out. An email-only limit lets
anyone lock a known user out of their own account by failing five logins from anywhere. The
pair is what makes neither possible.

**THE KEYS CONTAIN THE EMAIL ADDRESS AND MUST NEVER BE LOGGED.** The degraded-path log line
below carries an exception name and code only, for exactly that reason.

IT FAILS OPEN, DELIBERATELY. Redis being unreachable must not take authentication down with
it — a login outage is worse than a throttling outage, and credentials are still verified
either way. But a `TypeError` or an `AttributeError` is a bug in this file rather than an
unavailable dependency, so those are re-raised instead of being reported as a degraded
limiter and quietly hidden.
"""

import logging
from typing import Any

from app import cache

LOGIN_WINDOW_SECONDS = 15 * 60
IP_LIMIT = 20
EMAIL_IP_LIMIT = 5

_logger = logging.getLogger("crm-api.login-rate-limit")

# A fault in key construction is ours. Reporting it as "the limiter is unavailable" would hide
# a real bug behind a message that says the system is coping.
_PROGRAMMER_ERRORS = (TypeError, AttributeError, SyntaxError)


def _normalise(value: Any) -> str:
    """`normalizeLimiterValue`: trimmed, lower-cased, whitespace collapsed to hyphens."""
    import re

    return re.sub(r"\s+", "-", str(value if value is not None else "unknown").strip().lower())


def login_rate_limit_keys(email: str | None, ip_address: str | None) -> tuple[str, str]:
    normalised_ip = _normalise(ip_address)
    normalised_email = _normalise(email)

    return (
        f"auth:login:ip:{normalised_ip}",
        f"auth:login:email-ip:{normalised_email}:{normalised_ip}",
    )


async def _increment_window(client, key: str, window_seconds: int) -> int:
    """
    INCR, then EXPIRE only on the first hit.

    Re-setting the TTL on every attempt would turn a fixed window into a sliding one that never
    expires while an attacker keeps trying — the counter would stay above the limit forever and
    lock the account out permanently.
    """
    count = await client.incr(key)

    if count == 1:
        await client.expire(key, window_seconds)

    return count


async def check_login_rate_limit(
    *, email: str | None, ip_address: str | None
) -> dict[str, Any]:
    """`checkLoginRateLimit`. Returns `limited`, `retryAfterSeconds` and a `degraded` flag."""
    ip_key, email_ip_key = login_rate_limit_keys(email, ip_address)

    try:
        # The try wraps ONLY the Redis round trip. Key construction above is ours.
        client = cache.get_client()
        ip_count = await _increment_window(client, ip_key, LOGIN_WINDOW_SECONDS)
        email_ip_count = await _increment_window(client, email_ip_key, LOGIN_WINDOW_SECONDS)
    except _PROGRAMMER_ERRORS:
        raise
    except Exception as error:  # noqa: BLE001
        # Name and type only. The keys hold the email address and never appear in a log line.
        _logger.warning(
            "LOGIN_RATE_LIMIT: counter unavailable; allowing the attempt through to credential "
            "checks without throttling. (%s)",
            type(error).__name__,
        )

        return {
            "limited": False,
            "retryAfterSeconds": LOGIN_WINDOW_SECONDS,
            "degraded": True,
            "counters": {"ipCount": 0, "emailIpCount": 0},
        }

    return {
        "limited": ip_count > IP_LIMIT or email_ip_count > EMAIL_IP_LIMIT,
        "retryAfterSeconds": LOGIN_WINDOW_SECONDS,
        "degraded": False,
        "counters": {"ipCount": ip_count, "emailIpCount": email_ip_count},
    }


async def clear_login_rate_limit(*, email: str | None, ip_address: str | None) -> None:
    """
    Cleared after a SUCCESSFUL sign-in, so a user who mistyped twice is not throttled later.

    Swallows its own failure: the worst case is that stale counters expire on their own after
    the window, and failing a completed login because the cleanup did not work would be absurd.
    """
    ip_key, email_ip_key = login_rate_limit_keys(email, ip_address)

    try:
        client = cache.get_client()
        await client.delete(ip_key)
        await client.delete(email_ip_key)
    except Exception as error:  # noqa: BLE001
        _logger.warning(
            "LOGIN_RATE_LIMIT: could not clear counters after a successful sign-in; they "
            "expire on their own. (%s)",
            type(error).__name__,
        )
