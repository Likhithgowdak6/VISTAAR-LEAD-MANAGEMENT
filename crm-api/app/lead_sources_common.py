"""
Constants, serializers, error models, and validation schemas for lead sources.
Ported from Node's constants, lead-source.serializer.ts, lead-source.validation.ts,
lead-source.errors.ts, and meta-credentials.service.ts.
"""

from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any, Literal
from bson import ObjectId
from pydantic import BaseModel, Field, field_validator

from app.encryption import decrypt_string, encrypt_string
from app.serialization import serialize_date, serialize_id


# ---- Constants -----------------------------------------------------------------

class LEAD_SOURCE_KINDS:
    GOOGLE_SHEET = "google_sheet"
    META_LEAD_ADS = "meta_lead_ads"


LEAD_SOURCE_KIND_VALUES = (LEAD_SOURCE_KINDS.GOOGLE_SHEET, LEAD_SOURCE_KINDS.META_LEAD_ADS)


class LEAD_SOURCE_STATUSES:
    ACTIVE = "active"
    PAUSED = "paused"


LEAD_SOURCE_STATUS_VALUES = (LEAD_SOURCE_STATUSES.ACTIVE, LEAD_SOURCE_STATUSES.PAUSED)


class LEAD_SOURCE_SYNC_STATUSES:
    PENDING = "pending"
    OK = "ok"
    FAILED = "failed"
    NEEDS_ATTENTION = "needs_attention"


LEAD_SOURCE_SYNC_STATUS_VALUES = (
    LEAD_SOURCE_SYNC_STATUSES.PENDING,
    LEAD_SOURCE_SYNC_STATUSES.OK,
    LEAD_SOURCE_SYNC_STATUSES.FAILED,
    LEAD_SOURCE_SYNC_STATUSES.NEEDS_ATTENTION,
)


class META_CONNECTION_STATUSES:
    ACTIVE = "active"
    NEEDS_ATTENTION = "needs_attention"
    DISCONNECTED = "disconnected"


META_CONNECTION_STATUS_VALUES = (
    META_CONNECTION_STATUSES.ACTIVE,
    META_CONNECTION_STATUSES.NEEDS_ATTENTION,
    META_CONNECTION_STATUSES.DISCONNECTED,
)


class CALL_SCHEDULING_STATUSES:
    WAITING = "waiting"
    REPLIED = "replied"
    COMPLETED = "completed"
    FAILED_PERMANENT = "failed_permanent"


CALL_SCHEDULING_STATUS_VALUES = (
    CALL_SCHEDULING_STATUSES.WAITING,
    CALL_SCHEDULING_STATUSES.REPLIED,
    CALL_SCHEDULING_STATUSES.COMPLETED,
    CALL_SCHEDULING_STATUSES.FAILED_PERMANENT,
)


class LEAD_SUBMISSION_STATUSES:
    IMPORTED = "imported"
    SKIPPED = "skipped"
    FAILED = "failed"


LEAD_SUBMISSION_STATUS_VALUES = (
    LEAD_SUBMISSION_STATUSES.IMPORTED,
    LEAD_SUBMISSION_STATUSES.SKIPPED,
    LEAD_SUBMISSION_STATUSES.FAILED,
)


class LEAD_SKIP_REASONS:
    NO_PHONE = "no_phone"
    UNPARSABLE_PHONE = "unparsable_phone"
    NO_IDENTITY = "no_identity"


LEAD_SKIP_REASON_VALUES = (
    LEAD_SKIP_REASONS.NO_PHONE,
    LEAD_SKIP_REASONS.UNPARSABLE_PHONE,
    LEAD_SKIP_REASONS.NO_IDENTITY,
)

META_ACCESS_TOKEN_PURPOSE = "wam-crm-ai:v1:leadSource.encryptedMetaAccessToken"
META_ACCESS_TOKEN_MIN_LENGTH = 20
META_GRAPH_API_VERSION = "v25.0"
META_GRAPH_BASE_URL = "https://graph.facebook.com"
META_GRAPH_PAGE_SIZE = 100
META_LEADGEN_FIELD = "leadgen"


# ---- Errors --------------------------------------------------------------------

class LeadSourceError(Exception):
    def __init__(self, message: str, code: str = "LEAD_SOURCE_ERROR", cause: Any = None):
        super().__init__(message)
        self.code = code
        self.cause = cause


