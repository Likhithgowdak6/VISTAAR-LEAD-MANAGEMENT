"""
The AI's opening message to an imported lead from ad forms or manual creation.

A DIRECT PORT OF backend/src/modules/ai-brain/imported-lead-greeting.service.ts.
Provides:
  - build_greeting_directive
  - greet_imported_lead
"""

from __future__ import annotations

from typing import Any, Literal, Optional

GreetingOrigin = Literal["form", "manual", "form_call_scheduling"]

GREETING_SIGNATURE = ["Himanshu", "Creative Director/Cinematographer"]


def opening_message_layout() -> list[str]:
    return [
        'LAYOUT - this message only, and it OVERRIDES the usual "one short paragraph" rule:',
        "write it as SHORT LINES SEPARATED BY BLANK LINES, not as a single block of prose.",
        "Roughly: a one-line greeting with their name; then one line saying what they enquired",
        "about and when, where you actually know it; then one or two short lines on what we care",
        "about for an occasion like theirs; then the ask; then the sign-off.",
        "Up to about 90 words total - longer than a normal reply, because it is doing more.",
        "Still no bullet points, no headings and no bold - blank lines are the only structure.",
        "At most one emoji, in the greeting line if anywhere.",
        f'Sign off on its own lines, exactly: "{"\", then \"".join(GREETING_SIGNATURE)}".',
        "Vary the wording every time. The shape is fixed; the sentences are yours.",
    ]


def do_not_infer_the_service_from_the_form_name(source_label: str) -> list[str]:
    return [
        "YOU DO NOT KNOW WHAT THEY WANT. The form is called",
        f'"{source_label}", and that is OUR name for it, not something they told us -',
        "it is not evidence of their occasion and you must not infer one from it.",
        'Do not call it "the wedding form" or name any service they did not ask for.',
        "Acknowledge the enquiry in neutral terms, say briefly what we do, and ASK what",
        "they are looking for. Keep the warmth general rather than about \"the day\".",
        "The same goes for any package or product name you have been given: that is OUR catalogue",
        "wording, it may name an occasion or a price, and it is not what they told you they want.",
    ]


def build_greeting_directive(
    *,
    source_label: str,
    category: Optional[str] = None,
    origin: GreetingOrigin = "form",
    origin_note: Optional[str] = None,
) -> str:
    has_verified_service = bool(category and category != "unknown")

    if has_verified_service:
        clean_cat = category.replace("_", " ")  # type: ignore[union-attr]
        about = (
            f"They enquired about {clean_cat}. "
            "THAT IS THE OCCASION AND IT IS SETTLED: it came from what they themselves selected. "
            "Do not call it anything else, and do not let any other wording you have been given "
            "override it - a package or product name is OUR catalogue's wording and may well mention "
            "a different occasion, a price or a tier. It describes what we sell, never what they are "
            f'celebrating. If anything you have contradicts "{clean_cat}", the '
            "contradiction is ours to ignore, not theirs to be corrected about."
        )
    else:
        about = "They did not say which service."

    if origin == "manual":
        context = (
            f'How we know them, in the owner\'s own words: "{origin_note.strip()}". Work that into your first line so they can place us.'
            if origin_note and origin_note.strip()
            else "You do NOT know how we got their number. Do not invent a reason, do not mention a form, an ad or an enquiry, and do not imply they contacted us. Just open with who we are and what they need."
        )
        return " ".join([
            "This is your FIRST message to this person and they have never messaged us.",
            f"{about} {context}",
            "They did NOT fill in a form - never say or imply that they did.",
            "WRITE AS THE STUDIO ITSELF, IN THE FIRST PERSON. Never mention the owner by name or",
            "by title, never say anyone asked or told you to make contact, and never present yourself",
            "as passing on someone else's message. There is no third party in this conversation.",
            "Then follow the normal opening: confirm we do the thing they need,",
            "and ask your opening questions. Keep it short and do not apologise for messaging them.",
        ])

    if origin == "form_call_scheduling":
        parts = [
            "This is your FIRST message to this person and they have never messaged us.",
            f'They filled in our "{source_label}" enquiry form. {about}',
            "Open by referring to the form so they instantly recognise why we are messaging -",
            "they filled it in on an ad and may not remember the studio name.",
            "Use their name if you have it; if you do not, greet them without one rather than",
            "leaving a gap. Mention their occasion and date ONLY where you actually have them -",
            "never guess either, and do not repeat the occasion more than once.",
        ]
        if not has_verified_service:
            parts.extend(do_not_infer_the_service_from_the_form_name(source_label))
        parts.extend([
            "Convey, IN YOUR OWN WORDS AND DIFFERENTLY EACH TIME, that what matters to us is not just",
            "covering the event but capturing the people, the feeling and the small moments they will",
            "want back later. Do not reuse a stock sentence for this - say it the way it fits THIS",
            "person's occasion.",
            "Then ask, naturally, whether they have a time today for a short call.",
            "ONE clear ask: the call. Do not also ask your usual qualifying questions in this message.",
            "No prices, no packages, no availability, no deliverables, no discounts and no urgency -",
            "you have been given none of those and must not imply any.",
            "That holds even if the form answers mention a package or a budget - acknowledge the",
            "enquiry without repeating any figure back at them.",
            "Warm and human, and do not apologise for messaging them.",
            *opening_message_layout(),
        ])
        return " ".join(parts)

    parts = [
        "This is your FIRST message to this person and they have never messaged us.",
        f'They filled in our "{source_label}" enquiry form. {about}',
        "Open by referring to the form so they instantly recognise why we are messaging -",
        "they filled it in on an ad and may not remember the studio name.",
    ]
    if has_verified_service:
        parts.append("Then follow the normal opening: say what we do, confirm we do the thing they asked about,")
    else:
        parts.extend(do_not_infer_the_service_from_the_form_name(source_label))
        parts.append("Then follow the normal opening: say what we do,")
    parts.append("and ask your opening questions. Keep it short and do not apologise for messaging them.")
    return " ".join(parts)


async def greet_imported_lead(
    *,
    organization_id: Any,
    conversation: dict[str, Any],
    source_label: str,
    category: Optional[str] = None,
    origin: GreetingOrigin = "form",
    origin_note: Optional[str] = None,
) -> None:
    """Dispatches first greeting turn through handle_inbound_message_for_automation."""
    from app.ai_brain_service import handle_inbound_message_for_automation

    directive = build_greeting_directive(
        source_label=source_label,
        category=category,
        origin=origin,
        origin_note=origin_note,
    )
    conv_id = str(conversation.get("_id"))
    await handle_inbound_message_for_automation(
        organization_id=organization_id,
        conversation=conversation,
        inbound_message_id=f"auto-greet:{conv_id}",
        inbound_text="",
        owner_instruction=directive,
    )

