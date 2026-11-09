"""
The realtime permission filter and SSE wire format.

`should_deliver_to_client` is the only thing standing between a staff member's open stream and
every change in the organisation. The events carry no message content — a conversation id, an
assignee and a reason — but "this conversation just changed" is still a fact about a lead, and a
restricted user seeing it for leads they cannot open is a leak.

The rules are tested in ORDER, because each one makes the ones below it unreachable and
reordering any two changes who sees what without changing any visible behaviour.
"""

import json

import pytest

from app.realtime import (
    ACCOUNT_CHANGED,
    CONVERSATION_CHANGED,
    REALTIME_CHANNEL,
    RealtimeClient,
    format_sse_event,
    parse_channel_message,
    should_deliver_to_client,
)

ORG = "6ab4c2037469f65204cfe999"
OTHER_ORG = "6ab4c2037469f65204cfe000"
USER = "6ab4c2037469f65204cfe99a"
COLLEAGUE = "6ab4c2037469f65204cfe99b"


def client(*, can_read_all: bool = False, user_id: str = USER, org: str = ORG) -> RealtimeClient:
    return RealtimeClient(
        user_id=user_id, organization_id=org, can_read_all=can_read_all, queue=None
    )


def event(**over) -> dict:
    base = {
        "type": CONVERSATION_CHANGED,
        "organizationId": ORG,
        "conversationId": "c1",
        "assignedTo": None,
        "reason": "inbound",
    }
    base.update(over)

    return base


class TestOrganizationIsolation:
    def test_ANOTHER_ORGANIZATIONS_EVENT_IS_NEVER_DELIVERED(self):
        # Checked first, before every other rule. A read_all admin of one studio must not see
        # another studio's traffic.
        assert should_deliver_to_client(event(organizationId=OTHER_ORG), client(can_read_all=True)) is False

    def test_an_account_event_from_another_organization_is_also_refused(self):
        # The account-event shortcut sits BELOW the organisation check for exactly this reason.
        assert (
            should_deliver_to_client(
                event(type=ACCOUNT_CHANGED, organizationId=OTHER_ORG),
                client(can_read_all=True),
            )
            is False
        )

    def test_a_client_with_no_organization_receives_nothing(self):
        assert should_deliver_to_client(event(), client(org=None)) is False


class TestTheAssignmentRule:
    def test_read_all_sees_everything_in_its_organization(self):
        assert should_deliver_to_client(event(assignedTo=COLLEAGUE), client(can_read_all=True)) is True

    def test_a_restricted_client_sees_its_own_leads(self):
        assert should_deliver_to_client(event(assignedTo=USER), client()) is True

    def test_A_RESTRICTED_CLIENT_NEVER_SEES_A_COLLEAGUES_LEAD(self):
        assert should_deliver_to_client(event(assignedTo=COLLEAGUE), client()) is False

    def test_AN_UNASSIGNED_LEAD_IS_NOT_ASSIGNED_TO_YOU(self):
        # The failure this guards: treating a null assignee as "matches everyone" would stream
        # every unassigned lead's activity to every restricted client in the organisation.
        assert should_deliver_to_client(event(assignedTo=None), client()) is False

    def test_an_empty_string_assignee_is_also_not_a_match(self):
        assert should_deliver_to_client(event(assignedTo=""), client()) is False

    def test_a_client_with_no_user_id_matches_nothing(self):
        assert should_deliver_to_client(event(assignedTo=None), client(user_id=None)) is False


class TestAccountEvents:
    def test_ACCOUNT_EVENTS_GO_TO_THE_WHOLE_ORGANIZATION(self):
        # They carry no conversation and no assignment. Falling through to the assignment rule
        # would silently drop "WhatsApp disconnected" for every restricted user - who are
        # precisely the people who need to know the inbox has stopped working.
        assert should_deliver_to_client(event(type=ACCOUNT_CHANGED), client()) is True

    def test_the_account_shortcut_beats_the_assignment_rule(self):
        assert (
            should_deliver_to_client(
                event(type=ACCOUNT_CHANGED, assignedTo=COLLEAGUE), client()
            )
            is True
        )


class TestDefensiveInputs:
    @pytest.mark.parametrize("bad", [None, {}])
    def test_a_missing_event_delivers_nothing(self, bad):
        assert should_deliver_to_client(bad, client()) is False

    def test_a_missing_client_delivers_nothing(self):
        assert should_deliver_to_client(event(), None) is False


class TestTheWireFormat:
    def test_THE_BLANK_LINE_TERMINATOR_IS_PRESENT(self):
        # Browsers buffer an SSE frame until the blank line. A missing one means the client
        # receives nothing and shows no error - the stream simply appears dead.
        frame = format_sse_event(event())

        assert frame.endswith("\n\n")

    def test_the_frame_names_the_event_type(self):
        frame = format_sse_event(event())

        assert frame.startswith(f"event: {CONVERSATION_CHANGED}\n")
        assert "\ndata: " in frame

    def test_THE_PAYLOAD_IS_COMPACT_JSON_LIKE_JSON_STRINGIFY(self):
        # `json.dumps` defaults to spaces after separators; `JSON.stringify` does not. A
        # difference here is cosmetic on the wire but means the two services emit visibly
        # different bytes for the same event.
        frame = format_sse_event(event())
        payload = frame.split("\ndata: ", 1)[1].rstrip("\n")

        assert ", " not in payload
        assert json.loads(payload)["conversationId"] == "c1"

    def test_the_whole_event_travels_not_a_subset(self):
        payload = json.loads(format_sse_event(event()).split("\ndata: ", 1)[1].rstrip("\n"))

        assert payload["type"] == CONVERSATION_CHANGED
        assert payload["reason"] == "inbound"


class TestChannelParsing:
    def test_parses_a_published_event(self):
        raw = json.dumps(event())

        assert parse_channel_message(raw)["conversationId"] == "c1"

    def test_accepts_bytes_as_redis_returns_them(self):
        assert parse_channel_message(json.dumps(event()).encode()) is not None

    @pytest.mark.parametrize(
        "bad",
        ["not json", "[]", '"a string"', json.dumps({"type": "something.else"}), "null"],
        ids=["malformed", "array", "scalar", "unknown-type", "null"],
    )
    def test_A_BAD_PAYLOAD_RETURNS_NONE_RATHER_THAN_RAISING(self, bad):
        # A publisher putting rubbish on the channel must not take down the subscriber loop,
        # and with it every connected client's stream.
        assert parse_channel_message(bad) is None

    def test_the_channel_name_matches_nodes(self):
        # Both services subscribe to the same channel against the same Redis - that is what
        # makes the fan-out cross-process and lets this route move without its runner.
        assert REALTIME_CHANNEL == "realtime:events"
