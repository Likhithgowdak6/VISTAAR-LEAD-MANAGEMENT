"""
The ai-brain service's HTTP API.

This is the whole surface wam-crm-ai talks to. Nothing else about this
service is public. See README.md for the full contract with request/response
examples.

Endpoints:
  GET  /health
  POST /v1/conversations/{id}/lead-message   - a lead said something; advance
  POST /v1/conversations/{id}/owner-decision - a human approved/edited/skipped
  GET  /v1/conversations/{id}/pending        - what (if anything) is waiting on a human
  POST /v1/conversations/{id}/outcome        - AI opinion on won/lost/needs-attention
  POST /v1/conversations/{id}/followup       - draft a day-2/5/9/15 "still there?" nudge
  POST /v1/conversations/{id}/summary        - the owner's catch-up read of the whole thread
  POST /v1/proposals/generate                - facts -> proposal JSON
  POST /v1/proposals/revise                  - proposal JSON + instruction -> updated JSON
  POST /v1/proposals/render                  - proposal JSON + template -> docx/pdf
"""

import base64
import logging
from typing import Any, Literal

from fastapi import Depends, FastAPI, Header, HTTPException
from langgraph.types import Command
from pydantic import BaseModel, Field

from app import followup, outcome, proposals, summary
from app.config import settings
from app.graph import compiled, pending_interrupt, thread_config

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s :: %(message)s")
log = logging.getLogger(__name__)

app = FastAPI(title="Vistaar AI Brain", version="0.1.0")


def require_service_key(x_service_key: str | None = Header(default=None)) -> None:
    if settings.service_api_key and x_service_key != settings.service_api_key:
        raise HTTPException(401, "bad or missing X-Service-Key")


@app.get("/health")
def health():
    return {"ok": True}


# --------------------------------------------------------------------------
class LeadMessageIn(BaseModel):
    text: str | None = Field(None, description="What the lead just said. Omit to just re-run with current facts.")
    category: str = "unknown"
    facts: dict[str, Any] = Field(default_factory=dict)
    required_fields: list[str] = Field(default_factory=list)
    catalog_text: str = "(no plans configured - do not quote any price)"
    knowledge_text: str = "(no knowledge base yet - do not state facts you were not given)"
    rules_text: str = "(none supplied - promise nothing at all)"
    service_brief: str = "(nothing specific - treat it generally)"
    style_examples: str = "(none saved - use your own judgement)"


class BrainResult(BaseModel):
    status: Literal["asked", "awaiting_approval", "escalated", "sent", "skipped"]
    message: str = ""
    facts: dict[str, Any] = Field(default_factory=dict)
    escalation_reason: str = ""


def _result_to_response(conversation_id: str, result: dict, fallback_facts: dict) -> BrainResult:
    pending = pending_interrupt(conversation_id)
    if pending:
        return BrainResult(
            status="awaiting_approval",
            message=pending.get("draft", ""),
            facts=pending.get("facts", fallback_facts),
        )
    if result.get("escalation_reason"):
        return BrainResult(
            status="escalated",
            facts=result.get("facts", fallback_facts),
            escalation_reason=result["escalation_reason"],
        )
    return BrainResult(
        status="asked",
        message=result.get("draft", ""),
        facts=result.get("facts", fallback_facts),
    )


@app.post("/v1/conversations/{conversation_id}/lead-message", dependencies=[Depends(require_service_key)])
def lead_message(conversation_id: str, body: LeadMessageIn) -> BrainResult:
    seed: dict[str, Any] = {
        "conversation_id": conversation_id,
        "category": body.category,
        "facts": body.facts,
        "required_fields": body.required_fields,
        "catalog_text": body.catalog_text,
        "knowledge_text": body.knowledge_text,
        "rules_text": body.rules_text,
        "service_brief": body.service_brief,
        "style_examples": body.style_examples,
    }
    if body.text:
        seed["transcript"] = [{"role": "lead", "text": body.text}]

    result = compiled().invoke(seed, config=thread_config(conversation_id))
    return _result_to_response(conversation_id, result, body.facts)


# --------------------------------------------------------------------------
class OwnerDecisionIn(BaseModel):
    verdict: Literal["approve", "edit", "skip"]
    instruction: str = ""


@app.post("/v1/conversations/{conversation_id}/owner-decision", dependencies=[Depends(require_service_key)])
def owner_decision(conversation_id: str, body: OwnerDecisionIn) -> BrainResult:
    result = compiled().invoke(
        Command(resume={"verdict": body.verdict, "instruction": body.instruction}),
        config=thread_config(conversation_id),
    )

    pending = pending_interrupt(conversation_id)
    if pending:
        return BrainResult(status="awaiting_approval", message=pending.get("draft", ""), facts=pending.get("facts", {}))
    if body.verdict == "skip":
        return BrainResult(status="skipped", facts=result.get("facts", {}))
    return BrainResult(status="sent", message=result.get("draft", ""), facts=result.get("facts", {}))


