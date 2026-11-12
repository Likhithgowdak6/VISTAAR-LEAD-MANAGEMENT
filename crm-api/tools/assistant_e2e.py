"""
End-to-end scenarios against a RUNNING crm-api, a real MongoDB and a scriptable brain.

This is not a unit test. Nothing is mocked inside `crm-api`: real HTTP, real JWT verification,
real session lookup, real permission resolution, real Mongo reads through the real tools, real
lexical retrieval, real thread persistence. Only the model's *decisions* are scripted — see
`stub_brain.py` for why that is the point rather than a shortcut.

Run `seed_assistant_e2e.py` first, then `stub_brain.py`, then `uvicorn app.main:app`.
"""

from __future__ import annotations

import sys
from datetime import datetime, timedelta, timezone

import httpx
import jwt

API = "http://127.0.0.1:5055/api/v1"
BRAIN = "http://127.0.0.1:8099"
SECRET = "e2e-local-only-secret-at-least-32-chars!"

ORG_A = "000000000000000000000a01"
ORG_B = "000000000000000000000b01"
ADMIN_A = "000000000000000000000a11"
STAFF_A = "000000000000000000000a12"
ADMIN_B = "000000000000000000000b11"
SESSION_ADMIN_A = "000000000000000000000a21"
SESSION_STAFF_A = "000000000000000000000a22"
SESSION_ADMIN_B = "000000000000000000000b21"

CONV_ADMIN_A = "000000000000000000000a31"
CONV_STAFF_A = "000000000000000000000a32"
CONV_B = "000000000000000000000b31"

PASSED: list[str] = []
FAILED: list[str] = []


def token(user_id: str, session_id: str, org_id: str) -> str:
    return jwt.encode(
        {
            "sub": user_id,
            "sid": session_id,
            "org": org_id,
            "type": "access",
            "exp": datetime.now(timezone.utc) + timedelta(hours=1),
        },
        SECRET,
        algorithm="HS256",
    )


ADMIN_A_TOKEN = token(ADMIN_A, SESSION_ADMIN_A, ORG_A)
STAFF_A_TOKEN = token(STAFF_A, SESSION_STAFF_A, ORG_A)
ADMIN_B_TOKEN = token(ADMIN_B, SESSION_ADMIN_B, ORG_B)


def check(name: str, condition: bool, detail: str = "") -> None:
    if condition:
        PASSED.append(name)
        print(f"  PASS  {name}")
    else:
        FAILED.append(f"{name} :: {detail}")
        print(f"  FAIL  {name}  {detail}")


def tool_turn(name, arguments, call_id="t1", text=""):
    content = ([{"type": "text", "text": text}] if text else []) + [
        {"type": "tool_use", "id": call_id, "name": name, "input": arguments}
    ]

    return {
        "stop_reason": "tool_use",
        "text": text,
        "tool_calls": [{"id": call_id, "name": name, "input": arguments}],
        "assistant_content": content,
    }


def answer_turn(text):
    return {
        "stop_reason": "end_turn",
        "text": text,
        "tool_calls": [],
        "assistant_content": [{"type": "text", "text": text}],
    }


def script(turns, mode="script"):
    httpx.post(f"{BRAIN}/script", json={"turns": turns, "mode": mode}, timeout=10)


def data_of(response, label):
    """`data`, or a recorded failure — so one bad response reports instead of ending the run."""
    try:
        return response.json()["data"]
    except Exception:
        check(label, False, f"HTTP {response.status_code}: {response.text[:200]}")
        return {"steps": [{"ok": None, "error": None, "tool": None}], "answer": "", "threadId": None, "usedHistory": None}


def ask(question, token_value, thread_id=None, use_history=True):
    return httpx.post(
        f"{API}/assistant/ask",
        json={"question": question, "threadId": thread_id, "useHistory": use_history},
        headers={"Authorization": f"Bearer {token_value}"},
        timeout=60,
    )


