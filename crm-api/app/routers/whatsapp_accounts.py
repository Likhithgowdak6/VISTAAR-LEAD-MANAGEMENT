"""
FastAPI router for WhatsApp account management.

Ported from backend/src/modules/whatsapp-accounts/whatsapp-account.routes.ts
and whatsapp-account.controller.ts.

Endpoints:
- GET    /api/v1/whatsapp-accounts                (accounts.read)
- GET    /api/v1/whatsapp-accounts/sendable       (messages.send)
- POST   /api/v1/whatsapp-accounts                (accounts.manage)
- GET    /api/v1/whatsapp-accounts/{accountId}    (accounts.read)
- GET    /api/v1/whatsapp-accounts/{accountId}/qr (accounts.manage)
- POST   /api/v1/whatsapp-accounts/{accountId}/connect    (accounts.manage)
- POST   /api/v1/whatsapp-accounts/{accountId}/pause      (accounts.manage)
- POST   /api/v1/whatsapp-accounts/{accountId}/resume     (accounts.manage)
- POST   /api/v1/whatsapp-accounts/{accountId}/reset      (accounts.manage)
- POST   /api/v1/whatsapp-accounts/{accountId}/disconnect (accounts.manage)
- DELETE /api/v1/whatsapp-accounts/{accountId}            (accounts.manage)
"""

from __future__ import annotations

import re
from typing import Any

from bson import ObjectId
from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from pydantic import BaseModel, Field, field_validator

from app.deps import AuthContext, require_permission
from app.permissions import ACCOUNTS_MANAGE, ACCOUNTS_READ, MESSAGES_SEND
from app.whatsapp_accounts_service import (
    AccountBrandKeyExistsError,
    AccountError,
    AccountNotFoundError,
    WhatsAppAccountNotStartableError,
    WhatsAppAccountRequiredError,
    WhatsAppDisabledError,
    connect_account_for_actor,
    create_account_for_actor,
    disconnect_account_for_actor,
    get_account_for_organization,
    get_account_qr_for_actor,
    list_accounts_for_organization,
    list_sendable_accounts_for_actor,
    pause_account_for_actor,
    remove_account_for_actor,
    reset_account_for_actor,
    resume_account_for_actor,
)

router = APIRouter()

_require_accounts_read = require_permission(ACCOUNTS_READ)
_require_accounts_manage = require_permission(ACCOUNTS_MANAGE)
_require_messages_send = require_permission(MESSAGES_SEND)

OBJECT_ID_REGEX = re.compile(r"^[a-f\d]{24}$", re.IGNORECASE)
BRAND_KEY_REGEX = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
PHONE_REGEX = re.compile(r"^\+?[0-9\s()-]{8,20}$")


def validate_object_id(val: str, param_name: str = "accountId") -> ObjectId:
    if not val or not OBJECT_ID_REGEX.match(val):
        raise HTTPException(
            status_code=400,
            detail={"error": {"code": "VALIDATION_FAILED", "message": f"Invalid {param_name}."}},
        )
    return ObjectId(val)


def map_account_error(error: Exception) -> HTTPException:
    if isinstance(error, HTTPException):
        return error
    if isinstance(error, AccountNotFoundError):
        return HTTPException(
            status_code=404,
            detail={"error": {"code": error.code, "message": error.message}},
        )
    if isinstance(error, (AccountBrandKeyExistsError, WhatsAppDisabledError, WhatsAppAccountNotStartableError)):
        return HTTPException(
            status_code=409,
            detail={"error": {"code": error.code, "message": error.message}},
        )
    if isinstance(error, WhatsAppAccountRequiredError):
        return HTTPException(
            status_code=400,
            detail={"error": {"code": error.code, "message": error.message}},
        )
    if isinstance(error, AccountError):
        return HTTPException(
            status_code=400,
            detail={"error": {"code": error.code, "message": error.message}},
        )
    return HTTPException(
        status_code=500,
        detail={"error": {"code": "INTERNAL_SERVER_ERROR", "message": "Internal server error."}},
    )


class CreateAccountBody(BaseModel):
    name: str = Field(..., min_length=2, max_length=120)
    brandKey: str = Field(..., min_length=2, max_length=120)
    description: str | None = Field(None, max_length=500)

    @field_validator("name")
    @classmethod
    def validate_name(cls, v: str) -> str:
        s = v.strip()
        if len(s) < 2 or len(s) > 120:
            raise ValueError("name must be between 2 and 120 characters")
        return s

    @field_validator("brandKey")
    @classmethod
    def validate_brand_key(cls, v: str) -> str:
        s = v.strip().lower()
        if len(s) < 2 or len(s) > 120 or not BRAND_KEY_REGEX.match(s):
            raise ValueError("brandKey must be lowercase-with-hyphens")
        return s

    @field_validator("description")
    @classmethod
    def validate_description(cls, v: str | None) -> str | None:
        if v is None:
            return None
        s = v.strip()
        if len(s) > 500:
            raise ValueError("description must be at most 500 characters")
        return s or None


class ConnectAccountBody(BaseModel):
    pairingPhoneNumber: str | None = None

    @field_validator("pairingPhoneNumber")
    @classmethod
    def validate_phone(cls, v: str | None) -> str | None:
        if v is None:
            return None
        s = v.strip()
        if not s:
            return None
        if not PHONE_REGEX.match(s):
            raise ValueError("Enter a phone number with country code, digits only.")
        return s


