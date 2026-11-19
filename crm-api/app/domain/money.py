"""
Money as a value object.

The current code stores amounts as ``float``. That is a real hazard for money:
binary floating point cannot represent 0.1 exactly, so arithmetic drifts.
``0.1 + 0.2 == 0.30000000000000004``, and repeated addition compounds it. The
existing code papers over this with ``round(..., 2)`` at each step and a
"small tolerance for float rounding" when comparing against a balance — both
symptoms of the same underlying problem.

``Money`` stores **integer paise**. Integers are exact, so a balance either is
zero or isn't, with no tolerance needed and no drift however many payments are
summed.

LIFTED FROM vistaar-payment-bot UNCHANGED except for this note. In that codebase
the database columns were still SQL ``Float`` and this type was used only for
calculation, converting back at the boundary. **In this CRM there is no such
boundary: invoices store integer paise, so ``Money.paise`` is what is written to
Mongo.** The float conversion below survives for display and for the PDF
renderer, which was written against it — it must never be used for arithmetic.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal


@dataclass(frozen=True, order=True)
class Money:
    """An exact monetary amount, held as integer minor units (paise)."""

    paise: int

    def __post_init__(self) -> None:
        if not isinstance(self.paise, int):
            raise TypeError(
                f"Money holds integer paise, got {type(self.paise).__name__}. "
                "Use Money.from_rupees() to convert."
            )

    # ── Construction ─────────────────────────────────────────────────────────

    @classmethod
    def from_rupees(cls, rupees: float | int | str | Decimal) -> Money:
        """
        Build from a rupee amount.

        Routed through ``Decimal`` with explicit ROUND_HALF_UP. Python's
        built-in ``round()`` uses banker's rounding, so ``round(2.675, 2)`` is
        2.67 — not what an invoice should say. Converting the float to ``str``
        first avoids inheriting its binary representation error.
        """
        d = Decimal(str(rupees))
        return cls(int((d * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP)))

    @classmethod
    def zero(cls) -> Money:
        return cls(0)

    # ── Conversion ───────────────────────────────────────────────────────────

    @property
    def rupees(self) -> Decimal:
        """Exact decimal rupees — for display and reporting."""
        return (Decimal(self.paise) / 100).quantize(Decimal("0.01"))

    def to_float(self) -> float:
        """
        Float rupees, for display and for the PDF renderer.

        NOT a storage format here — invoices persist `paise` directly. Never for arithmetic.
        """
        return float(self.rupees)

    # ── Arithmetic ───────────────────────────────────────────────────────────

    def __add__(self, other: Money) -> Money:
        self._check(other)
        return Money(self.paise + other.paise)

    def __sub__(self, other: Money) -> Money:
        self._check(other)
        return Money(self.paise - other.paise)

    def __mul__(self, factor: int | float | Decimal) -> Money:
        result = (Decimal(self.paise) * Decimal(str(factor))).quantize(
            Decimal("1"), rounding=ROUND_HALF_UP
        )
        return Money(int(result))

    def __neg__(self) -> Money:
        return Money(-self.paise)

    def percentage(self, percent: float | Decimal) -> Money:
        """A percentage of this amount, e.g. GST at 18%."""
        return self * (Decimal(str(percent)) / 100)

    def apply_discount(self, percent: float | Decimal) -> Money:
        """This amount reduced by a percentage."""
        return self - self.percentage(percent)

    def split_evenly(self, parts: int) -> list[Money]:
        """
        Split into ``parts``, distributing the remainder so the pieces sum
        exactly back to the original.

        This is why CGST/SGST can halve 1 paisa without losing it: naive
        halving twice would round both down and quietly lose money.
        """
        if parts < 1:
            raise ValueError("parts must be at least 1")
        base, remainder = divmod(self.paise, parts)
        return [Money(base + (1 if i < remainder else 0)) for i in range(parts)]

    # ── Predicates ───────────────────────────────────────────────────────────

    @property
    def is_zero(self) -> bool:
        return self.paise == 0

    @property
    def is_positive(self) -> bool:
        return self.paise > 0

    @property
    def is_negative(self) -> bool:
        return self.paise < 0

    def _check(self, other: object) -> None:
        if not isinstance(other, Money):
            raise TypeError(f"Cannot combine Money with {type(other).__name__}")

    def __str__(self) -> str:
        return f"₹{self.rupees:,}"

    def __repr__(self) -> str:
        return f"Money.from_rupees('{self.rupees}')"
