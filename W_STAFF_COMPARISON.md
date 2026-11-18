# W-Staff ZIP comparison

Compared `w-crm-main.zip` with Vistaar at commit `25e1f92` before making changes.
The ZIP is an older version of this CRM, not a separate staff application.

| ZIP capability | Current project | Action |
| --- | --- | --- |
| Baileys accounts and QR pairing | Already implemented | Keep existing account/session flows |
| Team roles, assignments and protected phone reveal | Already implemented, with per-member phone controls | Keep current permissions |
| Tags, stages, notes and activity history | Already implemented | Keep current screens |
| Follow-up tasks | Already implemented with richer reminders and rescheduling | Keep current reminders |
| AI business knowledge | Existing knowledge dialog supports raw notes, optional rewrites and editing | Keep current dialog |
| Reviewed AI reply suggestions | Backend endpoint remained, but composer entry point had been replaced by the template writer | Add Suggest reply alongside templates |
| `whatsapp-admin://open` shortcut | Same unresolved external shortcut in both projects | Do not pretend the ZIP implements its handler |

## Addition

Users with both AI-generation and message-send permission can open Suggest reply for
the current conversation, explicitly generate a draft, edit it, and insert it into
the composer. Generating or inserting never sends a message. Existing text requires
confirmation before replacement. Closing the dialog cancels its pending browser request.
The existing template writer, starred messages, attachments and send flow remain available.

The existing draft endpoint retains conversation visibility checks, its hourly limit,
and business-knowledge context. Provider configuration errors and upstream failures
now return errors instead of the previous hardcoded fallback greeting. Generation
uses the configured Anthropic, Grok or Groq provider and configured model; no keys or
production settings are added or changed by this implementation.

This addition does not restore the ZIP's draft-outcome reporting in the send flow.
The manual message-send contract remains unchanged.

## Preservation

A tracked-source ZIP was saved beside the repository before edits:
`Vistaar-before-wstaff-20261117-143208.zip`. It excludes ignored environment files,
dependencies and customer/session data. Existing Git history and the original ZIP
are unchanged. No wholesale file imports, production writes or WhatsApp sends are
part of this change. Deployment and device testing are separate steps.
