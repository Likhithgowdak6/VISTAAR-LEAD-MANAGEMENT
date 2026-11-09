"""
Python decrypts what NODE encrypted.

THE FIXTURES ARE THE WHOLE POINT. `tests/fixtures/encrypted_fields.json` was produced by
`crm-api/tools/make_encryption_fixtures.mjs`, which imports the real
`backend/src/modules/security/encryption.service.ts` and calls its real `encryptString` and
`encryptJson`. Testing a format port against values the port itself produced proves nothing -
two implementations can agree perfectly on a shape that the production database has never seen.
These bytes came out of the code that wrote every encrypted row in production.

THE KEY IN THE FIXTURE FILE IS GENERATED PER RUN AND PROTECTS NOTHING. The plaintexts are
"919876543210" and "himanshu@vistaarverse.com". No production key is ever used here, and the
generator must never be pointed at one.

WHAT A FAILURE IN THIS FILE MEANS. AES-GCM authenticates, so a wrong key or a wrong AAD raises
rather than returning plausible garbage - that is the good case. The case these tests exist for
is subtler: a port that returns `None` where Node returned a number. The route answers 200
either way, and the owner just sees a blank phone field on the lead he is trying to call.
"""

import base64
import json
import os
from pathlib import Path

import pytest

from app import encryption
from app.encryption import EncryptionOperationError, decrypt_json, decrypt_string

FIXTURES = json.loads(
    (Path(__file__).parent / "fixtures" / "encrypted_fields.json").read_text(encoding="utf-8")
)


@pytest.fixture(autouse=True)
def key_ring(monkeypatch):
    """The fixture file's own key, installed the way the container would supply it."""
    monkeypatch.setenv("ENCRYPTION_KEY_V1", FIXTURES["key"])
    monkeypatch.setenv("ENCRYPTION_KEY_CURRENT_VERSION", "1")


class TestAgainstNodeFixtures:
    @pytest.mark.parametrize("case", FIXTURES["cases"], ids=lambda c: repr(c["plaintext"])[:30])
    def test_decrypts_what_node_encrypted(self, case):
        assert decrypt_string(case["field"], case["purpose"]) == case["plaintext"]

    def test_DECRYPTS_AN_EMPTY_STRING_AS_EMPTY_NOT_NONE(self):
        # An empty plaintext encrypts to zero ciphertext bytes. A port that treated an empty
        # ciphertext as "nothing here" would return None and turn "" into "no phone number".
        empty = next(c for c in FIXTURES["cases"] if c["plaintext"] == "")

        assert decrypt_string(empty["field"], empty["purpose"]) == ""

    def test_decrypts_multibyte_utf8(self):
        # Byte length and character length differ here, which is where a wrong decode shows up.
        case = next(c for c in FIXTURES["cases"] if "😀" in c["plaintext"])

        assert decrypt_string(case["field"], case["purpose"]) == case["plaintext"]

    def test_decrypts_a_json_envelope(self):
        payload = FIXTURES["json"]

        assert decrypt_json(payload["field"], payload["purpose"]) == payload["value"]


class TestTheAadBinding:
    """
    The purpose string is bound into the authentication tag.

    This is what stops a ciphertext being lifted out of the phone field and dropped into the
    email field: it fails to authenticate rather than silently decrypting.
    """

    def test_THE_WRONG_PURPOSE_RAISES_RATHER_THAN_DECRYPTING(self):
        phone = next(c for c in FIXTURES["cases"] if c["plaintext"] == "919876543210")

        with pytest.raises(EncryptionOperationError):
            decrypt_string(phone["field"], encryption.CONTACT_EMAIL)

    def test_a_purpose_differing_by_one_character_raises(self):
        phone = next(c for c in FIXTURES["cases"] if c["plaintext"] == "919876543210")

        with pytest.raises(EncryptionOperationError):
            decrypt_string(phone["field"], encryption.CONTACT_PHONE + "x")

    def test_an_empty_purpose_is_refused_before_any_crypto(self):
        phone = next(c for c in FIXTURES["cases"] if c["plaintext"] == "919876543210")

        with pytest.raises(EncryptionOperationError, match="purpose is required"):
            decrypt_string(phone["field"], "   ")


