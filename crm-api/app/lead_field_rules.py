"""
Reading a Meta lead form's answers into the canonical facts the AI brain works in - ported
from Node's backend/src/modules/lead-sources/lead-field-rules.ts.

The same form reaches this CRM by two completely different routes and both end up here,
because the question labels are identical either way:

 1. THE SHEET. Meta writes form submissions into a Google Sheet, the CRM polls its CSV export
    (see lead_import.py). Every non-standard column is one form question.
 2. CLICK-TO-WHATSAPP. Meta hands the answers to the LEAD, who pastes them to us as their
    first WhatsApp message - one block of "Label: value" lines opening with "Hello! I filled
    out your form...". Until this existed, the AI read that block as ordinary chatter and then
    asked for the event date the lead had typed two lines above.

On matching: labels are matched by KEYWORD SUBSTRING, not by exact string. The live form reads
"What is most important for you while choosing am Event Photography Partner" and "Choose Your
Candid & Cinematic P&V Pacakage" - with the typos. Anyone can edit a form label in Ads Manager
without telling the CRM, so an exact-match table is a table that is already wrong. Nothing is
ever dropped: a label nothing recognises is kept under a slug of its own text, so a new
question shows up in the facts rather than vanishing.

Everything here is pure: no database, no I/O, no throwing. It runs on the inbound-webhook path
where an exception loses a lead's first message, and inside a sheet poll where it must not
abandon the rest of the rows.
"""

from __future__ import annotations

import re
from typing import Any, NamedTuple


class LabelRule(NamedTuple):
    match: str
    key: str


# Label keyword -> the fact key the answer is stored under.
#
# ORDER IS LOAD-BEARING and it is a tuple, not a dict, for exactly that reason: the first
# entry whose keyword appears in the label wins, so the specific ones come first. "Event Name"
# must not be read as the lead's name, and the bare "name" fallback is deliberately last.
LABEL_RULES: tuple[LabelRule, ...] = (
    LabelRule("email", "email"),
    LabelRule("phone", "phone"),
    LabelRule("mobile", "phone"),
    LabelRule("whatsapp number", "phone"),
    LabelRule("full name", "name"),
    LabelRule("your name", "name"),
    LabelRule("event name", "event_name"),
    LabelRule("describe this event", "event_type"),
    LabelRule("kind of event", "event_type"),
    LabelRule("type of event", "event_type"),
    LabelRule("what is the event", "event_type"),
    LabelRule("occasion", "event_type"),
    LabelRule("location", "city"),
    LabelRule("area", "city"),
    LabelRule("venue", "city"),
    LabelRule("city", "city"),
    LabelRule("date", "event_date"),
    LabelRule("when", "event_date"),
    LabelRule("duration", "timing"),
    LabelRule("time", "timing"),
    LabelRule("guest", "guest_count"),
    LabelRule("package", "package_interest"),
    # The live form's own spelling. Keep it: the sheet header really is "..._pacakage".
    LabelRule("pacakage", "package_interest"),
    LabelRule("budget", "budget_range"),
    LabelRule("important for you", "what_matters"),
    LabelRule("looking for", "service_interest"),
    LabelRule("service", "service_interest"),
    LabelRule("interested in", "service_interest"),
    # Last: only when nothing more specific matched.
    LabelRule("name", "name"),
)

# Every distinct key LABEL_RULES can produce, in a stable sorted order.
LEAD_FACT_KEYS: tuple[str, ...] = tuple(sorted({rule.key for rule in LABEL_RULES}))

# The lead's own identity, which is never a qualifying fact.
CONTACT_FACT_KEYS: tuple[str, ...] = ("name", "email", "phone")

