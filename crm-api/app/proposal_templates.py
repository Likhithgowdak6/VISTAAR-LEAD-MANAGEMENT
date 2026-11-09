"""
DOCX proposal templates for category-driven rendering.

PORTED FROM backend/src/modules/ai-brain/proposal-templates.ts.

Maps business category to one of the bundled proposal template .docx files in templates/proposals/.
"""

from __future__ import annotations

import base64
from pathlib import Path

# Template directory resolution relative to project root
_ROOT_DIR = Path(__file__).resolve().parent.parent.parent
TEMPLATES_DIR = _ROOT_DIR / "backend" / "templates" / "proposals"

TEMPLATE_FILES: dict[str, str] = {
    # Family occasions
    "wedding": "proposal_wedding.docx",
    "birthday": "proposal_wedding.docx",
    "anniversary": "proposal_wedding.docx",
    "car_delivery": "proposal_wedding.docx",
    "house_warming": "proposal_wedding.docx",
    "half_saree": "proposal_wedding.docx",
    "ear_piercing": "proposal_wedding.docx",
    "social_private_event": "proposal_wedding.docx",
    "festival_event": "proposal_wedding.docx",
    "baby_shower": "proposal_wedding.docx",
    "party_shoot": "proposal_wedding.docx",
    "event_photography": "proposal_wedding.docx",
    # Commissioned by a business
    "sports_event": "proposal_generic.docx",
    "corporate_event": "proposal_generic.docx",
    "podcast_talking_head": "proposal_generic.docx",
    "real_estate_shoot": "proposal_generic.docx",
    "interior_article_shoot": "proposal_generic.docx",
    "corporate_commercial": "proposal_generic.docx",
    "seo_search": "proposal_generic.docx",
    # Specialist service lines
    "ecommerce_web": "proposal_ecommerce.docx",
    "marketing_retainer": "proposal_retainer.docx",
    "social_branding": "proposal_branding.docx",
    "unknown": "proposal_generic.docx",
}

DEFAULT_TEMPLATE_FILE = TEMPLATE_FILES["unknown"]


def template_file_for_category(category: str) -> str:
    """Returns the .docx template filename for a given aiCategory."""
    return TEMPLATE_FILES.get(category, DEFAULT_TEMPLATE_FILE)


def load_template_base64_for_category(category: str) -> str:
    """Reads the .docx template for category and returns it base64-encoded."""
    filename = template_file_for_category(category)
    template_path = TEMPLATES_DIR / filename
    if not template_path.exists():
        # Fallback to default
        template_path = TEMPLATES_DIR / DEFAULT_TEMPLATE_FILE

    content_bytes = template_path.read_bytes()
    return base64.b64encode(content_bytes).decode("ascii")

