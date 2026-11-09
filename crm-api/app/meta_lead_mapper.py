"""
Mapping Meta lead rows (from Google Sheet or Graph API) into CRM structures.
Ported from Node's backend/src/modules/lead-sources/meta-lead.mapper.ts.
"""

from __future__ import annotations

import hashlib
import re
from datetime import datetime
from typing import Any, NamedTuple

from app.lead_field_rules import (
    FormFieldEntry,
    build_lead_form_facts,
    parse_form_fields,
)


class META_STANDARD_COLUMNS:
    EXTERNAL_ID = "id"
    CREATED_TIME = "created_time"
    AD_ID = "ad_id"
    AD_NAME = "ad_name"
    ADSET_ID = "adset_id"
    ADSET_NAME = "adset_name"
    CAMPAIGN_ID = "campaign_id"
    CAMPAIGN_NAME = "campaign_name"
    FORM_ID = "form_id"
    FORM_NAME = "form_name"
    IS_ORGANIC = "is_organic"
    PLATFORM = "platform"
    EMAIL = "email"
    FULL_NAME = "full_name"
    PHONE_NUMBER = "phone_number"
    INBOX_URL = "inbox_url"
    LEAD_STATUS = "lead_status"


STANDARD_COLUMN_VALUES = (
    META_STANDARD_COLUMNS.EXTERNAL_ID,
    META_STANDARD_COLUMNS.CREATED_TIME,
    META_STANDARD_COLUMNS.AD_ID,
    META_STANDARD_COLUMNS.AD_NAME,
    META_STANDARD_COLUMNS.ADSET_ID,
    META_STANDARD_COLUMNS.ADSET_NAME,
    META_STANDARD_COLUMNS.CAMPAIGN_ID,
    META_STANDARD_COLUMNS.CAMPAIGN_NAME,
    META_STANDARD_COLUMNS.FORM_ID,
    META_STANDARD_COLUMNS.FORM_NAME,
    META_STANDARD_COLUMNS.IS_ORGANIC,
    META_STANDARD_COLUMNS.PLATFORM,
    META_STANDARD_COLUMNS.EMAIL,
    META_STANDARD_COLUMNS.FULL_NAME,
    META_STANDARD_COLUMNS.PHONE_NUMBER,
    META_STANDARD_COLUMNS.INBOX_URL,
    META_STANDARD_COLUMNS.LEAD_STATUS,
)

PHONE_HEADER_ALIASES: tuple[str, ...] = (
    "phone",
    "phone number",
    "mobile",
    "mobile_number",
    "mobile number",
    "mobile_phone",
    "contact_number",
    "contact number",
    "whatsapp",
    "whatsapp_number",
    "whatsapp number",
    "phone_no",
    "telephone",
)

DEFAULT_LEAD_DISPLAY_NAME = "Meta Lead"
DISPLAY_NAME_MAX_LENGTH = 160
CUSTOM_FIELD_VALUE_MAX_LENGTH = 1000
MAX_CUSTOM_FIELDS = 60


def strip_meta_prefix(value: str) -> str:
    """Strips Meta prefixes like l:, p:, ag:, as:, c:, f: from identifiers."""
    return re.sub(r"^[a-z]{1,3}:", "", value)


def normalize_header(header: str) -> str:
    return str(header or "").strip().lower()


def empty_to_null(value: Any) -> str | None:
    norm = str(value).strip() if isinstance(value, str) else ""
    return norm if norm else None


def truncate(value: str, max_length: int) -> str:
    return value[:max_length] if len(value) > max_length else value


def prettify_label(header: str) -> str:
    """how_would_you_describe_this_event? -> How would you describe this event?"""
    spaced = re.sub(r"\s+", " ", re.sub(r"_+", " ", header)).strip()
    if not spaced:
        return header
    return spaced[0].upper() + spaced[1:]


def prettify_value(value: str) -> str:
    """Underscores in multiple choice options become spaces, unless already containing spaces."""
    if " " in value or "_" not in value:
        return value
    return re.sub(r"_+", " ", value).strip()


def parse_boolean(value: Any) -> bool:
    return isinstance(value, str) and value.strip().lower() == "true"


def parse_date(value: Any) -> datetime | None:
    norm = empty_to_null(value)
    if not norm:
        return None
    try:
        from app.event_date import parse_event_date
        d = parse_event_date(norm)
        return d
    except Exception:
        return None


