"""
A scriptable stand-in for `ai-brain-service`, for end-to-end testing without a model.

WHY NOT JUST USE THE REAL BRAIN FOR EVERYTHING. Two reasons, and neither is cost alone:

1. **Determinism.** The scenarios that matter most — a staff member cannot reach a colleague's
   thread, organisation B cannot see organisation A — need the *model* to attempt the thing
   being forbidden. A real model is under no obligation to try, so a green run would prove
   nothing. Here the attempt is scripted, and the refusal is the real one.
2. **Failure injection.** "What happens when the LLM fails" cannot be tested by asking Claude
   nicely to fail.

It speaks the same wire format `crm-api/app/assistant_agent.py` reads: `tool_calls`,
`assistant_content`, `text`. `/script` sets the turns for the next question.

Local only. Binds 127.0.0.1 and holds no credentials.
"""

from __future__ import annotations

import sys

import uvicorn
from fastapi import FastAPI, Request

app = FastAPI()

_turns: list[dict] = []
_mode = "script"


@app.post("/script")
async def script(request: Request):
    """Queue the turns the next question will receive. `mode` can force a failure."""
    global _mode

    body = await request.json()
    _mode = body.get("mode", "script")

    _turns.clear()
    _turns.extend(body.get("turns", []))

    return {"queued": len(_turns), "mode": _mode}


_last: dict = {}


@app.get("/last")
async def last():
    """
    The exact payload `crm-api` last sent.

    THIS IS THE ONLY WAY TO VERIFY RETRIEVAL SCOPING HONESTLY. Asserting that retrieval "ran"
    proves nothing about what it retrieved; the question is whether a colleague's or another
    organisation's text reached the prompt. That is visible only here, on the wire.
    """
    return _last


@app.post("/v1/assistant/agent-turn")
async def agent_turn(request: Request):
    _last.clear()
    _last.update(await request.json())

    if _mode == "crash":
        # What `crm-api` sees when the brain is down or the provider refuses.
        return uvicorn_response_500()

    if _turns:
        return _turns.pop(0)

    return {
        "stop_reason": "end_turn",
        "text": "I have nothing scripted for that.",
        "tool_calls": [],
        "assistant_content": [{"type": "text", "text": "I have nothing scripted for that."}],
    }


def uvicorn_response_500():
    from fastapi.responses import JSONResponse

    return JSONResponse(status_code=500, content={"detail": "simulated brain failure"})


@app.get("/health")
async def health():
    return {"ok": True, "stub": True}


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8099
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")
