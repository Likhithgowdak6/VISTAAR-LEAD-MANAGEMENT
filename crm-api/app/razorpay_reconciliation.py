"""A bounded, leased provider sweep. It records receipts; it never creates links or sends messages."""
import logging
import secrets
from datetime import timedelta

from app import db
from app.payment_links_repository import LINKS
from app.razorpay_service import sync_link, database_or

logger = logging.getLogger(__name__)

async def reconcile_links(*, db_override=None, client=None, limit=100):
    database = database_or(db_override)
    result = {"checked": 0, "recorded": 0, "errors": 0}
    for _ in range(min(max(limit, 0), 100)):
        now, lease = db.utc_now(), secrets.token_hex(16)
        row = await database[LINKS].find_one_and_update(
            {"settledAt": None, "nextCheckAt": {"$lte": now},
             "$or": [{"leaseUntil": None}, {"leaseUntil": {"$lte": now}}]},
            {"$set": {"leaseToken": lease, "leaseUntil": now + timedelta(minutes=5),
                      "nextCheckAt": now + timedelta(minutes=10)}},
            sort=[("nextCheckAt", 1)], return_document=True)
        if not row:
            break
        result["checked"] += 1
        changes = {}
        try:
            outcome = await sync_link(organization_id=row["organizationId"], link_id=row["_id"],
                                      client=client, db_override=database)
            result["recorded"] += outcome["recorded"]
            if outcome["link"]["state"] in ("expired", "cancelled"):
                # A late captured payment can follow cancellation/expiry. Keep checking these
                # quietly once a day rather than declaring that no money can ever arrive.
                changes["nextCheckAt"] = db.utc_now() + timedelta(days=1)
        except Exception as exc:
            result["errors"] += 1
            changes["lastError"] = getattr(exc, "code", "RECONCILIATION_FAILED")
            # Do not log exception messages, raw provider responses, or credentials.
            logger.warning("Razorpay reconciliation failed (%s)", type(exc).__name__)
        finally:
            await database[LINKS].update_one(
                {"_id": row["_id"], "organizationId": row["organizationId"], "leaseToken": lease},
                {"$set": changes, "$unset": {"leaseUntil": "", "leaseToken": ""}})
    return result

def create_razorpay_reconciliation_runner():
    from app.runners import IntervalRunner
    return IntervalRunner(name="razorpay_reconciliation", tick=reconcile_links, interval_seconds=600)
