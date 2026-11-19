"""
Amounts in words, Indian style.

Why this is in the domain layer
------------------------------
"Rupees Four Lakh Seventy Two Thousand and Fifty Paise Only" is not decoration.
An amount in words is what an accountant checks the figures against, and on a
disputed invoice it is the line a court reads — the words govern when words and
figures disagree. So it is business logic, it belongs next to the money types,
and it gets tested like arithmetic rather than eyeballed like a label.

Indian grouping, not Western
----------------------------
Indian numbering groups the first three digits, then in pairs: 12,34,567 reads
"twelve lakh thirty-four thousand five hundred sixty-seven", not "one million
two hundred thirty-four thousand...". Getting this wrong is immediately obvious
to every Indian reader and invisible to everyone else, which is the worst
combination for a bug.

The scale names are: thousand (10^3), lakh (10^5), crore (10^7), and above that
arab / kharab exist but are effectively unused in commerce — an invoice past
₹100 crore is rare enough that spelling it "one thousand crore" is both correct
and clearer than reaching for "arab".
"""

from __future__ import annotations

from decimal import ROUND_HALF_UP, Decimal, InvalidOperation

_UNITS = (
    "Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight",
    "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen",
    "Sixteen", "Seventeen", "Eighteen", "Nineteen",
)
_TENS = (
    "", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy",
    "Eighty", "Ninety",
)


def _two_digits(n: int) -> str:
    """0-99. Teens are irregular in English, so 0-19 is a lookup, not a rule."""
    if n < 20:
        return _UNITS[n]
    tens, ones = divmod(n, 10)
    return _TENS[tens] + (f"-{_UNITS[ones]}" if ones else "")


def _three_digits(n: int) -> str:
    """0-999."""
    hundreds, rest = divmod(n, 100)
    parts = []
    if hundreds:
        parts.append(f"{_UNITS[hundreds]} Hundred")
    if rest:
        parts.append(_two_digits(rest))
    return " ".join(parts)


def integer_to_words(value: int) -> str:
    """
    A non-negative integer in Indian words.

    >>> integer_to_words(1234567)
    'Twelve Lakh Thirty-Four Thousand Five Hundred Sixty-Seven'
    """
    if value < 0:
        raise ValueError("integer_to_words does not take negative values")
    if value == 0:
        return "Zero"

    # Split from the right in Indian groups: 3 digits, then pairs.
    #   1,23,45,678 -> crore=1, lakh=23, thousand=45, hundreds=678
    hundreds = value % 1000
    value //= 1000
    thousands = value % 100
    value //= 100
    lakhs = value % 100
    value //= 100
    crores = value  # everything above 10^7, spelled as "N Crore"

    parts: list[str] = []
    if crores:
        # Recurse for crores so ₹1,20,00,00,000 reads "One Hundred Twenty Crore"
        # rather than needing an "arab" nobody uses on an invoice.
        parts.append(f"{integer_to_words(crores)} Crore")
    if lakhs:
        parts.append(f"{_two_digits(lakhs)} Lakh")
    if thousands:
        parts.append(f"{_two_digits(thousands)} Thousand")
    if hundreds:
        parts.append(_three_digits(hundreds))
    return " ".join(parts)


