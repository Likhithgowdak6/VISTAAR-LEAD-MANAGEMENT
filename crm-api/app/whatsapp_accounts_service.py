"""
WhatsApp account service business logic.

Ported from backend/src/modules/whatsapp-accounts/whatsapp-account.service.ts
and whatsapp-account.serializer.ts.

Responsibilities:
- Accounts listing and retrieval with runtime connection state.
- Sendable accounts listing filtered by user account-access restrictions.
- Account creation with uniqueness check on brandKey.
- Lifecycle actions: connect (QR/pairing), pause, resume, reset (deletes Baileys auth), disconnect.
- Dual-mode account removal:
  - If unreferenced or purgeHistory=True: hard delete with Baileys auth cleanup and audit logging.
  - If referenced and purgeHistory=False: soft-remove (status='removed') keeping history intact.
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Any, Callable, Coroutine, Protocol

from bson import ObjectId

from app.audit import create_audit_log
from app.whatsapp_accounts_repository import (
    ACCOUNT_STATUS_ACTIVE,
    ACCOUNT_STATUS_DISCONNECTED,
    ACCOUNT_STATUS_PAUSED,
    ACCOUNT_STATUS_REMOVED,
    count_account_references as default_count_references,
    create_account_record as default_create_account_record,
    find_account_by_brand_key as default_find_account_by_brand_key,
    find_account_by_id as default_find_account_by_id,
    find_accounts_by_organization as default_find_accounts_by_organization,
    hard_delete_account as default_hard_delete,
    purge_account_data as default_purge_data,
    soft_remove_account as default_soft_remove,
    update_account_status as default_update_account_status,
)

logger = logging.getLogger(__name__)

ACCOUNT_REMOVAL_DELETED = "deleted"
ACCOUNT_REMOVAL_HIDDEN = "hidden"
ACCOUNT_REMOVAL_PURGED = "purged"

AUDIT_EVENT_WHATSAPP_ACCOUNT_DELETED = "WHATSAPP_ACCOUNT_DELETED"


class AccountError(Exception):
    """Base exception for WhatsApp account domain errors."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class AccountNotFoundError(AccountError):
    def __init__(self) -> None:
        super().__init__("ACCOUNT_NOT_FOUND", "WhatsApp account not found.")


class AccountBrandKeyExistsError(AccountError):
    def __init__(self) -> None:
        super().__init__("ACCOUNT_BRAND_KEY_EXISTS", "A WhatsApp account with this brand key already exists.")


class WhatsAppDisabledError(AccountError):
    def __init__(self) -> None:
        super().__init__("WHATSAPP_DISABLED", "WhatsApp connections are disabled (WHATSAPP_ENABLED).")


class WhatsAppAccountNotStartableError(AccountError):
    def __init__(self) -> None:
        super().__init__("WHATSAPP_ACCOUNT_NOT_STARTABLE", "This account cannot be connected from its current status.")


class WhatsAppAccountRequiredError(AccountError):
    def __init__(self) -> None:
        super().__init__("WHATSAPP_ACCOUNT_REQUIRED", "Account is required.")


class SessionManagerProtocol(Protocol):
    """Protocol for WhatsApp session manager communication."""

    def get_session_state(self, account_id: Any) -> dict[str, Any]: ...

    async def connect_account(self, account: dict[str, Any], pairing_phone_number: str | None = None) -> None: ...

    async def disconnect_account(
        self,
        account_id: Any,
        organization_id: Any = None,
        status: str = "disconnected",
        disconnect_code: str | None = None,
        disconnect_reason: str | None = None,
    ) -> None: ...

    async def get_qr_data_url(self, account_id: Any) -> str | None: ...

    def get_pairing_code(self, account_id: Any) -> str | None: ...