class TestTamperingAndKeys:
    def test_A_TAMPERED_CIPHERTEXT_RAISES(self):
        phone = next(c for c in FIXTURES["cases"] if c["plaintext"] == "919876543210")
        tampered = dict(phone["field"])
        raw = bytearray(base64.b64decode(tampered["ciphertext"]))
        raw[0] ^= 0x01
        tampered["ciphertext"] = base64.b64encode(bytes(raw)).decode()

        with pytest.raises(EncryptionOperationError):
            decrypt_string(tampered, phone["purpose"])

    def test_a_tampered_auth_tag_raises(self):
        phone = next(c for c in FIXTURES["cases"] if c["plaintext"] == "919876543210")
        tampered = dict(phone["field"])
        raw = bytearray(base64.b64decode(tampered["authTag"]))
        raw[0] ^= 0x01
        tampered["authTag"] = base64.b64encode(bytes(raw)).decode()

        with pytest.raises(EncryptionOperationError):
            decrypt_string(tampered, phone["purpose"])

    def test_AN_UNKNOWN_KEY_VERSION_RAISES_AND_NAMES_IT(self):
        # During a rotation, a row written with v2 must not silently read as empty on a service
        # that only has v1.
        phone = next(c for c in FIXTURES["cases"] if c["plaintext"] == "919876543210")
        future = {**phone["field"], "keyVersion": "2"}

        with pytest.raises(EncryptionOperationError, match="version 2"):
            decrypt_string(future, phone["purpose"])

    def test_THE_KEY_RING_IS_READ_PER_CALL_NOT_CACHED(self, monkeypatch):
        # A key added after start must be usable without a restart. Caching at import would make
        # a mid-rotation key look like data corruption.
        phone = next(c for c in FIXTURES["cases"] if c["plaintext"] == "919876543210")
        rotated = {**phone["field"], "keyVersion": "7"}

        with pytest.raises(EncryptionOperationError):
            decrypt_string(rotated, phone["purpose"])

        monkeypatch.setenv("ENCRYPTION_KEY_V7", FIXTURES["key"])

        assert decrypt_string(rotated, phone["purpose"]) == "919876543210"

    def test_a_key_of_the_wrong_length_is_refused(self, monkeypatch):
        monkeypatch.setenv("ENCRYPTION_KEY_V3", base64.b64encode(b"short").decode())
        phone = next(c for c in FIXTURES["cases"] if c["plaintext"] == "919876543210")

        with pytest.raises(EncryptionOperationError, match="32 bytes"):
            decrypt_string({**phone["field"], "keyVersion": "3"}, phone["purpose"])


