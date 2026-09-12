# Vistaar Lead Management — how it works

A WhatsApp-first CRM with an AI sales agent. A lead messages you (or fills a Meta ad form), the AI
qualifies them, you approve anything that matters, and nothing about a booking gets forgotten.

---

## The two ways a lead arrives

### 1. Someone WhatsApps you

```
Lead: "Do u guys do wedding shoot"
    ↓
Message lands, thread created in the Inbox. AI is ON by default.
    ↓
AI reads the knowledge base (who you are, your prices, your rules)
    ↓
AI replies: "Hey Likhith! Yes, we do wedding shoots — we're storytellers who
             capture the raw emotion of the day. When's the wedding, and which city?"
    ↓
You get a WhatsApp: "🔔 New lead — Likhith"
    ↓
No reply from you in 10 min? Your phone rings.
```

From there the AI keeps qualifying — date, city, photo or video, budget — and the lead score climbs
as facts arrive. It never quotes a price that isn't in your knowledge base, and it never promises a
date. When it hits something it shouldn't decide alone, it stops and asks you.

### 2. Someone fills your Meta ad form

```
Lead fills the Wedding Genie form on Instagram/Facebook
    ↓
Importer pulls it (name, phone, what they asked for)
    ↓
Contact + thread created, answers stored, service classified (wedding / birthday / …)
    ↓
You get a WhatsApp: "🔔 New lead — Priya" with the details
    ↓
No reply in 10 min? Your phone rings.
    ↓
If that form has "AI messages first" switched on, then 5 minutes after they
filled it in the lead gets a WhatsApp from the AI — naming the form, so they
recognise why you're in their chat.
```

**Leads from before the day you connected the form are never touched.** Their events have already
happened, and a message about a wedding that was last month is worse than no message.

### Controlling it per form

Each connected form has three switches on the Lead Sources page:

| Switch | What it does | Default |
|---|---|---|
| **Importing** | Pull leads from this form | On |
| **AI reads answers** | Whether the form answers reach the AI | Off |
| **AI messages first** | Whether the AI opens the chat | **Off** |

These are **per form, not per ad** — the finest grain that exists, because a lead record only ever
carries the form it came from. Two ads pointing at one form can't be separated. If you want
independent control, give those ads separate forms and connect each as its own source.

The 5-minute pause is a real window, not a formality: the switch is re-read at send time, so
turning it off inside those five minutes stops the message.

---

## Turning the AI off for one lead

Every row in the inbox has an **AI toggle**. It's **on** for every lead from the moment they
arrive. Flip it off and the AI stops doing anything in that chat — no replies, no follow-ups, no
nurture — until you flip it back.

It also switches itself off when it escalates to you, so you always know a paused chat is one
someone decided to pause.

---

## Once they're in the pipeline

**Stages:** New → Contacted → Qualified → Proposal → **Won** / Lost / Closed

**Lead score (0–100)** climbs as the AI learns: event date +20, venue +15, budget +15, asked for a
quote +15, replied +20. Cold / Warm / Hot at a glance in the inbox.

**Follow-ups** nudge quiet leads on days 2, 5, 9 and 15 — and **stop the moment the event date
passes**, because chasing someone after their wedding is pointless.

**Escalation.** If they push twice on price, ask for your best price, mention a competitor, or ask
about contracts and refunds, the AI stops and hands it to you. Discounts are your decision, always.

---

## Once you've won it

```
Deal marked Won, event date known
    ↓
Every morning, 7 days out: "📸 2 bookings this week
                             Tomorrow — Likhith, wedding (12 Sep 2026)
                             In 4 days — Priya, birthday"
    ↓
Something on tomorrow? Your phone rings with the names.
Nothing on tomorrow? No call. Silence means clear.
    ↓
Day after the shoot: "💰 Likhith (12 Sep) — shoot done. Payment collected?
                      Reply B4 collected or B4 pending"
    ↓
You say collected  → done, nothing more said
You say pending    → client gets ONE polite reminder, then it's assigned to you
You say nothing    → you get asked again tomorrow. The client is never chased.
```

The last line is the important one: **the AI never messages a client about money unless you have
explicitly said it's outstanding.** Asking someone who has already paid to pay again isn't an
annoyance — it's an accusation, aimed at a customer who just spent money with you.

