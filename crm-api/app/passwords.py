"""
Password hashing and policy.

A PORT OF backend/src/modules/auth/password.service.ts.

THE HASHES MUST BE INTERCHANGEABLE IN BOTH DIRECTIONS, and that is not a nice-to-have. Node
owns `/auth/login` until Phase 6, so a password Python writes through
`PATCH /users/:id/reset-password` is verified by Node on the very next login. If the formats
disagree the user is simply locked out, with a correct password and a 401 that says
"Invalid email or password" — which looks like the user's mistake, not ours.

Both sides are bcrypt and both emit `$2b$`, but that is asserted against hashes bcryptjs
actually produced (`tests/fixtures/password_hashes.json`) rather than assumed. The two places
bcrypt implementations classically diverge are the prefix and the **72-byte truncation**, so
both are pinned by fixtures.

THE POLICY AND THE ROUTE VALIDATION DISAGREE, AND THAT IS NODE'S BEHAVIOUR. `PASSWORD_POLICY`
allows 8 characters, but `createUserBodySchema` and `resetUserPasswordBodySchema` both spell
`z.string().min(12)`. zod runs first, so **the effective API minimum is 12** and
`PASSWORD_TOO_SHORT` is unreachable through these routes — a 10-character password is rejected
as `VALIDATION_FAILED`, not as `PASSWORD_TOO_SHORT`. Both checks are ported anyway, in the same
order, because the policy function is also reachable from paths that do not go through zod.

`PASSWORD_HAS_SURROUNDING_WHITESPACE` *is* reachable: zod does not trim the password field.

NO DECOY VERIFY HERE. `verifyPasswordOrDecoy` exists to keep an unknown-account login as
expensive as a real one, and login is Phase 6. It lands with the auth routes, not before, so
there is no half-built timing defence sitting unused.
"""

import re

import bcrypt

# 8 at the owner's request. Three frontend copies of this number exist (ChangePasswordGate,
# UserRow, AddUserForm); they are hints, but a hint that disagrees with the server rejects a
# password the server would have accepted.
PASSWORD_MIN_LENGTH = 8
PASSWORD_MAX_LENGTH = 128

# The route schemas are stricter than the policy. Kept as its own constant so the gap is
# visible rather than looking like one of the two is a typo.
ROUTE_PASSWORD_MIN_LENGTH = 12

# bcrypt ignores everything past 72 BYTES — not characters. A multibyte password can cross the
# boundary at far fewer than 72 characters, so the limit is applied to the encoded form.
BCRYPT_MAX_BYTES = 72


class PasswordPolicyError(Exception):
    """Carries Node's reason code, which the controller maps to a status and message."""

    def __init__(self, reason_code: str) -> None:
        super().__init__(reason_code)
        self.reason_code = reason_code


def validate_plain_password(password: object) -> str | None:
    """
    `validatePlainPassword`. Returns the reason code, or None when valid.

    THE ORDER IS OBSERVABLE: whitespace is checked BEFORE length. "   abc   " is rejected as
    `PASSWORD_HAS_SURROUNDING_WHITESPACE`, not as `PASSWORD_TOO_SHORT`, and the owner gets the
    message that tells them what to fix.
    """
    if not isinstance(password, str):
        return "PASSWORD_REQUIRED"

    if password.strip() != password:
        return "PASSWORD_HAS_SURROUNDING_WHITESPACE"

    if len(password) < PASSWORD_MIN_LENGTH:
        return "PASSWORD_TOO_SHORT"

    if len(password) > PASSWORD_MAX_LENGTH:
        return "PASSWORD_TOO_LONG"

    return None


def hash_password(password: str, rounds: int) -> str:
    """
    `hashPassword`. Validates first, exactly as Node does, so an invalid password never reaches
    the hasher.

    `rounds` is passed in rather than read from settings here, so the caller — and the tests —
    decide the cost. Production uses `BCRYPT_ROUNDS`, which the schema constrains to 12..15.
    """
    reason = validate_plain_password(password)

    if reason:
        raise PasswordPolicyError(reason)

    encoded = password.encode("utf-8")[:BCRYPT_MAX_BYTES]

    return bcrypt.hashpw(encoded, bcrypt.gensalt(rounds)).decode("ascii")


# `$2<variant>$<cost>$<22-char salt><31-char digest>`. bcryptjs emits `2b`; `2a` and `2y` are
# accepted because older rows may carry them and bcryptjs verifies all three.
BCRYPT_HASH_PATTERN = re.compile(r"^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$")


def verify_password(password: str | None, password_hash: str | None) -> bool:
    """
    `verifyPassword`. Falsy input is False, never an exception — a missing hash is an ordinary
    state for an account that has never had one set.

    THE SHAPE IS CHECKED BEFORE `checkpw` IS CALLED, and that is not belt-and-braces. The
    `bcrypt` wheel is a Rust extension: handed a truncated hash it does not raise `ValueError`,
    it **panics**, and `pyo3_runtime.PanicException` inherits from `BaseException` — so an
    `except Exception` around the call does not catch it and the panic becomes a hard 500.

    Found by a test that fed it `"$2b$04$tooshort"`. One corrupted `passwordHash` in the
    collection would otherwise take the login route down for everybody, not just that account.
    """
    if not password or not password_hash:
        return False

    if not BCRYPT_HASH_PATTERN.match(password_hash):
        # A malformed stored hash. False, not a 500: the caller's question was "is this the
        # right password", and the answer is still no.
        return False

    try:
        return bcrypt.checkpw(
            password.encode("utf-8")[:BCRYPT_MAX_BYTES], password_hash.encode("ascii")
        )
    except (ValueError, UnicodeEncodeError):
        return False