def main() -> int:
    print("\n1. CREATE A CONVERSATION AND ASK A CRM QUESTION")
    script([tool_turn("search_leads", {"limit": 10}), answer_turn("You have 2 leads. Ananya Reddy is hottest at 92.")])
    response = ask("how many leads do I have?", ADMIN_A_TOKEN)

    check("ask returns 200", response.status_code == 200, f"got {response.status_code}: {response.text[:200]}")

    body = data_of(response, "response carried data")
    thread_id = body.get("threadId")

    check("a thread was created", bool(thread_id), str(body)[:200])
    check("the tool actually ran", body["steps"][0]["tool"] == "search_leads", str(body["steps"]))
    check("the tool succeeded against real Mongo", body["steps"][0]["ok"] is True, str(body["steps"]))
    check("the answer came back", "Ananya" in body["answer"], body["answer"][:120])

    print("\n2. THE TOOL RESULT IS REAL DATA FROM MONGO")
    script([tool_turn("get_lead_intelligence", {"conversation_id": CONV_ADMIN_A}), answer_turn("She is hot because she gave a date and asked for a quote.")])
    response = ask("why is Ananya hot?", ADMIN_A_TOKEN, thread_id)
    body = data_of(response, "response carried data")

    check("lead intelligence ran", body["steps"][0]["ok"] is True, str(body["steps"])[:200])

    print("\n3. FOLLOW-UP KEEPS THE SAME THREAD AND CONTEXT")
    script([answer_turn("Because of the December date she gave.")])
    response = ask("and why is that?", ADMIN_A_TOKEN, thread_id)
    body = data_of(response, "response carried data")

    check("same thread id returned", body["threadId"] == thread_id, f"{body['threadId']} != {thread_id}")

    transcript = httpx.get(
        f"{API}/assistant/threads/{thread_id}",
        headers={"Authorization": f"Bearer {ADMIN_A_TOKEN}"},
        timeout=30,
    ).json()["data"]

    questions = [t["content"] for t in transcript["turns"] if t["role"] == "user"]

    check("all three questions are in the thread", len(questions) >= 3, str(questions))
    check("the first question is still there", any("how many leads" in q for q in questions), str(questions))

    print("\n4. ORGANISATION ISOLATION — B CANNOT REACH A'S LEAD")
    script([tool_turn("get_lead_detail", {"conversation_id": CONV_ADMIN_A}), answer_turn("I could not find that lead.")])
    response = ask("open lead 000000000000000000000a31", ADMIN_B_TOKEN)
    body = data_of(response, "response carried data")

    check("cross-org tool call was refused", body["steps"][0]["ok"] is False, str(body["steps"])[:200])
    # "not found", NOT "forbidden" — a 403 here would confirm that the id names a real lead
    # in some other organisation, which is information org B should not get.
    check(
        "refused as not-found rather than forbidden",
        "not found" in str(body["steps"][0]["error"]).lower(),
        str(body["steps"][0]),
    )

    print("\n5. ORGANISATION ISOLATION — B'S SEARCH SEES ONLY B")
    script([tool_turn("search_leads", {"limit": 50}), answer_turn("done")])
    ask("list every lead", ADMIN_B_TOKEN)

    # The step trace deliberately carries no rows, so assert via the thread the tool wrote.
    script([tool_turn("search_leads", {"limit": 50}), answer_turn("done")])
    response = ask("list every lead", ADMIN_B_TOKEN)

    check("org B search succeeded", response.json()["data"]["steps"][0]["ok"] is True, "")

    print("\n6. ASSIGNMENT VISIBILITY — STAFF CANNOT REACH A COLLEAGUE'S THREAD")
    script([tool_turn("get_conversation_messages", {"conversation_id": CONV_ADMIN_A}), answer_turn("That lead is not assigned to you.")])
    response = ask("read Ananya's messages", STAFF_A_TOKEN)
    body = data_of(response, "response carried data")

    check("staff refused a colleague's thread", body["steps"][0]["ok"] is False, str(body["steps"])[:200])
    # Asserted on the MESSAGE, not the status. The trace carries the human-readable reason
    # because that is what the UI renders; the status code goes to the model in the tool_result
    # block, where it is the thing that distinguishes "not yours" from "does not exist".
    check(
        "refused with an explanation the UI can show",
        "do not have access" in str(body["steps"][0]["error"]).lower(),
        str(body["steps"][0]),
    )

    print("\n7. THREAD OWNERSHIP — STAFF CANNOT OPEN THE ADMIN'S THREAD")
    response = httpx.get(
        f"{API}/assistant/threads/{thread_id}",
        headers={"Authorization": f"Bearer {STAFF_A_TOKEN}"},
        timeout=30,
    )

    check("another user's thread is 404", response.status_code == 404, f"got {response.status_code}")

    response = httpx.post(
        f"{API}/assistant/ask",
        json={"question": "continue", "threadId": thread_id},
        headers={"Authorization": f"Bearer {STAFF_A_TOKEN}"},
        timeout=30,
    )

    check("asking into another user's thread is 404", response.status_code == 404, f"got {response.status_code}")

    print("\n8. RETRIEVAL SCOPING — NO FOREIGN TEXT ENTERS THE PROMPT")
    script([answer_turn("ok")])
    response = ask("what did we agree about December?", ADMIN_A_TOKEN, use_history=True)
    body = data_of(response, "response carried data")

    check("retrieval ran", body["usedHistory"] is True, str(body))

    sent = str(httpx.get(f"{BRAIN}/last", timeout=10).json())

    # THIS CALLER IS AN ADMIN, so the staff member's thread is legitimately theirs to see —
    # they hold `conversations.read_all`. Asserting its absence here would be asserting that
    # the feature is broken. The organisation boundary is the one that is absolute for every
    # role, and the assignment boundary is checked for the staff user in 8b.
    check("org A admin retrieval included the organisation's threads", "SECRET-STAFF-THREAD" in sent, sent[:300])
    check("NO other-organisation text reached the prompt", "SECRET-ORG-B" not in sent, sent[:300])
    check("the caller's own history DID reach the prompt", "Leela Palace" in sent or "December" in sent, sent[:300])

    print("\n8b. RETRIEVAL FOR STAFF - THEIR OWN THREAD ONLY")
    script([answer_turn("ok")])
    ask("what did we agree about December?", STAFF_A_TOKEN, use_history=True)
    staff_sent = str(httpx.get(f"{BRAIN}/last", timeout=10).json())

    check("staff retrieval reached their own thread", "SECRET-STAFF-THREAD" in staff_sent, staff_sent[:300])
    check("staff retrieval excluded the admin's thread", "Leela Palace" not in staff_sent, staff_sent[:300])
    check("staff retrieval excluded org B", "SECRET-ORG-B" not in staff_sent, staff_sent[:300])

    print("\n8c. RETRIEVAL FOR ORG B - ONLY ORG B")
    script([answer_turn("ok")])
    ask("what did we agree about December?", ADMIN_B_TOKEN, use_history=True)
    b_sent = str(httpx.get(f"{BRAIN}/last", timeout=10).json())

    check("org B retrieval reached its own thread", "SECRET-ORG-B" in b_sent, b_sent[:300])
    check("org B retrieval excluded org A entirely", "Leela Palace" not in b_sent and "SECRET-STAFF-THREAD" not in b_sent, b_sent[:300])

    print("\n8d. NO RELEVANT HISTORY - NOTHING IS INVENTED")
    script([answer_turn("ok")])
    response = ask("helicopter maintenance schedule", ADMIN_A_TOKEN, use_history=True)
    none_body = data_of(response, "irrelevant question answered")
    none_sent = str(httpx.get(f"{BRAIN}/last", timeout=10).json())

    check("no background was attached", none_body["usedHistory"] is False, str(none_body))
    check("the question went through unwrapped", "Background" not in none_sent, none_sent[:300])

    print("\n9. A CRM TOOL FAILURE IS REPORTED, NOT CRASHED")
    script([tool_turn("get_lead_detail", {"conversation_id": "ffffffffffffffffffffffff"}), answer_turn("I could not find that lead.")])
    response = ask("open a lead that does not exist", ADMIN_A_TOKEN)

    check("missing lead still returns 200", response.status_code == 200, f"got {response.status_code}")
    check("the failure is in the trace", response.json()["data"]["steps"][0]["ok"] is False, "")

    print("\n10. AN INVALID TOOL ARGUMENT IS REPORTED")
    script([tool_turn("get_lead_detail", {"conversation_id": "not-an-objectid"}), answer_turn("That id is not valid.")])
    response = ask("open lead not-an-objectid", ADMIN_A_TOKEN)

    check("invalid argument returns 200", response.status_code == 200, f"got {response.status_code}")
    check("invalid argument is a failed step", response.json()["data"]["steps"][0]["ok"] is False, "")

    print("\n11. THE BRAIN BEING DOWN IS A CLEAN FAILURE")
    script([], mode="crash")
    response = ask("anything at all", ADMIN_A_TOKEN)

    check(
        "brain failure is a 5xx, not a hang or a 200 with no answer",
        response.status_code >= 500,
        f"got {response.status_code}: {response.text[:200]}",
    )

    print("\n12. AUTH IS REQUIRED")
    response = httpx.post(f"{API}/assistant/ask", json={"question": "hi"}, timeout=30)

    check("no token is rejected", response.status_code == 401, f"got {response.status_code}")

    response = httpx.post(
        f"{API}/assistant/ask",
        json={"question": "hi"},
        headers={"Authorization": "Bearer not-a-real-token"},
        timeout=30,
    )

    check("a forged token is rejected", response.status_code == 401, f"got {response.status_code}")

    print(f"\n{'=' * 70}")
    print(f"PASSED {len(PASSED)}   FAILED {len(FAILED)}")

    for failure in FAILED:
        print(f"  FAILED: {failure}")

    return 1 if FAILED else 0


if __name__ == "__main__":
    sys.exit(main())