class DefaultSessionManager:
    """In-memory fallback session manager when the external Baileys gateway is accessed via shared state."""

    def __init__(self) -> None:
        self._states: dict[str, dict[str, Any]] = {}

    def get_session_state(self, account_id: Any) -> dict[str, Any]:
        return self._states.get(str(account_id), {"running": False, "qrAvailable": False})

    async def connect_account(self, account: dict[str, Any], pairing_phone_number: str | None = None) -> None:
        key = str(account.get("_id", ""))
        self._states[key] = {"running": True, "qrAvailable": True, "pairingMode": bool(pairing_phone_number)}

    async def disconnect_account(
        self,
        account_id: Any,
        organization_id: Any = None,
        status: str = "disconnected",
        disconnect_code: str | None = None,
        disconnect_reason: str | None = None,
    ) -> None:
        key = str(account_id)
        if key in self._states:
            self._states[key]["running"] = False
            self._states[key]["qrAvailable"] = False
        if organization_id:
            try:
                await default_update_account_status(
                    account_id=account_id,
                    organization_id=organization_id,
                    status=status,
                    disconnect_code=disconnect_code,
                    disconnect_reason=disconnect_reason,
                )
            except Exception:
                pass

    async def get_qr_data_url(self, account_id: Any) -> str | None:
        return None

    def get_pairing_code(self, account_id: Any) -> str | None:
        return None


_global_session_manager: SessionManagerProtocol = DefaultSessionManager()


def get_session_manager() -> SessionManagerProtocol:
    return _global_session_manager


def set_session_manager(manager: SessionManagerProtocol) -> None:
    global _global_session_manager
    _global_session_manager = manager


def serialize_date(val: Any) -> str | None:
    if val is None:
        return None
    if isinstance(val, datetime):
        return val.isoformat()
    return str(val)


def serialize_id(val: Any) -> str | None:
    if val is None:
        return None
    return str(val)


def serialize_whatsapp_account(doc: dict[str, Any] | None) -> dict[str, Any] | None:
    """Serializes a WhatsApp account document matching Express output."""
    if not doc:
        return None

    settings = doc.get("settings") or {}
    return {
        "id": serialize_id(doc.get("_id")),
        "organizationId": serialize_id(doc.get("organizationId")),
        "name": doc.get("name"),
        "description": doc.get("description"),
        "brandKey": doc.get("brandKey"),
        "status": doc.get("status"),
        "ownerUserId": serialize_id(doc.get("ownerUserId")),
        "settings": {
            "outboundIntervalMs": settings.get("outboundIntervalMs"),
            "aiEnabled": bool(settings.get("aiEnabled", False)),
        },
        "lastConnectedAt": serialize_date(doc.get("lastConnectedAt")),
        "lastDisconnectedAt": serialize_date(doc.get("lastDisconnectedAt")),
        "disconnectCode": doc.get("disconnectCode"),
        "disconnectReason": doc.get("disconnectReason"),
        "removedAt": serialize_date(doc.get("removedAt")),
        "createdBy": serialize_id(doc.get("createdBy")),
        "updatedBy": serialize_id(doc.get("updatedBy")),
        "createdAt": serialize_date(doc.get("createdAt")),
        "updatedAt": serialize_date(doc.get("updatedAt")),
    }


def serialize_account_removal(
    outcome: str,
    account: dict[str, Any] | None,
    references: dict[str, int],
    purged: dict[str, int] | None = None,
) -> dict[str, Any]:
    """Formats the outcome of an account removal operation."""
    return {
        "outcome": outcome,
        "account": serialize_whatsapp_account(account),
        "references": {
            "conversations": references.get("conversations", 0),
            "messages": references.get("messages", 0),
            "leadSources": references.get("leadSources", 0),
            "total": references.get("total", 0),
        },
        "purged": purged,
    }


def with_runtime(
    account: dict[str, Any],
    session_manager: SessionManagerProtocol | None = None,
) -> dict[str, Any]:
    """Attaches live socket runtime state to a serialized account."""
    manager = session_manager or get_session_manager()
    serialized = serialize_whatsapp_account(account) or {}
    runtime_state = manager.get_session_state(account.get("_id"))
    return {
        **serialized,
        "runtime": {
            "running": bool(runtime_state.get("running", False)),
            "qrAvailable": bool(runtime_state.get("qrAvailable", False)),
        },
    }


async def _load_account(
    organization_id: Any,
    account_id: Any,
    find_account: Callable[..., Coroutine[Any, Any, dict[str, Any] | None]] = default_find_account_by_id,
) -> dict[str, Any]:
    account = await find_account(account_id=account_id, organization_id=organization_id)
    if not account:
        raise AccountNotFoundError()
    return account


