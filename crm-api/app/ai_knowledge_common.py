"""
Constants, Pydantic schemas, and serializers for AI Knowledge entries.

A DIRECT PORT OF backend/src/constants/ai-knowledge-statuses.ts,
ai-knowledge.validation.ts, and ai-knowledge.serializer.ts.

THE FOUR SECTIONS:
The dashboard renders four sections: COMPANY, SERVICES, PRICING, and RULES.
Older categories (POLICY, PRODUCT, FAQ, OTHER) predate them and are preserved so rows
written under those categories continue to load and remain editable.
"""

from __future__ import annotations

from typing import Any, Literal
from pydantic import BaseModel, Field, model_validator

from app.serialization import serialize_date, serialize_id


class AI_KNOWLEDGE_STATUSES:
    ACTIVE = "active"
    ARCHIVED = "archived"


AI_KNOWLEDGE_STATUS_VALUES = (AI_KNOWLEDGE_STATUSES.ACTIVE, AI_KNOWLEDGE_STATUSES.ARCHIVED)


class AI_KNOWLEDGE_CATEGORIES:
    COMPANY = "company"
    SERVICES = "services"
    PRICING = "pricing"
    RULES = "rules"
    POLICY = "policy"
    PRODUCT = "product"
    FAQ = "faq"
    OTHER = "other"


AI_KNOWLEDGE_SECTION_VALUES = (
    AI_KNOWLEDGE_CATEGORIES.COMPANY,
    AI_KNOWLEDGE_CATEGORIES.SERVICES,
    AI_KNOWLEDGE_CATEGORIES.PRICING,
    AI_KNOWLEDGE_CATEGORIES.RULES,
)

AI_KNOWLEDGE_CATEGORY_VALUES = (
    AI_KNOWLEDGE_CATEGORIES.COMPANY,
    AI_KNOWLEDGE_CATEGORIES.SERVICES,
    AI_KNOWLEDGE_CATEGORIES.PRICING,
    AI_KNOWLEDGE_CATEGORIES.RULES,
    AI_KNOWLEDGE_CATEGORIES.POLICY,
    AI_KNOWLEDGE_CATEGORIES.PRODUCT,
    AI_KNOWLEDGE_CATEGORIES.FAQ,
    AI_KNOWLEDGE_CATEGORIES.OTHER,
)

AiKnowledgeCategory = Literal[
    "company",
    "services",
    "pricing",
    "rules",
    "policy",
    "product",
    "faq",
    "other",
]

AiKnowledgeStatus = Literal["active", "archived"]


class CreateKnowledgeBody(BaseModel):
    label: str = Field(..., min_length=1, max_length=120)
    content: str = Field(..., min_length=1, max_length=2000)
    category: AiKnowledgeCategory | None = None


class UpdateKnowledgeBody(BaseModel):
    label: str | None = Field(None, min_length=1, max_length=120)
    content: str | None = Field(None, min_length=1, max_length=2000)
    category: AiKnowledgeCategory | None = None

    @model_validator(mode="after")
    def check_at_least_one_field(self) -> UpdateKnowledgeBody:
        if self.label is None and self.content is None and self.category is None:
            raise ValueError("Provide at least one of label, content or category.")
        return self


class OptimizeKnowledgeBody(BaseModel):
    rawText: str = Field(..., min_length=1, max_length=2000)


def serialize_knowledge(item: Any) -> dict[str, Any] | None:
    if not item or not isinstance(item, dict):
        return None

    return {
        "id": serialize_id(item.get("_id")),
        "organizationId": serialize_id(item.get("organizationId")),
        "label": item.get("label"),
        "content": item.get("content"),
        "category": item.get("category"),
        "status": item.get("status"),
        "createdBy": serialize_id(item.get("createdBy")),
        "updatedBy": serialize_id(item.get("updatedBy")),
        "createdAt": serialize_date(item.get("createdAt")),
        "updatedAt": serialize_date(item.get("updatedAt")),
    }