@app.get("/v1/conversations/{conversation_id}/pending", dependencies=[Depends(require_service_key)])
def get_pending(conversation_id: str) -> dict:
    return {"pending": pending_interrupt(conversation_id)}


# --------------------------------------------------------------------------
class OutcomeIn(BaseModel):
    facts: dict[str, Any] = Field(default_factory=dict)
    transcript: list[dict[str, str]] = Field(default_factory=list)
    knowledge_text: str = ""
    style_examples: str = ""
    days_silent: int = 0
    who_spoke_last: str = "unknown"


@app.post("/v1/conversations/{conversation_id}/outcome", dependencies=[Depends(require_service_key)])
def conversation_outcome(conversation_id: str, body: OutcomeIn) -> dict:
    return outcome.classify(
        facts=body.facts,
        transcript=body.transcript,
        knowledge_text=body.knowledge_text,
        style_examples=body.style_examples,
        days_silent=body.days_silent,
        who_spoke_last=body.who_spoke_last,
    )


# --------------------------------------------------------------------------
class FollowupIn(BaseModel):
    facts: dict[str, Any] = Field(default_factory=dict)
    transcript: list[dict[str, str]] = Field(default_factory=list)
    step: int = 1
    total: int = 4
    days_silent: int = 0
    knowledge_text: str = ""
    style_examples: str = ""


class FollowupOut(BaseModel):
    message: str


@app.post("/v1/conversations/{conversation_id}/followup", dependencies=[Depends(require_service_key)])
def conversation_followup(conversation_id: str, body: FollowupIn) -> FollowupOut:
    message = followup.draft_followup(
        facts=body.facts,
        transcript=body.transcript,
        step=body.step,
        total=body.total,
        days_silent=body.days_silent,
        knowledge_text=body.knowledge_text,
        style_examples=body.style_examples,
    )
    return FollowupOut(message=message)


# --------------------------------------------------------------------------
class SummaryIn(BaseModel):
    facts: dict[str, Any] = Field(default_factory=dict)
    transcript: list[dict[str, str]] = Field(default_factory=list)
    category: str = "unknown"
    knowledge_text: str = ""


class SummaryOut(BaseModel):
    headline: str = ""
    what_they_asked_for: str = ""
    where_it_stands: str = ""
    open_questions: list[str] = Field(default_factory=list)
    suggested_next_step: str = ""


@app.post("/v1/conversations/{conversation_id}/summary", dependencies=[Depends(require_service_key)])
def conversation_summary(conversation_id: str, body: SummaryIn) -> SummaryOut:
    return SummaryOut(
        **summary.summarize(
            facts=body.facts,
            transcript=body.transcript,
            category=body.category,
            knowledge_text=body.knowledge_text,
        )
    )


# --------------------------------------------------------------------------
class ProposalGenerateIn(BaseModel):
    category: str = "unknown"
    facts: dict[str, Any] = Field(default_factory=dict)
    transcript: list[dict[str, str]] = Field(default_factory=list)
    pricing_json: str = "[]"
    client_name: str = ""


@app.post("/v1/proposals/generate", dependencies=[Depends(require_service_key)])
def proposal_generate(body: ProposalGenerateIn) -> dict:
    return proposals.generate(
        category=body.category,
        facts=body.facts,
        transcript=body.transcript,
        pricing_json=body.pricing_json,
        client_name=body.client_name,
    )


class ProposalReviseIn(BaseModel):
    content: dict[str, Any]
    instruction: str


@app.post("/v1/proposals/revise", dependencies=[Depends(require_service_key)])
def proposal_revise(body: ProposalReviseIn) -> dict:
    return proposals.revise(body.content, body.instruction)


class ProposalRenderIn(BaseModel):
    content: dict[str, Any]
    template_base64: str
    version: int = 1


class ProposalRenderOut(BaseModel):
    docx_base64: str
    pdf_base64: str | None = None


@app.post("/v1/proposals/render", dependencies=[Depends(require_service_key)])
def proposal_render(body: ProposalRenderIn) -> ProposalRenderOut:
    template_bytes = base64.b64decode(body.template_base64)
    out = proposals.render(body.content, template_bytes, version=body.version)
    return ProposalRenderOut(
        docx_base64=base64.b64encode(out["docx"]).decode(),
        pdf_base64=base64.b64encode(out["pdf"]).decode() if out["pdf"] else None,
    )
