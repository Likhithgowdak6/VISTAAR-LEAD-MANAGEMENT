"""
Seed an ISOLATED local database for assistant end-to-end testing.

----------------------------------------------------------------------------------------------
WHAT THIS WILL AND WILL NOT TOUCH
----------------------------------------------------------------------------------------------
It writes to a database named by `--database`, defaulting to `wam_crm_ai_assistant_e2e`, on the
MongoDB named by `--mongo-uri`, defaulting to `mongodb://localhost:27017`.

**It refuses to run against a database called `wam_crm_ai`** — the developer's own working data
— and refuses any host that is not loopback unless `--i-know-what-im-doing` is passed. Those are
not politeness: this script calls `drop_database`, and a seeding tool that can be pointed at
production by a typo in an environment variable is a tool that eventually is.

Two organisations, two users in the first, so the isolation scenarios have something real to
fail against. Everything here is invented; no production data is read or copied.
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from datetime import datetime, timedelta, timezone

import bcrypt
from bson import ObjectId
from motor.motor_asyncio import AsyncIOMotorClient

#: The seeded password, so the UI can actually be logged into for manual verification. Local
#: throwaway data only — these accounts exist in an isolated e2e database that this script
#: drops on every run, and nothing here is ever a production credential.
E2E_PASSWORD = "AssistantE2E!2026"


def _hash() -> str:
    return bcrypt.hashpw(E2E_PASSWORD.encode(), bcrypt.gensalt(rounds=4)).decode()

NOW = datetime.now(timezone.utc)

#: Fixed so the harness and the frontend can reference the same records across runs.
ORG_A = ObjectId("000000000000000000000a01")
ORG_B = ObjectId("000000000000000000000b01")
ADMIN_A = ObjectId("000000000000000000000a11")
STAFF_A = ObjectId("000000000000000000000a12")
ADMIN_B = ObjectId("000000000000000000000b11")
SESSION_ADMIN_A = ObjectId("000000000000000000000a21")
SESSION_STAFF_A = ObjectId("000000000000000000000a22")
SESSION_ADMIN_B = ObjectId("000000000000000000000b21")

CONV_ADMIN_A = ObjectId("000000000000000000000a31")
CONV_STAFF_A = ObjectId("000000000000000000000a32")
CONV_B = ObjectId("000000000000000000000b31")

PROTECTED_DATABASES = {"wam_crm_ai", "admin", "config", "local"}


def _conversation(_id, organization_id, assigned_to, name, lead_id, score, band, signals):
    return {
        "_id": _id,
        "organizationId": organization_id,
        "whatsappAccountId": ObjectId(),
        "contactId": ObjectId(),
        "assignedTo": assigned_to,
        "displayName": name,
        "leadId": lead_id,
        "stage": "qualified",
        "status": "open",
        "deletedAt": None,
        "optedOutAt": None,
        "salesRejectedAt": None,
        "leadScore": score,
        "leadScoreBand": band,
        "leadScoreSignals": signals,
        "aiFacts": {"event_date": "12 December", "city": "Bengaluru", "budget_range": "80000"},
        "aiCategory": "wedding",
        "lastInboundAt": NOW - timedelta(days=1),
        "lastMessageAt": NOW - timedelta(hours=1),
        "lastDeliveredOutboundAt": NOW - timedelta(hours=1),
        "createdAt": NOW - timedelta(days=20),
        "updatedAt": NOW,
    }


def _message(conversation_id, organization_id, direction, body, days_ago):
    return {
        "_id": ObjectId(),
        "organizationId": organization_id,
        "conversationId": conversation_id,
        "direction": direction,
        "body": body,
        "status": "received" if direction == "in" else "sent",
        "sentAt": NOW - timedelta(days=days_ago),
        "createdAt": NOW - timedelta(days=days_ago),
    }


async def seed(mongo_uri: str, database_name: str) -> None:
    client = AsyncIOMotorClient(mongo_uri, serverSelectionTimeoutMS=4000)
    db = client[database_name]

    await client.drop_database(database_name)

    await db.organizations.insert_many(
        [
            {"_id": ORG_A, "name": "Vistaar Studio A", "slug": "studio-a", "status": "active"},
            {"_id": ORG_B, "name": "Rival Studio B", "slug": "studio-b", "status": "active"},
        ]
    )

    await db.users.insert_many(
        [
            {
                "_id": ADMIN_A, "organizationId": ORG_A, "name": "Asha Menon",
                "email": "asha@studio-a.test", "passwordHash": _hash(), "role": "admin", "status": "active",
                "mustChangePassword": False,
            },
            {
                "_id": STAFF_A, "organizationId": ORG_A, "name": "Vikram Rao",
                # "staff", not "agent". `DEFAULT_ROLE_PERMISSIONS` knows admin / manager / staff /
                # super_admin; an unrecognised role resolves to NO permissions, so the assistant
                # route refuses with 403 and every visibility scenario below becomes untestable.
                "email": "vikram@studio-a.test", "passwordHash": _hash(), "role": "staff", "status": "active",
                "mustChangePassword": False,
            },
            {
                "_id": ADMIN_B, "organizationId": ORG_B, "name": "Priya Nair",
                "email": "priya@studio-b.test", "passwordHash": _hash(), "role": "admin", "status": "active",
                "mustChangePassword": False,
            },
        ]
    )

    await db.refreshsessions.insert_many(
        [
            {"_id": SESSION_ADMIN_A, "userId": ADMIN_A, "organizationId": ORG_A,
             "status": "active", "familyId": ObjectId(), "expiresAt": NOW + timedelta(days=7)},
            {"_id": SESSION_STAFF_A, "userId": STAFF_A, "organizationId": ORG_A,
             "status": "active", "familyId": ObjectId(), "expiresAt": NOW + timedelta(days=7)},
            {"_id": SESSION_ADMIN_B, "userId": ADMIN_B, "organizationId": ORG_B,
             "status": "active", "familyId": ObjectId(), "expiresAt": NOW + timedelta(days=7)},
        ]
    )

    await db.conversations.insert_many(
        [
            _conversation(CONV_ADMIN_A, ORG_A, ADMIN_A, "Ananya Reddy", "L-1001",
                          92, "hot", ["event_date", "venue", "budget", "replied", "quotation_requested"]),
            _conversation(CONV_STAFF_A, ORG_A, STAFF_A, "Rahul Mehta", "L-1002",
                          55, "warm", ["event_date", "replied"]),
            _conversation(CONV_B, ORG_B, ADMIN_B, "Other Org Lead", "L-9001",
                          88, "hot", ["event_date", "venue", "budget", "replied"]),
        ]
    )

    await db.messages.insert_many(
        [
            _message(CONV_ADMIN_A, ORG_A, "in",
                     "Hi, we are planning a December wedding at Leela Palace. What is the price?", 5),
            _message(CONV_ADMIN_A, ORG_A, "outbound",
                     "Our candid package starts at 80,000. Shall I send the full quotation?", 4),
            _message(CONV_ADMIN_A, ORG_A, "in",
                     "That seems a bit high honestly, our budget is around 80000 total.", 3),
            _message(CONV_STAFF_A, ORG_A, "in",
                     "SECRET-STAFF-THREAD do not reveal this to anyone else. December plans.", 2),
            _message(CONV_B, ORG_B, "in",
                     "SECRET-ORG-B confidential December booking for a different company.", 2),
        ]
    )

    await db.followuptasks.insert_one(
        {
            "_id": ObjectId(), "organizationId": ORG_A, "assignedTo": ADMIN_A,
            "status": "pending", "title": "Send Ananya the December quotation",
            "conversationId": CONV_ADMIN_A, "dueAt": NOW - timedelta(hours=3),
        }
    )

    print(f"Seeded '{database_name}' on {mongo_uri}")
    print(f"  org A      {ORG_A}  admin={ADMIN_A} staff={STAFF_A}")
    print(f"  org B      {ORG_B}  admin={ADMIN_B}")
    print(f"  org A convs: Ananya Reddy (admin, hot 92), Rahul Mehta (staff, warm 55)")
    print(f"  org B conv : Other Org Lead")
    print(f"  login      : slug=studio-a  email=asha@studio-a.test  password={E2E_PASSWORD}")
    print(f"               slug=studio-a  email=vikram@studio-a.test (staff)")
    print(f"               slug=studio-b  email=priya@studio-b.test (other org)")

    client.close()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mongo-uri", default="mongodb://localhost:27017")
    parser.add_argument("--database", default="wam_crm_ai_assistant_e2e")
    parser.add_argument("--i-know-what-im-doing", action="store_true")
    args = parser.parse_args()

    host_is_local = any(
        token in args.mongo_uri for token in ("localhost", "127.0.0.1", "[::1]")
    )

    if args.database in PROTECTED_DATABASES and not args.__dict__["i_know_what_im_doing"]:
        print(
            f"Refusing to drop '{args.database}'. This script calls drop_database, and that "
            f"name is either a system database or the developer's own working data.",
            file=sys.stderr,
        )
        return 2

    if not host_is_local and not args.__dict__["i_know_what_im_doing"]:
        print(
            f"Refusing to seed a non-loopback host ({args.mongo_uri}). Pass "
            f"--i-know-what-im-doing only if you are certain it is not production.",
            file=sys.stderr,
        )
        return 2

    asyncio.run(seed(args.mongo_uri, args.database))

    return 0


if __name__ == "__main__":
    sys.exit(main())
