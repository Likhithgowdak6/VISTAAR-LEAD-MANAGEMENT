"""
HTTP client for ai-brain-service.

A PORT OF the transport half of backend/src/modules/ai-brain/ai-brain.client.ts. Like that file,
this is the ONLY place in the Python service that knows ai-brain-service's URL shape.

WHY A CLIENT RATHER THAN CALLING AN LLM DIRECTLY. ai-brain-service already exists, already runs
on this box, and already owns every prompt, every model choice and every retry policy. Giving
`crm-api` its own LLM SDK would duplicate all of that and create a second place where a prompt
can drift - and the two services would then disagree about what the assistant says depending on
which one answered. The brain stays the single owner of AI behaviour; this service asks it
questions.

NODE AND PYTHON MAY BOTH CALL IT AT ONCE, SAFELY. `/v1/templates/price` is a pure function: it
writes nothing, holds no session, and returns four candidate messages. Nothing is saved until
the owner picks one and POSTs it back. So there is no "exactly one owner" constraint here, which
is why this route can move before the rest of the AI work.

THE TWO ERROR CASES ARE DIFFERENT ON PURPOSE and the controller maps them to different statuses:

  - not configured -> 409. The operator has not turned the brain on. Retrying will not help.
  - upstream error -> 502, carrying the brain's own body as `details`. Retrying might help.

Collapsing them into one 500 would tell the owner "try again" for a condition no amount of
trying will fix.
"""

from typing import Any

import httpx

from app.config import settings


class AiBrainNotConfiguredError(Exception):
    """`AI_BRAIN_ENABLED` is false or no URL is set. Maps to 409."""


class AiBrainRequestError(Exception):
    """The brain answered, but not with a success. Maps to 502, carrying its body."""

    def __init__(self, message: str, status_code: int, body: Any) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.body = body


def _base_url() -> str:
    if not settings.ai_brain_enabled or not settings.ai_brain_service_url:
        raise AiBrainNotConfiguredError("AI_BRAIN_NOT_CONFIGURED")

    return settings.ai_brain_service_url.rstrip("/")


async def _post(path: str, body: dict[str, Any], timeout_ms: int | None = None) -> Any:
    """
    One POST, with the shared timeout.

    `timeout_ms` is an OVERRIDE, not a new default - the same contract the Node client has.
    `AI_BRAIN_REQUEST_TIMEOUT_MS` is sized for the slowest thing the brain does; only callers
    that must give up sooner pass their own.
    """
    url = f"{_base_url()}{path}"

    headers = {"Content-Type": "application/json"}

    # Sent only when configured, matching Node. An empty header is not the same as an absent one
    # to a service checking for its presence.
    if settings.ai_brain_service_key:
        headers["X-Service-Key"] = settings.ai_brain_service_key

    timeout = (timeout_ms or settings.ai_brain_request_timeout_ms) / 1000

    async with httpx.AsyncClient(timeout=timeout) as client:
        response = await client.post(url, json=body, headers=headers)

    # `response.text` then parse, rather than `response.json()`, because the brain answers some
    # errors with an empty body and Node treats that as null rather than as a parse failure.
    text = response.text
    parsed = response.json() if text else None

    if response.status_code >= 400:
        raise AiBrainRequestError(
            f"ai-brain-service returned {response.status_code} for {path}.",
            response.status_code,
            parsed,
        )

    return parsed


async def _get(path: str, timeout_ms: int | None = None) -> Any:
    """One GET, with shared timeout and authentication."""
    url = f"{_base_url()}{path}"

    headers = {}
    if settings.ai_brain_service_key:
        headers["X-Service-Key"] = settings.ai_brain_service_key

    timeout = (timeout_ms or settings.ai_brain_request_timeout_ms) / 1000

    async with httpx.AsyncClient(timeout=timeout) as client:
        response = await client.get(url, headers=headers)

    text = response.text
    parsed = response.json() if text else None

    if response.status_code >= 400:
        raise AiBrainRequestError(
            f"ai-brain-service returned {response.status_code} for {path}.",
            response.status_code,
            parsed,
        )

    return parsed


async def generate_price_templates(
    raw_details: str, rejected: list[str] | None = None
) -> dict[str, Any]:
    """
    `generatePriceTemplates`. Note the snake_case wire field - the brain is a Python service and
    its contract is `raw_details`, not `rawDetails`.
    """
    return await _post(
        "/v1/templates/price",
        {"raw_details": raw_details, "rejected": list(rejected or [])},
    )


