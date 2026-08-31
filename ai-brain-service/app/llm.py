"""
Single place where we call the model.

Ported from vistaar-agent's app/agent/llm.py. Unchanged: the provider
handling (Groq/OpenAI-compatible vs Anthropic), the reasoning-model empty
-content retry, the JSON-mode helper. Removed: the `_record_call` telemetry
table (`LLMCall`) - that was a row in vistaar's own Postgres, and this
service doesn't keep a database of its own beyond LangGraph's checkpoints.
If you want per-call cost tracking, wam-crm-ai is the right place to log it,
since it's the one place all your AI usage (this service AND its existing
ai-draft feature) can be seen together.
"""

import json
import logging
import os
import re
import time
from contextlib import contextmanager
from contextvars import ContextVar
from typing import Any

from app.config import settings

log = logging.getLogger(__name__)

_ctx: ContextVar[tuple[str, str | None]] = ContextVar("llm_ctx", default=("llm", None))


@contextmanager
def llm_context(purpose: str, conversation_id: str | None = None):
    token = _ctx.set((purpose, conversation_id))
    try:
        yield
    finally:
        _ctx.reset(token)


BASE_URLS = {
    "groq": "https://api.groq.com/openai/v1",
    "openai": "https://api.openai.com/v1",
}

REASONING_HINTS = ("gpt-oss", "deepseek-r1", "qwen3", "o1", "o3", "o4")
MIN_REASONING_TOKENS = 700

_client: Any = None


def _is_anthropic() -> bool:
    return settings.llm_provider.lower() == "anthropic"


def _is_reasoning_model() -> bool:
    return any(h in settings.llm_model.lower() for h in REASONING_HINTS)


def _reasoning_effort() -> str:
    return os.getenv("LLM_REASONING_EFFORT", "low").strip().lower() or "low"


def _get_client():
    global _client
    if _client is not None:
        return _client

    if _is_anthropic():
        from anthropic import Anthropic

        _client = Anthropic(
            api_key=settings.llm_api_key,
            timeout=settings.llm_timeout_seconds,
            max_retries=settings.llm_max_retries,
        )
    else:
        from openai import OpenAI

        provider = settings.llm_provider.lower()
        _client = OpenAI(
            api_key=settings.llm_api_key,
            base_url=settings.llm_base_url or BASE_URLS.get(provider, BASE_URLS["groq"]),
            timeout=settings.llm_timeout_seconds,
            max_retries=settings.llm_max_retries,
        )
    return _client


def _is_rate_limit(exc: Exception) -> bool:
    """
    True for a provider 429. Matched structurally where the SDK exposes a status code, and by
    class name otherwise, so this keeps working across the OpenAI and Anthropic clients without
    importing either at module load.
    """
    if getattr(exc, "status_code", None) == 429:
        return True

    response = getattr(exc, "response", None)
    if getattr(response, "status_code", None) == 429:
        return True

    return "ratelimit" in type(exc).__name__.replace("_", "").lower()


def _budget(requested: int) -> int:
    return max(requested, MIN_REASONING_TOKENS) if _is_reasoning_model() else requested


def _extra() -> dict:
    if not _is_reasoning_model() or _is_anthropic():
        return {}
    return {"reasoning_effort": _reasoning_effort(), "include_reasoning": False}