# The lead categories.
class LEAD_CATEGORIES:
    WEDDING = "wedding"
    BIRTHDAY = "birthday"
    ANNIVERSARY = "anniversary"
    CAR_DELIVERY = "car_delivery"
    HOUSE_WARMING = "house_warming"
    HALF_SAREE = "half_saree"
    EAR_PIERCING = "ear_piercing"
    SOCIAL_PRIVATE_EVENT = "social_private_event"
    SPORTS_EVENT = "sports_event"
    CORPORATE_EVENT = "corporate_event"
    PODCAST_TALKING_HEAD = "podcast_talking_head"
    FESTIVAL_EVENT = "festival_event"
    BABY_SHOWER = "baby_shower"
    REAL_ESTATE_SHOOT = "real_estate_shoot"
    INTERIOR_ARTICLE_SHOOT = "interior_article_shoot"
    PARTY_SHOOT = "party_shoot"

    # Broader groups
    EVENT_PHOTOGRAPHY = "event_photography"
    CORPORATE_COMMERCIAL = "corporate_commercial"
    ECOMMERCE_WEB = "ecommerce_web"
    MARKETING_RETAINER = "marketing_retainer"
    SOCIAL_BRANDING = "social_branding"
    SEO_SEARCH = "seo_search"


UNKNOWN_LEAD_CATEGORY = "unknown"


class CategoryHint(NamedTuple):
    match: str
    category: str


