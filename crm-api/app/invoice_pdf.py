"""
A ruled GST tax invoice, in the shape Indian billing software produces.

LIFTED FROM vistaar-payment-bot (`app/invoices/billbook.py`) ESSENTIALLY UNCHANGED. Only the two
imports differ: `app.logger` became the standard library's logging, and the words/place-of-supply
helpers moved to `app.domain.words`. Everything below that is the original.

It was lifted rather than rewritten because it is 993 lines of millimetre-tuned layout for a
document a client's accounts team reconciles against GSTR-2B, and the statutory requirements it
satisfies - set out below - were worked out once already. Re-deriving it from a description would
only be a second chance to leave a required field off a tax invoice.

NOTHING IN HERE KNOWS ABOUT MONGO, and it should stay that way. Every field is read through
`getattr(obj, name, default)`, which is what lets `invoice_pdf_service.py` hand it plain
namespaces built from CRM documents. Reaching into a dict here would couple a layout file to a
schema.

Why this replaces the previous design
-------------------------------------
The old PDF was a modern SaaS invoice: a dark banner across the top, "BILL TO",
generous white space, no cell borders. It looks current, and it is the wrong
document. Two reasons:

1. **It was missing statutory fields.** CGST Rule 46 requires, among others: the
   words "Tax Invoice"; the recipient's GSTIN; place of supply; the state name;
   HSN/SAC per line; the tax rate per line; CGST, SGST and IGST in *separate*
   columns; a reverse-charge statement; and a signature. Several were absent, and
   HSN was being appended to the description string rather than given its own
   column, which is not the same thing to an auditor.

2. **It was unfamiliar to the people who read it.** An invoice is read by the
   customer's accounts clerk, who reconciles hundreds of them against GSTR-2B.
   A ruled grid with the columns in the expected order is faster for that person
   than a beautiful layout they have to decode. Familiarity is a feature here,
   not a compromise.

Design notes
------------
- **Ruled, not banded.** Every cell has a border. That is what makes it scan
  like a bill book and, practically, what stops a figure being read against the
  wrong row when the page is printed and faxed — which still happens.
- **CGST+SGST or IGST, never both.** Intrastate supply splits the tax in two
  halves; interstate charges IGST. Showing all three columns with zeros in some
  is how people mis-file returns, so the table is built to match the supply.
- **HSN-wise tax summary.** A second small table totalling tax by rate. Mandatory
  in spirit (the return is filed rate-wise) and the first thing a clerk checks.
- **Multi-tenant.** Nothing about any one business is hardcoded. Everything comes
  from BusinessProfile, and each block is skipped when its data is absent — a
  business with no UPI ID gets no UPI row rather than an empty label.

Coordinates
-----------
ReportLab's origin is bottom-left, so `y` decreases down the page. Every helper
here takes and returns the current `y`, which keeps the flow readable and makes
"does this fit on the page" a single comparison rather than bookkeeping.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import date
from decimal import ROUND_HALF_UP, Decimal
from io import BytesIO

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas

from app.domain.words import place_of_supply, rupees_in_words

logger = logging.getLogger(__name__)

# ── Page geometry ────────────────────────────────────────────────────────────
PAGE_W, PAGE_H = A4
MARGIN = 12 * mm
CONTENT_W = PAGE_W - 2 * MARGIN

# ── Ink ──────────────────────────────────────────────────────────────────────
# Near-black rules rather than mid-grey: this document gets printed on cheap
# office printers and photocopied, and a 30% grey hairline disappears entirely
# after one generation of copying.
RULE = colors.HexColor("#1A1A1A")
RULE_LIGHT = colors.HexColor("#8A8A8A")
INK = colors.HexColor("#111111")
INK_SOFT = colors.HexColor("#555555")
BAND = colors.HexColor("#EFEFEF")
BAND_DARK = colors.HexColor("#DCDCDC")

FONT = "Helvetica"
FONT_B = "Helvetica-Bold"


def _money(value) -> Decimal:
    """A Decimal rounded to paise, half-up, tolerant of what the ORM hands back."""
    try:
        return Decimal(str(value or 0)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    except Exception:
        return Decimal("0.00")


def _fmt(value) -> str:
    """
    Indian digit grouping: 4,72,000.00 — pairs after the first three digits.

    Written by hand rather than via locale, because the `en_IN` locale is not
    installed in most containers and `locale.setlocale` is process-global, so a
    PDF render would change number formatting for every other thread.
    """
    d = _money(value)
    negative = d < 0
    whole, _, frac = f"{abs(d):.2f}".partition(".")
    if len(whole) > 3:
        head, tail = whole[:-3], whole[-3:]
        groups = []
        while len(head) > 2:
            groups.insert(0, head[-2:])
            head = head[:-2]
        if head:
            groups.insert(0, head)
        whole = ",".join(groups + [tail])
    out = f"{whole}.{frac}"
    return f"-{out}" if negative else out


def _qty(value) -> str:
    """
    Quantities print without trailing zeros: 2 not 2.00, 2.5 stays 2.5.

    Not via Decimal.normalize(). That "simplifies" a trailing zero into an
    exponent, so a quantity of 620 printed as `6.2E+2` and 1000 as `1E+3` — on
    an invoice line, next to a unit. It shipped that way for exactly one render,
    which is one more than it should have.
    """
    try:
        d = Decimal(str(value or 0))
    except Exception:
        return "0"
    if d == d.to_integral_value():
        return str(int(d))
    # Up to three decimals, then trim the padding — enough for 0.125 kg, and
    # rstrip is safe here because the string always contains a '.'.
    return f"{d:.3f}".rstrip("0").rstrip(".")


@dataclass
class _Col:
    """One column of the item grid."""

    key: str
    title: str
    width: float
    align: str = "left"


def _text(c, x, y, s, *, font=FONT, size=8.2, colour=INK, align="left"):
    c.setFont(font, size)
    c.setFillColor(colour)
    if align == "right":
        c.drawRightString(x, y, str(s))
    elif align == "center":
        c.drawCentredString(x, y, str(s))
    else:
        c.drawString(x, y, str(s))


def _wrap(c, text, font, size, max_w) -> list[str]:
    """Greedy wrap. Also breaks a single over-long token, which a naive
    word-wrap silently lets overflow the cell."""
    words = str(text or "").split()
    if not words:
        return [""]
    lines: list[str] = []
    line = ""
    for w in words:
        probe = f"{line} {w}".strip()
        if c.stringWidth(probe, font, size) <= max_w:
            line = probe
            continue
        if line:
            lines.append(line)
        # A token wider than the cell (a long SKU, a URL) must be cut, not left
        # to run over the border.
        while c.stringWidth(w, font, size) > max_w and len(w) > 1:
            cut = len(w)
            while cut > 1 and c.stringWidth(w[:cut], font, size) > max_w:
                cut -= 1
            lines.append(w[:cut])
            w = w[cut:]
        line = w
    if line:
        lines.append(line)
    return lines


class BillBookInvoice:
    """Renders one invoice. Stateful only for the duration of the render."""

    @staticmethod
    def _default_title(profile) -> str:
        """
        "TAX INVOICE" only when there is a GSTIN to put on it.

        Rule 46 requires the supplier's GSTIN on a tax invoice, so a document
        headed "TAX INVOICE" with that field blank is not one — and handing it to
        a customer's accounts team gets it sent back, because they cannot claim
        input credit against it. A business that hasn't entered a GSTIN is either
        unregistered or hasn't finished setting up, and in both cases "INVOICE"
        is the honest heading.
        """
        gstin = (getattr(profile, "gstin", None) or "").strip()
        return "TAX INVOICE" if gstin else "INVOICE"

    def __init__(self, invoice, client, profile, *, items, is_interstate, doc_title=None):
        self.inv = invoice
        self.client = client
        self.profile = profile
        self.items = items
        self.interstate = is_interstate
        self.doc_title = doc_title or self._default_title(profile)
        self.buffer = BytesIO()
        self.c = canvas.Canvas(self.buffer, pagesize=A4)
        self.c.setTitle(f"{doc_title} {getattr(invoice, 'invoice_number', '')}".strip())
        self.page = 1
        self.columns = self._build_columns()

    # ── Columns ─────────────────────────────────────────────────────────────
    def _build_columns(self) -> list[_Col]:
        """
        Column set follows the supply type, and widths are measured, not guessed.

        An intrastate invoice shows CGST and SGST; an interstate one shows IGST.
        Printing all three and zeroing two of them is a real source of filing
        errors, so the grid is built for the invoice in hand.

        Two decisions that buy the description column enough room to be readable
        — A4 portrait is 186mm of usable width, and twelve columns do not fit:

        - **Quantity and unit share a column** ("3 day", "620 sqft"). They are
          read as one value anyway, and splitting them cost 10mm to print the
          word "Unit" twice.
        - **One tax-rate column, not two.** CGST and SGST are always half each of
          a single GST rate, so printing "9%" twice conveys nothing. Rule 46
          requires the rate per item and the *amounts* in separate columns; it
          does not require the rate twice. The amounts remain separate.

        The first version of this method allocated the description column
        whatever was left over, which turned out to be 12mm — one word per line,
        rows 90mm tall, two items per page. Now the fixed columns are sized to
        their widest realistic content and the description gets the remainder,
        with a floor it cannot go below.
        """
        c = self.c

        def needed(samples: list[str], title: str, *, pad=3.4 * mm) -> float:
            """Width to hold the widest sample and the widest word of the title."""
            body = max((c.stringWidth(s, FONT_B, 8.2) for s in samples), default=0)
            head = max((c.stringWidth(w, FONT_B, 6.9) for w in title.split()), default=0)
            return max(body, head) + pad

        # Realistic worst cases rather than theoretical ones: a ₹99,99,999.00
        # line item on an SMB invoice is not a thing, and sizing for it would
        # steal width from the description on every ordinary invoice.
        amount_samples = ["28,85,000.00"]
        rate_samples = ["2,85,000.00"]

        cols = [
            _Col("sn", "S.No", needed(["99"], "S.No"), "center"),
            _Col("desc", "Description of Goods / Services", 0, "left"),  # flexes
            _Col("hsn", "HSN/SAC", needed(["99999999"], "HSN/SAC"), "center"),
            _Col("qty", "Qty", needed(["620 sqft"], "Qty"), "right"),
            _Col("rate", "Rate", needed(rate_samples, "Rate"), "right"),
            _Col("taxable", "Taxable Value", needed(amount_samples, "Taxable"), "right"),
            _Col("tax_r", "GST %", needed(["18%"], "GST %"), "center"),
        ]
        if self.interstate:
            cols.append(_Col("igst_a", "IGST Amt", needed(amount_samples, "IGST"), "right"))
        else:
            cols.append(_Col("cgst_a", "CGST Amt", needed(amount_samples, "CGST"), "right"))
            cols.append(_Col("sgst_a", "SGST Amt", needed(amount_samples, "SGST"), "right"))
        cols.append(_Col("total", "Total", needed(amount_samples, "Total"), "right"))

        fixed = sum(col.width for col in cols)
        desc = next(col for col in cols if col.key == "desc")
        desc.width = CONTENT_W - fixed

        # A description narrower than this cannot hold a plausible line item, and
        # is the signal that a column was added without re-checking the budget.
        # Shrink the amount columns proportionally rather than shipping the
        # unreadable layout.
        MIN_DESC = 46 * mm
        if desc.width < MIN_DESC:
            shortfall = MIN_DESC - desc.width
            shrinkable = [col for col in cols if col.key not in ("desc", "sn")]
            pool = sum(col.width for col in shrinkable)
            for col in shrinkable:
                col.width -= shortfall * (col.width / pool)
            desc.width = MIN_DESC

        return cols

    def _col_x(self) -> list[float]:
        xs, x = [], MARGIN
        for col in self.columns:
            xs.append(x)
            x += col.width
        xs.append(x)
        return xs

    # ── Frame ───────────────────────────────────────────────────────────────
    def _outer_frame(self):
        """The box every bill book has around the whole page."""
        self.c.setStrokeColor(RULE)
        self.c.setLineWidth(1.1)
        self.c.rect(MARGIN, MARGIN, CONTENT_W, PAGE_H - 2 * MARGIN, fill=0, stroke=1)

    def _hline(self, y, *, width=0.6, colour=RULE, x0=None, x1=None):
        self.c.setStrokeColor(colour)
        self.c.setLineWidth(width)
        self.c.line(x0 if x0 is not None else MARGIN, y,
                    x1 if x1 is not None else PAGE_W - MARGIN, y)

    def _vline(self, x, y0, y1, *, width=0.6, colour=RULE):
        self.c.setStrokeColor(colour)
        self.c.setLineWidth(width)
        self.c.line(x, y0, x, y1)

    # ── Header ──────────────────────────────────────────────────────────────
    def _draw_header(self, y: float) -> float:
        c = self.c
        p = self.profile
        # THE ONE BEHAVIOURAL CHANGE FROM THE LIFTED ORIGINAL, AND IT IS A BUG FIX.
        #
        # It read `os.getenv("COMPANY_NAME")` when the profile had no name. That is reasonable in
        # a single-business application, which is what vistaar-payment-bot was. In a multi-tenant
        # CRM it is a data leak: a tenant who has not filled in their billing profile would issue
        # invoices headed with whatever company name happens to be in the server's environment -
        # which is another business's name.
        #
        # An unnamed business now prints no name. That is visibly incomplete, which is the point:
        # it prompts somebody to fill the profile in, rather than quietly looking correct and
        # wrong.
        name = (getattr(p, "company_name", None) or "").strip()

        # Document title, centred in its own band. "Tax Invoice" is a required
        # phrase, not a heading choice.
        band_h = 8.5 * mm
        c.setFillColor(BAND_DARK)
        c.rect(MARGIN, y - band_h, CONTENT_W, band_h, fill=1, stroke=0)
        self._hline(y - band_h)
        _text(c, PAGE_W / 2, y - band_h + 2.8 * mm, self.doc_title,
              font=FONT_B, size=11, align="center")
        y -= band_h

        # Supplier block on the left, invoice meta on the right, split by a rule.
        split_x = MARGIN + CONTENT_W * 0.58
        top = y
        ly = y - 6 * mm

        _text(c, MARGIN + 3 * mm, ly, name or "—", font=FONT_B, size=13)
        ly -= 5 * mm
        for line in _wrap(c, getattr(p, "address", "") or "", FONT, 8.2,
                          split_x - MARGIN - 8 * mm):
            _text(c, MARGIN + 3 * mm, ly, line, size=8.2, colour=INK_SOFT)
            ly -= 4 * mm

        gstin = (getattr(p, "gstin", None) or "").strip()
        if gstin:
            _text(c, MARGIN + 3 * mm, ly, f"GSTIN: {gstin}", font=FONT_B, size=8.6)
            ly -= 4.4 * mm
        state = (getattr(p, "state", None) or "").strip()
        if state or gstin:
            _text(c, MARGIN + 3 * mm, ly, f"State: {place_of_supply(state, gstin)}",
                  size=8.2, colour=INK_SOFT)
            ly -= 4.4 * mm

        # Right column: the fields a clerk looks up first.
        ry = y - 6 * mm
        meta = [
            ("Invoice No.", getattr(self.inv, "invoice_number", "") or "—"),
            ("Invoice Date", self._d(getattr(self.inv, "created_at", None)) or self._d(date.today())),
            ("Due Date", self._d(getattr(self.inv, "due_date", None)) or "—"),
            ("Place of Supply", place_of_supply(
                getattr(self.client, "state", None), getattr(self.client, "gstin", None))),
            # A reverse-charge statement is mandatory even when it is "No".
            ("Reverse Charge", "No"),
        ]
        for label, value in meta:
            _text(c, split_x + 3 * mm, ry, label, size=8, colour=INK_SOFT)
            _text(c, PAGE_W - MARGIN - 3 * mm, ry, value, font=FONT_B, size=8.6, align="right")
            ry -= 5.2 * mm

        y = min(ly, ry) - 1 * mm
        self._vline(split_x, y, top)
        self._hline(y)
        return y

    @staticmethod
    def _d(value) -> str:
        if not value:
            return ""
        try:
            return value.strftime("%d-%b-%Y")
        except AttributeError:
            return str(value)

    # ── Parties ─────────────────────────────────────────────────────────────
    def _draw_parties(self, y: float) -> float:
        """
        Bill To and Ship To side by side.

        Both are shown even when they're the same address, because their being
        the same is itself information — a clerk checking a delivery against an
        invoice needs to see that the ship-to was considered, not infer it from
        an absence.
        """
        c = self.c
        cl = self.client
        mid = MARGIN + CONTENT_W / 2
        top = y

        head_h = 6 * mm
        c.setFillColor(BAND)
        c.rect(MARGIN, y - head_h, CONTENT_W, head_h, fill=1, stroke=0)
        _text(c, MARGIN + 3 * mm, y - head_h + 1.8 * mm, "Billed To", font=FONT_B, size=8.4)
        _text(c, mid + 3 * mm, y - head_h + 1.8 * mm, "Shipped To", font=FONT_B, size=8.4)
        self._hline(y - head_h, width=0.5)
        y -= head_h

        billing = (getattr(cl, "billing_address", None) or "").strip()
        shipping = (getattr(cl, "shipping_address", None) or "").strip() or billing
        company = (getattr(cl, "company", None) or "").strip()
        display = company or getattr(cl, "name", "") or "—"

        def party(x, addr, *, show_contact):
            yy = y - 5 * mm
            _text(c, x + 3 * mm, yy, display, font=FONT_B, size=9.6)
            yy -= 4.6 * mm
            if company and getattr(cl, "name", None) and company != cl.name:
                _text(c, x + 3 * mm, yy, f"Attn: {cl.name}", size=8, colour=INK_SOFT)
                yy -= 4.2 * mm
            for line in _wrap(c, addr or "—", FONT, 8.2, CONTENT_W / 2 - 8 * mm):
                _text(c, x + 3 * mm, yy, line, size=8.2, colour=INK_SOFT)
                yy -= 4.1 * mm
            g = (getattr(cl, "gstin", None) or "").strip()
            if g:
                _text(c, x + 3 * mm, yy, f"GSTIN: {g}", font=FONT_B, size=8.2)
                yy -= 4.2 * mm
            st = (getattr(cl, "state", None) or "").strip()
            if st or g:
                _text(c, x + 3 * mm, yy, f"State: {place_of_supply(st, g)}", size=8, colour=INK_SOFT)
                yy -= 4.2 * mm
            if show_contact:
                contact = " · ".join(
                    v for v in [(getattr(cl, "phone", None) or "").strip(),
                                (getattr(cl, "email", None) or "").strip()] if v)
                if contact:
                    _text(c, x + 3 * mm, yy, contact, size=7.8, colour=INK_SOFT)
                    yy -= 4.2 * mm
            return yy

        left_y = party(MARGIN, billing, show_contact=True)
        right_y = party(mid, shipping, show_contact=False)

        y = min(left_y, right_y) - 0.5 * mm
        self._vline(mid, y, top - head_h)
        self._hline(y)
        return y

    # ── Item grid ───────────────────────────────────────────────────────────
    def _draw_table_head(self, y: float) -> float:
        c = self.c
        xs = self._col_x()
        head_h = 9 * mm
        c.setFillColor(BAND)
        c.rect(MARGIN, y - head_h, CONTENT_W, head_h, fill=1, stroke=0)

        for i, col in enumerate(self.columns):
            cx = {"left": xs[i] + 1.6 * mm,
                  "right": xs[i + 1] - 1.6 * mm,
                  "center": (xs[i] + xs[i + 1]) / 2}[col.align]
            # Wrap the heading only when it genuinely doesn't fit. The previous
            # rule keyed off column width, so "Description of Goods / Services"
            # got split and its second line ran straight through the HSN column
            # border — a heading colliding with the next column, which no amount
            # of reading the code would have revealed.
            avail = col.width - 3.2 * mm
            parts = _wrap(c, col.title, FONT_B, 6.9, avail)
            ty = y - 3.4 * mm if len(parts) > 1 else y - 5.6 * mm
            for part in parts[:2]:
                _text(c, cx, ty, part, font=FONT_B, size=6.9, align=col.align)
                ty -= 3.1 * mm

        self._hline(y - head_h, width=0.7)
        for x in xs[1:-1]:
            self._vline(x, y - head_h, y)
        return y - head_h

    def _row_cells(self, idx, item) -> dict[str, str]:
        qty = Decimal(str(getattr(item, "quantity", 0) or 0))
        rate = _money(getattr(item, "rate", 0))
        taxable = _money(getattr(item, "line_subtotal", None) if getattr(item, "line_subtotal", None) is not None
                         else qty * rate)
        tax = _money(getattr(item, "line_tax", 0))
        tax_rate = Decimal(str(getattr(item, "tax_rate", 0) or 0))

        unit = (getattr(item, "unit", None) or "").strip()
        cells = {
            "sn": str(idx),
            "desc": getattr(item, "description", "") or "—",
            "hsn": (getattr(item, "hsn_sac_code", None) or "—"),
            # Quantity and unit read as one value — "3 day", "620 sqft".
            "qty": f"{_qty(qty)} {unit}".strip() if unit else _qty(qty),
            "rate": _fmt(rate),
            "taxable": _fmt(taxable),
            # The full GST rate. CGST and SGST are half each of this, so the
            # halves are implied by the amounts beside it.
            "tax_r": f"{_qty(tax_rate)}%",
            "total": _fmt(taxable + tax),
        }
        if self.interstate:
            cells["igst_a"] = _fmt(tax)
        else:
            half = (tax / 2).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
            cells["cgst_a"] = _fmt(half)
            # The second half absorbs the rounding remainder, so CGST + SGST
            # always equals the tax charged. Halving twice and rounding both
            # loses a paisa on odd amounts, and an invoice whose columns don't
            # add up gets sent back.
            cells["sgst_a"] = _fmt(tax - half)
        return cells

    def _draw_rows(self, y: float) -> float:
        c = self.c
        xs = self._col_x()
        desc_i = next(i for i, col in enumerate(self.columns) if col.key == "desc")
        desc_w = self.columns[desc_i].width - 3.2 * mm

        for idx, item in enumerate(self.items, start=1):
            cells = self._row_cells(idx, item)
            lines = _wrap(c, cells["desc"], FONT, 8.2, desc_w)
            row_h = max(7 * mm, 3.2 * mm + len(lines) * 3.9 * mm)

            # Reserve room for the totals block; breaking a page immediately
            # before it looks like the invoice is missing its total.
            if y - row_h < MARGIN + self._footer_height() + 34 * mm:
                y = self._new_page(y)
                xs = self._col_x()

            ty = y - 4.6 * mm
            for i, col in enumerate(self.columns):
                cx = {"left": xs[i] + 1.6 * mm,
                      "right": xs[i + 1] - 1.6 * mm,
                      "center": (xs[i] + xs[i + 1]) / 2}[col.align]
                if col.key == "desc":
                    dy = ty
                    for line in lines:
                        _text(c, cx, dy, line, size=8.2)
                        dy -= 3.9 * mm
                else:
                    bold = col.key == "total"
                    _text(c, cx, ty, cells[col.key], size=8.2,
                          font=FONT_B if bold else FONT, align=col.align)

            y -= row_h
            self._hline(y, width=0.4, colour=RULE_LIGHT)
            for x in xs[1:-1]:
                self._vline(x, y, y + row_h, width=0.4, colour=RULE_LIGHT)

        return y

    # ── Filling a short invoice ──────────────────────────────────────────────
    #
    # Floor and ceiling for the footer band. The band is sized to its contents
    # between these: a fixed 46mm was enough for five bank fields *or* a terms
    # paragraph but not both, so terms silently disappeared from an invoice that
    # had them. A tenant with no bank details and no terms gets the floor, which
    # is just the signature box and the declaration.
    FOOTER_MIN_H = 30 * mm
    FOOTER_MAX_H = 78 * mm

    def _bank_lines(self) -> list[tuple[str, str]]:
        p = self.profile
        pairs = [
            ("Bank", getattr(p, "bank_name", None)),
            ("A/c Name", getattr(p, "bank_account_name", None)),
            ("A/c No.", getattr(p, "bank_account_number", None)),
            ("IFSC", getattr(p, "bank_ifsc", None)),
            ("UPI", getattr(p, "upi_id", None)),
        ]
        return [(k, str(v).strip()) for k, v in pairs if v and str(v).strip()]

    def _terms_lines(self) -> list[str]:
        terms = (getattr(self.inv, "terms", None) or "").strip()
        if not terms:
            return []
        # Mirrors the footer's own arithmetic: the terms column stops where the
        # pay block starts, or at the signature box when there is no link.
        pay_w = self.PAY_BLOCK_W if self._payment_url() else 0
        left_w = (PAGE_W - MARGIN - 58 * mm - pay_w) - MARGIN - 6 * mm
        return _wrap(self.c, terms, FONT, 7.4, left_w)

    PAY_BLOCK_W = 34 * mm

    def _payment_url(self) -> str | None:
        """The Razorpay link for this invoice, if one was created."""
        url = (getattr(self.inv, "razorpay_link_url", None) or "").strip()
        return url or None

    def _footer_height(self) -> float:
        """
        How tall the footer band needs to be for this invoice's content.

        Measured rather than assumed, because both a fixed value and a derived
        one failed here before: fixed dropped the terms, and deriving it from
        wherever the tables ended made the signature box grow to a third of the
        page on a one-line invoice.
        """
        # Declaration: three lines plus the gap above them.
        h = 2 * mm + 2 * 3.1 * mm + 3.4 * mm + 4 * mm

        bank = self._bank_lines()
        if bank:
            h += 4.2 * mm + len(bank) * 3.9 * mm

        terms = self._terms_lines()
        if terms:
            h += 1.5 * mm + 4 * mm + len(terms) * 3.6 * mm

        # Room for "For <Company>" above the signature line.
        h += 8 * mm

        # The QR block sits between the payment details and the signature, and is
        # taller than a couple of text lines — without accounting for it the
        # footer band was too short and the code overlapped the declaration.
        if self._payment_url():
            h = max(h, 52 * mm)

        return max(self.FOOTER_MIN_H, min(h, self.FOOTER_MAX_H))

    def _totals_height(self) -> float:
        """How tall the totals box will be, so the grid knows where to stop."""
        t = self._totals()
        rows = 1  # taxable
        if t["discount"]:
            rows += 1
        rows += 1 if self.interstate else 2  # IGST, or CGST + SGST
        if t["roundoff"]:
            rows += 1
        return rows * 6.2 * mm + 7.6 * mm  # normal rows + the emphasised total

    def _tax_summary_height(self) -> float:
        rates = {Decimal(str(getattr(i, "tax_rate", 0) or 0)) for i in self.items}
        if len(rates) < 2:
            return 0.0
        return 6 * mm + len(rates) * 5.8 * mm + 2 * mm

    def _close_grid(self, y: float) -> float:
        """
        Close the item grid under the last real row. No filler rows.

        An earlier version padded down to the totals with blank ruled rows, the
        way a pre-printed bill book does. It filled the page, but it also drew
        twenty empty boxes for a one-line invoice, which is a lot of ink to say
        nothing. Only content is ruled now; the space below the grid is left
        blank on purpose.

        The grid still gets a closing border and its column lines still stop at
        the last row, so it reads as a finished table with white space under it
        rather than a table that ran out mid-draw.
        """
        self._hline(y, width=0.7)
        return y

    def _new_page(self, y: float) -> float:
        """Close the grid, stamp continuation, start the next page."""
        _text(self.c, PAGE_W - MARGIN - 3 * mm, MARGIN + 4 * mm,
              f"Page {self.page} — continued overleaf", size=7.4, colour=INK_SOFT, align="right")
        self.c.showPage()
        self.page += 1
        self._outer_frame()
        y = PAGE_H - MARGIN
        y = self._draw_header(y)
        _text(self.c, MARGIN + 3 * mm, y - 4.5 * mm,
              f"{self.doc_title} {getattr(self.inv, 'invoice_number', '')} (continued)",
              font=FONT_B, size=8.4)
        y -= 7 * mm
        self._hline(y)
        return self._draw_table_head(y)

    # ── Totals, words, tax summary ──────────────────────────────────────────
    def _totals(self) -> dict[str, Decimal]:
        taxable = sum((_money(getattr(i, "line_subtotal", 0)) for i in self.items), Decimal("0"))
        tax = sum((_money(getattr(i, "line_tax", 0)) for i in self.items), Decimal("0"))
        discount = _money(getattr(self.inv, "discount_amount", 0))

        # Prefer the stored split — it is what the return was filed on — and fall
        # back to computing it only for invoices written before the split existed.
        cgst = _money(getattr(self.inv, "cgst_amount", 0))
        sgst = _money(getattr(self.inv, "sgst_amount", 0))
        igst = _money(getattr(self.inv, "igst_amount", 0))
        if not (cgst or sgst or igst):
            if self.interstate:
                igst = tax
            else:
                cgst = (tax / 2).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
                sgst = tax - cgst

        gross = taxable + cgst + sgst + igst - discount
        rounded = gross.quantize(Decimal("1"), rounding=ROUND_HALF_UP)
        return {
            "taxable": taxable, "cgst": cgst, "sgst": sgst, "igst": igst,
            "discount": discount, "gross": gross,
            "roundoff": rounded - gross, "grand": rounded,
        }

    def _draw_totals(self, y: float) -> float:
        c = self.c
        t = self._totals()
        box_w = 62 * mm
        box_x = PAGE_W - MARGIN - box_w
        top = y

        rows = [("Taxable Value", t["taxable"], False)]
        if t["discount"]:
            rows.append(("Discount", -t["discount"], False))
        if self.interstate:
            rows.append(("IGST", t["igst"], False))
        else:
            rows.append(("CGST", t["cgst"], False))
            rows.append(("SGST", t["sgst"], False))
        if t["roundoff"]:
            rows.append(("Round Off", t["roundoff"], False))
        rows.append(("Total", t["grand"], True))

        ry = y
        for label, value, strong in rows:
            h = 7.6 * mm if strong else 6.2 * mm
            if strong:
                c.setFillColor(BAND_DARK)
                c.rect(box_x, ry - h, box_w, h, fill=1, stroke=0)
            _text(c, box_x + 2.5 * mm, ry - h + 2.1 * mm, label,
                  font=FONT_B if strong else FONT, size=9 if strong else 8.4)
            _text(c, PAGE_W - MARGIN - 2.5 * mm, ry - h + 2.1 * mm, _fmt(value),
                  font=FONT_B if strong else FONT, size=9.4 if strong else 8.4, align="right")
            ry -= h
            self._hline(ry, width=0.4, colour=RULE_LIGHT, x0=box_x)

        # Amount in words, filling the space beside the totals box. This is the
        # line an accountant reads the figures against.
        _text(c, MARGIN + 3 * mm, y - 5 * mm, "Total Amount (in words)",
              font=FONT_B, size=7.6, colour=INK_SOFT)
        wy = y - 10 * mm
        for line in _wrap(c, rupees_in_words(t["grand"]), FONT_B, 9, box_x - MARGIN - 8 * mm):
            _text(c, MARGIN + 3 * mm, wy, line, font=FONT_B, size=9)
            wy -= 4.4 * mm

        y = min(ry, wy) - 1 * mm
        self._vline(box_x, y, top)
        self._hline(y)
        return y

    def _draw_tax_summary(self, y: float) -> float:
        """
        Tax totalled by rate.

        GST returns are filed rate-wise, so this is the table the customer's
        clerk actually copies from. Skipped when there is only one rate on the
        invoice, where it would just repeat the totals box above.
        """
        by_rate: dict[Decimal, dict[str, Decimal]] = {}
        for item in self.items:
            rate = Decimal(str(getattr(item, "tax_rate", 0) or 0))
            bucket = by_rate.setdefault(rate, {"taxable": Decimal("0"), "tax": Decimal("0")})
            bucket["taxable"] += _money(getattr(item, "line_subtotal", 0))
            bucket["tax"] += _money(getattr(item, "line_tax", 0))
        if len(by_rate) < 2:
            return y

        c = self.c
        widths = ([26 * mm, 34 * mm, 30 * mm, 34 * mm] if self.interstate
                  else [22 * mm, 30 * mm, 26 * mm, 26 * mm, 26 * mm])
        titles = (["Tax Rate", "Taxable Value", "IGST", "Total Tax"] if self.interstate
                  else ["Tax Rate", "Taxable Value", "CGST", "SGST", "Total Tax"])
        table_w = sum(widths)

        head_h = 6 * mm
        c.setFillColor(BAND)
        c.rect(MARGIN, y - head_h, table_w, head_h, fill=1, stroke=0)
        x = MARGIN
        for w, title in zip(widths, titles):
            _text(c, x + w / 2, y - head_h + 1.8 * mm, title, font=FONT_B, size=7.2, align="center")
            x += w
        self._hline(y - head_h, width=0.5, x0=MARGIN, x1=MARGIN + table_w)
        y -= head_h

        totals = {"taxable": Decimal("0"), "tax": Decimal("0")}
        for rate in sorted(by_rate):
            b = by_rate[rate]
            totals["taxable"] += b["taxable"]
            totals["tax"] += b["tax"]
            half = (b["tax"] / 2).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
            cells = ([f"{_qty(rate)}%", _fmt(b["taxable"]), _fmt(b["tax"]), _fmt(b["tax"])]
                     if self.interstate else
                     [f"{_qty(rate)}%", _fmt(b["taxable"]), _fmt(half), _fmt(b["tax"] - half), _fmt(b["tax"])])
            row_h = 5.8 * mm
            x = MARGIN
            for i, (w, cell) in enumerate(zip(widths, cells)):
                _text(c, x + w - 2 * mm if i else x + w / 2, y - row_h + 1.9 * mm, cell,
                      size=7.6, align="right" if i else "center")
                x += w
            y -= row_h
            self._hline(y, width=0.35, colour=RULE_LIGHT, x0=MARGIN, x1=MARGIN + table_w)

        for x_off in [sum(widths[:i]) for i in range(1, len(widths))]:
            self._vline(MARGIN + x_off, y, y + head_h + 5.8 * mm * len(by_rate),
                        width=0.35, colour=RULE_LIGHT)
        self._vline(MARGIN + table_w, y, y + head_h + 5.8 * mm * len(by_rate), width=0.5)
        return y - 2 * mm

    # ── Footer ──────────────────────────────────────────────────────────────
    def _draw_pay_block(self, x: float, top: float, bottom: float) -> None:
        """
        QR code and a clickable "Pay now" link.

        Restores something the previous renderer had and this one dropped when it
        was rewritten. It matters more than a decoration: for a customer holding a
        printed invoice the QR is the only path to paying without typing a URL,
        and it is the single change most likely to shorten how long an invoice
        stays unpaid.

        The QR encodes the **Razorpay link**, not a UPI string.
        ------------------------------------------------------
        A `upi://pay?pa=…` QR would open GPay or PhonePe directly, which is
        friendlier — but the money would move bank-to-bank without Razorpay ever
        seeing it, so no webhook would fire and the payment would never appear on
        the dashboard. The invoice would stay "unpaid" and reminders would keep
        chasing someone who had already paid.

        Razorpay's own page offers UPI anyway, so the customer still pays by
        scanning and approving in their UPI app — the difference is that this route
        reports back. Given the requirement is that a QR payment must show up on
        the dashboard, this is the only correct choice.
        """
        url = self._payment_url()
        if not url:
            return

        c = self.c
        width = self.PAY_BLOCK_W
        centre = x + width / 2

        _text(c, centre, top - 4.5 * mm, "SCAN TO PAY", font=FONT_B, size=7,
              colour=INK_SOFT, align="center")

        size = min(24 * mm, max(0.0, (top - bottom) - 16 * mm))
        qr_y = top - 7 * mm - size

        try:
            import qrcode

            qr = qrcode.QRCode(
                version=None,  # let it pick the smallest version that fits
                error_correction=qrcode.constants.ERROR_CORRECT_M,
                box_size=10,
                border=1,  # 1 module, not the default 4 — the surrounding white
                           # space is already quiet, and 4 shrinks the pattern
                           # enough to matter at 24mm on a phone camera.
            )
            qr.add_data(url)
            qr.make(fit=True)
            img = qr.make_image(fill_color="black", back_color="white")
            buf = BytesIO()
            img.save(buf, format="PNG")
            buf.seek(0)
            c.drawImage(ImageReader(buf), centre - size / 2, qr_y, width=size, height=size)
        except Exception as exc:  # pragma: no cover - depends on optional deps
            # A QR that cannot be drawn must not take the invoice down with it.
            # The clickable link below still works, and the amount is still owed.
            logger.warning(f"Could not draw the payment QR: {exc}")
            _text(c, centre, qr_y + size / 2, "(QR unavailable)", size=7,
                  colour=RULE_LIGHT, align="center")

        # A real link annotation, not just blue text. `linkURL` makes the whole
        # rectangle clickable in any PDF reader, so a customer reading this on a
        # phone taps once instead of transcribing a URL.
        label_y = qr_y - 5 * mm
        _text(c, centre, label_y, "Pay now", font=FONT_B, size=8.6,
              colour=colors.HexColor("#1A4FA0"), align="center")
        label_w = c.stringWidth("Pay now", FONT_B, 8.6)
        c.linkURL(
            url,
            (centre - label_w / 2 - 2, label_y - 2.5, centre + label_w / 2 + 2, label_y + 8),
            relative=0,
            thickness=0,
        )
        # The QR itself is clickable too — on a desktop reader, scanning is not an
        # option and the code is the most obvious thing to click.
        c.linkURL(url, (centre - size / 2, qr_y, centre + size / 2, qr_y + size),
                  relative=0, thickness=0)

    def _draw_footer(self, y: float):
        """
        Footer band: payment details and terms on the left, signature on the right.

        The band starts where the tables end rather than being pinned to the
        bottom of the page. Pinned to the bottom it had about 14mm of usable
        height, so with five bank fields and a terms paragraph the bank block
        silently failed its fits-on-page check and vanished — the invoice printed
        with no way to pay it, and no error anywhere. Meanwhile a third of the
        page above sat empty.

        Starting at `y` also puts payment details immediately after the amount
        due, which is where someone about to pay looks for them.
        """
        c = self.c
        p = self.profile
        base = MARGIN
        sign_w = 58 * mm
        sign_x = PAGE_W - MARGIN - sign_w

        # The pay block sits immediately left of the signature box, so the two
        # things a reader wants — how to pay, and who issued it — are together.
        pay_url = self._payment_url()
        pay_x = sign_x - self.PAY_BLOCK_W if pay_url else sign_x

        # A fixed band, not one derived from where the content happened to end.
        # Deriving it produced two different failures on the same page: capped at
        # base+96mm it left a void between the totals and the footer on a short
        # invoice, and uncapped it made the signature box grow to fill a third of
        # the page. The grid above now pads itself down to exactly here.
        band_top = base + self._footer_height()
        self._hline(band_top)

        # Signature block, bottom right, where every Indian invoice puts it.
        self._vline(sign_x, base, band_top)
        if pay_url:
            self._vline(pay_x, base, band_top)
            self._draw_pay_block(pay_x, band_top, base)
        name = (getattr(p, "company_name", None) or "").strip()
        _text(c, sign_x + sign_w / 2, band_top - 6 * mm, f"For {name or '—'}",
              font=FONT_B, size=8.6, align="center")
        _text(c, sign_x + sign_w / 2, base + 4 * mm, "Authorised Signatory",
              size=7.8, colour=INK_SOFT, align="center")

        sign_top = band_top
        left_w = pay_x - MARGIN - 6 * mm

        # The declaration is drawn first and owns a fixed strip at the very
        # bottom, so everything above it has a hard floor to respect.
        #
        # It used to be positioned last at a fixed offset while the bank block
        # grew downward from above — with five bank fields filled in, the two
        # collided and "IFSC: HDFC0001234" printed straight through "Declaration:
        # We declare that...". Whether the footer overlapped depended on how much
        # of their profile a tenant had completed, so it would have looked fine in
        # testing and broken for the most complete accounts.
        # Wrapped to the column, not hard-coded line breaks. The fixed version
        # was written for a footer that spanned to the signature box; once the QR
        # block took a column out of the middle, the first line carried on
        # straight through the divider and into it.
        DECL_TEXT = (
            "Declaration: We declare that this invoice shows the actual price of "
            "the goods/services described and that all particulars are true and correct."
        )
        DECL = [(line, 6.8, INK_SOFT) for line in _wrap(c, DECL_TEXT, FONT, 6.8, left_w)]
        DECL.append(("This is a computer-generated invoice.", 6.4, RULE_LIGHT))
        dy = base + 2 * mm + (len(DECL) - 1) * 3.1 * mm
        floor = dy + 3.4 * mm  # nothing above may descend past this
        for text, size, colour in DECL:
            _text(c, MARGIN + 3 * mm, dy, text, size=size, colour=colour)
            dy -= 3.1 * mm


        ly = sign_top - 4.5 * mm

        # Bank block — omitted entirely when a tenant hasn't filled it in, rather
        # than printing labels with nothing after them.
        bank_bits = self._bank_lines()
        if bank_bits and ly - 4.2 * mm - len(bank_bits) * 3.9 * mm > floor:
            _text(c, MARGIN + 3 * mm, ly, "Payment Details", font=FONT_B, size=7.6, colour=INK_SOFT)
            ly -= 4.2 * mm
            for label, value in bank_bits:
                if ly < floor:
                    break
                _text(c, MARGIN + 3 * mm, ly, f"{label}: ", size=7.8, colour=INK_SOFT)
                _text(c, MARGIN + 20 * mm, ly, value, font=FONT_B, size=7.8)
                ly -= 3.9 * mm

        terms = self._terms_lines()
        if terms and ly - 8 * mm > floor:
            ly -= 1.5 * mm
            _text(c, MARGIN + 3 * mm, ly, "Terms & Conditions", font=FONT_B, size=7.6, colour=INK_SOFT)
            ly -= 4 * mm
            for line in terms:
                if ly < floor:
                    break
                _text(c, MARGIN + 3 * mm, ly, line, size=7.4, colour=INK_SOFT)
                ly -= 3.6 * mm

    # ── Public ──────────────────────────────────────────────────────────────
    def render(self) -> bytes:
        self._outer_frame()
        y = PAGE_H - MARGIN
        y = self._draw_header(y)
        y = self._draw_parties(y)
        y = self._draw_table_head(y)
        y = self._draw_rows(y)
        y = self._close_grid(y)
        y = self._draw_totals(y)
        y = self._draw_tax_summary(y)
        self._draw_footer(y)
        self.c.showPage()
        self.c.save()
        return self.buffer.getvalue()
