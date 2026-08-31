"""
Runs the whole qualify -> draft -> approve flow through the real FastAPI app
with a stubbed LLM (no real API key needed) and the in-memory checkpointer,
to prove the graph wiring, the pause/resume mechanics, and the HTTP contract
actually work before this ever touches a real key or a real conversation.
"""
import sys

from fastapi.testclient import TestClient

from app import llm

CALLS = []
QUALIFY_SYSTEMS = []


def fake_complete_json(system, user, schema_hint, max_tokens=2500, temperature=0.4):
    CALLS.append(("json", user))
    QUALIFY_SYSTEMS.append(system)
    if "2026-12-12" in user:
        return {"decision": "ready", "message": "", "learned": {"event_date": "2026-12-12", "city": "Bangalore"}}
    return {"decision": "ask", "message": "What date and city is this for?", "learned": {}}


DRAFT_SYSTEMS = []


def fake_complete(system, user, max_tokens=1200, temperature=0.6):
    CALLS.append(("text", user))
    DRAFT_SYSTEMS.append(system)
    return "Hi! Based on what you've shared, here are two options for your event..."


llm.complete_json = fake_complete_json
llm.complete = fake_complete

from app.main import app  # noqa: E402  (import after monkeypatch so nodes.py picks up the fakes)

client = TestClient(app)

conv_id = "test-conv-1"
required = ["event_date", "city"]

RULES = "- Availability: Never promise availability.\n- Pricing: Never invent pricing."
BRIEF = "Months of planning and the largest budget in this list."

print("== 1. lead's first message, missing facts -> should ask ==")
r = client.post(f"/v1/conversations/{conv_id}/lead-message", json={
    "text": "Hi, I need a photographer",
    "category": "wedding",
    "facts": {},
    "required_fields": required,
    "rules_text": RULES,
    "service_brief": BRIEF,
})
print(r.status_code, r.json())
assert r.status_code == 200
assert r.json()["status"] == "asked"

# The two new interpolation points reached the prompt, and reached it as their own sections
# rather than being folded into the knowledge blob.
first_system = QUALIFY_SYSTEMS[0]
assert "Never promise availability" in first_system, "rules did not reach QUALIFY_SYSTEM"
assert "not negotiable" in first_system, "rules were not framed as constraints"
assert BRIEF in first_system, "the service brief did not reach QUALIFY_SYSTEM"
assert "no knowledge base yet" in first_system, "knowledge is still its own separate slot"
# Only THIS service's brief, never the other fifteen.
assert "car delivery" not in first_system.lower().split("THIS JOB IN PARTICULAR")[-1][:400]

# Nothing is answered yet, so both required fields are still being asked for.
assert "event_date, city" in first_system

facts_so_far = r.json()["facts"]

print("\n== 2. lead answers with everything needed -> should reach owner approval ==")
r = client.post(f"/v1/conversations/{conv_id}/lead-message", json={
    "text": "It's on 2026-12-12 in Bangalore",
    "category": "wedding",
    "facts": facts_so_far,
    "required_fields": required,
    "rules_text": RULES,
    "service_brief": BRIEF,
})
print(r.status_code, r.json())
assert r.status_code == 200
assert r.json()["status"] == "awaiting_approval", r.json()
draft = r.json()["message"]
assert draft, "expected a drafted reply waiting for approval"

# The rules reach the DRAFT prompt too, where the actual quote gets written.
assert DRAFT_SYSTEMS, "expected a draft to have been written"
assert "Never invent pricing" in DRAFT_SYSTEMS[-1], "rules did not reach DRAFT_SYSTEM"

print("\n== 2b. missing_fields shrinks once the facts are known ==")
# The whole point of wam-crm-ai persisting what the AI learns: a fact given in chat comes back
# on the next turn as a fact, so the prompt stops asking for it.
r = client.post("/v1/conversations/test-conv-facts/lead-message", json={
    "text": "any update?",
    "category": "wedding",
    "facts": {"event_date": "2026-12-12", "city": "Bangalore"},
    "required_fields": required,
    "rules_text": RULES,
    "service_brief": BRIEF,
})
print(r.status_code, r.json()["status"])
assert r.status_code == 200
assert "event_date, city" in QUALIFY_SYSTEMS[0], "turn one should have asked for both"
assert "(nothing - you have enough)" in QUALIFY_SYSTEMS[-1], QUALIFY_SYSTEMS[-1]