---

## What you control

| Where | What it does |
|---|---|
| **Knowledge** | What the agent knows and how it must behave. Type it in plain English, the AI tidies it up and files it. `rules` are non-negotiable, `pricing` is the only thing it may quote. |
| **Templates** | Type your prices, get four ready-to-send versions, keep one. Insert it into any chat from the reply box. |
| **Inbox** | Every thread, the AI's summary, the lead panel, the per-chat AI toggle, and a reply box where nothing sends without you. |
| **Stages / Tags** | Your pipeline, your labels. |
| **Lead sources** | Connect a Meta lead form or a Google Sheet. |
| **Settings** | Which number is yours for alerts and calls. |
| **Your self-chat** | Ask the agent anything: *"how many birthday bookings"*, *"show me the hot leads"*, *"how's the pipeline"*. It answers from real data, never from memory. |

---

## The safety rules, in one place

1. **Sales replies need your approval.** Only qualifying questions send themselves.
2. **No price it wasn't given.** No invented discount, no invented package, no "starting from".
3. **No dates promised.** Availability is a human's word.
4. **No links.** Ever.
5. **Never chased after the event.** Follow-ups stop at the event date.
6. **Never chased for money without your word.** One message, then it's yours.
7. **Old leads are never contacted.** Hard floor at the day you connected the source.
8. **Opting out is permanent**, even if automation is switched back on.
9. **Strangers are messaged slowly.** Ad-form greetings are capped at 5 per round, 20 seconds
   apart, hard-limited in config — a backlog can never become a spam run.

---

## About the AI messaging ad leads first

This is the only place the agent speaks to someone who never messaged it, and it's off by default
per form.

It runs over Baileys — the CRM is signed into WhatsApp the way you are on a laptop. WhatsApp bans
numbers for messaging strangers, and a ban takes your business number and every conversation on it.
The guardrails above exist for that reason, and they are the reason it's safe enough to test with a
few real leads.

**Before you point real ad spend at this**, move first contact to the official WhatsApp Business
API with an approved template. Costs a little per message, needs template approval, and cannot get
you banned. Once they reply, everything carries on exactly as it does now.

---

## Status

**Live:** WhatsApp ingestion, AI qualifying and replies, approvals, knowledge base, templates,
lead scoring, event-aware follow-ups, new-lead alerts, 10-minute escalation call, event reminders,
booking countdown and the tomorrow call, self-chat assistant, Meta importer, per-chat AI toggle.

**Ready, off by default, never yet run against a live form:** the AI opening the chat with an
ad-form lead. Fully built and unit-tested, with its switch on the Lead Sources page — but no Meta
form is connected yet, so it has never sent a real one.

**Written and tested, not yet switched on:** payment follow-up. Logic and tests are done; it still
needs its daily runner and the reply routing wired in. Until then, nobody is asked about payment.

**Before going live:** clear `WHATSAPP_TEST_ALLOWED_NUMBERS` (right now every message from any
other number is silently dropped), set `OWNER_CALL_ESCALATION_DELAY_SECONDS=600`, and remove the
`dev-tools` module — it exposes a one-click wipe of all your data.

---

## Settings worth knowing

| Key | Default | What it does |
|---|---|---|
| `OWNER_CALL_ESCALATION_DELAY_SECONDS` | `600` | How long you have to reply before your phone rings |
| `LEAD_AUTO_GREET_DELAY_MS` | `300000` | Wait after someone fills the form before messaging (5 min) |
| `LEAD_AUTO_GREET_MAX_PER_TICK` | `5` | Ad-form leads the AI may message per round (max 25) |
| `LEAD_AUTO_GREET_SPACING_MS` | `20000` | Gap between those messages |
| `LEAD_AUTO_GREET_SWEEP_INTERVAL_MS` | `60000` | How often it checks whether a pause has elapsed |
| `VAPI_SCHEDULE_ASSISTANT_ID` | — | The "shooting tomorrow" voice assistant (separate from the new-lead one) |
| `LEAD_IMPORT_MAX_ROWS_PER_TICK` | `200` | Leads imported per round — importing is free, messaging isn't |
| `DIGEST_HOUR` | `9` | Morning read at :00, digest at :10, booking countdown at :20 |
