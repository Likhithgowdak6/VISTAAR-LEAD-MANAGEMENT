"""
Proposal generation - ported from vistaar-agent's app/services/proposals.py.

What changed: no Postgres Proposal/Lead rows, no Celery follow-up
scheduling, no direct WhatsApp/email delivery. This module's job stops at
"here is the proposal content, and here is the rendered file" - wam-crm-ai
owns the proposal record, the version history, and actually sending it.

What's unchanged: the JSON -> docx (docxtpl) -> pdf (LibreOffice) pipeline
and the prompts. Bring your own .docx template - the five templates in
vistaar-agent's templates/ folder still work with this unmodified, because
this only reads {{ }} placeholders, same as before.
"""

import json
import logging
import os
import shutil
import subprocess
import tempfile
from datetime import datetime, timezone

from docxtpl import DocxTemplate

from app import prompts
from app.llm import complete_json

log = logging.getLogger(__name__)

PROPOSAL_SCHEMA = """{
  "title": "Proposal title",
  "client_name": "...",
  "intro": "2-3 sentence opening paragraph, finished prose",
  "understanding": "what we understood about their need, one paragraph",
  "approach": "how we'll do it, one paragraph",
  "sections": [
    {"heading": "...", "body": "finished prose paragraph"}
  ],
  "deliverables": ["item", "item"],
  "timeline": [{"phase": "Discovery", "duration": "1 week", "detail": "..."}],
  "pricing": [{"item": "...", "amount": 150000, "note": "..."}],
  "total_amount": 150000,
  "terms": ["50% advance", "..."],
  "next_step": "one sentence call to action"
}"""

LIBREOFFICE_AVAILABLE = shutil.which("libreoffice") is not None


def generate(category: str, facts: dict, transcript: list, pricing_json: str, client_name: str = "") -> dict:
    """Facts + rate card + transcript -> proposal content as JSON. Doesn't render."""
    transcript_text = "\n".join(
        f"{'Lead' if r.get('role') == 'lead' else 'Us'}: {r.get('text', '')}"
        for r in transcript[-40:]
    )
    content = complete_json(
        system=prompts.PROPOSAL_SYSTEM.format(
            facts=json.dumps(facts or {}, ensure_ascii=False),
            pricing=pricing_json,
            transcript=transcript_text,
        ),
        user=f"Write the proposal for {client_name or 'this client'}.",
        schema_hint=PROPOSAL_SCHEMA,
        max_tokens=4000,
    )
    content.setdefault("client_name", client_name)
    return content


def revise(current_content: dict, instruction: str) -> dict:
    """Owner said 'change X'. Returns the whole updated JSON."""
    return complete_json(
        system=prompts.PROPOSAL_EDIT_SYSTEM.format(
            proposal_json=json.dumps(current_content, ensure_ascii=False),
            instruction=instruction,
        ),
        user="Return the updated proposal JSON.",
        schema_hint=PROPOSAL_SCHEMA,
        max_tokens=4000,
        temperature=0.3,
    )


def render(content: dict, template_bytes: bytes, version: int = 1) -> dict:
    """
    JSON + a .docx template -> rendered docx bytes, and pdf bytes if
    LibreOffice is available in this environment. Returns
    {"docx": bytes, "pdf": bytes | None}.
    """
    content = dict(content)

    pricing = []
    for row in content.get("pricing") or []:
        amount = float(row.get("amount") or 0)
        pricing.append({**row, "amount": amount, "amount_fmt": f"{amount:,.0f}"})
    content["pricing"] = pricing
    total = float(content.get("total_amount") or sum(r["amount"] for r in pricing) if pricing else 0)
    content["total_amount"] = total
    content["total_fmt"] = f"{total:,.0f}"

    for key, default in (
        ("title", "Proposal"), ("intro", ""), ("understanding", ""),
        ("approach", ""), ("next_step", ""),
    ):
        content.setdefault(key, default)
    for key in ("sections", "deliverables", "timeline", "terms"):
        content.setdefault(key, [])

    with tempfile.TemporaryDirectory() as tmp:
        template_path = os.path.join(tmp, "template.docx")
        with open(template_path, "wb") as f:
            f.write(template_bytes)

        doc = DocxTemplate(template_path)
        doc.render({
            **content,
            "generated_on": datetime.now(timezone.utc).strftime("%d %B %Y"),
            "version": version,
        })
        docx_path = os.path.join(tmp, "proposal.docx")
        doc.save(docx_path)

        with open(docx_path, "rb") as f:
            docx_bytes = f.read()

        pdf_bytes = None
        if LIBREOFFICE_AVAILABLE:
            try:
                subprocess.run(
                    ["libreoffice", "--headless", "--norestore",
                     "--convert-to", "pdf", "--outdir", tmp, docx_path],
                    check=True, timeout=180,
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                )
                pdf_path = os.path.join(tmp, "proposal.pdf")
                if os.path.exists(pdf_path):
                    with open(pdf_path, "rb") as f:
                        pdf_bytes = f.read()
            except Exception:
                log.exception("docx-to-pdf conversion failed")

        return {"docx": docx_bytes, "pdf": pdf_bytes}
