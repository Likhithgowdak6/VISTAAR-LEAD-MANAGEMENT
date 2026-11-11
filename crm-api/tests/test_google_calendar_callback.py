"""
The Google Calendar OAuth callback page.

`GET /callback` is **unauthenticated** — it has to be, because Google redirects a browser to it
with no credentials of ours attached. That makes every query parameter attacker-controlled: a
crafted link is all it takes to reach this handler.

Two defects lived here and both are pinned below:

1. **Reflected XSS.** `error` and the exception text were interpolated into the markup unescaped.
   Because the API is served from `/api/v1/*` on the same host as the dashboard, injected script
   runs SAME-ORIGIN with the app — able to read tokens and issue authenticated requests with the
   refresh cookie.

2. **A broken redirect on the SUCCESS path.** `FRONTEND_ORIGIN` is a comma-separated list, and
   it was used raw as a URL base, producing `https://a.example,https://localhost/calendar?...`
   — so a user who had just connected Google Calendar landed nowhere.
"""

import html
import re

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.config import settings
from app.routers import google_calendar as router_module
from app.routers.google_calendar import _callback_page, _frontend_base

#: The classic break-out payloads, aimed at each quoting context on the page.
XSS_PAYLOADS = [
    "<script>alert(1)</script>",
    "'><script>alert(1)</script>",
    '"><script>alert(1)</script>',
    "javascript:alert(1)",
    "<img src=x onerror=alert(1)>",
    "access_denied<svg/onload=alert(1)>",
]


@pytest.fixture
def client():
    application = FastAPI()
    application.include_router(router_module.router, prefix="/api/v1/integrations/google-calendar")

    return TestClient(application)


@pytest.fixture
def origin(monkeypatch):
    """The production shape: a real web origin followed by the Android WebView's."""
    monkeypatch.setattr(
        settings, "frontend_origin", "https://crm.example.com,https://localhost", raising=False
    )

    return "https://crm.example.com"


def callback(client, **params):
    return client.get(
        "/api/v1/integrations/google-calendar/callback", params=params, follow_redirects=False
    )


class TestTheFrontendBase:
    def test_THE_FIRST_ENTRY_OF_THE_LIST_WINS(self, origin):
        # Using the raw setting produced `https://crm.example.com,https://localhost/calendar?...`,
        # which is not a reachable address. This fired on the success path.
        assert _frontend_base() == "https://crm.example.com"

    def test_a_single_origin_is_unchanged(self, monkeypatch):
        monkeypatch.setattr(settings, "frontend_origin", "https://only.example.com", raising=False)

        assert _frontend_base() == "https://only.example.com"

    def test_a_trailing_slash_is_dropped(self, monkeypatch):
        # Otherwise the link becomes `https://x.example.com//calendar`, which some proxies
        # normalise and some serve as a 404.
        monkeypatch.setattr(settings, "frontend_origin", "https://x.example.com/", raising=False)

        assert _frontend_base() == "https://x.example.com"

    def test_whitespace_around_entries_is_ignored(self, monkeypatch):
        monkeypatch.setattr(
            settings, "frontend_origin", "  https://a.example.com , https://localhost ", raising=False
        )

        assert _frontend_base() == "https://a.example.com"

    @pytest.mark.parametrize("value", ["", "   ", ",", " , "])
    def test_an_empty_setting_yields_an_empty_base(self, monkeypatch, value):
        # A relative `/calendar?...` link still works when the API and the app share a host,
        # which is the deployment here - better than emitting the literal text "None".
        monkeypatch.setattr(settings, "frontend_origin", value, raising=False)

        assert _frontend_base() == ""


class TestTheSuccessPage:
    def test_it_points_at_a_single_usable_url(self, client, origin):
        page = _callback_page(
            heading="Google Calendar connected",
            detail="Redirecting...",
            params={"google_calendar_connected": "true"},
        )
        body = page.body.decode()

        assert "https://crm.example.com/calendar?google_calendar_connected=true" in body
        assert ",https://localhost" not in body

    def test_THE_URL_APPEARS_ONCE_PER_PLACE_IT_IS_NEEDED(self, origin):
        # The meta refresh and the manual link must agree; a user who waits and a user who
        # clicks should land in the same place.
        body = _callback_page(
            heading="x", detail="y", params={"google_calendar_connected": "true"}
        ).body.decode()

        assert body.count("https://crm.example.com/calendar?google_calendar_connected=true") == 2


#: Every tag the page is allowed to contain. Anything else means a payload became MARKUP.
EXPECTED_TAGS = {"html", "head", "meta", "body", "h3", "p", "a", "/html", "/head", "/body", "/h3", "/p", "/a"}


def tags_in(body: str) -> set[str]:
    """
    The element names the browser would actually parse out of the document.

    Asserted instead of "the payload string is absent", because an ESCAPED payload legitimately
    still contains its own characters — `&lt;img src=x onerror=alert(1)&gt;` holds the literal
    text `onerror=` and is completely inert. A substring search on the whole document therefore
    fails on correct output, which is exactly what it did here first time round.

    What actually matters is whether a NEW ELEMENT appeared, and that is what this measures.
    """
    return {match.lower() for match in re.findall(r"<\s*(/?[a-zA-Z][a-zA-Z0-9]*)", body)}


def href_in(body: str) -> str:
    match = re.search(r'<a href="([^"]*)"', body)

    assert match, body

    return match.group(1)