print("\n== 3. pending endpoint should show the same thing is waiting ==")
r = client.get(f"/v1/conversations/{conv_id}/pending")
print(r.status_code, r.json())
assert r.json()["pending"] is not None

print("\n== 4. owner approves -> should be 'sent' ==")
r = client.post(f"/v1/conversations/{conv_id}/owner-decision", json={"verdict": "approve"})
print(r.status_code, r.json())
assert r.status_code == 200
assert r.json()["status"] == "sent"
assert r.json()["message"] == draft

print("\n== 5. a second conversation: owner edits, should loop back to awaiting_approval ==")
conv_id_2 = "test-conv-2"
r2 = client.post(f"/v1/conversations/{conv_id_2}/lead-message", json={
    "text": "hi", "category": "wedding", "facts": {}, "required_fields": required,
})
client.post(f"/v1/conversations/{conv_id_2}/lead-message", json={
    "text": "2026-12-12, Bangalore", "category": "wedding", "facts": r2.json()["facts"], "required_fields": required,
})
r = client.post(f"/v1/conversations/{conv_id_2}/owner-decision", json={"verdict": "edit", "instruction": "make it shorter"})
print(r.status_code, r.json())
assert r.json()["status"] == "awaiting_approval"

print("\n== 6. outcome classifier (stubbed) ==")
from app import outcome as outcome_module  # noqa: E402

def fake_outcome_json(system, user, schema_hint, max_tokens=2500, temperature=0.4):
    return {"decision": "won", "message": "", "reasoning": "client confirmed the booking"}
outcome_module.complete_json = fake_outcome_json
r = client.post(f"/v1/conversations/{conv_id}/outcome", json={
    "facts": {"event_date": "2026-12-12"},
    "transcript": [{"role": "lead", "text": "yes let's confirm, sending advance now"}],
})
print(r.status_code, r.json())
assert r.json()["decision"] == "won"

print("\n== 7. followup drafting (stubbed) ==")
from app import followup as followup_module  # noqa: E402

FOLLOWUP_CALLS = []


def fake_followup_complete(system, user, max_tokens=1200, temperature=0.6):
    FOLLOWUP_CALLS.append(system)
    return "Hey! Just checking this didn't get buried - still keen to help whenever you're ready 😊"


followup_module.complete = fake_followup_complete

r = client.post(f"/v1/conversations/{conv_id}/followup", json={
    "facts": {"event_date": "2026-12-12", "city": "Bangalore"},
    "transcript": [
        {"role": "us", "text": "Sounds great, shall we confirm the shoot?"},
    ],
    "step": 1,
    "total": 4,
    "days_silent": 2,
})
print(r.status_code, r.json())
assert r.status_code == 200
assert r.json()["message"]
assert "follow-up 1 of 4" in FOLLOWUP_CALLS[-1]

print("\n== 8. final followup (step == total) uses the same endpoint ==")
r = client.post(f"/v1/conversations/{conv_id}/followup", json={
    "facts": {},
    "transcript": [],
    "step": 4,
    "total": 4,
    "days_silent": 15,
})
print(r.status_code, r.json())
assert r.status_code == 200
assert r.json()["message"]
assert "follow-up 4 of 4" in FOLLOWUP_CALLS[-1]

print("\n== 9. a category nobody configured still formats the prompt ==")
r = client.post("/v1/conversations/test-conv-3/lead-message", json={
    "text": "hi", "category": "moon_landing", "facts": {}, "required_fields": [],
})
print(r.status_code, r.json())
assert r.status_code == 200
# wam-crm-ai resolves an unknown category to its fallback playbook before it ever gets here;
# this proves the service itself is also fine with the defaults when nothing is supplied.
assert "(nothing specific - treat it generally)" in QUALIFY_SYSTEMS[-1]
assert "promise nothing at all" in QUALIFY_SYSTEMS[-1]

print("\nALL SMOKE TESTS PASSED")