@router.get("")
@router.get("/")
async def list_accounts(
    status_param: str | None = Query(None, alias="status"),
    limit: int = Query(50, ge=1, le=100),
    skip: int = Query(0, ge=0),
    auth: AuthContext = Depends(_require_accounts_read),
) -> dict[str, Any]:
    clean_status = status_param.strip() if status_param else None

    accounts = await list_accounts_for_organization(
        organization_id=auth.organization_id,
        status=clean_status,
        limit=limit,
        skip=skip,
    )
    return {
        "data": accounts,
        "meta": {"limit": limit, "skip": skip, "count": len(accounts)},
    }


@router.get("/sendable")
async def list_sendable_accounts(
    auth: AuthContext = Depends(_require_messages_send),
) -> dict[str, Any]:
    # Gated on messages.send, not accounts.read: staff hold no accounts permission at all,
    # and they still need to choose which number a reply goes out from.
    accounts = await list_sendable_accounts_for_actor(
        organization_id=auth.organization_id,
        actor=auth.user,
    )
    return {
        "data": accounts,
        "meta": {"count": len(accounts)},
    }


@router.post("", status_code=status.HTTP_201_CREATED)
@router.post("/", status_code=status.HTTP_201_CREATED)
async def create_account(
    body: CreateAccountBody,
    auth: AuthContext = Depends(_require_accounts_manage),
) -> dict[str, Any]:
    try:
        account = await create_account_for_actor(
            organization_id=auth.organization_id,
            actor=auth.user,
            name=body.name,
            brand_key=body.brandKey,
            description=body.description,
        )
        return {"data": account}
    except Exception as exc:
        raise map_account_error(exc) from exc


@router.get("/{accountId}")
async def get_account(
    accountId: str,
    auth: AuthContext = Depends(_require_accounts_read),
) -> dict[str, Any]:
    oid = validate_object_id(accountId)
    try:
        account = await get_account_for_organization(
            organization_id=auth.organization_id,
            account_id=oid,
        )
        return {"data": account}
    except Exception as exc:
        raise map_account_error(exc) from exc


@router.get("/{accountId}/qr")
async def get_account_qr(
    accountId: str,
    auth: AuthContext = Depends(_require_accounts_manage),
) -> dict[str, Any]:
    oid = validate_object_id(accountId)
    try:
        data = await get_account_qr_for_actor(
            organization_id=auth.organization_id,
            account_id=oid,
        )
        return {"data": data}
    except Exception as exc:
        raise map_account_error(exc) from exc


@router.post("/{accountId}/connect", status_code=status.HTTP_202_ACCEPTED)
async def connect_account(
    accountId: str,
    body: ConnectAccountBody | None = None,
    auth: AuthContext = Depends(_require_accounts_manage),
) -> dict[str, Any]:
    oid = validate_object_id(accountId)
    pairing_phone = body.pairingPhoneNumber if body else None
    try:
        account = await connect_account_for_actor(
            organization_id=auth.organization_id,
            account_id=oid,
            pairing_phone_number=pairing_phone,
        )
        return {"data": account}
    except Exception as exc:
        raise map_account_error(exc) from exc


@router.post("/{accountId}/pause")
async def pause_account(
    accountId: str,
    auth: AuthContext = Depends(_require_accounts_manage),
) -> dict[str, Any]:
    oid = validate_object_id(accountId)
    try:
        account = await pause_account_for_actor(
            organization_id=auth.organization_id,
            account_id=oid,
        )
        return {"data": account}
    except Exception as exc:
        raise map_account_error(exc) from exc


@router.post("/{accountId}/resume")
async def resume_account(
    accountId: str,
    auth: AuthContext = Depends(_require_accounts_manage),
) -> dict[str, Any]:
    oid = validate_object_id(accountId)
    try:
        account = await resume_account_for_actor(
            organization_id=auth.organization_id,
            account_id=oid,
        )
        return {"data": account}
    except Exception as exc:
        raise map_account_error(exc) from exc


@router.post("/{accountId}/reset")
async def reset_account(
    accountId: str,
    auth: AuthContext = Depends(_require_accounts_manage),
) -> dict[str, Any]:
    oid = validate_object_id(accountId)
    try:
        account = await reset_account_for_actor(
            organization_id=auth.organization_id,
            account_id=oid,
        )
        return {"data": account}
    except Exception as exc:
        raise map_account_error(exc) from exc


@router.post("/{accountId}/disconnect")
async def disconnect_account(
    accountId: str,
    auth: AuthContext = Depends(_require_accounts_manage),
) -> dict[str, Any]:
    oid = validate_object_id(accountId)
    try:
        account = await disconnect_account_for_actor(
            organization_id=auth.organization_id,
            account_id=oid,
        )
        return {"data": account}
    except Exception as exc:
        raise map_account_error(exc) from exc


@router.delete("/{accountId}")
async def remove_account(
    accountId: str,
    purgeHistory: str | None = Query("false"),
    auth: AuthContext = Depends(_require_accounts_manage),
) -> dict[str, Any]:
    auth.require_permission(ACCOUNTS_MANAGE)
    oid = validate_object_id(accountId)

    if purgeHistory is None or purgeHistory == "":
        purge_bool = False
    elif purgeHistory == "true":
        purge_bool = True
    elif purgeHistory == "false":
        purge_bool = False
    else:
        raise HTTPException(
            status_code=400,
            detail={"error": {"code": "VALIDATION_FAILED", "message": "Invalid purgeHistory parameter."}},
        )

    try:
        data = await remove_account_for_actor(
            organization_id=auth.organization_id,
            account_id=oid,
            actor=auth.user,
            purge_history=purge_bool,
        )
        return {"data": data}
    except Exception as exc:
        raise map_account_error(exc) from exc
