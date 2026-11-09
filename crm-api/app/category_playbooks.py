"""
AI category playbooks and selectable categories.

A PORT OF backend/src/modules/ai-brain/category-playbooks.ts.

Derived from CATEGORY_PLAYBOOKS so any playbook added is immediately selectable
in the conversation category picker without a second edit.
"""

from typing import Any

# The 23 categorized playbooks matching Node's CATEGORY_PLAYBOOKS keys.
CATEGORY_PLAYBOOKS: dict[str, dict[str, Any]] = {
    "anniversary": {
        "requiredFields": ["event_date", "city", "timing", "photo_or_video"],
        "brief": "Anniversary celebration shoot. Confirm date, city, timing and whether they need photo, video or both.",
    },
    "baby_shower": {
        "requiredFields": ["event_date", "city", "timing", "photo_or_video"],
        "brief": "Baby shower or seemantham ceremony. Capture family portraits and ritual coverage.",
    },
    "birthday": {
        "requiredFields": ["event_date", "city", "timing", "photo_or_video", "guest_count"],
        "brief": "Birthday party shoot. Ask for event date, city, timing, photo/video requirements, and approximate guest count.",
    },
    "car_delivery": {
        "requiredFields": ["event_date", "city", "timing", "photo_or_video"],
        "brief": "Car or vehicle delivery celebration shoot.",
    },
    "corporate_commercial": {
        "requiredFields": ["shoot_type", "shoot_date", "city", "deliverables_needed"],
        "brief": "Corporate commercial shoot. Needs details on the subject, date, location and required deliverables.",
    },
    "corporate_event": {
        "requiredFields": ["event_date", "city", "timing", "photo_or_video", "guest_count"],
        "brief": "Corporate seminar, gala, conference or annual day.",
    },
    "ear_piercing": {
        "requiredFields": ["event_date", "city", "timing", "photo_or_video"],
        "brief": "Traditional ear piercing ceremony.",
    },
    "ecommerce_web": {
        "requiredFields": ["deliverables_needed", "city", "timing"],
        "brief": "E-commerce product catalog or website photography.",
    },
    "event_photography": {
        "requiredFields": ["event_date", "city", "timing", "photo_or_video"],
        "brief": "General event photography and videography fallback.",
    },
    "festival_event": {
        "requiredFields": ["event_date", "city", "timing", "photo_or_video"],
        "brief": "Religious, community or cultural festival event.",
    },
    "half_saree": {
        "requiredFields": ["event_date", "city", "timing", "photo_or_video"],
        "brief": "Half saree / Ritu Kala ceremony shoot.",
    },
    "house_warming": {
        "requiredFields": ["event_date", "city", "timing", "photo_or_video"],
        "brief": "House warming or griha pravesh ceremony.",
    },
    "interior_article_shoot": {
        "requiredFields": ["shoot_type", "shoot_date", "city", "deliverables_needed"],
        "brief": "Interior design, architectural or magazine editorial shoot.",
    },
    "marketing_retainer": {
        "requiredFields": ["deliverables_needed", "city", "timing"],
        "brief": "Monthly marketing content retainer.",
    },
    "party_shoot": {
        "requiredFields": ["event_date", "city", "timing", "photo_or_video", "guest_count"],
        "brief": "Private party, cocktail dinner, or reunion shoot.",
    },
    "podcast_talking_head": {
        "requiredFields": ["shoot_type", "shoot_date", "city", "deliverables_needed"],
        "brief": "Podcast studio recording, interview or talking head video.",
    },
    "real_estate_shoot": {
        "requiredFields": ["shoot_type", "shoot_date", "city", "deliverables_needed"],
        "brief": "Real estate property walkthrough, drone shots and architectural photos.",
    },
    "seo_search": {
        "requiredFields": ["deliverables_needed", "city"],
        "brief": "SEO and digital presence marketing.",
    },
    "social_branding": {
        "requiredFields": ["deliverables_needed", "city"],
        "brief": "Social media personal branding and influencer content shoot.",
    },
    "social_private_event": {
        "requiredFields": ["event_date", "city", "timing", "photo_or_video"],
        "brief": "Private social event or get-together.",
    },
    "sports_event": {
        "requiredFields": ["event_date", "city", "timing", "photo_or_video"],
        "brief": "Sports tournament, marathon, or athletic meet.",
    },
    "unknown": {
        "requiredFields": ["event_date", "city", "photo_or_video"],
        "brief": "Generic fallback playbook when service is not yet known.",
    },
    "wedding": {
        "requiredFields": ["event_date", "city", "timing", "photo_or_video", "guest_count"],
        "brief": "Wedding celebration, engagement, or reception shoot.",
    },
}

SELECTABLE_AI_CATEGORIES: list[str] = sorted(CATEGORY_PLAYBOOKS.keys())


def playbook_for_category(category: str) -> dict[str, Any]:
    return CATEGORY_PLAYBOOKS.get(category, CATEGORY_PLAYBOOKS["unknown"])


def required_fields_for_category(category: str) -> list[str]:
    return list(playbook_for_category(category)["requiredFields"])


def service_brief_for_category(category: str) -> str:
    return str(playbook_for_category(category)["brief"])


