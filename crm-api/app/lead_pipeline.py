"""
The shared tail of lead importing: everything that happens once a source — a Google Sheet or
the Meta Graph API — has produced a list of `NormalizedMetaLead`.

PORTED FROM backend/src/modules/lead-sources/lead-pipeline.service.ts.

It lives apart from `lead_import_service` so the two source kinds cannot drift. Contact
resolution, the ADR-005 AI-context boundary, the submission ledger, the activity entry, the
owner ping and the per-lead failure isolation are written once and both importers run the same
code. A change to how a lead becomes a CRM record lands on both, or on neither.

Deliberately not transactional, mirroring inbound WhatsApp ingestion: the conversation upsert
is idempotent and the submission ledger's unique index is the duplicate check, so a crash
mid-lead costs at most a contact with no submission attached, which the next poll repairs.
Nothing here sends a message — an imported lead is a thread waiting for a human.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, NamedTuple
from bson import ObjectId

from app.activity import ACTIVITY_EVENTS, create_activity
from app.allowlist import NumberAllowlist, create_number_allowlist
from app.config import settings
from app.contacts_repository import (
    attach_contact_email_if_missing,
    attach_contact_phone_if_missing,
    find_or_create_contact_by_provider_key,
)
from app.conversations_repository import (
    merge_conversation_ai_context,
    schedule_auto_greet,
    touch_conversation,
    upsert_conversation_for_contact,
)
from app.lead_score import recompute_lead_score
from app.lead_sources_common import (
    LEAD_SKIP_REASONS,
    LEAD_SUBMISSION_STATUSES,
    LeadSourceError,
    sanitize_lead_source_error_text,
)
from app.lead_sources_repository import (
    count_lead_submissions_for_conversation,
    create_lead_submission,
    find_imported_external_ids,
)
from app.meta_lead_mapper import NormalizedMetaLead
from app.protected_pii import (
    compute_contact_provider_key_from_phone,
    normalize_phone_number,
)
from app.realtime import REALTIME_REASONS, enqueue_conversation_changed

logger = logging.getLogger(__name__)

LEAD_CONTACT_SOURCE = "meta-lead-form"
WHATSAPP_JID_DOMAIN = "s.whatsapp.net"


def mask_phone(phone: Any) -> str:
    """
    Enough of a phone to recognise in a log line without writing a lead's number into the logs -
    the same shape the inbound router's `maskJid` produces, so the two refusal lines read alike.
    """
    val = str(phone or "").strip()
    if not val:
        return "(none)"
    return f"{val[:3]}***{val[-3:]}" if len(val) > 6 else "***"


def is_duplicate_key_error(error: Any) -> bool:
    """Checks for MongoDB duplicate key error code 11000."""
    if error is None:
        return False
    code = getattr(error, "code", None)
    if code == 11000:
        return True
    if isinstance(error, dict) and error.get("code") == 11000:
        return True
    from pymongo.errors import DuplicateKeyError
    return isinstance(error, DuplicateKeyError)


def describe_error(error: Any) -> str:
    """
    Our own errors carry messages written for the admin ("the sheet is not link-shared") and are
    safe to persist. Anything else could be a driver or fetch error echoing the sheet URL, the
    Graph URL (which carries the access token) or row content, so only its code/name survives.
    Either way the result goes through the sanitizer before it can reach `lastError`.
    """
    if isinstance(error, LeadSourceError):
        return sanitize_lead_source_error_text(str(error))

    code = getattr(error, "code", getattr(error, "name", None))
    if code is None and isinstance(error, dict):
        code = error.get("code") or error.get("name")
    return sanitize_lead_source_error_text(str(code or "lead_import_failed"))


class LeadImportCounts(NamedTuple):
    imported: int
    duplicates: int
    skipped: int
    failed: int


class LeadBatchResult(NamedTuple):
    counts: LeadImportCounts
    newest_submitted_at: datetime | None


class LeadPipeline:
    """
    Stateful or configured lead pipeline processor.
    Handles per-row ingestion, allowlist check, contact & conversation upsert,
    AI context merging, auto-greet scheduling, and ledger writes.
    """

    def __init__(
        self,
        *,
        allowlist: NumberAllowlist | None = None,
        max_rows_per_tick: int | None = None,
        greet_delay_ms: int | None = None,
        fn_find_or_create_contact: Callable[..., Any] = find_or_create_contact_by_provider_key,
        fn_attach_phone: Callable[..., Any] = attach_contact_phone_if_missing,
        fn_attach_email: Callable[..., Any] = attach_contact_email_if_missing,
        fn_upsert_conversation: Callable[..., Any] = upsert_conversation_for_contact,
        fn_touch_conversation: Callable[..., Any] = touch_conversation,
        fn_merge_ai_context: Callable[..., Any] = merge_conversation_ai_context,
        fn_create_lead_submission: Callable[..., Any] = create_lead_submission,
        fn_find_imported_ids: Callable[..., Any] = find_imported_external_ids,
        fn_count_submissions: Callable[..., Any] = count_lead_submissions_for_conversation,
        fn_create_activity: Callable[..., Any] = create_activity,
        fn_send_new_lead_alert: Callable[..., Any] | None = None,
        fn_schedule_auto_greet: Callable[..., Any] = schedule_auto_greet,
        fn_recompute_lead_score: Callable[..., Any] = recompute_lead_score,
        fn_publish_event: Callable[..., Any] = enqueue_conversation_changed,
        fn_compute_provider_key: Callable[..., Any] = compute_contact_provider_key_from_phone,
        fn_normalize_phone: Callable[..., Any] = normalize_phone_number,
    ):
        raw_allowed = getattr(settings, "whatsapp_test_allowed_numbers", None)
        self.allowlist = allowlist or create_number_allowlist(str(raw_allowed or ""))
        self.max_rows_per_tick = max_rows_per_tick or int(getattr(settings, "lead_import_max_rows_per_tick", 200))
        self.greet_delay_ms = greet_delay_ms or int(getattr(settings, "lead_auto_greet_delay_ms", 300_000))

        self._find_or_create_contact = fn_find_or_create_contact
        self._attach_phone = fn_attach_phone
        self._attach_email = fn_attach_email
        self._upsert_conversation = fn_upsert_conversation
        self._touch_conversation = fn_touch_conversation
        self._merge_ai_context = fn_merge_ai_context
        self._create_lead_submission = fn_create_lead_submission
        self._find_imported_ids = fn_find_imported_ids
        self._count_submissions = fn_count_submissions
        self._create_activity = fn_create_activity
        self._send_new_lead_alert = fn_send_new_lead_alert
        self._schedule_auto_greet = fn_schedule_auto_greet
        self._recompute_lead_score = fn_recompute_lead_score
        self._publish_event = fn_publish_event
        self._compute_provider_key = fn_compute_provider_key
        self._normalize_phone = fn_normalize_phone

    async def record_skipped_lead(
        self,
        lead_source: dict[str, Any],
        lead: NormalizedMetaLead,
        skip_reason: str,
    ) -> None:
        """
        Written to the ledger rather than retried: the same lead will be just as unusable on the
        next poll, and an admin needs to see the count to know the form needs fixing.
        """
        ls_id = lead_source["_id"]
        org_id = lead_source["organizationId"]

        # Serialize custom_fields safely
        cfields = [
            {"key": cf.key, "label": cf.label, "value": cf.value}
            if hasattr(cf, "key")
            else cf
            for cf in (lead.custom_fields or [])
        ]

        await self._create_lead_submission(
            organization_id=org_id,
            lead_source_id=ls_id,
            external_id=lead.external_id,
            status=LEAD_SUBMISSION_STATUSES.SKIPPED,
            skip_reason=skip_reason,
            payload={
                "fullName": lead.full_name,
                "phone": lead.phone,
                "email": lead.email,
                "inboxUrl": lead.inbox_url,
                "customFields": cfields,
                "raw": lead.raw,
            },
            submitted_at=lead.submitted_at,
            platform=lead.platform,
            is_organic=lead.is_organic,
            lead_status=lead.lead_status,
            campaign_id=lead.campaign_id,
            campaign_name=lead.campaign_name,
            ad_id=lead.ad_id,
            ad_name=lead.ad_name,
            adset_id=lead.adset_id,
            adset_name=lead.adset_name,
            form_id=lead.form_id,
            form_name=lead.form_name,
        )

    async def import_lead(
        self,
        lead_source: dict[str, Any],
        lead: NormalizedMetaLead,
        now: datetime | None = None,
    ) -> str:
        """
        Imports one lead. Returns 'imported', 'duplicate', or 'skipped'.
        """
        org_id = lead_source["organizationId"]
        country_code = lead_source.get("defaultCountryCode", "91")
        normalized_phone = self._normalize_phone(lead.phone, country_code)

        if normalized_phone is None:
            skip_reason = (
                LEAD_SKIP_REASONS.NO_PHONE
                if lead.phone is None
                else LEAD_SKIP_REASONS.UNPARSABLE_PHONE
            )
            await self.record_skipped_lead(lead_source, lead, skip_reason)
            return "skipped"

        # The same test-phase gate inbound WhatsApp enforces, and for the same reason: with
        # `WHATSAPP_TEST_ALLOWED_NUMBERS` set, a sheet or a Meta form must not be the back door that
        # fills the dashboard with numbers the owner has restricted to one. Checked here, before any
        # contact or conversation exists, so a refused lead leaves nothing behind. Judged as an
        # ingestion gate rather than a send gate, so it fails closed exactly like the inbound one.
        #
        # Deliberately NOT written to the submission ledger. Every other skip reason is permanent -
        # a row with no usable phone will still have none on the next poll - but this one is a
        # configuration switch. A ledger row would mark the lead processed forever, so clearing the
        # allowlist for production would silently leave every refused lead unimported. Leaving the
        # ledger alone means the lead simply arrives on the first poll after the gate is lifted.
        if not self.allowlist.permits_inbound_jid(f"{normalized_phone}@{WHATSAPP_JID_DOMAIN}", normalized_phone):
            logger.warning(
                "Lead refused: phone %s not on test allowlist for lead source %s (externalId=%s).",
                mask_phone(normalized_phone),
                str(lead_source.get("_id")),
                lead.external_id,
            )
            return "skipped"

        # The identity bridge: hashing `<digits>@s.whatsapp.net` produces the same blind index that
        # inbound ingestion derives from the sender's JID, so a lead who later messages the number
        # resolves to this very contact instead of a second one.
        provider_contact_key = self._compute_provider_key(normalized_phone, country_code)
        if not provider_contact_key:
            await self.record_skipped_lead(lead_source, lead, LEAD_SKIP_REASONS.NO_IDENTITY)
            return "skipped"

        res = await self._find_or_create_contact(
            organization_id=org_id,
            provider_contact_key=provider_contact_key,
            display_name=lead.display_name,
            phone=normalized_phone,
            provider_jids=[f"{normalized_phone}@{WHATSAPP_JID_DOMAIN}"],
            source=LEAD_CONTACT_SOURCE,
        )
        contact = res.contact
        contact_created = res.created

        if not contact:
            raise LeadSourceError("Contact could not be resolved for the lead.", code="LEAD_CONTACT_UNRESOLVED")

        # A contact first seen over WhatsApp has a phone but no email, and one first seen through a
        # form may predate its phone being known. Both fills are "only if missing" in the query.
        await self._attach_phone(
            contact_id=contact["_id"],
            organization_id=org_id,
            phone=normalized_phone,
        )
        await self._attach_email(
            contact_id=contact["_id"],
            organization_id=org_id,
            email=lead.email,
        )

        conversation = await self._upsert_conversation(
            organization_id=org_id,
            whatsapp_account_id=lead_source["whatsappAccountId"],
            contact_id=contact["_id"],
            lead_id=contact.get("leadId"),
            display_name=contact.get("displayName"),
            defaults={
                "stage": "new",
                # Which form this came from, so the greet sweep can re-check the source's settings at
                # send time rather than trusting what they were at import.
                "leadSourceId": lead_source["_id"],
                # On insert only. An imported lead arrives with automation ON, like an inbound one.
                "aiAutomationEnabled": True,
            },
        )

        # ADR-005, the same boundary lead-context enforces: answers only reach AI if enabled.
        if lead_source.get("aiContextEnabled"):
            await self._merge_ai_context(
                conversation_id=conversation["_id"],
                organization_id=org_id,
                facts=lead.canonical_facts,
                category=lead.category,
            )
            # Facts changed: recompute lead score
            await self._recompute_lead_score(
                organization_id=org_id,
                conversation_id=conversation["_id"],
                whatsapp_account_id=lead_source["whatsappAccountId"],
            )

        prior_submissions = (
            0
            if contact_created
            else await self._count_submissions(
                organization_id=org_id,
                conversation_id=conversation["_id"],
            )
        )

        cfields = [
            {"key": cf.key, "label": cf.label, "value": cf.value}
            if hasattr(cf, "key")
            else cf
            for cf in (lead.custom_fields or [])
        ]

        try:
            await self._create_lead_submission(
                organization_id=org_id,
                lead_source_id=lead_source["_id"],
                external_id=lead.external_id,
                status=LEAD_SUBMISSION_STATUSES.IMPORTED,
                contact_id=contact["_id"],
                conversation_id=conversation["_id"],
                payload={
                    "fullName": lead.full_name,
                    "phone": normalized_phone,
                    "email": lead.email,
                    "inboxUrl": lead.inbox_url,
                    "customFields": cfields,
                    "raw": lead.raw,
                },
                submitted_at=lead.submitted_at,
                platform=lead.platform,
                is_organic=lead.is_organic,
                lead_status=lead.lead_status,
                campaign_id=lead.campaign_id,
                campaign_name=lead.campaign_name,
                ad_id=lead.ad_id,
                ad_name=lead.ad_name,
                adset_id=lead.adset_id,
                adset_name=lead.adset_name,
                form_id=lead.form_id,
                form_name=lead.form_name,
            )
        except Exception as exc:
            if is_duplicate_key_error(exc):
                return "duplicate"
            raise

        is_resubmission = prior_submissions > 0

        await self._create_activity(
            organization_id=org_id,
            whatsapp_account_id=conversation.get("whatsappAccountId"),
            conversation_id=conversation["_id"],
            actor_id=None,
            event_type=(
                ACTIVITY_EVENTS["LEAD_RESUBMITTED"]
                if is_resubmission
                else ACTIVITY_EVENTS["LEAD_IMPORTED"]
            ),
            summary=(
                "Lead submitted the form again."
                if is_resubmission
                else f"Lead imported from {lead_source.get('name')}."
            ),
            metadata={
                "leadSourceId": str(lead_source["_id"]),
                "externalId": lead.external_id,
                "campaignName": lead.campaign_name,
                "formName": lead.form_name,
                "platform": lead.platform,
            },
            session=None,
        )

        if is_resubmission:
            await self._touch_conversation(
                conversation_id=conversation["_id"],
                organization_id=org_id,
            )

        await self._publish_event(
            organization_id=org_id,
            conversation_id=conversation["_id"],
            assigned_to=conversation.get("assignedTo"),
            reason=REALTIME_REASONS["IMPORTED"],
        )

        # 🔔 Owner ping: failure-isolated courtesy alert.
        if self._send_new_lead_alert:
            try:
                await self._send_new_lead_alert(
                    organization_id=org_id,
                    whatsapp_account_id=conversation.get("whatsappAccountId"),
                    conversation_id=conversation["_id"],
                    lead_display_name=conversation.get("displayName"),
                    phone=normalized_phone,
                    facts=lead.canonical_facts,
                    category=lead.category,
                    source_label=lead_source.get("name"),
                )
            except Exception as alert_err:
                logger.error(
                    "New-lead owner alert threw unexpectedly for conversation %s: %s; lead imported either way.",
                    str(conversation["_id"]),
                    describe_error(alert_err),
                )

        # Auto-greet scheduling:
        # Off unless the source says otherwise, and last in the function on purpose.
        if lead_source.get("autoGreetEnabled") is True:
            cur_time = now or datetime.now(timezone.utc)
            submitted = lead.submitted_at or cur_time
            base_time = max(submitted, cur_time)
            due_at = base_time + timedelta(milliseconds=self.greet_delay_ms)

            try:
                await self._schedule_auto_greet(
                    conversation_id=conversation["_id"],
                    organization_id=org_id,
                    due_at=due_at,
                )
            except Exception as greet_err:
                logger.error(
                    "Could not schedule auto-greet for conversation %s: %s; lead imported either way.",
                    str(conversation["_id"]),
                    describe_error(greet_err),
                )

        return "imported"

    async def import_leads(
        self,
        lead_source: dict[str, Any],
        leads: list[NormalizedMetaLead],
        now: datetime | None = None,
    ) -> LeadBatchResult:
        """
        Consumes lead batch in the order given (oldest-first from Meta).
        Watermark only advances past leads that were processed.
        """
        imported_count = 0
        duplicates_count = 0
        skipped_count = 0
        failed_count = 0

        import_from_time = lead_source.get("importFromTime")
        if import_from_time and import_from_time.tzinfo is None:
            import_from_time = import_from_time.replace(tzinfo=timezone.utc)

        # Filter inWindow: submitted_at is None or submitted_at > importFromTime
        in_window: list[NormalizedMetaLead] = []
        for l in leads:
            sub_at = l.submitted_at
            if sub_at and sub_at.tzinfo is None:
                sub_at = sub_at.replace(tzinfo=timezone.utc)
            if sub_at is None or import_from_time is None or sub_at > import_from_time:
                in_window.append(l)

        # Pre-filter already imported leads
        already_imported = await self._find_imported_ids(
            organization_id=lead_source["organizationId"],
            lead_source_id=lead_source["_id"],
            external_ids=[l.external_id for l in in_window],
        )

        pending_leads = [
            l for l in in_window if l.external_id not in already_imported
        ][: self.max_rows_per_tick]

        duplicates_count += len(in_window) - len(pending_leads)

        newest_submitted_at: datetime | None = None

        for lead in pending_leads:
            try:
                outcome = await self.import_lead(lead_source, lead, now=now)
                if outcome == "imported":
                    imported_count += 1
                elif outcome == "duplicate":
                    duplicates_count += 1
                else:
                    skipped_count += 1

                if lead.submitted_at is not None:
                    lead_sub = lead.submitted_at
                    if lead_sub.tzinfo is None:
                        lead_sub = lead_sub.replace(tzinfo=timezone.utc)
                    if newest_submitted_at is None or lead_sub > newest_submitted_at:
                        newest_submitted_at = lead_sub
            except Exception as err:
                failed_count += 1
                logger.error(
                    "Lead row import failed safely for source %s: %s",
                    str(lead_source.get("_id")),
                    describe_error(err),
                )

        counts = LeadImportCounts(
            imported=imported_count,
            duplicates=duplicates_count,
            skipped=skipped_count,
            failed=failed_count,
        )
        return LeadBatchResult(counts=counts, newest_submitted_at=newest_submitted_at)


def create_lead_pipeline(
    *,
    allowlist: NumberAllowlist | None = None,
    max_rows_per_tick: int | None = None,
    greet_delay_ms: int | None = None,
    **kwargs: Any,
) -> LeadPipeline:
    """Factory helper creating a LeadPipeline instance."""
    return LeadPipeline(
        allowlist=allowlist,
        max_rows_per_tick=max_rows_per_tick,
        greet_delay_ms=greet_delay_ms,
        **kwargs,
    )