class LeadSheetFetchError(LeadSourceError):
    def __init__(self, message: str, code: str = "LEAD_SHEET_FETCH_FAILED", cause: Any = None):
        super().__init__(message, code=code, cause=cause)


class META_GRAPH_FAILURE_KINDS:
    TRANSIENT = "transient"
    RATE_LIMITED = "rate_limited"
    NEEDS_ATTENTION = "needs_attention"


class MetaGraphError(LeadSourceError):
    def __init__(
        self,
        message: str,
        code: str = "META_GRAPH_REQUEST_FAILED",
        failure_kind: str = META_GRAPH_FAILURE_KINDS.TRANSIENT,
        meta_code: int | None = None,
        meta_subcode: int | None = None,
        http_status: int | None = None,
        cause: Any = None,
    ):
        super().__init__(message, code=code, cause=cause)
        self.failure_kind = failure_kind
        self.meta_code = meta_code
        self.meta_subcode = meta_subcode
        self.http_status = http_status


class MetaLeadSourceNotConfiguredError(LeadSourceError):
    def __init__(self, message: str = "This Meta source has no access token yet."):
        super().__init__(message, code="META_SOURCE_NOT_CONFIGURED")


class MetaOauthError(Exception):
    def __init__(self, message: str, code: str = "META_OAUTH_ERROR"):
        super().__init__(message)
        self.code = code


URL_PATTERN = re.compile(r"\bhttps?://\S+", re.IGNORECASE)
TOKEN_QUERY_PATTERN = re.compile(r"\b(access_token|client_secret|token)=[^\s&\"']+", re.IGNORECASE)
BEARER_LIKE_PATTERN = re.compile(r"\b(EAA|EAAB)[A-Za-z0-9]{20,}\b")
LEAD_SOURCE_ERROR_MAX_LENGTH = 300


def sanitize_lead_source_error_text(value: Any) -> str:
    """Redact tokens, URLs, and secrets before persisting to lastError."""
    text = value if isinstance(value, str) else str(value or "")
    redacted = TOKEN_QUERY_PATTERN.sub(lambda m: f"{m.group(1)}=[redacted]", text)
    redacted = URL_PATTERN.sub("[url]", redacted)
    redacted = BEARER_LIKE_PATTERN.sub("[redacted]", redacted).strip()
    if len(redacted) > LEAD_SOURCE_ERROR_MAX_LENGTH:
        return f"{redacted[:LEAD_SOURCE_ERROR_MAX_LENGTH - 1]}…"
    return redacted


# ---- Credentials ---------------------------------------------------------------

def normalize_meta_access_token(value: Any) -> str | None:
    token = str(value).strip() if isinstance(value, str) else ""
    return token if token else None


def encrypt_meta_access_token(value: Any) -> dict[str, str] | None:
    norm = normalize_meta_access_token(value)
    return encrypt_string(norm, META_ACCESS_TOKEN_PURPOSE) if norm else None


def decrypt_meta_access_token(encrypted_field: Any) -> str | None:
    return decrypt_string(encrypted_field, META_ACCESS_TOKEN_PURPOSE)


def meta_access_token_last4(value: Any) -> str | None:
    token = normalize_meta_access_token(value)
    if not token or len(token) < 4:
        return None
    return token[-4:]


# ---- Serializers ---------------------------------------------------------------