async def list_accounts_for_organization(
    organization_id: Any,
    status: str | None = None,
    limit: int = 50,
    skip: int = 0,
    find_accounts: Callable[..., Coroutine[Any, Any, list[dict[str, Any]]]] = default_find_accounts_by_organization,
    session_manager: SessionManagerProtocol | None = None,
) -> list[dict[str, Any]]:
    """Lists accounts for an organization with attached runtime state."""
    accounts = await find_accounts(
        organization_id=organization_id,
        status=status,
        limit=limit,
        skip=skip,
    )
    manager = session_manager or get_session_manager()
    return [with_runtime(account, manager) for account in accounts]


def filter_accessible_accounts(actor: Any, accounts: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """
    Filters accounts an actor has permission to see/send from.
    An empty accountAccess list or mode 'all' grants unrestricted access.
    """
    mode = getattr(actor, "account_access_mode", None) or (actor.get("accountAccessMode") if isinstance(actor, dict) else None)
    if mode == "all":
        return list(accounts)

    allowed = getattr(actor, "account_access", None) or (actor.get("accountAccess") if isinstance(actor, dict) else None)
    if not allowed:
        return list(accounts)

    allowed_ids = {str(item) for item in allowed}
    return [acct for acct in accounts if str(acct.get("_id")) in allowed_ids]


async def list_sendable_accounts_for_actor(
    organization_id: Any,
    actor: Any,
    find_accounts: Callable[..., Coroutine[Any, Any, list[dict[str, Any]]]] = default_find_accounts_by_organization,
    session_manager: SessionManagerProtocol | None = None,
) -> list[dict[str, Any]]:
    """
    Numbers a staff user may send from right now.
    Returns only active, running accounts with name and brandKey.
    """
    accounts = await find_accounts(
        organization_id=organization_id,
        status=ACCOUNT_STATUS_ACTIVE,
        limit=100,
    )
    manager = session_manager or get_session_manager()
    accessible = filter_accessible_accounts(actor, accounts)

    return [
        {
            "id": str(account["_id"]),
            "name": account.get("name"),
            "brandKey": account.get("brandKey"),
        }
        for account in accessible
        if manager.get_session_state(account["_id"]).get("running") is True
    ]


async def create_account_for_actor(
    organization_id: Any,
    actor: Any,
    name: str,
    brand_key: str,
    description: str | None = None,
    find_brand_key: Callable[..., Coroutine[Any, Any, dict[str, Any] | None]] = default_find_account_by_brand_key,
    create_account: Callable[..., Coroutine[Any, Any, dict[str, Any]]] = default_create_account_record,
    session_manager: SessionManagerProtocol | None = None,
) -> dict[str, Any]:
    """Creates a new WhatsApp account for the organization."""
    existing = await find_brand_key(organization_id=organization_id, brand_key=brand_key)
    if existing:
        raise AccountBrandKeyExistsError()

    actor_id = getattr(actor, "id", None) or getattr(actor, "_id", None) or (actor.get("_id") if isinstance(actor, dict) else None)
    account = await create_account(
        {
            "organizationId": organization_id,
            "name": name,
            "brandKey": brand_key,
            "description": description,
            "ownerUserId": actor_id,
            "createdBy": actor_id,
        }
    )
    return with_runtime(account, session_manager)


async def get_account_for_organization(
    organization_id: Any,
    account_id: Any,
    find_account: Callable[..., Coroutine[Any, Any, dict[str, Any] | None]] = default_find_account_by_id,
    session_manager: SessionManagerProtocol | None = None,
) -> dict[str, Any]:
    account = await _load_account(organization_id, account_id, find_account)
    return with_runtime(account, session_manager)


async def connect_account_for_actor(
    organization_id: Any,
    account_id: Any,
    pairing_phone_number: str | None = None,
    find_account: Callable[..., Coroutine[Any, Any, dict[str, Any] | None]] = default_find_account_by_id,
    session_manager: SessionManagerProtocol | None = None,
) -> dict[str, Any]:
    account = await _load_account(organization_id, account_id, find_account)
    manager = session_manager or get_session_manager()
    await manager.connect_account(account=account, pairing_phone_number=pairing_phone_number)
    refreshed = await _load_account(organization_id, account_id, find_account)
    return with_runtime(refreshed, manager)


async def get_account_qr_for_actor(
    organization_id: Any,
    account_id: Any,
    find_account: Callable[..., Coroutine[Any, Any, dict[str, Any] | None]] = default_find_account_by_id,
    session_manager: SessionManagerProtocol | None = None,
) -> dict[str, Any]:
    await _load_account(organization_id, account_id, find_account)
    manager = session_manager or get_session_manager()
    qr_data_url = await manager.get_qr_data_url(account_id)
    pairing_code = manager.get_pairing_code(account_id) if hasattr(manager, "get_pairing_code") else None
    return {"qrDataUrl": qr_data_url or None, "pairingCode": pairing_code or None}


async def pause_account_for_actor(
    organization_id: Any,
    account_id: Any,
    find_account: Callable[..., Coroutine[Any, Any, dict[str, Any] | None]] = default_find_account_by_id,
    session_manager: SessionManagerProtocol | None = None,
) -> dict[str, Any]:
    await _load_account(organization_id, account_id, find_account)
    manager = session_manager or get_session_manager()
    await manager.disconnect_account(
        account_id=account_id,
        organization_id=organization_id,
        status=ACCOUNT_STATUS_PAUSED,
        disconnect_code="manual_pause",
        disconnect_reason="Account paused from the app.",
    )
    await default_update_account_status(
        account_id=account_id,
        organization_id=organization_id,
        status=ACCOUNT_STATUS_PAUSED,
        disconnect_code="manual_pause",
        disconnect_reason="Account paused from the app.",
    )
    refreshed = await _load_account(organization_id, account_id, find_account)
    return with_runtime(refreshed, manager)


async def resume_account_for_actor(
    organization_id: Any,
    account_id: Any,
    find_account: Callable[..., Coroutine[Any, Any, dict[str, Any] | None]] = default_find_account_by_id,
    update_status: Callable[..., Coroutine[Any, Any, dict[str, Any] | None]] = default_update_account_status,
    session_manager: SessionManagerProtocol | None = None,
) -> dict[str, Any]:
    await _load_account(organization_id, account_id, find_account)
    updated = await update_status(
        account_id=account_id,
        organization_id=organization_id,
        status=ACCOUNT_STATUS_DISCONNECTED,
        disconnect_code="manual_resume",
        disconnect_reason="Account resumed; ready to connect.",
    )
    return with_runtime(updated or {}, session_manager)


async def reset_account_for_actor(
    organization_id: Any,
    account_id: Any,
    find_account: Callable[..., Coroutine[Any, Any, dict[str, Any] | None]] = default_find_account_by_id,
    session_manager: SessionManagerProtocol | None = None,
    delete_auth: Callable[..., Coroutine[Any, Any, Any]] | None = None,
) -> dict[str, Any]:
    await _load_account(organization_id, account_id, find_account)
    manager = session_manager or get_session_manager()
    await manager.disconnect_account(
        account_id=account_id,
        organization_id=organization_id,
        status=ACCOUNT_STATUS_DISCONNECTED,
        disconnect_code="connection_reset",
        disconnect_reason="Connection reset; stored login was cleared.",
    )
    await default_update_account_status(
        account_id=account_id,
        organization_id=organization_id,
        status=ACCOUNT_STATUS_DISCONNECTED,
        disconnect_code="connection_reset",
        disconnect_reason="Connection reset; stored login was cleared.",
    )
    if delete_auth:
        await delete_auth(organization_id=organization_id, account_id=account_id)
    refreshed = await _load_account(organization_id, account_id, find_account)
    return with_runtime(refreshed, manager)


async def disconnect_account_for_actor(
    organization_id: Any,
    account_id: Any,
    find_account: Callable[..., Coroutine[Any, Any, dict[str, Any] | None]] = default_find_account_by_id,
    session_manager: SessionManagerProtocol | None = None,
) -> dict[str, Any]:
    await _load_account(organization_id, account_id, find_account)
    manager = session_manager or get_session_manager()
    await manager.disconnect_account(
        account_id=account_id,
        organization_id=organization_id,
        status=ACCOUNT_STATUS_DISCONNECTED,
        disconnect_code="manual_disconnect",
        disconnect_reason="Disconnected from the app.",
    )
    await default_update_account_status(
        account_id=account_id,
        organization_id=organization_id,
        status=ACCOUNT_STATUS_DISCONNECTED,
        disconnect_code="manual_disconnect",
        disconnect_reason="Disconnected from the app.",
    )
    refreshed = await _load_account(organization_id, account_id, find_account)
    return with_runtime(refreshed, manager)


def create_account_removal_service(
    find_account: Callable[..., Coroutine[Any, Any, dict[str, Any] | None]] = default_find_account_by_id,
    count_references: Callable[..., Coroutine[Any, Any, dict[str, int]]] = default_count_references,
    hard_delete: Callable[..., Coroutine[Any, Any, dict[str, int]]] = default_hard_delete,
    purge_data: Callable[..., Coroutine[Any, Any, dict[str, int]]] = default_purge_data,
    soft_remove: Callable[..., Coroutine[Any, Any, dict[str, Any] | None]] = default_soft_remove,
    record_audit: Callable[..., Coroutine[Any, Any, Any]] = create_audit_log,
    session_manager_provider: Callable[[], SessionManagerProtocol] = get_session_manager,
):
    """
    Factory creating account removal service with dependency injection.
    Handles soft removal when threads exist, or complete purge / hard-delete when unreferenced or requested.
    """

    async def remove_account_for_actor(
        organization_id: Any,
        account_id: Any,
        actor: Any,
        purge_history: bool = False,
    ) -> dict[str, Any]:
        account = await find_account(account_id=account_id, organization_id=organization_id)
        if not account:
            raise AccountNotFoundError()

        actor_id = getattr(actor, "id", None) or getattr(actor, "_id", None) or (actor.get("_id") if isinstance(actor, dict) else None)
        manager = session_manager_provider()
        await manager.disconnect_account(
            account_id=account_id,
            organization_id=organization_id,
            status=ACCOUNT_STATUS_REMOVED,
            disconnect_code="account_removed",
            disconnect_reason="Account removed from the app.",
        )

        references = await count_references(account_id=account_id, organization_id=organization_id)

        purged = None
        if purge_history and references.get("total", 0) > 0:
            purged = await purge_data(account_id=account_id, organization_id=organization_id)

        if not purged and references.get("total", 0) > 0:
            soft_removed = await soft_remove(
                account_id=account_id,
                organization_id=organization_id,
                actor_id=actor_id,
            )
            return serialize_account_removal(
                outcome=ACCOUNT_REMOVAL_HIDDEN,
                account=soft_removed or account,
                references=references,
            )

        deletion = await hard_delete(account_id=account_id, organization_id=organization_id)

        try:
            await record_audit(
                organization_id=ObjectId(str(account["organizationId"])),
                event_type=AUDIT_EVENT_WHATSAPP_ACCOUNT_DELETED,
                actor_id=ObjectId(str(actor_id)) if actor_id else None,
                metadata={
                    "whatsappAccountId": str(account["_id"]),
                    "name": account.get("name"),
                    "brandKey": account.get("brandKey"),
                    "deletedAuthStates": deletion.get("deletedAuthStates", 0),
                    "purged": purged,
                },
            )
        except Exception as exc:
            logger.error("Could not record audit log for account deletion: %s", exc)

        return serialize_account_removal(
            outcome=ACCOUNT_REMOVAL_PURGED if purged else ACCOUNT_REMOVAL_DELETED,
            account=account,
            references=references,
            purged=purged,
        )

    return remove_account_for_actor


_default_removal_service = create_account_removal_service()


async def remove_account_for_actor(
    organization_id: Any,
    account_id: Any,
    actor: Any,
    purge_history: bool = False,
) -> dict[str, Any]:
    return await _default_removal_service(
        organization_id=organization_id,
        account_id=account_id,
        actor=actor,
        purge_history=purge_history,
    )

