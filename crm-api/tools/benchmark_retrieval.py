"""
How lexical retrieval behaves as a CRM grows.

MEASURES, CHANGES NOTHING. Seeds an isolated database with synthetic conversations and messages
at several sizes and times `LexicalRetriever.search` against each. The point is to answer three
questions with numbers rather than opinion:

1. Is the current approach fast enough at the sizes this CRM will actually reach?
2. Where does it stop being fast enough?
3. Does the 500-conversation scope cap bite before latency does?

Refuses non-loopback hosts and the developer's own database, like the seed script.
"""

from __future__ import annotations

import argparse
import asyncio
import statistics
import sys
import time
from pathlib import Path

# Run as `python tools/benchmark_retrieval.py` from crm-api/, so the package root is one level
# up from this file rather than on the path already.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from datetime import datetime, timedelta, timezone

from bson import ObjectId
from motor.motor_asyncio import AsyncIOMotorClient

NOW = datetime.now(timezone.utc)
ORG = ObjectId("000000000000000000000c01")
ACTOR = ObjectId("000000000000000000000c11")

PROTECTED = {"wam_crm_ai", "admin", "config", "local"}

#: Realistic-ish WhatsApp fragments, cycled so the index has varied vocabulary. Retrieval
#: quality is not what this measures — latency against volume is.
BODIES = [
    "Hi, we are planning a December wedding at Leela Palace. What is the price?",
    "Our budget is around 80000 total for the full day shoot",
    "That seems a bit high honestly, can you do better on the candid package",
    "Can I see your portfolio from previous weddings in Bengaluru",
    "We have not decided the date yet, maybe February or March next year",
    "shaadi ka date 12 December hai, venue abhi finalise nahi hua",
    "Please share the quotation with the drone coverage included",
    "Is the photographer available on the 12th, we need confirmation",
    "We are also talking to another vendor who quoted less",
    "Thanks, we will discuss with family and revert by Monday",
]


async def seed(db, conversations: int, messages_each: int) -> None:
    await db.conversations.delete_many({})
    await db.messages.delete_many({})

    convs = []
    msgs = []

    for index in range(conversations):
        conv_id = ObjectId()
        convs.append(
            {
                "_id": conv_id,
                "organizationId": ORG,
                "assignedTo": ACTOR,
                "displayName": f"Lead {index}",
                "deletedAt": None,
                "lastMessageAt": NOW - timedelta(minutes=index),
            }
        )

        for message_index in range(messages_each):
            msgs.append(
                {
                    "_id": ObjectId(),
                    "organizationId": ORG,
                    "conversationId": conv_id,
                    "direction": "in" if message_index % 2 == 0 else "outbound",
                    "body": BODIES[(index + message_index) % len(BODIES)],
                    "sentAt": NOW - timedelta(minutes=index * 10 + message_index),
                }
            )

    await db.conversations.insert_many(convs)

    for start in range(0, len(msgs), 2000):
        await db.messages.insert_many(msgs[start : start + 2000])

    # The index the live collection has. Benchmarking without it would measure a collection
    # scan that production does not perform.
    await db.messages.create_index([("organizationId", 1), ("conversationId", 1), ("sentAt", -1)])
    await db.conversations.create_index([("organizationId", 1), ("lastMessageAt", -1)])


async def time_search(retriever, context, query: str, runs: int = 5) -> dict:
    timings = []
    found = 0

    for _ in range(runs):
        started = time.perf_counter()
        passages = await retriever.search(query=query, context=context, top_k=4)
        timings.append((time.perf_counter() - started) * 1000)
        found = len(passages)

    return {
        "p50": round(statistics.median(timings), 1),
        "max": round(max(timings), 1),
        "found": found,
    }


