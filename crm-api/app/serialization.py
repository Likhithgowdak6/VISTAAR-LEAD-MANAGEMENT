"""
Turning MongoDB documents into exactly the JSON the Node backend returns.

THIS FILE EXISTS BECAUSE THE OBVIOUS IMPLEMENTATIONS ARE WRONG. Both halves of the API are
live at once behind one Caddy, and the React frontend cannot tell which answered - so "near
enough" is not a standard that applies. The two traps:

  - `datetime.isoformat()` produces "2026-11-07T10:30:00+00:00", or six microsecond digits when
    there are any. JavaScript's `toISOString()` - which is what serialization.ts calls - always
    produces exactly three fractional digits and a literal "Z". A client parsing one and
    comparing it to the other finds two different strings for the same instant.

  - `str(ObjectId)` is right, but `None` must stay `null` rather than becoming "None". Node's
    `serializeId` returns null for any falsy value, and that includes an unset reference.

Mirrors backend/src/utils/serialization.ts. Changing either without the other is how the two
backends start disagreeing about a response neither of them is obviously wrong about.
"""

from datetime import datetime, timezone
from typing import Any


def serialize_id(value: Any) -> str | None:
    """
    `str(value)`, or None.

    Node returns null for every falsy value, so an unset ObjectId reference, an empty string and
    None all collapse to null here too.
    """
    if not value:
        return None

    return str(value)


def serialize_date(value: Any) -> str | None:
    """
    JavaScript's `Date.toISOString()`, exactly.

    Always three fractional digits, always "Z", never an offset. Naive datetimes are read as
    UTC, which is what the driver returns for a BSON date - Mongo stores no zone.
    """
    if not value:
        return None

    if not isinstance(value, datetime):
        return None

    moment = value.astimezone(timezone.utc) if value.tzinfo else value.replace(tzinfo=timezone.utc)

    # Built by hand rather than with strftime's %f, which emits six digits. Truncating rather
    # than rounding matches JavaScript, which simply drops sub-millisecond precision.
    millis = moment.microsecond // 1000

    return f"{moment.strftime('%Y-%m-%dT%H:%M:%S')}.{millis:03d}Z"