# Order is load-bearing: first match wins.
CATEGORY_HINTS: tuple[CategoryHint, ...] = (
    CategoryHint("half saree", LEAD_CATEGORIES.HALF_SAREE),
    CategoryHint("halfsaree", LEAD_CATEGORIES.HALF_SAREE),
    CategoryHint("langa voni", LEAD_CATEGORIES.HALF_SAREE),
    CategoryHint("ritu kala", LEAD_CATEGORIES.HALF_SAREE),
    CategoryHint("ear piercing", LEAD_CATEGORIES.EAR_PIERCING),
    CategoryHint("earpiercing", LEAD_CATEGORIES.EAR_PIERCING),
    CategoryHint("karnavedha", LEAD_CATEGORIES.EAR_PIERCING),
    CategoryHint("car delivery", LEAD_CATEGORIES.CAR_DELIVERY),
    CategoryHint("new car", LEAD_CATEGORIES.CAR_DELIVERY),
    CategoryHint("car handover", LEAD_CATEGORIES.CAR_DELIVERY),
    CategoryHint("house warming", LEAD_CATEGORIES.HOUSE_WARMING),
    CategoryHint("housewarming", LEAD_CATEGORIES.HOUSE_WARMING),
    CategoryHint("griha", LEAD_CATEGORIES.HOUSE_WARMING),
    CategoryHint("baby shower", LEAD_CATEGORIES.BABY_SHOWER),
    CategoryHint("babyshower", LEAD_CATEGORIES.BABY_SHOWER),
    CategoryHint("seemantham", LEAD_CATEGORIES.BABY_SHOWER),
    CategoryHint("godh bharai", LEAD_CATEGORIES.BABY_SHOWER),
    CategoryHint("maternity", LEAD_CATEGORIES.BABY_SHOWER),
    CategoryHint("real estate", LEAD_CATEGORIES.REAL_ESTATE_SHOOT),
    CategoryHint("property shoot", LEAD_CATEGORIES.REAL_ESTATE_SHOOT),
    CategoryHint("apartment shoot", LEAD_CATEGORIES.REAL_ESTATE_SHOOT),
    CategoryHint("villa shoot", LEAD_CATEGORIES.REAL_ESTATE_SHOOT),
    CategoryHint("interior", LEAD_CATEGORIES.INTERIOR_ARTICLE_SHOOT),
    CategoryHint("article shoot", LEAD_CATEGORIES.INTERIOR_ARTICLE_SHOOT),
    CategoryHint("furniture", LEAD_CATEGORIES.INTERIOR_ARTICLE_SHOOT),
    CategoryHint("podcast", LEAD_CATEGORIES.PODCAST_TALKING_HEAD),
    CategoryHint("talking head", LEAD_CATEGORIES.PODCAST_TALKING_HEAD),
    CategoryHint("corporate event", LEAD_CATEGORIES.CORPORATE_EVENT),
    CategoryHint("conference", LEAD_CATEGORIES.CORPORATE_EVENT),
    CategoryHint("annual day", LEAD_CATEGORIES.CORPORATE_EVENT),
    CategoryHint("agm", LEAD_CATEGORIES.CORPORATE_EVENT),
    CategoryHint("product launch", LEAD_CATEGORIES.CORPORATE_EVENT),
    CategoryHint("award", LEAD_CATEGORIES.CORPORATE_EVENT),
    CategoryHint("offsite", LEAD_CATEGORIES.CORPORATE_EVENT),
    CategoryHint("sports", LEAD_CATEGORIES.SPORTS_EVENT),
    CategoryHint("tournament", LEAD_CATEGORIES.SPORTS_EVENT),
    CategoryHint("marathon", LEAD_CATEGORIES.SPORTS_EVENT),
    CategoryHint("match day", LEAD_CATEGORIES.SPORTS_EVENT),
    CategoryHint("festival", LEAD_CATEGORIES.FESTIVAL_EVENT),
    CategoryHint("ganesh", LEAD_CATEGORIES.FESTIVAL_EVENT),
    CategoryHint("navratri", LEAD_CATEGORIES.FESTIVAL_EVENT),
    CategoryHint("dussehra", LEAD_CATEGORIES.FESTIVAL_EVENT),
    CategoryHint("diwali", LEAD_CATEGORIES.FESTIVAL_EVENT),
    CategoryHint("christmas", LEAD_CATEGORIES.FESTIVAL_EVENT),
    CategoryHint("anniversary", LEAD_CATEGORIES.ANNIVERSARY),
    CategoryHint("birthday", LEAD_CATEGORIES.BIRTHDAY),
    CategoryHint("bday", LEAD_CATEGORIES.BIRTHDAY),
    CategoryHint("get together", LEAD_CATEGORIES.SOCIAL_PRIVATE_EVENT),
    CategoryHint("farewell", LEAD_CATEGORIES.SOCIAL_PRIVATE_EVENT),
    CategoryHint("reunion", LEAD_CATEGORIES.SOCIAL_PRIVATE_EVENT),
    CategoryHint("private event", LEAD_CATEGORIES.SOCIAL_PRIVATE_EVENT),
    CategoryHint("wedding", LEAD_CATEGORIES.WEDDING),
    CategoryHint("shaadi", LEAD_CATEGORIES.WEDDING),
    CategoryHint("marriage", LEAD_CATEGORIES.WEDDING),
    CategoryHint("engagement", LEAD_CATEGORIES.WEDDING),
    CategoryHint("reception", LEAD_CATEGORIES.WEDDING),
    CategoryHint("haldi", LEAD_CATEGORIES.WEDDING),
    CategoryHint("mehendi", LEAD_CATEGORIES.WEDDING),
    CategoryHint("mehndi", LEAD_CATEGORIES.WEDDING),
    CategoryHint("sangeet", LEAD_CATEGORIES.WEDDING),
    CategoryHint("party", LEAD_CATEGORIES.PARTY_SHOOT),
    CategoryHint("club night", LEAD_CATEGORIES.PARTY_SHOOT),
    CategoryHint("new year", LEAD_CATEGORIES.PARTY_SHOOT),
    CategoryHint("commercial", LEAD_CATEGORIES.CORPORATE_COMMERCIAL),
    CategoryHint("corporate", LEAD_CATEGORIES.CORPORATE_COMMERCIAL),
    CategoryHint("product shoot", LEAD_CATEGORIES.CORPORATE_COMMERCIAL),
    CategoryHint("e-commerce", LEAD_CATEGORIES.ECOMMERCE_WEB),
    CategoryHint("ecommerce", LEAD_CATEGORIES.ECOMMERCE_WEB),
    CategoryHint("website", LEAD_CATEGORIES.ECOMMERCE_WEB),
    CategoryHint("web design", LEAD_CATEGORIES.ECOMMERCE_WEB),
    CategoryHint("seo", LEAD_CATEGORIES.SEO_SEARCH),
    CategoryHint("search engine", LEAD_CATEGORIES.SEO_SEARCH),
    CategoryHint("social media", LEAD_CATEGORIES.MARKETING_RETAINER),
    CategoryHint("advertis", LEAD_CATEGORIES.MARKETING_RETAINER),
    CategoryHint("marketing", LEAD_CATEGORIES.MARKETING_RETAINER),
    CategoryHint("influencer", LEAD_CATEGORIES.MARKETING_RETAINER),
    CategoryHint("logo", LEAD_CATEGORIES.SOCIAL_BRANDING),
    CategoryHint("branding", LEAD_CATEGORIES.SOCIAL_BRANDING),
    CategoryHint("naming", LEAD_CATEGORIES.EVENT_PHOTOGRAPHY),
    CategoryHint("event", LEAD_CATEGORIES.EVENT_PHOTOGRAPHY),
    CategoryHint("photograph", LEAD_CATEGORIES.EVENT_PHOTOGRAPHY),
    CategoryHint("videograph", LEAD_CATEGORIES.EVENT_PHOTOGRAPHY),
)