async def run(mongo_uri: str, database_name: str) -> int:
    client = AsyncIOMotorClient(mongo_uri, serverSelectionTimeoutMS=5000)
    db = client[database_name]

    # Imported here so `app.db` can be pointed at this database first.
    from app import db as app_db
    from app.assistant_retrieval import MAX_SCOPED_CONVERSATIONS, SCAN_LIMIT, LexicalRetriever
    from app.assistant_tools import ToolContext
    from app.permissions import CONVERSATIONS_READ_ALL, CONVERSATIONS_READ_ASSIGNED

    app_db.get_database = lambda: db  # type: ignore[assignment]

    # A/B WITHIN ONE RUN, using the real code paths rather than a patched constant.
    #
    # Every conversation is assigned to ACTOR, so the two contexts differ in exactly one way:
    # `read_all` takes the uncapped admin path, `read_assigned` takes the enumeration that
    # still applies the 500-conversation cap. Same data, same ranking, same scan limit — the
    # only variable is the cap, which is what the change was about.
    admin = ToolContext(
        organization_id=ORG,
        actor_id=ACTOR,
        permissions=(CONVERSATIONS_READ_ALL, CONVERSATIONS_READ_ASSIGNED),
    )
    capped = ToolContext(
        organization_id=ORG,
        actor_id=ACTOR,
        permissions=(CONVERSATIONS_READ_ASSIGNED,),
    )
    retriever = LexicalRetriever()

    print(f"MAX_SCOPED_CONVERSATIONS={MAX_SCOPED_CONVERSATIONS}  SCAN_LIMIT={SCAN_LIMIT}\n")
    print(
        f"{'convs':>7} {'msgs':>7} {'capped ms':>10} {'admin ms':>9} "
        f"{'capped?':>8} {'admin?':>7}"
    )
    print("-" * 56)

    # Sparse first (1 message each), so total messages stay under SCAN_LIMIT and the
    # CONVERSATION CAP is the only binding constraint — that is the limitation this change
    # removed. Then dense, where SCAN_LIMIT binds for both paths and neither can reach the
    # oldest message: proof that coverage is improved, not unlimited.
    for conversations, messages_each in (
        (200, 1),
        (500, 1),
        (1000, 1),
        (1400, 1),
        (500, 20),
        (2000, 20),
    ):
        await seed(db, conversations, messages_each)

        # A NEEDLE IN THE OLDEST CONVERSATION. Latency alone cannot show the coverage
        # problem — the old path was fast precisely because it ignored most of the data.
        # This asks whether the oldest conversation is reachable at all.
        buried = ObjectId()
        await db.conversations.insert_one(
            {
                "_id": buried,
                "organizationId": ORG,
                "assignedTo": ACTOR,
                "displayName": "Buried",
                "deletedAt": None,
                "lastMessageAt": NOW - timedelta(days=4000),
            }
        )
        await db.messages.insert_one(
            {
                "_id": ObjectId(),
                "organizationId": ORG,
                "conversationId": buried,
                "direction": "in",
                "body": "the zygomorphic pergola gazebo arrangement",
                "sentAt": NOW - timedelta(days=4000),
            }
        )

        found_admin = await retriever.search(
            query="zygomorphic pergola gazebo", context=admin, top_k=4
        )
        found_capped = await retriever.search(
            query="zygomorphic pergola gazebo", context=capped, top_k=4
        )

        admin_timing = await time_search(
            retriever, admin, "December wedding Leela Palace budget"
        )
        capped_timing = await time_search(
            retriever, capped, "December wedding Leela Palace budget"
        )

        total_messages = conversations * messages_each + 1
        flag = ""

        if total_messages > SCAN_LIMIT:
            flag = f"  <- past SCAN_LIMIT ({SCAN_LIMIT} messages)"
        elif conversations > MAX_SCOPED_CONVERSATIONS:
            flag = f"  <- past the {MAX_SCOPED_CONVERSATIONS} conversation cap"

        print(
            f"{conversations:>7} {total_messages:>7} {capped_timing['p50']:>10} "
            f"{admin_timing['p50']:>9} "
            f"{('yes' if found_capped else 'NO'):>8} "
            f"{('yes' if found_admin else 'NO'):>7}{flag}"
        )

    await client.drop_database(database_name)
    client.close()

    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mongo-uri", default="mongodb://localhost:27017")
    parser.add_argument("--database", default="wam_crm_ai_retrieval_bench")
    args = parser.parse_args()

    if args.database in PROTECTED:
        print(f"Refusing to use '{args.database}'.", file=sys.stderr)
        return 2

    if not any(t in args.mongo_uri for t in ("localhost", "127.0.0.1", "[::1]")):
        print(f"Refusing a non-loopback host ({args.mongo_uri}).", file=sys.stderr)
        return 2

    return asyncio.run(run(args.mongo_uri, args.database))


if __name__ == "__main__":
    sys.exit(main())