async def optimize_knowledge(
    raw_text: str,
    category_options: list[str] | tuple[str, ...],
) -> dict[str, Any]:
    """
    `optimizeKnowledge`.
    POST /v1/knowledge/optimize with { raw_text, category_options }.
    Returns { label: str, content: str, category: str, notes: str }.
    """
    return await _post(
        "/v1/knowledge/optimize",
        {
            "raw_text": raw_text,
            "category_options": list(category_options),
        },
    )


async def classify_commitment(
    *,
    conversation_id: str,
    message: str,
    transcript: list[dict[str, Any]] | None = None,
    timeout_ms: int = 8_000,
) -> dict[str, Any]:
    """
    `classifyCommitment`.

    POST /v1/commitment with { message, transcript, conversation_id }.
    Returns { action: 'contact_lead' | 'await_lead' | 'none', when, task, quote, confidence }.
    """
    return await _post(
        "/v1/commitment",
        {
            "message": message,
            "transcript": list(transcript or []),
            "conversation_id": conversation_id,
        },
        timeout_ms=timeout_ms,
    )


async def classify_rejection(
    *,
    conversation_id: str,
    message: str,
    transcript: list[dict[str, Any]] | None = None,
    timeout_ms: int = 8_000,
) -> dict[str, Any]:
    """
    `classifyRejection`.

    POST /v1/rejection with { message, transcript, conversation_id }.
    Returns { verdict: 'firm_rejection' | 'none', quote: str, confidence: float }.
    """
    return await _post(
        "/v1/rejection",
        {
            "message": message,
            "transcript": list(transcript or []),
            "conversation_id": conversation_id,
        },
        timeout_ms=timeout_ms,
    )


async def get_followup(
    conversation_id: str,
    params: dict[str, Any],
) -> dict[str, Any]:
    """
    `getFollowup`.

    POST /v1/conversations/{conversation_id}/followup with snake_case fields.
    """
    body = {
        "facts": params.get("facts", {}),
        "transcript": params.get("transcript", []),
        "step": params.get("step", 1),
        "total": params.get("total", 1),
        "days_silent": params.get("daysSilent", params.get("days_silent", 0)),
        "knowledge_text": params.get("knowledgeText", params.get("knowledge_text", "")),
        "style_examples": params.get("styleExamples", params.get("style_examples", "")),
        "promise_context": params.get("promiseContext", params.get("promise_context", "")),
    }
    return await _post(f"/v1/conversations/{conversation_id}/followup", body)


async def send_lead_message(
    conversation_id: str,
    params: dict[str, Any],
) -> dict[str, Any]:
    """
    `sendLeadMessage`.
    POST /v1/conversations/{conversation_id}/lead-message.
    """
    body = {
        "text": params.get("text"),
        "category": params.get("category"),
        "lead_name": params.get("leadName", params.get("lead_name", "")),
        "facts": params.get("facts", {}),
        "required_fields": params.get("requiredFields", params.get("required_fields", [])),
        "catalog_text": params.get("catalogText", params.get("catalog_text", "")),
        "knowledge_text": params.get("knowledgeText", params.get("knowledge_text", "")),
        "rules_text": params.get("rulesText", params.get("rules_text", "")),
        "service_brief": params.get("serviceBrief", params.get("service_brief", "")),
        "style_examples": params.get("styleExamples", params.get("style_examples", "")),
        "today": params.get("today", ""),
        "owner_instruction": params.get("ownerInstruction", params.get("owner_instruction", "")),
        "category_options": params.get("categoryOptions", params.get("category_options", [])),
    }
    return await _post(f"/v1/conversations/{conversation_id}/lead-message", body)


async def classify_intent(
    *,
    conversation_id: str,
    message: str,
    transcript: list[dict[str, Any]] | None = None,
    timeout_ms: int | None = None,
) -> dict[str, Any]:
    """
    `classifyIntent`.
    POST /v1/intent with { message, transcript, conversation_id }.
    """
    return await _post(
        "/v1/intent",
        {
            "message": message,
            "transcript": list(transcript or []),
            "conversation_id": conversation_id,
        },
        timeout_ms=timeout_ms or settings.ai_brain_intent_timeout_ms,
    )


async def send_owner_decision(
    conversation_id: str,
    verdict: str,
    instruction: str = "",
) -> dict[str, Any]:
    """
    `sendOwnerDecision`.
    POST /v1/conversations/{conversation_id}/owner-decision with { verdict, instruction }.
    """
    return await _post(
        f"/v1/conversations/{conversation_id}/owner-decision",
        {"verdict": verdict, "instruction": instruction},
    )


