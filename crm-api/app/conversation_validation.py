"""
Validation schemas for conversation routes.

A PORT OF backend/src/modules/conversations/conversation.validation.ts.

All regexes and bounds match Node exactly:
- ObjectIds are 24-hex characters.
- Stage keys match `^[a-z0-9]+(?:-[a-z0-9]+)*$` (kebab-case).
- Category keys match `^[a-z0-9]+(?:_[a-z0-9]+)*$` (snake_case).
- Search query is bounded to 120 characters before becoming a regex in Mongo.
"""

from datetime import datetime
import re
from typing import Any, Optional

from pydantic import BaseModel, Field, field_validator, model_validator

OBJECT_ID_REGEX = re.compile(r"^[a-fA-F0-9]{24}$")
STAGE_REGEX = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
CATEGORY_REGEX = re.compile(r"^[a-z0-9]+(?:_[a-z0-9]+)*$")

CONVERSATION_STATUS_VALUES = ("open", "closed", "snoozed", "archived")
ENQUIRY_CLASS_VALUES = ("service_enquiry", "support", "spam_or_irrelevant", "unclear")
AI_RESPONSE_STATUS_VALUES = (
    "needs_reply",
    "unanswered_lead",
    "agent_replied",
    "lead_replied",
    "closed",
)


def validate_object_id(v: Any) -> str:
    if not isinstance(v, str) or not OBJECT_ID_REGEX.match(v):
        raise ValueError("Invalid ObjectId format; must be a 24-character hex string.")
    return v


class ListConversationsQuery(BaseModel):
    whatsappAccountId: Optional[str] = None
    stage: Optional[str] = None
    tagIds: Optional[list[str]] = None
    status: Optional[str] = None
    enquiryClass: Optional[str] = None
    aiStatus: Optional[str] = None
    needsAttention: Optional[bool] = None
    search: Optional[str] = None
    limit: int = Field(default=50, ge=1, le=100)
    skip: int = Field(default=0, ge=0)

    @field_validator("whatsappAccountId")
    @classmethod
    def check_whatsapp_account_id(cls, v: Optional[str]) -> Optional[str]:
        return validate_object_id(v) if v else None

    @field_validator("stage")
    @classmethod
    def check_stage(cls, v: Optional[str]) -> Optional[str]:
        if not v:
            return None
        cleaned = v.strip().lower()
        if not (1 <= len(cleaned) <= 60 and STAGE_REGEX.match(cleaned)):
            raise ValueError("Stage must be kebab-case 1-60 characters.")
        return cleaned

    @field_validator("search")
    @classmethod
    def check_search(cls, v: Optional[str]) -> Optional[str]:
        if not v:
            return None
        cleaned = v.strip()
        if not (1 <= len(cleaned) <= 120):
            raise ValueError("Search must be 1-120 characters.")
        return cleaned


class AssignConversationBody(BaseModel):
    assignedTo: Optional[str] = None
    assignedTeam: Optional[str] = None

    @field_validator("assignedTo")
    @classmethod
    def check_assigned_to(cls, v: Optional[str]) -> Optional[str]:
        return validate_object_id(v) if v else None

    @model_validator(mode="after")
    def check_at_least_one(self) -> "AssignConversationBody":
        if self.assignedTo is None and self.assignedTeam is None:
            raise ValueError("assignedTo or assignedTeam is required.")
        return self


class ChangeStageBody(BaseModel):
    stage: str

    @field_validator("stage")
    @classmethod
    def check_stage(cls, v: str) -> str:
        cleaned = v.strip().lower()
        if not (1 <= len(cleaned) <= 60 and STAGE_REGEX.match(cleaned)):
            raise ValueError("Stage must be kebab-case 1-60 characters.")
        return cleaned


class ChangeCategoryBody(BaseModel):
    aiCategory: str

    @field_validator("aiCategory")
    @classmethod
    def check_category(cls, v: str) -> str:
        cleaned = v.strip().lower()
        if not (1 <= len(cleaned) <= 60 and CATEGORY_REGEX.match(cleaned)):
            raise ValueError("aiCategory must be snake_case 1-60 characters.")
        return cleaned


class CreateManualLeadBody(BaseModel):
    phone: str
    whatsappAccountId: str
    displayName: Optional[str] = None
    aiCategory: Optional[str] = None
    eventDate: Optional[str] = None
    originNote: Optional[str] = None
    greetNow: bool = False

    @field_validator("phone")
    @classmethod
    def check_phone(cls, v: str) -> str:
        cleaned = v.strip()
        if not (6 <= len(cleaned) <= 24 and any(c.isdigit() for c in cleaned)):
            raise ValueError("Phone number needs at least one digit and 6-24 chars.")
        return cleaned

    @field_validator("whatsappAccountId")
    @classmethod
    def check_account_id(cls, v: str) -> str:
        return validate_object_id(v.strip())

    @field_validator("aiCategory")
    @classmethod
    def check_cat(cls, v: Optional[str]) -> Optional[str]:
        if not v:
            return None
        cleaned = v.strip().lower()
        if not (len(cleaned) <= 60 and CATEGORY_REGEX.match(cleaned)):
            raise ValueError("aiCategory must be snake_case up to 60 characters.")
        return cleaned


class SendMessageBody(BaseModel):
    body: Optional[str] = Field(default=None, max_length=5000)
    idempotencyKey: str = Field(min_length=8, max_length=255)
    whatsappAccountId: Optional[str] = None
    media: Optional[dict[str, Any]] = None

    @field_validator("whatsappAccountId")
    @classmethod
    def check_account(cls, v: Optional[str]) -> Optional[str]:
        return validate_object_id(v) if v else None

    @model_validator(mode="after")
    def check_body_or_media(self) -> "SendMessageBody":
        has_body = self.body is not None and self.body.strip() != ""
        has_media = self.media is not None
        if not (has_body or has_media):
            raise ValueError("A message needs either text or an attachment.")
        return self


class RegenerateConversationSummaryBody(BaseModel):
    force: bool = False