def hash_row(row: dict[str, str]) -> str:
    """Stable sha256 hash for a sheet row lacking a Meta external lead id."""
    body = " ".join(f"{k}={row.get(k, '')}" for k in sorted(row.keys()))
    return hashlib.sha256(body.encode("utf-8")).hexdigest()[:40]


class LeadCustomField(NamedTuple):
    key: str
    label: str
    value: str


class NormalizedMetaLead(NamedTuple):
    external_id: str
    submitted_at: datetime | None
    display_name: str
    full_name: str | None
    phone: str | None
    email: str | None
    inbox_url: str | None
    lead_status: str | None
    platform: str | None
    is_organic: bool
    campaign_id: str | None
    campaign_name: str | None
    ad_id: str | None
    ad_name: str | None
    adset_id: str | None
    adset_name: str | None
    form_id: str | None
    form_name: str | None
    custom_fields: list[LeadCustomField]
    canonical_facts: dict[str, str]
    category: str
    raw: dict[str, str]


def map_meta_lead_row(
    row: dict[str, str],
    column_mapping: dict[str, str | None] | None = None,
    field_key_overrides: dict[str, str | None] | None = None,
) -> NormalizedMetaLead:
    """Turns one row dict into a NormalizedMetaLead."""
    by_header: dict[str, str] = {
        normalize_header(k): str(v).strip() if isinstance(v, str) else ""
        for k, v in row.items()
    }
    mapping = column_mapping or {}

    def read_column(standard_col: str, override: str | None = None) -> str | None:
        ov = empty_to_null(override)
        if ov:
            return empty_to_null(by_header.get(normalize_header(ov)))
        return empty_to_null(by_header.get(standard_col))

    alias_phone_header: str | None = None
    if not empty_to_null(mapping.get("phone")) and META_STANDARD_COLUMNS.PHONE_NUMBER not in by_header:
        for alias in PHONE_HEADER_ALIASES:
            norm_alias = normalize_header(alias)
            if empty_to_null(by_header.get(norm_alias)) is not None:
                alias_phone_header = norm_alias
                break

    mapped_headers = set(STANDARD_COLUMN_VALUES)
    for ov in mapping.values():
        ov_hdr = empty_to_null(ov)
        if ov_hdr:
            mapped_headers.add(normalize_header(ov_hdr))
    if alias_phone_header:
        mapped_headers.add(alias_phone_header)

    custom_fields: list[LeadCustomField] = []
    form_entries: list[FormFieldEntry] = []

    for header, value in row.items():
        norm_h = normalize_header(header)
        if not norm_h or norm_h in mapped_headers:
            continue
        norm_v = empty_to_null(value)
        if norm_v is None or len(custom_fields) >= MAX_CUSTOM_FIELDS:
            continue

        display_val = truncate(prettify_value(norm_v), CUSTOM_FIELD_VALUE_MAX_LENGTH)
        custom_fields.append(
            LeadCustomField(
                key=norm_h,
                label=truncate(prettify_label(header), 200),
                value=display_val,
            )
        )
        form_entries.append(FormFieldEntry(label=header, value=display_val))

    lead_form_facts = build_lead_form_facts(
        parse_form_fields(form_entries, field_key_overrides or {})
    )

    raw_external_id = read_column(META_STANDARD_COLUMNS.EXTERNAL_ID, mapping.get("externalId"))
    full_name = read_column(META_STANDARD_COLUMNS.FULL_NAME, mapping.get("fullName"))

    def read_phone_col() -> str | None:
        direct = read_column(META_STANDARD_COLUMNS.PHONE_NUMBER, mapping.get("phone"))
        if direct is not None or alias_phone_header is None:
            return direct
        return empty_to_null(by_header.get(alias_phone_header))

    raw_phone = read_phone_col()

    def read_id_col(std_col: str) -> str | None:
        val = read_column(std_col)
        return strip_meta_prefix(val) if val else None

    external_id = strip_meta_prefix(raw_external_id) if raw_external_id else hash_row(row)
    phone = strip_meta_prefix(raw_phone) if raw_phone else None
    display_name = truncate(full_name, DISPLAY_NAME_MAX_LENGTH) if full_name else DEFAULT_LEAD_DISPLAY_NAME

    return NormalizedMetaLead(
        external_id=external_id,
        submitted_at=parse_date(read_column(META_STANDARD_COLUMNS.CREATED_TIME, mapping.get("createdTime"))),
        display_name=display_name,
        full_name=full_name,
        phone=phone,
        email=read_column(META_STANDARD_COLUMNS.EMAIL, mapping.get("email")),
        inbox_url=read_column(META_STANDARD_COLUMNS.INBOX_URL),
        lead_status=read_column(META_STANDARD_COLUMNS.LEAD_STATUS),
        platform=read_column(META_STANDARD_COLUMNS.PLATFORM),
        is_organic=parse_boolean(by_header.get(META_STANDARD_COLUMNS.IS_ORGANIC)),
        campaign_id=read_id_col(META_STANDARD_COLUMNS.CAMPAIGN_ID),
        campaign_name=read_column(META_STANDARD_COLUMNS.CAMPAIGN_NAME),
        ad_id=read_id_col(META_STANDARD_COLUMNS.AD_ID),
        ad_name=read_column(META_STANDARD_COLUMNS.AD_NAME),
        adset_id=read_id_col(META_STANDARD_COLUMNS.ADSET_ID),
        adset_name=read_column(META_STANDARD_COLUMNS.ADSET_NAME),
        form_id=read_id_col(META_STANDARD_COLUMNS.FORM_ID),
        form_name=read_column(META_STANDARD_COLUMNS.FORM_NAME),
        custom_fields=custom_fields,
        canonical_facts=lead_form_facts.facts,
        category=lead_form_facts.category,
        raw=row,
    )


