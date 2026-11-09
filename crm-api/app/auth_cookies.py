"""
The refresh-token cookie.

A PORT OF backend/src/modules/auth/auth-cookie.service.ts.

`SameSite` IS THE WHOLE REASON THIS FILE HAS COMMENTS. A Capacitor WebView runs on
`capacitor://localhost` (Android) or `capacitor://` (iOS), so **every** call the mobile app
makes to this API is cross-site. A `SameSite=Lax` cookie is simply not sent on those, and the
failure is quiet and confusing: signing in works, then the first token refresh finds no cookie
and the user is thrown out — which reads as a broken login rather than a cookie policy.

`None` is only honoured alongside `Secure`, i.e. over HTTPS, which is why it is opt-in rather
than the default: switching it on without TLS gets the cookie rejected outright and produces
the same symptom from the opposite direction.

THE PATH IS `/api/v1/auth`, NOT `/`. The browser then sends the refresh token only to the
routes that rotate it, so it never rides along on every analytics or inbox request — which is
both less exposure and less bandwidth on every call the app makes.
"""

from app.config import settings

REFRESH_COOKIE_NAME = "wam_refresh"
REFRESH_COOKIE_PATH = "/api/v1/auth"


def refresh_cookie_max_age_seconds() -> int:
    return settings.refresh_token_ttl_days * 24 * 60 * 60


def refresh_cookie_same_site() -> str:
    """`Lax` for a browser on the same origin, `None` for the mobile app."""
    return "None" if settings.auth_cookie_cross_site else "Lax"


def refresh_cookie_secure() -> bool:
    """`None` requires `Secure`, so cross-site mode forces it on regardless of NODE_ENV."""
    return settings.auth_cookie_cross_site or settings.node_env == "production"


def build_refresh_cookie(refresh_token: str) -> dict:
    """
    The kwargs for Starlette's `set_cookie`.

    Returned as a dict rather than a serialised header so the route hands it straight to
    `response.set_cookie` and there is no second place that knows the cookie's shape.
    """
    return {
        "key": REFRESH_COOKIE_NAME,
        "value": refresh_token,
        "httponly": True,
        "secure": refresh_cookie_secure(),
        "samesite": refresh_cookie_same_site().lower(),
        "path": REFRESH_COOKIE_PATH,
        "max_age": refresh_cookie_max_age_seconds(),
    }


def build_clear_refresh_cookie() -> dict:
    """
    Clearing it must repeat `path`, `secure` and `samesite` EXACTLY.

    A browser matches a deletion against those attributes; get one wrong and the old cookie
    survives alongside a new empty one, so the user appears logged out and is silently logged
    back in on the next refresh.
    """
    return {
        "key": REFRESH_COOKIE_NAME,
        "value": "",
        "httponly": True,
        "secure": refresh_cookie_secure(),
        "samesite": refresh_cookie_same_site().lower(),
        "path": REFRESH_COOKIE_PATH,
        "max_age": 0,
    }


def read_refresh_token(request) -> str | None:
    return request.cookies.get(REFRESH_COOKIE_NAME) or None
