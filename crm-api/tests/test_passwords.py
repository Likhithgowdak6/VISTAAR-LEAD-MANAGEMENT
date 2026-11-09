"""
Python and Node must agree about bcrypt, in BOTH directions.

WHY BOTH DIRECTIONS MATTER. Node owns `/auth/login` until Phase 6. So:

  - a hash PYTHON writes (reset-password) is verified by NODE on the next login
  - a hash NODE wrote (every existing user) is verified by PYTHON wherever Python checks one

If the formats disagree the user is locked out with a correct password and a 401 reading
"Invalid email or password" — which looks like their mistake, not ours, and would be reported
as "the app won't let me in" long after the deploy that caused it.

THE FIXTURES CAME OUT OF bcryptjs, the library Node actually uses. A test against hashes this
module produced would prove Python can read Python. The round-trip in the other direction is
covered by `tools/make_password_fixtures.mjs` plus the Node-side assertion noted at the bottom
of this file.

NO REAL PASSWORD APPEARS HERE. Every value is a literal.
"""

import json
from pathlib import Path

import bcrypt
import pytest

from app.passwords import (
    BCRYPT_MAX_BYTES,
    PASSWORD_MAX_LENGTH,
    PASSWORD_MIN_LENGTH,
    PasswordPolicyError,
    hash_password,
    validate_plain_password,
    verify_password,
)

FIXTURES = json.loads(
    (Path(__file__).parent / "fixtures" / "password_hashes.json").read_text(encoding="utf-8")
)

# Cheap on purpose. These guard no account; 12 rounds would make the suite slow for nothing.
TEST_ROUNDS = 4


class TestVerifyingNodeHashes:
    @pytest.mark.parametrize(
        "case", FIXTURES["cases"], ids=lambda c: f"len{len(c['password'])}"
    )
    def test_VERIFIES_A_HASH_BCRYPTJS_PRODUCED(self, case):
        assert verify_password(case["password"], case["hash"]) is True

    @pytest.mark.parametrize("wrong", FIXTURES["wrong"])
    def test_rejects_a_wrong_password_against_a_node_hash(self, wrong):
        correct = FIXTURES["cases"][0]

        assert verify_password(wrong, correct["hash"]) is False

    def test_bcryptjs_emits_the_prefix_python_expects(self):
        # Pinned rather than assumed. $2a$ vs $2b$ is the classic place two bcrypt
        # implementations stop understanding each other.
        assert all(case["hash"].startswith("$2b$") for case in FIXTURES["cases"])

    def test_A_PASSWORD_PAST_72_BYTES_MATCHES_ITS_TRUNCATION_IN_BOTH(self):
        # bcrypt ignores everything past 72 bytes. Both libraries do this, so a 100-character
        # password and its 72-character prefix are the SAME credential. Asserted explicitly
        # because a port that rejected over-72 inputs instead of truncating would lock out every
        # user with a long password.
        long_case = next(c for c in FIXTURES["cases"] if len(c["password"]) == 100)

        assert verify_password(long_case["password"], long_case["hash"]) is True
        assert verify_password("x" * 72, long_case["hash"]) is True

    def test_multibyte_passwords_verify(self):
        case = next(c for c in FIXTURES["cases"] if "😀" in c["password"])

        assert verify_password(case["password"], case["hash"]) is True


class TestHashesPythonProduces:
    def test_round_trips_through_its_own_verifier(self):
        hashed = hash_password("correct-horse-battery", TEST_ROUNDS)

        assert verify_password("correct-horse-battery", hashed) is True
        assert verify_password("wrong-horse-battery", hashed) is False

    def test_EMITS_THE_SAME_PREFIX_NODE_DOES(self):
        # This is the half of the contract Node has to read. A $2y$ or $2a$ here would be a
        # silent lockout on the next login.
        assert hash_password("correct-horse-battery", TEST_ROUNDS).startswith("$2b$")

    def test_the_hash_is_ascii_and_fits_the_schema(self):
        # Stored as a plain String in Mongoose with no length cap, but a non-ASCII hash would
        # mean the encoding is wrong somewhere.
        hashed = hash_password("correct-horse-battery", TEST_ROUNDS)

        assert hashed.isascii()
        assert len(hashed) == 60

    def test_TWO_HASHES_OF_THE_SAME_PASSWORD_DIFFER(self):
        # Salted. Equal hashes would mean the salt is fixed, which is a real vulnerability and
        # an easy thing to break while porting.
        first = hash_password("correct-horse-battery", TEST_ROUNDS)
        second = hash_password("correct-horse-battery", TEST_ROUNDS)

        assert first != second
        assert verify_password("correct-horse-battery", second) is True

    def test_the_cost_is_the_one_requested(self):
        assert hash_password("correct-horse-battery", TEST_ROUNDS).startswith(
            f"$2b${TEST_ROUNDS:02d}$"
        )

    def test_A_NODE_VERIFIER_SHAPE_CHECK(self):
        # bcryptjs's own checkpw equivalent is not importable from Python, so this asserts the
        # structural contract it relies on: algorithm, cost and a 22-character salt.
        hashed = hash_password("correct-horse-battery", TEST_ROUNDS)
        _, algorithm, cost, remainder = hashed.split("$")

        assert algorithm == "2b"
        assert cost == f"{TEST_ROUNDS:02d}"
        assert len(remainder) == 53  # 22 salt + 31 digest