def rupees_in_words(amount: Decimal | float | int | str) -> str:
    """
    A money amount as it appears on a tax invoice.

    Rounds to two decimals first, because the words must agree with the figure
    printed beside them — and the figure is always shown to paise. Rounding
    inside the words but not the figure is how the two end up disagreeing.

    >>> rupees_in_words(472000)
    'Rupees Four Lakh Seventy-Two Thousand Only'
    >>> rupees_in_words(Decimal("1250.50"))
    'Rupees One Thousand Two Hundred Fifty and Fifty Paise Only'
    """
    try:
        value = Decimal(str(amount))
    except (InvalidOperation, TypeError, ValueError):
        return ""

    negative = value < 0
    # ROUND_HALF_UP explicitly. Decimal's default is ROUND_HALF_EVEN — banker's
    # rounding — which sends ₹10.005 to ₹10.00 while the figure printed beside
    # these words rounds half-up to ₹10.01. Two roundings, two answers, on the
    # same invoice. Half-up is also what Indian tax practice expects, so this is
    # the correct rule as well as the consistent one.
    value = abs(value).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)

    whole = int(value)
    paise = int((value - whole) * 100)

    words = "Rupees " + integer_to_words(whole)
    if paise:
        # "and Fifty Paise" — the conjunction is conventional on Indian invoices
        # and its absence reads as a typo to the people who check these.
        words += f" and {_two_digits(paise)} Paise"
    words += " Only"

    return ("Minus " + words) if negative else words


# ── GST state codes ──────────────────────────────────────────────────────────
#
# The first two digits of a GSTIN are the state code, so a supplier's or
# customer's state code never needs to be stored or asked for — it is already
# inside a field we have, and deriving it means it cannot disagree with the
# GSTIN. Place of supply is a mandatory field on a tax invoice (CGST Rule 46)
# and is what decides CGST+SGST versus IGST.
GST_STATE_CODES = {
    "01": "Jammu and Kashmir", "02": "Himachal Pradesh", "03": "Punjab",
    "04": "Chandigarh", "05": "Uttarakhand", "06": "Haryana", "07": "Delhi",
    "08": "Rajasthan", "09": "Uttar Pradesh", "10": "Bihar", "11": "Sikkim",
    "12": "Arunachal Pradesh", "13": "Nagaland", "14": "Manipur",
    "15": "Mizoram", "16": "Tripura", "17": "Meghalaya", "18": "Assam",
    "19": "West Bengal", "20": "Jharkhand", "21": "Odisha",
    "22": "Chhattisgarh", "23": "Madhya Pradesh", "24": "Gujarat",
    "25": "Daman and Diu", "26": "Dadra and Nagar Haveli and Daman and Diu",
    "27": "Maharashtra", "28": "Andhra Pradesh (old)", "29": "Karnataka",
    "30": "Goa", "31": "Lakshadweep", "32": "Kerala", "33": "Tamil Nadu",
    "34": "Puducherry", "35": "Andaman and Nicobar Islands",
    "36": "Telangana", "37": "Andhra Pradesh", "38": "Ladakh",
    "97": "Other Territory", "99": "Centre Jurisdiction",
}

_STATE_TO_CODE = {name.lower(): code for code, name in GST_STATE_CODES.items()}


def state_code_from_gstin(gstin: str | None) -> str | None:
    """The two-digit state code encoded in a GSTIN, or None if unusable."""
    if not gstin:
        return None
    cleaned = gstin.strip().upper()
    if len(cleaned) < 2 or not cleaned[:2].isdigit():
        return None
    return cleaned[:2] if cleaned[:2] in GST_STATE_CODES else None


def state_name_from_gstin(gstin: str | None) -> str | None:
    code = state_code_from_gstin(gstin)
    return GST_STATE_CODES.get(code) if code else None


def code_for_state_name(state: str | None) -> str | None:
    """
    Reverse lookup, for parties with a state recorded but no GSTIN — an
    unregistered customer still needs a place of supply on the invoice.
    """
    if not state:
        return None
    return _STATE_TO_CODE.get(state.strip().lower())


def place_of_supply(state: str | None, gstin: str | None) -> str:
    """
    "Karnataka (29)" — the format tax software prints and auditors expect.

    Prefers the GSTIN, because it is machine-checkable and a typed state name
    is not. Falls back to the recorded state name, then to whatever we have.
    """
    code = state_code_from_gstin(gstin)
    if code:
        return f"{GST_STATE_CODES[code]} ({code})"
    code = code_for_state_name(state)
    if code:
        return f"{GST_STATE_CODES[code]} ({code})"
    return (state or "").strip() or "—"