def meta_graph_lead_to_row(
    lead: dict[str, Any], form_name: str | None = None
) -> dict[str, str]:
    """Flattens a Graph API lead dictionary into the row dict expected by map_meta_lead_row."""
    row: dict[str, str] = {}

    def set_if_present(col: str, val: Any) -> None:
        if isinstance(val, str) and val.strip():
            row[col] = val.strip()

    set_if_present(META_STANDARD_COLUMNS.EXTERNAL_ID, lead.get("id"))
    set_if_present(META_STANDARD_COLUMNS.CREATED_TIME, lead.get("created_time"))
    set_if_present(META_STANDARD_COLUMNS.AD_ID, lead.get("ad_id"))
    set_if_present(META_STANDARD_COLUMNS.AD_NAME, lead.get("ad_name"))
    set_if_present(META_STANDARD_COLUMNS.ADSET_ID, lead.get("adset_id"))
    set_if_present(META_STANDARD_COLUMNS.ADSET_NAME, lead.get("adset_name"))
    set_if_present(META_STANDARD_COLUMNS.CAMPAIGN_ID, lead.get("campaign_id"))
    set_if_present(META_STANDARD_COLUMNS.CAMPAIGN_NAME, lead.get("campaign_name"))
    set_if_present(META_STANDARD_COLUMNS.FORM_ID, lead.get("form_id"))
    set_if_present(META_STANDARD_COLUMNS.FORM_NAME, form_name)
    set_if_present(META_STANDARD_COLUMNS.PLATFORM, lead.get("platform"))

    if isinstance(lead.get("is_organic"), bool):
        row[META_STANDARD_COLUMNS.IS_ORGANIC] = "true" if lead["is_organic"] else "false"

    field_data = lead.get("field_data") or []
    if isinstance(field_data, list):
        for field in field_data:
            if not isinstance(field, dict):
                continue
            name = str(field.get("name") or "").strip()
            if not name:
                continue
            vals = field.get("values") or []
            val_strs = [str(v).strip() for v in vals if isinstance(v, str) and v.strip()]
            val_joined = ", ".join(val_strs)
            if val_joined and name not in row:
                row[name] = val_joined

    return row


def map_meta_graph_lead(
    lead: dict[str, Any],
    column_mapping: dict[str, str | None] | None = None,
    form_name: str | None = None,
    field_key_overrides: dict[str, str | None] | None = None,
) -> NormalizedMetaLead:
    """Converts a Graph API lead object into NormalizedMetaLead via flattening and row mapping."""
    row = meta_graph_lead_to_row(lead, form_name=form_name)
    return map_meta_lead_row(
        row=row,
        column_mapping=column_mapping,
        field_key_overrides=field_key_overrides,
    )