async def get_pending(conversation_id: str) -> dict[str, Any]:
    """
    `getPending`.
    GET /v1/conversations/{conversation_id}/pending.
    """
    return await _get(f"/v1/conversations/{conversation_id}/pending")


async def get_outcome(
    conversation_id: str,
    params: dict[str, Any],
) -> dict[str, Any]:
    """
    `getOutcome`.
    POST /v1/conversations/{conversation_id}/outcome.
    """
    body = {
        "facts": params.get("facts", {}),
        "transcript": params.get("transcript", []),
        "knowledge_text": params.get("knowledgeText", params.get("knowledge_text", "")),
        "style_examples": params.get("styleExamples", params.get("style_examples", "")),
        "days_silent": params.get("daysSilent", params.get("days_silent", 0)),
        "who_spoke_last": params.get("whoSpokeLast", params.get("who_spoke_last", "unknown")),
    }
    return await _post(f"/v1/conversations/{conversation_id}/outcome", body)


async def get_summary(
    conversation_id: str,
    params: dict[str, Any],
) -> dict[str, Any]:
    """
    `getSummary`.
    POST /v1/conversations/{conversation_id}/summary.
    """
    body = {
        "facts": params.get("facts", {}),
        "transcript": params.get("transcript", []),
        "category": params.get("category", "unknown"),
        "knowledge_text": params.get("knowledgeText", params.get("knowledge_text", "")),
    }
    return await _post(f"/v1/conversations/{conversation_id}/summary", body)


async def plan_assistant_action(params: dict[str, Any]) -> dict[str, Any]:
    """
    `planAssistantAction`.
    POST /v1/assistant/plan.
    """
    body = {
        "question": params.get("question", ""),
        "stages": list(params.get("stages", [])),
        "categories": list(params.get("categories", [])),
        "score_bands": list(params.get("scoreBands", params.get("score_bands", []))),
        "parked_lead_name": params.get("parkedLeadName", params.get("parked_lead_name", "")),
    }
    return await _post("/v1/assistant/plan", body)


async def answer_assistant_question(params: dict[str, Any]) -> dict[str, Any]:
    """
    `answerAssistantQuestion`.
    POST /v1/assistant/answer.
    """
    body = {
        "question": params.get("question", ""),
        "restated": params.get("restated", ""),
        "data": params.get("data", ""),
    }
    return await _post("/v1/assistant/answer", body)


async def assistant_agent_turn(params: dict[str, Any]) -> dict[str, Any]:
    """
    One step of the multi-step assistant.
    POST /v1/assistant/agent-turn.

    The brain decides; `assistant_agent.run_assistant` executes and calls back here. The whole
    conversation is sent each time because the brain holds no assistant state — which is the
    point: it has no database and cannot be given one.
    """
    body = {
        "messages": list(params.get("messages", [])),
        "tools": list(params.get("tools", [])),
        "conversation_id": str(params.get("conversationId", params.get("conversation_id", ""))),
    }

    if params.get("maxTokens") or params.get("max_tokens"):
        body["max_tokens"] = int(params.get("maxTokens") or params.get("max_tokens"))

    return await _post("/v1/assistant/agent-turn", body)


async def generate_proposal(params: dict[str, Any]) -> dict[str, Any]:
    """
    `generateProposal`.
    POST /v1/proposals/generate.
    """
    body = {
        "category": params.get("category", ""),
        "facts": params.get("facts", {}),
        "transcript": params.get("transcript", []),
        "pricing_json": params.get("pricingJson", params.get("pricing_json", "")),
        "client_name": params.get("clientName", params.get("client_name", "")),
    }
    return await _post("/v1/proposals/generate", body)


async def revise_proposal(
    content: dict[str, Any],
    instruction: str,
) -> dict[str, Any]:
    """
    `reviseProposal`.
    POST /v1/proposals/revise with { content, instruction }.
    """
    return await _post("/v1/proposals/revise", {"content": content, "instruction": instruction})


async def render_proposal(params: dict[str, Any]) -> dict[str, Any]:
    """
    `renderProposal`.
    POST /v1/proposals/render.
    """
    body = {
        "content": params.get("content", {}),
        "template_base64": params.get("templateBase64", params.get("template_base64", "")),
        "version": params.get("version", 1),
    }
    return await _post("/v1/proposals/render", body)

