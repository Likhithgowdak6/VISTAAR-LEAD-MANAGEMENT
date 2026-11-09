"""
Machine-checkable route parity verifier.
Compares every route declared in compiled Express routers with FastAPI routes.
"""

import re
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent))
from app.main import app

# Canonical 129 Express routes dumped from backend/dist:
EXPRESS_ROUTES = [
    "DELETE /api/v1/ai/knowledge/:knowledgeId",
    "DELETE /api/v1/conversations/:conversationId",
    "DELETE /api/v1/conversations/:conversationId/notes/:noteId",
    "DELETE /api/v1/conversations/:conversationId/tags/:tagId",
    "DELETE /api/v1/lead-sources/:leadSourceId",
    "DELETE /api/v1/lead-sources/meta/connection",
    "DELETE /api/v1/push/devices",
    "DELETE /api/v1/stages/:stageId",
    "DELETE /api/v1/starred-messages/:starredMessageId",
    "DELETE /api/v1/templates/:templateId",
    "DELETE /api/v1/whatsapp-accounts/:accountId",
    "GET /api/v1/ai-brain/approvals",
    "GET /api/v1/ai-brain/conversations/:conversationId/approval",
    "GET /api/v1/ai/knowledge",
    "GET /api/v1/analytics/ai-performance",
    "GET /api/v1/analytics/attention",
    "GET /api/v1/analytics/attention.csv",
    "GET /api/v1/analytics/breakdowns",
    "GET /api/v1/analytics/overview",
    "GET /api/v1/analytics/reminders",
    "GET /api/v1/analytics/trends",
    "GET /api/v1/auth/me",
    "GET /api/v1/calls/:callId",
    "GET /api/v1/contacts/:contactId",
    "GET /api/v1/conversations",
    "GET /api/v1/conversations/:conversationId",
    "GET /api/v1/conversations/:conversationId/activity",
    "GET /api/v1/conversations/:conversationId/calls",
    "GET /api/v1/conversations/:conversationId/follow-ups",
    "GET /api/v1/conversations/:conversationId/lead-submissions",
    "GET /api/v1/conversations/:conversationId/messages",
    "GET /api/v1/conversations/:conversationId/notes",
    "GET /api/v1/conversations/:conversationId/summary",
    "GET /api/v1/conversations/meta/ai-categories",
    "GET /api/v1/follow-ups",
    "GET /api/v1/follow-ups/tasks",
    "GET /api/v1/health",
    "GET /api/v1/health/readiness",
    "GET /api/v1/lead-sources",
    "GET /api/v1/lead-sources/meta/connection",
    "GET /api/v1/lead-sources/meta/diagnostics",
    "GET /api/v1/lead-sources/meta/field-keys",
    "GET /api/v1/lead-sources/meta/oauth/start",
    "GET /api/v1/lead-sources/meta/pages",
    "GET /api/v1/lead-sources/meta/pages/:pageId/forms",
    "GET /api/v1/lead-sources/meta/pages/:pageId/forms/:formId/fields",
    "GET /api/v1/messages/:messageId/media",
    "GET /api/v1/meta/oauth/callback",
    "GET /api/v1/meta/webhook",
    "GET /api/v1/push/status",
    "GET /api/v1/realtime/stream",
    "GET /api/v1/settings",
    "GET /api/v1/stages",
    "GET /api/v1/starred-messages",
    "GET /api/v1/tags",
    "GET /api/v1/templates",
    "GET /api/v1/users",
    "GET /api/v1/users/:userId",
    "GET /api/v1/whatsapp-accounts",
    "GET /api/v1/whatsapp-accounts/:accountId",
    "GET /api/v1/whatsapp-accounts/:accountId/qr",
    "GET /api/v1/whatsapp-accounts/sendable",
    "PATCH /api/v1/ai/knowledge/:knowledgeId",
    "PATCH /api/v1/ai/knowledge/:knowledgeId/archive",
    "PATCH /api/v1/calls/:callId/outcome",
    "PATCH /api/v1/conversations/:conversationId/ai-draft/:draftId/outcome",
    "PATCH /api/v1/conversations/:conversationId/assignment",
    "PATCH /api/v1/conversations/:conversationId/category",
    "PATCH /api/v1/conversations/:conversationId/stage",
    "PATCH /api/v1/follow-ups/:taskId/cancel",
    "PATCH /api/v1/follow-ups/:taskId/complete",
    "PATCH /api/v1/follow-ups/:taskId/reschedule",
    "PATCH /api/v1/lead-sources/:leadSourceId",
    "PATCH /api/v1/settings",
    "PATCH /api/v1/stages/:stageId/archive",
    "PATCH /api/v1/starred-messages/:starredMessageId",
    "PATCH /api/v1/tags/:tagId/archive",
    "PATCH /api/v1/users/:userId",
    "PATCH /api/v1/users/:userId/disable",
    "PATCH /api/v1/users/:userId/enable",
    "PATCH /api/v1/users/:userId/reset-password",
    "POST /api/v1/ai-brain/conversations/:conversationId/approval/resolve",
    "POST /api/v1/ai-brain/conversations/:conversationId/automation",
    "POST /api/v1/ai-brain/conversations/:conversationId/nurture",
    "POST /api/v1/ai-brain/conversations/:conversationId/outcome/check",
    "POST /api/v1/ai-brain/conversations/:conversationId/proposal/generate",
    "POST /api/v1/ai-brain/conversations/:conversationId/proposal/render",
    "POST /api/v1/ai-brain/proposal/revise",
    "POST /api/v1/ai/knowledge",
    "POST /api/v1/ai/knowledge/optimize",
    "POST /api/v1/auth/change-password",
    "POST /api/v1/auth/login",
    "POST /api/v1/auth/logout",
    "POST /api/v1/auth/logout-all",
    "POST /api/v1/auth/refresh",
    "POST /api/v1/contacts/:contactId/reveal-phone",
    "POST /api/v1/conversations",
    "POST /api/v1/conversations/:conversationId/ai-draft",
    "POST /api/v1/conversations/:conversationId/call-outcome",
    "POST /api/v1/conversations/:conversationId/calls",
    "POST /api/v1/conversations/:conversationId/follow-ups",
    "POST /api/v1/conversations/:conversationId/media",
    "POST /api/v1/conversations/:conversationId/messages",
    "POST /api/v1/conversations/:conversationId/notes",
    "POST /api/v1/conversations/:conversationId/restore",
    "POST /api/v1/conversations/:conversationId/summary",
    "POST /api/v1/conversations/:conversationId/tags",
    "POST /api/v1/follow-ups",
    "POST /api/v1/follow-ups/sync",
    "POST /api/v1/lead-sources",
    "POST /api/v1/lead-sources/:leadSourceId/sync",
    "POST /api/v1/lead-sources/meta/forms",
    "POST /api/v1/lead-sources/meta/sources",
    "POST /api/v1/lead-sources/meta/sources/:leadSourceId/subscribe",
    "POST /api/v1/lead-sources/meta/test-connection",
    "POST /api/v1/meta/webhook",
    "POST /api/v1/push/devices",
    "POST /api/v1/stages",
    "POST /api/v1/starred-messages",
    "POST /api/v1/tags",
    "POST /api/v1/templates",
    "POST /api/v1/templates/generate",
    "POST /api/v1/users",
    "POST /api/v1/whatsapp-accounts",
    "POST /api/v1/whatsapp-accounts/:accountId/connect",
    "POST /api/v1/whatsapp-accounts/:accountId/disconnect",
    "POST /api/v1/whatsapp-accounts/:accountId/pause",
    "POST /api/v1/whatsapp-accounts/:accountId/reset",
    "POST /api/v1/whatsapp-accounts/:accountId/resume",
]