class TestNullAndMalformed:
    def test_none_is_none_not_an_error(self):
        # An absent field is an ordinary state: a contact with no email on file.
        assert decrypt_string(None, encryption.CONTACT_PHONE) is None
        assert decrypt_json(None, encryption.CONTACT_PROVIDER_JIDS) is None

    def test_A_PLAINTEXT_STRING_IN_THE_COLUMN_IS_REFUSED(self):
        # Not decrypted, not passed through. Passing it through would mean a row that failed to
        # encrypt reads back as if it had succeeded.
        with pytest.raises(EncryptionOperationError, match="Invalid encrypted field"):
            decrypt_string("919876543210", encryption.CONTACT_PHONE)

    @pytest.mark.parametrize(
        "broken",
        [
            {"algorithm": "aes-128-gcm", "keyVersion": "1", "iv": "x", "ciphertext": "x", "authTag": "x"},
            {"algorithm": "aes-256-gcm", "keyVersion": "0", "iv": "x", "ciphertext": "x", "authTag": "x"},
            {"algorithm": "aes-256-gcm", "keyVersion": 1, "iv": "x", "ciphertext": "x", "authTag": "x"},
            {"algorithm": "aes-256-gcm", "keyVersion": "1", "iv": "x", "ciphertext": "x"},
        ],
        ids=["wrong-algorithm", "zero-key-version", "numeric-key-version", "missing-auth-tag"],
    )
    def test_a_malformed_envelope_is_refused(self, broken):
        with pytest.raises(EncryptionOperationError):
            decrypt_string(broken, encryption.CONTACT_PHONE)

    def test_A_WRONG_LENGTH_IV_IS_REFUSED(self):
        # 12 bytes is not advisory: GCM with a different nonce length is a different construction.
        phone = next(c for c in FIXTURES["cases"] if c["plaintext"] == "919876543210")
        short_iv = {**phone["field"], "iv": base64.b64encode(b"tooshort").decode()}

        with pytest.raises(EncryptionOperationError, match="12 bytes"):
            decrypt_string(short_iv, phone["purpose"])

    def test_json_that_is_not_json_raises(self):
        # The email case, not the phone one: "919876543210" is itself valid JSON (a number), so
        # decrypt_json would succeed on it and the test would prove nothing.
        email = next(c for c in FIXTURES["cases"] if "@" in c["plaintext"])

        with pytest.raises(EncryptionOperationError, match="not valid JSON"):
            decrypt_json(email["field"], email["purpose"])

    def test_A_NUMERIC_STRING_DECRYPTS_AS_A_STRING_NOT_A_NUMBER(self):
        # decrypt_string must never go through a JSON parse. A phone number that came back as
        # the integer 919876543210 would lose any leading zero and stop matching the allowlist.
        phone = next(c for c in FIXTURES["cases"] if c["plaintext"] == "919876543210")
        result = decrypt_string(phone["field"], phone["purpose"])

        assert isinstance(result, str)
        assert result == "919876543210"


class TestPurposeConstants:
    def test_THE_PURPOSE_STRINGS_MATCH_NODE_EXACTLY(self):
        # These are bound into the tag of every row already written. They are data, not naming -
        # changing one orphans a column.
        assert encryption.CONTACT_PHONE == "wam-crm-ai:v1:contact.encryptedPhone"
        assert encryption.CONTACT_EMAIL == "wam-crm-ai:v1:contact.encryptedEmail"
        assert encryption.CONTACT_PROVIDER_JIDS == "wam-crm-ai:v1:contact.encryptedProviderJids"
        assert encryption.WHATSAPP_ACCOUNT_PHONE == "wam-crm-ai:v1:whatsappAccount.encryptedPhone"
        assert encryption.WHATSAPP_ACCOUNT_JID == "wam-crm-ai:v1:whatsappAccount.encryptedJid"
        assert encryption.LEAD_SUBMISSION_PAYLOAD == "wam-crm-ai:v1:leadSubmission.encryptedPayload"

    def test_the_fixtures_were_generated_with_those_same_purposes(self):
        # Guards against the fixture generator drifting from the constants it is meant to pin.
        assert {case["purpose"] for case in FIXTURES["cases"]} <= {
            encryption.CONTACT_PHONE,
            encryption.CONTACT_EMAIL,
        }


class TestEncryptStringAndJson:
    def test_encrypt_and_decrypt_round_trip(self):
        purpose = encryption.CONTACT_PHONE
        plaintext = "+919876543210"
        encrypted = encryption.encrypt_string(plaintext, purpose)
        assert encryption.is_encrypted_field(encrypted)
        assert encrypted["algorithm"] == "aes-256-gcm"
        decrypted = encryption.decrypt_string(encrypted, purpose)
        assert decrypted == plaintext

    def test_encrypt_null_returns_none(self):
        assert encryption.encrypt_string(None, "purpose") is None
        assert encryption.encrypt_json(None, "purpose") is None

    def test_encrypt_non_string_raises(self):
        with pytest.raises(encryption.EncryptionOperationError):
            encryption.encrypt_string(12345, "purpose")  # type: ignore

    def test_encrypt_json_round_trip(self):
        purpose = encryption.LEAD_SUBMISSION_PAYLOAD
        data = {"name": "Test Lead", "budget": 50000, "custom": ["a", "b"]}
        encrypted = encryption.encrypt_json(data, purpose)
        assert encryption.is_encrypted_field(encrypted)
        decrypted = encryption.decrypt_json(encrypted, purpose)
        assert decrypted == data
