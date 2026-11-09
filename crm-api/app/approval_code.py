"""
Short, human-typeable reply codes for WhatsApp approval cards.

PORTED FROM backend/src/modules/ai-brain/approval-code.ts.

Pattern: one letter A-Z followed by one digit 1-9 (26 * 9 = 234 possibilities), e.g. "A7".
"""

from __future__ import annotations

import random
import re
from typing import Any

LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
DIGITS = "123456789"
APPROVAL_CODE_PATTERN = re.compile(r"^[A-Z][1-9]$")


def generate_approval_code() -> str:
    """Generates a random two-character approval code e.g. 'B4'."""
    letter = random.choice(LETTERS)
    digit = random.choice(DIGITS)
    return f"{letter}{digit}"


def is_valid_approval_code(value: Any) -> bool:
    """True when value is a string strictly matching ^[A-Z][1-9]$."""
    if not isinstance(value, str):
        return False
    return bool(APPROVAL_CODE_PATTERN.match(value))