FORM_PREAMBLE_HINTS: tuple[str, ...] = (
    "filled out your form",
    "filled your form",
    "i filled out",
)

LABELLED_LINE = re.compile(r"^\s*([^:\n]{2,80}?)\s*:\s*(.+?)\s*$")
MIN_LABELLED_LINES = 3
BLANK_VALUES = frozenset({"", "-", "--", "?", "n/a", "na", "none", "null"})

UNDECIDED_ANSWER_HINTS: tuple[str, ...] = (
    "not decided",
    "not yet decided",
    "undecided",
    "not finalized",
    "not finalised",
    "not fixed",
    "not confirmed",
    "not sure",
    "no idea",
    "dont know",
    "to be decided",
    "to be confirmed",
    "tbd",
    "tba",
    "decide nahi",
    "decided nahi",
    "nahi pata",
    "pata nahi",
    "nahi decide",
    "fix nahi",
    "abhi nahi",
)

URL_SCHEME_LABELS = frozenset({"http", "https", "ftp", "www"})
MIN_LABEL_LETTERS = 3
MAX_FACTS = 60
MAX_FACT_VALUE_LENGTH = 1000
MAX_SLUG_LENGTH = 60


def is_blank_answer(value: Any) -> bool:
    """Whether the lead wrote effectively nothing in this field."""
    return str(value if value is not None else "").strip().lower() in BLANK_VALUES


def normalize_answer(value: Any) -> str:
    """Lowercased, curly quotes stripped, non-alphanumeric collapsed to spaces, trimmed."""
    raw = str(value if value is not None else "").lower()
    raw = re.sub(r"[\u2018\u2019']", "", raw)
    raw = re.sub(r"[^a-z0-9]+", " ", raw)
    return raw.strip()


def is_unanswered_value(value: Any) -> bool:
    """True when an answer carries no usable information (blank or undecided)."""
    if is_blank_answer(value):
        return True
    normalized = normalize_answer(value)
    if not normalized:
        return True
    return any(hint in normalized for hint in UNDECIDED_ANSWER_HINTS)


def count_letters(value: str) -> int:
    return len(re.findall(r"[A-Za-z]", value))


def slugify_label(label: str) -> str:
    """
    A label with no rule keeps its own text as the key:
    `How would you describe this event?` -> `how_would_you_describe_this_event`.
    """
    slug = (
        re.sub(r"[^a-z0-9]+", "_", str(label or "").strip().lower())
        .strip("_")[:MAX_SLUG_LENGTH]
        .rstrip("_")
    )
    return "field" if not slug else slug


def key_for_label(label: str) -> str | None:
    """Canonical fact key for a form label, or None when no rule matches."""
    normalized = re.sub(r"[_-]", " ", str(label or "").lower())
    normalized = re.sub(r"\s+", " ", normalized).strip()
    if not normalized:
        return None
    for rule in LABEL_RULES:
        if rule.match in normalized:
            return rule.key
    return None


class FormFieldEntry(NamedTuple):
    label: str
    value: str


class ParsedFormFields(NamedTuple):
    facts: dict[str, str]
    unmapped: dict[str, str]


def truncate_value(value: str) -> str:
    return value[:MAX_FACT_VALUE_LENGTH] if len(value) > MAX_FACT_VALUE_LENGTH else value