def normalize_path(p: str) -> str:
    p = re.sub(r':([a-zA-Z0-9_]+)', r'{\1}', p)
    p = re.sub(r'\{([a-zA-Z0-9_]+)\}', lambda m: '{' + m.group(1).lower().replace('_', '') + '}', p)
    return p.rstrip('/') or '/'

def main():
    express_set = set()
    for line in EXPRESS_ROUTES:
        m, p = line.split(' ')
        express_set.add(f"{m} {normalize_path(p)}")

    fastapi_set = set()
    for r in app.routes:
        methods = getattr(r, 'methods', None)
        if methods:
            for m in methods:
                if m not in ('HEAD', 'OPTIONS'):
                    fastapi_set.add(f"{m} {normalize_path(r.path)}")

    missing_in_fastapi = express_set - fastapi_set
    extra_in_fastapi = fastapi_set - express_set

    print(f"Total Express Routes: {len(express_set)}")
    print(f"Total FastAPI Normalized Routes: {len(fastapi_set)}")

    if missing_in_fastapi:
        print("\n[FAIL] Missing routes in FastAPI:")
        for r in sorted(missing_in_fastapi):
            print(f"  - {r}")
        sys.exit(1)
    else:
        print("\n[PASS] All Express routes are present in FastAPI! (0 missing routes)")

    if extra_in_fastapi:
        print("\n[INFO] Additional routes in FastAPI:")
        for r in sorted(extra_in_fastapi):
            print(f"  + {r}")

    print("\nMachine-checkable Route Parity Verification: 100% OK")

if __name__ == "__main__":
    main()