def serialize_lead_source(lead_source: Any) -> dict[str, Any] | None:
    if not lead_source or not isinstance(lead_source, dict):
        return None

    column_mapping = lead_source.get("columnMapping") or {}
    counts = lead_source.get("lastSyncCounts") or {}
    meta = lead_source.get("meta") or {}

    return {
        "id": serialize_id(lead_source.get("_id")),
        "organizationId": serialize_id(lead_source.get("organizationId")),
        "name": lead_source.get("name"),
        "kind": lead_source.get("kind") or LEAD_SOURCE_KINDS.GOOGLE_SHEET,
        "sheetUrl": lead_source.get("sheetUrl") or None,
        "gid": lead_source.get("gid") or None,
        "meta": {
            "pageId": meta.get("pageId") or None,
            "pageName": meta.get("pageName") or None,
            "formId": meta.get("formId") or None,
            "formName": meta.get("formName") or None,
            "hasAccessToken": bool(meta.get("accessTokenSetAt")),
            "accessTokenLast4": meta.get("accessTokenLast4") or None,
            "accessTokenSetAt": serialize_date(meta.get("accessTokenSetAt")),
            "lastLeadCreatedAt": serialize_date(meta.get("lastLeadCreatedAt")),
            "webhookSubscribedAt": serialize_date(meta.get("webhookSubscribedAt")),
            "webhookError": meta.get("webhookError") or None,
            "usesFacebookLogin": bool(lead_source.get("metaConnectionId")),
        },
        "whatsappAccountId": serialize_id(lead_source.get("whatsappAccountId")),
        "defaultCountryCode": lead_source.get("defaultCountryCode"),
        "status": lead_source.get("status"),
        "aiContextEnabled": bool(lead_source.get("aiContextEnabled")),
        "autoGreetEnabled": bool(lead_source.get("autoGreetEnabled")),
        "callSchedulingEnabled": bool(lead_source.get("callSchedulingEnabled")),
        "columnMapping": {
            "externalId": column_mapping.get("externalId") or None,
            "createdTime": column_mapping.get("createdTime") or None,
            "fullName": column_mapping.get("fullName") or None,
            "phone": column_mapping.get("phone") or None,
            "email": column_mapping.get("email") or None,
        },
        "importFromTime": serialize_date(lead_source.get("importFromTime")),
        "lastSyncedAt": serialize_date(lead_source.get("lastSyncedAt")),
        "lastSyncStatus": lead_source.get("lastSyncStatus"),
        "lastError": lead_source.get("lastError"),
        "lastSyncCounts": {
            "imported": counts.get("imported", 0),
            "duplicates": counts.get("duplicates", 0),
            "skipped": counts.get("skipped", 0),
            "failed": counts.get("failed", 0),
        },
        "totalImported": lead_source.get("totalImported", 0),
        "createdBy": serialize_id(lead_source.get("createdBy")),
        "updatedBy": serialize_id(lead_source.get("updatedBy")),
        "createdAt": serialize_date(lead_source.get("createdAt")),
        "updatedAt": serialize_date(lead_source.get("updatedAt")),
    }


def serialize_meta_connection(connection: Any) -> dict[str, Any] | None:
    if not connection or not isinstance(connection, dict):
        return None

    return {
        "id": serialize_id(connection.get("_id")),
        "metaUserId": connection.get("metaUserId"),
        "metaUserName": connection.get("metaUserName") or None,
        "status": connection.get("status"),
        "grantedScopes": connection.get("grantedScopes") or [],
        "accessTokenLast4": connection.get("accessTokenLast4") or None,
        "accessTokenSetAt": serialize_date(connection.get("accessTokenSetAt")),
        "accessTokenExpiresAt": serialize_date(connection.get("accessTokenExpiresAt")),
        "lastError": connection.get("lastError") or None,
        "lastCheckedAt": serialize_date(connection.get("lastCheckedAt")),
        "createdAt": serialize_date(connection.get("createdAt")),
        "updatedAt": serialize_date(connection.get("updatedAt")),
    }


def serialize_lead_submission(
    submission: Any, payload: dict[str, Any] | None = None
) -> dict[str, Any] | None:
    if not submission or not isinstance(submission, dict):
        return None

    payload_val = payload or {}
    custom_fields = payload_val.get("customFields") or []
    fields: list[dict[str, str]] = []
    if isinstance(custom_fields, list):
        for entry in custom_fields:
            if isinstance(entry, dict) and "label" in entry and "value" in entry:
                fields.append({
                    "key": str(entry.get("key") or entry["label"]),
                    "label": str(entry["label"]),
                    "value": str(entry["value"]),
                })

    email = payload_val.get("email")
    phone = payload_val.get("phone")

    return {
        "id": serialize_id(submission.get("_id")),
        "status": submission.get("status"),
        "skipReason": submission.get("skipReason"),
        "submittedAt": serialize_date(submission.get("submittedAt")),
        "platform": submission.get("platform"),
        "isOrganic": bool(submission.get("isOrganic")),
        "leadStatus": submission.get("leadStatus"),
        "campaignName": submission.get("campaignName"),
        "adName": submission.get("adName"),
        "adsetName": submission.get("adsetName"),
        "formName": submission.get("formName"),
        "fields": fields,
        "hasEmail": bool(email and isinstance(email, str)),
        "hasPhone": bool(phone and isinstance(phone, str)),
    }


