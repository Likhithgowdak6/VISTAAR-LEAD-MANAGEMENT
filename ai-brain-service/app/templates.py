"""
Writes the owner's prices up as four sendable WhatsApp messages.

He knows what he charges and says it the way he'd say it out loud - "300
photos 45k, video 85k, we'll edit it and make a reel". Forwarding that to
someone deciding between studios is where the job gets lost, and writing it up
nicely four times over is exactly the work he does not have time for.

Four PRESENTATIONS, one offer. The prices, inclusions and counts are his and
come back unchanged; only the framing differs. That constraint is the feature,
not a limitation of it: a variant that invented a package to round out a
comparison, or added "offer valid this week" to create urgency, would be a
false promise sent to a paying customer with his name on it.

Mirrors summary.py and knowledge.py: one pure function, no state, no database,
no sending. wam-crm-ai stores whichever one he picks and does the sending.
"""

from app import prompts
from app.llm import complete_json

TEMPLATE_COUNT = 4

TEMPLATES_SCHEMA = """{
  "templates": [
    {
      "title": "under 40 chars - the style, not the price",
      "body": "the WhatsApp message, ready to send"
    }
  ]
}"""


def _text(value) -> str:
    return value.strip() if isinstance(value, str) else ""


def _rejected_block(rejected: list[str] | None) -> str:
    """
    The bodies he already turned down, so a regenerate is genuinely different.

    Without this, "regenerate" reliably returns the same four ideas with the
    sentences shuffled, which reads as the button not working.
    """
    lines = [_text(item) for item in (rejected or [])]
    lines = [line for line in lines if line]

    if not lines:
        return ""

    return prompts.PRICE_TEMPLATE_AVOID.format(
        rejected="\n\n".join(f"---\n{line}" for line in lines[-8:])
    )


def generate(raw_details: str, rejected: list[str] | None = None) -> list[dict]:
    """
    Returns four {title, body} dicts for the owner to choose between.

    `rejected` carries the bodies from an earlier round when he asks for
    another four. Capped inside _rejected_block: after a couple of rounds the
    list is long enough to crowd out the prices themselves, and the last
    handful is what "different from what I just saw" actually means.
    """
    details = _text(raw_details)
    if not details:
        raise ValueError("nothing to price")

    system = prompts.PRICE_TEMPLATE_SYSTEM.format(
        raw_details=details,
        avoid_block=_rejected_block(rejected),
    )

    result = complete_json(
        system=system,
        user=f"Write the {TEMPLATE_COUNT} versions now.",
        schema_hint=TEMPLATES_SCHEMA,
        max_tokens=2000,
        # Higher than the other calls here: four versions that read the same
        # is the failure mode, and this is the one place variety is the point.
        # Still not high - the prices must survive intact.
        temperature=0.7,
    )

    raw = result.get("templates")
    templates: list[dict] = []

    if isinstance(raw, list):
        for index, item in enumerate(raw):
            if not isinstance(item, dict):
                continue

            body = _text(item.get("body"))
            if not body:
                continue

            templates.append(
                {
                    "title": _text(item.get("title"))[:40] or f"Version {index + 1}",
                    "body": body,
                }
            )

    if not templates:
        raise RuntimeError("the model returned no usable templates")

    # Fewer than four is worth returning rather than failing: three good ways of
    # putting it is still a choice, and the owner can regenerate for more.
    return templates[:TEMPLATE_COUNT]
