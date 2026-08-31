# ai-brain-service

This is vistaar-agent's "brain" — the qualifying-question logic, the reply
drafting, the proposal writer, and the won/lost classifier — pulled out on
its own, in Python, so wam-crm-ai (the Node/TypeScript CRM) can call it like
a helper instead of the two projects being merged into one language.

**What this service does NOT do:** it does not own any leads, conversations,
proposals, rate cards, or WhatsApp accounts. It has no dashboard. It never
sends a WhatsApp message or an email itself. All of that stays exactly where
it already is, in wam-crm-ai. This service only *thinks* — you send it the
current facts and conversation, it sends back a decision.

The one exception is a tiny, invisible database used only to remember
"which step is this conversation on right now" while it's paused waiting for
a human to approve a draft. That's LangGraph's own bookkeeping, not business
data — you never look at it directly, and wam-crm-ai's own database remains
the one real source of truth for everything else.

## Running it

```bash
cp .env.example .env
# fill in LLM_API_KEY at minimum
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8091
```

Or with Docker: `docker build -t ai-brain . && docker run -p 8091:8091 --env-file .env ai-brain`

Check it's alive: `curl localhost:8091/health`

### Verifying it actually works, without spending anything

Two scripts run the whole thing end-to-end against a stubbed AI model (no
API key needed) and check the output at every step:

```bash
python3 smoke_test.py            # qualify -> draft -> approve/edit/skip, and the outcome classifier
python3 smoke_test_proposal.py   # facts -> proposal JSON -> real .docx -> real PDF
```

Both were run while building this and pass. `smoke_test_proposal.py` needs
one of vistaar-agent's real `.docx` templates at
`templates/proposal_wedding.docx` relative to it (or edit the path at the
top of the script) — copy the five files from vistaar-agent's `templates/`
folder into this project's own `templates/` folder before running it.

## The API wam-crm-ai calls

Every request needs an `X-Service-Key` header matching `SERVICE_API_KEY`
(skip it if you leave that setting blank while testing locally).

### A lead sent a WhatsApp message

```
POST /v1/conversations/{conversation_id}/lead-message
{
  "text": "It's a wedding, Dec 12, Bangalore",
  "category": "event_photography",
  "facts": { "...": "whatever wam-crm-ai already knows about this lead" },
  "required_fields": ["event_date", "city", "timing", ...],
  "catalog_text": "- Silver package | Rs.80,000 | ...",
  "knowledge_text": "- Our studio: ...",
  "style_examples": "- \"Yes we do cover that!...\""
}
```

`required_fields`, `catalog_text`, `knowledge_text` and `style_examples` are
your rate card, knowledge base, and saved reply examples — wam-crm-ai owns
that data (it'll need a small admin screen for it, similar to what
vistaar-agent's dashboard had), and passes the relevant text in on every
call. This service has no database of its own to look these up in.

Response:

```
{
  "status": "asked" | "awaiting_approval" | "escalated",
  "message": "the text to actually send, or the draft awaiting approval",
  "facts": { "...": "updated with anything the lead's message revealed" },
  "escalation_reason": "why a human needs to step in, if status is escalated"
}
```

- `"asked"` — send `message` to the lead now, no approval needed (matches
  the "auto-send qualifying, approve the rest" choice already made).
- `"awaiting_approval"` — show `message` to a human for approve / edit / skip,
  the same way wam-crm-ai's existing "suggest reply" draft already works.
- `"escalated"` — stop automating this conversation and notify your team;
  `escalation_reason` says why.

### A human approved, edited, or skipped a draft

```
POST /v1/conversations/{conversation_id}/owner-decision
{ "verdict": "approve" | "edit" | "skip", "instruction": "make it shorter" }
```

Response shape is the same as above. `"edit"` comes back as
`"awaiting_approval"` again with the revised draft — loop until approved or
skipped.

### What's this conversation currently waiting on?

```
GET /v1/conversations/{conversation_id}/pending
```

Useful after a restart, to reconcile state. Returns `{"pending": null}` or
the same payload a `lead-message`/`owner-decision` call would have returned.

### Is this deal won, lost, or does it need attention?

```
POST /v1/conversations/{conversation_id}/outcome
{
  "facts": { "...": "..." },
  "transcript": [{"role": "lead", "text": "..."}, {"role": "us", "text": "..."}],
  "knowledge_text": "...",
  "days_silent": 3,
  "who_spoke_last": "us"
}
```

Response: `{"decision": "won"|"lost"|"answer"|"reopen"|"wait"|"unclear", "message": "...", "reasoning": "one line, for your team, not the customer"}`.

This is the piece that flags won/lost automatically. Call it whenever it
makes sense to check in on a conversation — after a proposal gets a reply,
on a daily schedule for anything gone quiet, whatever fits your workflow —
and move the conversation's stage in wam-crm-ai based on the answer. A human
can always drag it back if the AI got it wrong, same trust model as
wam-crm-ai's existing AI draft feature.

### Proposals

```
POST /v1/proposals/generate    { category, facts, transcript, pricing_json, client_name } -> proposal content JSON
POST /v1/proposals/revise      { content, instruction }                                    -> updated content JSON
POST /v1/proposals/render      { content, template_base64, version }                       -> { docx_base64, pdf_base64 }
```

wam-crm-ai stores the content JSON and the version history (that's business
data, so it belongs there), sends the `.docx` template as base64 on
`/render`, and gets back a ready-to-send file. PDF conversion needs
LibreOffice in this service's environment (the provided `Dockerfile`
installs it); without it you still get the `.docx`.

## What's left before this runs for real

1. **wam-crm-ai's side isn't built yet.** This service only exists on its
   own so far — nothing in wam-crm-ai calls it. That's the next phase: a
   small module in wam-crm-ai's backend that calls these endpoints when a
   WhatsApp message comes in, shows the approval draft in the UI (or
   reuses the existing "suggest reply" panel), and a small admin screen
   for the rate card / knowledge base / style examples this service needs
   on every call.
2. **A place to run it.** Point `DATABASE_URL` at a small Postgres in
   production so paused conversations survive a restart — it can be a tiny,
   separate database; it stores nothing but LangGraph's own bookkeeping.
3. **Voice notes** (the lead sends a voice note, or the owner replies to an
   approval card with one) aren't ported yet — vistaar-agent's
   `transcribe.py` is small and can be added here the same way once the
   rest of this is wired up and working.