# ---- Validation Schemas --------------------------------------------------------

class ColumnMappingSchema(BaseModel):
    externalId: str | None = None
    createdTime: str | None = None
    fullName: str | None = None
    phone: str | None = None
    email: str | None = None


class LeadSourceFieldMappingSchema(BaseModel):
    metaKey: str = Field(..., min_length=1, max_length=200)
    metaLabel: str | None = Field(None, max_length=300)
    factKey: str | None = Field(None, max_length=80)


class CreateLeadSourceBody(BaseModel):
    name: str = Field(..., min_length=2, max_length=120)
    kind: Literal["google_sheet", "meta_lead_ads"] = "google_sheet"
    sheetUrl: str | None = Field(None, max_length=2000)
    accessToken: str | None = Field(None, min_length=META_ACCESS_TOKEN_MIN_LENGTH, max_length=1000)
    pageId: str | None = Field(None, max_length=64)
    pageName: str | None = Field(None, max_length=200)
    formId: str | None = Field(None, max_length=64)
    formName: str | None = Field(None, max_length=200)
    whatsappAccountId: str = Field(..., pattern=r"^[a-fA-F0-9]{24}$")
    defaultCountryCode: str = "91"
    aiContextEnabled: bool = False
    autoGreetEnabled: bool = False
    importExisting: bool = False
    columnMapping: ColumnMappingSchema | None = None

    @field_validator("defaultCountryCode", mode="before")
    def clean_country_code(cls, v: Any) -> str:
        s = str(v or "91").strip().lstrip("+")
        if not s.isdigit() or len(s) > 4:
            raise ValueError("Country code must be 1-4 digits.")
        return s


class UpdateLeadSourceBody(BaseModel):
    name: str | None = Field(None, min_length=2, max_length=120)
    whatsappAccountId: str | None = Field(None, pattern=r"^[a-fA-F0-9]{24}$")
    defaultCountryCode: str | None = None
    aiContextEnabled: bool | None = None
    autoGreetEnabled: bool | None = None
    callSchedulingEnabled: bool | None = None
    status: Literal["active", "paused"] | None = None
    columnMapping: ColumnMappingSchema | None = None
    accessToken: str | None = Field(None, min_length=META_ACCESS_TOKEN_MIN_LENGTH, max_length=1000)
    formId: str | None = Field(None, max_length=64)
    formName: str | None = Field(None, max_length=200)

    @field_validator("defaultCountryCode", mode="before")
    def clean_country_code(cls, v: Any) -> str | None:
        if v is None:
            return None
        s = str(v).strip().lstrip("+")
        if not s.isdigit() or len(s) > 4:
            raise ValueError("Country code must be 1-4 digits.")
        return s


class TestMetaConnectionBody(BaseModel):
    accessToken: str = Field(..., min_length=META_ACCESS_TOKEN_MIN_LENGTH, max_length=1000)


class ListMetaFormsBody(BaseModel):
    accessToken: str = Field(..., min_length=META_ACCESS_TOKEN_MIN_LENGTH, max_length=1000)
    pageId: str = Field(..., min_length=1, max_length=64)


class CreateMetaOauthLeadSourceBody(BaseModel):
    name: str = Field(..., min_length=2, max_length=120)
    pageId: str = Field(..., min_length=1, max_length=64)
    pageName: str | None = Field(None, max_length=200)
    formId: str = Field(..., min_length=1, max_length=64)
    formName: str | None = Field(None, max_length=200)
    whatsappAccountId: str = Field(..., pattern=r"^[a-fA-F0-9]{24}$")
    defaultCountryCode: str = "91"
    aiContextEnabled: bool = False
    autoGreetEnabled: bool = False
    importExisting: bool = False
    fieldMappings: list[LeadSourceFieldMappingSchema] = Field(default_factory=list, max_length=100)
    defaultStage: str | None = Field(None, max_length=60)
    defaultTagIds: list[str] = Field(default_factory=list, max_length=20)
    defaultAssigneeId: str | None = Field(None, pattern=r"^[a-fA-F0-9]{24}$")
    subscribeWebhook: bool = True

    @field_validator("defaultCountryCode", mode="before")
    def clean_country_code(cls, v: Any) -> str:
        s = str(v or "91").strip().lstrip("+")
        if not s.isdigit() or len(s) > 4:
            raise ValueError("Country code must be 1-4 digits.")
        return s