def _chat(messages: list[dict], max_tokens: int, temperature: float, json_mode: bool):
    kwargs: dict[str, Any] = {
        "model": settings.llm_model,
        "max_tokens": max_tokens,
        "temperature": temperature,
        "messages": messages,
    }
    if json_mode:
        kwargs["response_format"] = {"type": "json_object"}
    extra = _extra()
    if extra:
        kwargs["extra_body"] = extra
    t0 = time.monotonic()
    purpose, conversation_id = _ctx.get()

    try:
        resp = _get_client().chat.completions.create(**kwargs)
    except Exception as exc:
        latency_ms = int((time.monotonic() - t0) * 1000)
        # A 429 is not a bug in the prompt or the code - it is the account's quota, and it needs
        # to read that way in the logs. Groq's free tier is metered on tokens per minute, which a
        # reasoning model with a long system prompt reaches in very few calls, so this is the
        # failure most likely to be met in practice.
        if _is_rate_limit(exc):
            log.error(
                "llm RATE LIMITED purpose=%s conversation=%s model=%s latency_ms=%s - the "
                "provider refused on quota, not on the request. Lower the token budget, slow the "
                "call rate, or raise the plan limit.",
                purpose, conversation_id, settings.llm_model, latency_ms,
            )
        else:
            log.error(
                "llm call FAILED purpose=%s conversation=%s model=%s latency_ms=%s error=%s",
                purpose, conversation_id, settings.llm_model, latency_ms, type(exc).__name__,
            )
        raise

    latency_ms = int((time.monotonic() - t0) * 1000)
    log.info(
        "llm call purpose=%s conversation=%s model=%s latency_ms=%s",
        purpose, conversation_id, settings.llm_model, latency_ms,
    )
    return resp


def _content_of(resp) -> tuple[str, str]:
    choice = resp.choices[0]
    return (choice.message.content or "").strip(), (choice.finish_reason or "")


def complete(system: str, user: str, max_tokens: int = 1200, temperature: float = 0.6) -> str:
    if _is_anthropic():
        resp = _get_client().messages.create(
            model=settings.llm_model,
            max_tokens=max_tokens,
            temperature=temperature,
            system=system,
            messages=[{"role": "user", "content": user}],
        )
        return "".join(b.text for b in resp.content if b.type == "text").strip()

    messages = [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]
    budget = _budget(max_tokens)
    text, finish = _content_of(_chat(messages, budget, temperature, json_mode=False))

    if not text:
        log.warning(
            "empty content from %s (finish_reason=%s, max_tokens=%s) - retrying bigger",
            settings.llm_model, finish, budget,
        )
        text, finish = _content_of(_chat(messages, budget * 3, temperature, json_mode=False))

    if not text:
        raise RuntimeError(
            f"{settings.llm_model} returned no text twice (finish_reason={finish})."
        )
    return text


def complete_json(
    system: str,
    user: str,
    schema_hint: str,
    max_tokens: int = 2500,
    temperature: float = 0.4,
) -> dict[str, Any]:
    full_system = (
        f"{system}\n\n"
        f"Respond with JSON matching this shape and nothing else. "
        f"No markdown, no code fences, no commentary:\n{schema_hint}"
    )

    if _is_anthropic():
        resp = _get_client().messages.create(
            model=settings.llm_model,
            max_tokens=max_tokens,
            temperature=temperature,
            system=full_system,
            messages=[
                {"role": "user", "content": user},
                {"role": "assistant", "content": "{"},
            ],
        )
        raw = "{" + "".join(b.text for b in resp.content if b.type == "text")
        return _loads(raw)

    messages = [
        {"role": "system", "content": full_system},
        {"role": "user", "content": user},
    ]
    budget = _budget(max_tokens)
    raw, finish = _content_of(_chat(messages, budget, temperature, json_mode=True))

    if not raw:
        log.warning("empty JSON from %s (finish_reason=%s) - retrying bigger", settings.llm_model, finish)
        raw, finish = _content_of(_chat(messages, budget * 2, temperature, json_mode=True))

    if not raw:
        raise RuntimeError(f"{settings.llm_model} returned no JSON twice (finish_reason={finish}).")
    return _loads(raw)


def _loads(raw: str) -> dict[str, Any]:
    raw = raw.strip()
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        pass

    fenced = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", raw, re.S)
    if fenced:
        try:
            return json.loads(fenced.group(1))
        except json.JSONDecodeError:
            pass

    match = re.search(r"\{.*\}", raw, re.S)
    if match:
        try:
            return json.loads(match.group(0))
        except json.JSONDecodeError:
            pass

    log.error("Model returned unparseable JSON: %s", raw[:800])
    raise ValueError("LLM did not return valid JSON")


def ping() -> str:
    return complete(
        system="You are a test. Reply with exactly one word and nothing else.",
        user="Say: working",
        max_tokens=800,
        temperature=0,
    )
