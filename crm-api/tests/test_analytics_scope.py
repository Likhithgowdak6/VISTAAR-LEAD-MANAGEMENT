"""
The analytics narrowing — the rule that keeps a staff user's dashboard honest.

WHAT THIS GUARDS. `canReadAll` lives inside `conversation.service.ts` as a module-private
helper, so analytics restates it, and Python restates it a third time. Each restatement is a
chance to forget it. If it were forgotten, a staff user's inbox would show their own threads
while their dashboard totalled the whole organisation — and nothing about either screen would
look wrong.

That is not an access-control breach of the conversations themselves. It is a readout of how
many there are, which in aggregate is the same information.
"""

import pytest
from bson import ObjectId
from fastapi import HTTPException

from app.analytics_scope import (
    AnalyticsScope,
    can_read_all,
    can_reveal_pii,
    resolve_analytics_scope,
)
from app.permissions import (
    CLIENT_PII_REVEAL,
    CONVERSATIONS_READ_ALL,
    CONVERSATIONS_READ_ASSIGNED,
)

ORG = ObjectId()
ACTOR = ObjectId()
SOMEONE_ELSE = ObjectId()

READ_ALL = [CONVERSATIONS_READ_ALL, CONVERSATIONS_READ_ASSIGNED]
READ_ASSIGNED_ONLY = [CONVERSATIONS_READ_ASSIGNED]


def resolve(permissions, requested=None) -> AnalyticsScope:
    return resolve_analytics_scope(
        organization_id=ORG,
        actor_id=ACTOR,
        permissions=permissions,
        requested_assigned_to=requested,
    )


class TestNarrowing:
    def test_A_USER_WITHOUT_READ_ALL_IS_PINNED_TO_THEMSELVES(self):
        # The whole point. Forgetting this totals the organisation for someone whose inbox
        # shows only their own threads.
        scope = resolve(READ_ASSIGNED_ONLY)

        assert scope.assigned_to == ACTOR
        assert scope.conversation_filter() == {"organizationId": ORG, "assignedTo": ACTOR}

    def test_a_user_with_read_all_sees_the_whole_organization(self):
        scope = resolve(READ_ALL)

        assert scope.assigned_to is None
        assert scope.conversation_filter() == {"organizationId": ORG}

    def test_THE_ORGANIZATION_IS_ALWAYS_IN_THE_FILTER(self):
        # Even for read_all. Dropping it would total every studio on the box.
        for permissions in (READ_ALL, READ_ASSIGNED_ONLY):
            assert resolve(permissions).conversation_filter()["organizationId"] == ORG

    def test_an_empty_permission_list_is_narrowed_not_widened(self):
        # Fail closed. A caller with no permissions at all must not be handed the organisation.
        assert resolve([]).assigned_to == ACTOR


class TestTheRefusal:
    def test_REQUESTING_SOMEONE_ELSE_IS_REFUSED_NOT_REWRITTEN(self):
        # Quietly rewriting to themselves would show them their own numbers under another
        # person's name, with no way to tell.
        with pytest.raises(HTTPException) as raised:
            resolve(READ_ASSIGNED_ONLY, str(SOMEONE_ELSE))

        assert raised.value.status_code == 403
        assert raised.value.detail["error"]["code"] == "ANALYTICS_SCOPE_DENIED"

    def test_requesting_oneself_is_allowed(self):
        # Redundant but harmless, and the UI does send it when a filter chip is set.
        scope = resolve(READ_ASSIGNED_ONLY, str(ACTOR))

        assert scope.assigned_to == ACTOR

    def test_a_read_all_user_may_filter_to_anyone(self):
        scope = resolve(READ_ALL, str(SOMEONE_ELSE))

        assert scope.assigned_to == SOMEONE_ELSE
        assert scope.conversation_filter()["assignedTo"] == SOMEONE_ELSE

    def test_a_read_all_user_with_no_filter_is_unnarrowed(self):
        assert resolve(READ_ALL, None).assigned_to is None


class TestPermissionHelpers:
    def test_can_read_all(self):
        assert can_read_all(READ_ALL) is True
        assert can_read_all(READ_ASSIGNED_ONLY) is False
        assert can_read_all([]) is False
        assert can_read_all(None) is False

    def test_can_reveal_pii(self):
        assert can_reveal_pii([CLIENT_PII_REVEAL]) is True
        assert can_reveal_pii(READ_ALL) is False
        assert can_reveal_pii(None) is False

    def test_READ_ASSIGNED_DOES_NOT_IMPLY_READ_ALL(self):
        # They are separate permissions and `staff` holds only the first. Treating one as
        # implying the other is the single mistake that breaks the narrowing.
        assert can_read_all([CONVERSATIONS_READ_ASSIGNED]) is False