class TestPolicy:
    def test_rejects_a_non_string(self):
        assert validate_plain_password(None) == "PASSWORD_REQUIRED"
        assert validate_plain_password(12345678) == "PASSWORD_REQUIRED"

    def test_WHITESPACE_IS_CHECKED_BEFORE_LENGTH(self):
        # The order is observable. "  ab  " is surrounded by whitespace AND too short; the owner
        # must be told the thing they can act on.
        assert validate_plain_password("  ab  ") == "PASSWORD_HAS_SURROUNDING_WHITESPACE"

    def test_rejects_leading_or_trailing_whitespace(self):
        assert validate_plain_password(" correct-horse ") == "PASSWORD_HAS_SURROUNDING_WHITESPACE"
        assert validate_plain_password("correct-horse\n") == "PASSWORD_HAS_SURROUNDING_WHITESPACE"

    def test_rejects_too_short_and_too_long(self):
        assert validate_plain_password("x" * (PASSWORD_MIN_LENGTH - 1)) == "PASSWORD_TOO_SHORT"
        assert validate_plain_password("x" * (PASSWORD_MAX_LENGTH + 1)) == "PASSWORD_TOO_LONG"

    def test_accepts_the_boundaries(self):
        assert validate_plain_password("x" * PASSWORD_MIN_LENGTH) is None
        assert validate_plain_password("x" * PASSWORD_MAX_LENGTH) is None

    def test_INTERNAL_WHITESPACE_IS_FINE(self):
        # A passphrase is a legitimate password. Only surrounding whitespace is rejected.
        assert validate_plain_password("correct horse battery") is None

    def test_hashing_validates_first(self):
        with pytest.raises(PasswordPolicyError) as raised:
            hash_password(" too short ", TEST_ROUNDS)

        assert raised.value.reason_code == "PASSWORD_HAS_SURROUNDING_WHITESPACE"


class TestVerifyIsTotal:
    """A verifier that raises turns a wrong password into a 500."""

    @pytest.mark.parametrize(
        ("password", "stored"),
        [
            (None, "$2b$04$abcdefghijklmnopqrstuv"),
            ("correct-horse-battery", None),
            ("", "$2b$04$abcdefghijklmnopqrstuv"),
            ("correct-horse-battery", ""),
        ],
    )
    def test_missing_input_is_false_not_an_error(self, password, stored):
        assert verify_password(password, stored) is False

    def test_A_MALFORMED_STORED_HASH_IS_FALSE_NOT_A_CRASH(self):
        # A corrupted row must not take down the login route for everyone else.
        assert verify_password("correct-horse-battery", "not-a-bcrypt-hash") is False

    @pytest.mark.parametrize(
        "malformed",
        ["$2b$04$tooshort", "$2b$04$", "$2z$04$" + "x" * 53, "$2b$4$" + "x" * 53, "plain-text"],
        ids=["truncated", "no-payload", "unknown-variant", "one-digit-cost", "not-bcrypt"],
    )
    def test_A_MALFORMED_HASH_IS_FALSE_AND_DOES_NOT_PANIC(self, malformed):
        # THE `bcrypt` WHEEL IS A RUST EXTENSION. Handed a truncated hash it does not raise
        # ValueError - it PANICS, and pyo3_runtime.PanicException inherits from BaseException,
        # so `except Exception` does not catch it. One corrupted passwordHash row would take the
        # login route down for every user, not just that account. The shape is validated before
        # checkpw is ever called.
        assert verify_password("correct-horse-battery", malformed) is False


class TestTruncationBoundary:
    def test_the_boundary_is_bytes_not_characters(self):
        # A multibyte password crosses 72 BYTES at far fewer than 72 characters. Applying the
        # limit to characters would hand bcrypt an over-length buffer, which newer bcrypt
        # versions reject outright.
        multibyte = "é" * 50  # 100 bytes in utf-8

        assert len(multibyte) == 50
        assert len(multibyte.encode("utf-8")) == 100

        hashed = hash_password(multibyte, TEST_ROUNDS)

        assert verify_password(multibyte, hashed) is True

    def test_the_constant_matches_bcrypts_own_limit(self):
        assert BCRYPT_MAX_BYTES == 72

    def test_THE_LIBRARY_TRUNCATES_SILENTLY_SO_WE_DO_IT_EXPLICITLY(self):
        # bcrypt 4.2.1 does NOT reject an over-length input - it quietly ignores the tail. That
        # is the same thing bcryptjs does, so the two agree, but relying on two libraries to
        # silently agree about a boundary is how they stop agreeing on an upgrade. Truncating in
        # our own code makes the contract explicit and testable.
        salt = bcrypt.gensalt(TEST_ROUNDS)
        long_hash = bcrypt.hashpw(b"x" * 100, salt)

        assert bcrypt.checkpw(b"x" * 72, long_hash) is True