class TestReflectedXss:
    @pytest.mark.parametrize("payload", XSS_PAYLOADS)
    def test_NO_PAYLOAD_BECOMES_AN_ELEMENT(self, client, origin, payload):
        body = callback(client, error=payload).text

        assert tags_in(body) <= EXPECTED_TAGS, tags_in(body) - EXPECTED_TAGS

    @pytest.mark.parametrize("payload", XSS_PAYLOADS)
    def test_the_angle_brackets_are_escaped(self, client, origin, payload):
        # The mechanism behind the assertion above, pinned separately so a failure says which
        # of the two broke.
        body = callback(client, error=payload).text
        rendered = re.search(r"<p>(.*?)</p>", body, re.S).group(1)

        assert "<" not in rendered
        assert ">" not in rendered

    @pytest.mark.parametrize("payload", XSS_PAYLOADS)
    def test_the_payload_is_present_but_escaped(self, client, origin, payload):
        # Proving the text is RENDERED rather than silently dropped - a handler that discarded
        # the message entirely would also pass the test above while telling the user nothing.
        body = callback(client, error=payload).text

        assert html.escape(payload) in body or html.escape(payload, quote=True) in body

    def test_A_QUOTE_CANNOT_BREAK_OUT_OF_AN_ATTRIBUTE(self, client, origin):
        # `href="..."` and `content="..."` are the two attributes carrying a user-influenced
        # value. `html.escape(quote=True)` escapes BOTH quote styles, so neither can terminate.
        body = callback(client, error="\"><img src=x onerror=alert(1)>").text

        assert "img" not in tags_in(body)

    def test_AN_INJECTED_QUERY_PARAMETER_CANNOT_BE_SMUGGLED_IN(self, client, origin):
        # Without urlencode, `&admin=1` inside the value becomes a SEPARATE parameter on the
        # URL the browser then follows.
        #
        # Asserted against the HREF, not the whole document: the `<p>` legitimately displays
        # the text `x&amp;google_calendar_connected=true`, which is inert but does contain the
        # substring. Only the link decides where the browser goes.
        href = href_in(callback(client, error="x&google_calendar_connected=true").text)
        query = href.split("?", 1)[1]

        assert query.count("=") == 1
        assert query.startswith("google_calendar_error=")
        assert "%26" in query and "%3D" in query

    def test_THE_URL_ESCAPE_COVERS_THE_HALF_URLENCODE_DOES_NOT(self, client, monkeypatch):
        """
        `html.escape` on the URL looks redundant and is not.

        `urlencode` percent-encodes the QUERY, so a quote arriving through `error` can never
        reach the attribute — mutation testing confirmed that removing the escape changes
        nothing for any query-string payload.

        The ORIGIN half is different: it comes from `FRONTEND_ORIGIN`, which `urlencode` never
        sees. A malformed or hostile value there would otherwise terminate the `href="` and
        inject an attribute. That is the path this pins, and it is why the escape stays.
        """
        monkeypatch.setattr(
            settings, "frontend_origin", 'https://x.example.com/"><img src=x onerror=alert(1)>', raising=False
        )

        body = callback(client, error="access_denied").text

        assert "img" not in tags_in(body)

    def test_the_error_code_still_reaches_the_frontend(self, client, origin):
        # Google's real codes are a short known set and the UI switches on them, so the
        # ordinary case must keep working.
        body = callback(client, error="access_denied").text

        assert "google_calendar_error=access_denied" in body

    def test_the_status_is_400(self, client, origin):
        assert callback(client, error="access_denied").status_code == 400


class TestMissingParameters:
    def test_no_code_or_state_is_400(self, client, origin):
        assert callback(client).status_code == 400

    def test_it_names_a_fixed_reason(self, client, origin):
        body = callback(client, code="abc").text

        assert "google_calendar_error=missing_parameters" in body


class TestTheFailurePath:
    @pytest.fixture
    def exploding(self, monkeypatch):
        def boom(_state):
            raise RuntimeError(
                "token exchange failed: client_secret=SECRET123 at /srv/app/internal.py"
            )

        monkeypatch.setattr(router_module, "verify_google_oauth_state", boom)

    def test_THE_EXCEPTION_TEXT_NEVER_REACHES_THE_BROWSER(self, client, origin, exploding):
        # It can carry token-exchange details and internal paths. The page is shown in a browser
        # the caller controls.
        body = callback(client, code="abc", state="def").text

        assert "SECRET123" not in body
        assert "client_secret" not in body
        assert "/srv/app/internal.py" not in body
        assert "RuntimeError" not in body

    def test_the_exception_text_is_not_leaked_through_the_query_string_either(
        self, client, origin, exploding
    ):
        # The earlier version put `str(exc)` into `google_calendar_error=`, so the detail left
        # the server in the URL even when the page body was clean.
        body = callback(client, code="abc", state="def").text

        assert "google_calendar_error=connection_failed" in body
        assert "SECRET123" not in body

    def test_it_still_answers_500_and_offers_a_way_back(self, client, origin, exploding):
        response = callback(client, code="abc", state="def")

        assert response.status_code == 500
        assert "https://crm.example.com/calendar" in response.text


class TestThePageIsWellFormed:
    @pytest.mark.parametrize(
        "params",
        [
            {"error": "access_denied"},
            {"code": "abc"},
            {},
        ],
    )
    def test_every_branch_returns_html_with_a_refresh_and_a_link(self, client, origin, params):
        body = callback(client, **params).text

        assert body.startswith("<html>")
        assert re.search(r'<meta http-equiv="refresh" content="\d+;url=', body)
        assert "<a href=" in body