def parse_form_fields(
    entries: list[FormFieldEntry] | None,
    overrides: dict[str, str | None] | None = None,
) -> ParsedFormFields:
    """
    Form answers -> canonical facts + everything else.
    Explicit overrides win over LABEL_RULES. None in overrides means drop the field.
    """
    facts: dict[str, str] = {}
    unmapped: dict[str, str] = {}
    overrides_dict = overrides or {}

    def is_full() -> bool:
        return len(facts) + len(unmapped) >= MAX_FACTS

    def keep_unmapped(label: str, value: str) -> None:
        slug = slugify_label(label)
        if slug not in unmapped and not is_full():
            unmapped[slug] = value

    if not entries:
        return ParsedFormFields(facts, unmapped)

    for entry in entries:
        try:
            label = str(getattr(entry, "label", "") or "").strip()
            raw_value = str(getattr(entry, "value", "") or "").strip()

            if is_blank_answer(raw_value):
                continue

            if any(hint in label.lower() for hint in FORM_PREAMBLE_HINTS):
                continue

            if label.lower() in URL_SCHEME_LABELS:
                continue

            if count_letters(label) < MIN_LABEL_LETTERS:
                continue

            overridden = label in overrides_dict
            key = overrides_dict[label] if overridden else key_for_label(label)

            if overridden and key is None:
                continue

            if key is None:
                keep_unmapped(label, truncate_value(raw_value))
                continue

            value = truncate_value(
                re.sub(r"\D", "", raw_value) if key == "phone" else raw_value
            )
            if not value:
                continue

            if key not in facts:
                if not is_full():
                    facts[key] = value
                continue

            if facts[key] != value:
                keep_unmapped(label, value)
        except Exception:
            continue

    return ParsedFormFields(facts, unmapped)


def derive_facts(facts: dict[str, str]) -> dict[str, str]:
    """Answers that already contain a later question's answer (e.g. photo vs video)."""
    derived = dict(facts or {})
    try:
        blob = " ".join(str(v or "").lower() for v in derived.values())
        if "photo_or_video" not in derived:
            photo = "photograph" in blob or "photo" in blob
            video = "videograph" in blob or "cinematic" in blob or "video" in blob

            if "only photography" in blob or "photography only" in blob:
                derived["photo_or_video"] = "photography only"
            elif photo and video:
                derived["photo_or_video"] = "photo and video"
            elif photo:
                derived["photo_or_video"] = "photography"
            elif video:
                derived["photo_or_video"] = "videography"
    except Exception:
        pass
    return derived


def classify_category(facts: dict[str, str]) -> str:
    """Best guess at service group from all facts."""
    try:
        blob = " ".join(str(v or "").lower() for v in (facts or {}).values())
        for hint in CATEGORY_HINTS:
            if hint.match in blob:
                return hint.category
        return UNKNOWN_LEAD_CATEGORY
    except Exception:
        return UNKNOWN_LEAD_CATEGORY


def looks_like_form(text: str | None) -> bool:
    """Checks whether a message is a pasted lead form rather than a conversational greeting."""
    if not text:
        return False
    try:
        lower = text.lower()
        if any(hint in lower for hint in FORM_PREAMBLE_HINTS):
            return True
        labelled_lines = [
            line for line in text.splitlines() if LABELLED_LINE.match(line)
        ]
        return len(labelled_lines) >= MIN_LABELLED_LINES
    except Exception:
        return False


def split_pasted_form_entries(text: str | None) -> list[FormFieldEntry]:
    """Label: value lines of a pasted form."""
    if not text:
        return []
    entries: list[FormFieldEntry] = []
    try:
        for line in text.splitlines():
            m = LABELLED_LINE.match(line)
            if m:
                entries.append(FormFieldEntry(m.group(1).strip(), m.group(2).strip()))
    except Exception:
        pass
    return entries


def parse_pasted_form(text: str | None) -> ParsedFormFields:
    return parse_form_fields(split_pasted_form_entries(text))


def omit_contact_facts(facts: dict[str, str]) -> dict[str, str]:
    """Strip personal identity fields (name, email, phone) from AI context per ADR-005."""
    return {k: v for k, v in (facts or {}).items() if k not in CONTACT_FACT_KEYS}


class LeadFormFacts(NamedTuple):
    facts: dict[str, str]
    category: str


def build_lead_form_facts(parsed: ParsedFormFields) -> LeadFormFacts:
    """Merge unmapped and facts, strip contact identity, derive facts, and classify category."""
    merged = {**parsed.unmapped, **parsed.facts}
    omitted = omit_contact_facts(merged)
    with_derived = derive_facts(omitted)
    category = classify_category(with_derived)
    return LeadFormFacts(facts=with_derived, category=category)

