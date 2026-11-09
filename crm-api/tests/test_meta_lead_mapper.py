"""
Tests for app/meta_lead_mapper.py matching Node's meta-graph-lead.mapper.test.ts and meta-phone-mapping.test.ts.
"""

from app.meta_lead_mapper import (
    DEFAULT_LEAD_DISPLAY_NAME,
    map_meta_graph_lead,
    map_meta_lead_row,
    meta_graph_lead_to_row,
    prettify_label,
    prettify_value,
    strip_meta_prefix,
)


def test_strip_meta_prefix():
    assert strip_meta_prefix("l:123456789") == "123456789"
    assert strip_meta_prefix("p:+919876543210") == "+919876543210"
    assert strip_meta_prefix("c:campaign_123") == "campaign_123"
    assert strip_meta_prefix("Time: 5pm") == "Time: 5pm"


def test_prettify_label_and_value():
    assert prettify_label("how_would_you_describe_this_event?") == "How would you describe this event?"
    assert prettify_value("premium_wedding_shoot_2-3_days") == "premium wedding shoot 2-3 days"
    assert prettify_value("already has spaces") == "already has spaces"


def test_map_meta_lead_row():
    row = {
        "id": "l:998877",
        "created_time": "2026-05-15T10:00:00Z",
        "full_name": "Deepak Kumar",
        "phone_number": "p:+91 98765-43210",
        "email": "deepak@example.com",
        "campaign_name": "Summer Weddings",
        "how_would_you_describe_this_event?": "Wedding Reception",
        "approx_number_of_guest": "350",
    }
    lead = map_meta_lead_row(row)
    assert lead.external_id == "998877"
    assert lead.display_name == "Deepak Kumar"
    assert lead.phone == "+91 98765-43210"
    assert lead.email == "deepak@example.com"
    assert lead.campaign_name == "Summer Weddings"
    assert lead.canonical_facts.get("event_type") == "Wedding Reception"
    assert lead.canonical_facts.get("guest_count") == "350"
    assert lead.category == "wedding"


def test_phone_header_aliases():
    row = {
        "id": "112233",
        "full_name": "Test User",
        "whatsapp_number": "+919111122222",
    }
    lead = map_meta_lead_row(row)
    assert lead.phone == "+919111122222"


def test_meta_graph_lead_to_row_and_map():
    graph_lead = {
        "id": "999000",
        "created_time": "2026-06-01T12:00:00Z",
        "form_id": "form_123",
        "is_organic": False,
        "platform": "fb",
        "field_data": [
            {"name": "full_name", "values": ["Ananya Rao"]},
            {"name": "phone_number", "values": ["+91 98989-12345"]},
            {"name": "email", "values": ["ananya@example.com"]},
            {"name": "describe_this_event", "values": ["Half Saree ceremony"]},
        ],
    }
    lead = map_meta_graph_lead(graph_lead, form_name="Festival Form")
    assert lead.external_id == "999000"
    assert lead.display_name == "Ananya Rao"
    assert lead.phone == "+91 98989-12345"
    assert lead.form_name == "Festival Form"
    assert lead.category == "half_saree"
    assert lead.is_organic is False
    assert lead.platform == "fb"

