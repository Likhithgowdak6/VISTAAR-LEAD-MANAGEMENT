"""
The channel a conversation reports, and what it reports for the ones that predate the field.

THE FAILURE THIS GUARDS IS TOTAL AND LOOKS LIKE DATA LOSS. Every conversation written before
`channel` existed has none, and there are far more of those than there will ever be Instagram
threads. A dashboard that filters on an absent field shows an empty inbox on a working database.

Resolved in the serializer rather than in the dashboard so there is ONE answer: two clients
deciding independently what a missing channel means is how they drift.
"""

from __future__ import annotations

import pytest
from bson import ObjectId

from app.conversation_serializer import serialize_conversation

ORG = ObjectId()


def _conversation(**over):
    base = {
        "_id": ObjectId(),
        "organizationId": ORG,
        "contactId": ObjectId(),
        "leadId": "VIS-0001",
        "stage": "new",
        "status": "open",
    }
    base.update(over)
    return base


class TestChannelCompatibility:
    def test_a_conversation_written_before_the_field_reports_whatsapp(self):
        # The whole point: these are all WhatsApp, and there are a lot of them.
        assert serialize_conversation(_conversation())["channel"] == "whatsapp"

    def test_an_explicit_null_reports_whatsapp(self):
        assert serialize_conversation(_conversation(channel=None))["channel"] == "whatsapp"

    def test_an_explicit_whatsapp_reports_whatsapp(self):
        assert serialize_conversation(_conversation(channel="whatsapp"))["channel"] == "whatsapp"

    def test_instagram_reports_instagram(self):
        assert serialize_conversation(_conversation(channel="instagram"))["channel"] == "instagram"

    def test_an_unknown_channel_reports_whatsapp_rather_than_hiding_the_thread(self):
        """
        A value this build does not recognise is more likely a newer deployment's channel seen
        during a rolling restart than a corruption. Showing it as WhatsApp is cosmetic; hiding it
        is a lost customer message.
        """
        assert serialize_conversation(_conversation(channel="telegram"))["channel"] == "whatsapp"

    def test_only_an_exact_match_counts_as_instagram(self):
        # A near-miss must not route a WhatsApp thread into an Instagram reply box.
        assert serialize_conversation(_conversation(channel="Instagram"))["channel"] == "whatsapp"


class TestInstagramFields:
    def test_carries_the_instagram_account_when_there_is_one(self):
        account_id = ObjectId()

        serialized = serialize_conversation(
            _conversation(channel="instagram", instagramAccountId=account_id)
        )

        assert serialized["instagramAccountId"] == str(account_id)

    def test_a_whatsapp_thread_reports_no_instagram_account(self):
        assert serialize_conversation(_conversation())["instagramAccountId"] is None

    def test_still_carries_the_whatsapp_account_it_always_did(self):
        # The existing contract, unchanged. Every WhatsApp reader depends on this field.
        account_id = ObjectId()

        serialized = serialize_conversation(_conversation(whatsappAccountId=account_id))

        assert serialized["whatsappAccountId"] == str(account_id)
