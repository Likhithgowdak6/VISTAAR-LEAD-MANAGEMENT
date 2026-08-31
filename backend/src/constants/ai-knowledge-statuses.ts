export const AI_KNOWLEDGE_STATUSES = Object.freeze({
  ACTIVE: 'active',
  ARCHIVED: 'archived',
} as const);

export type AiKnowledgeStatus = (typeof AI_KNOWLEDGE_STATUSES)[keyof typeof AI_KNOWLEDGE_STATUSES];

export const AI_KNOWLEDGE_STATUS_VALUES = Object.freeze(
  Object.values(AI_KNOWLEDGE_STATUSES),
) as readonly [AiKnowledgeStatus, ...AiKnowledgeStatus[]];

/**
 * The knowledge base's sections.
 *
 * The client's four sections are COMPANY, SERVICES, PRICING (their "pricing rules": starting-from
 * bands, never fixed figures) and RULES (the hard constraints on what the AI may say). POLICY,
 * PRODUCT, FAQ and OTHER predate them and are kept ON PURPOSE: rows already written under those
 * values - archived ones included - must keep loading, and the model's `enum` would reject them
 * otherwise. They read as general knowledge, exactly as they always did; only PRICING and RULES
 * are treated specially by ai-brain/ai-brain-context.service.ts.
 */
export const AI_KNOWLEDGE_CATEGORIES = Object.freeze({
  COMPANY: 'company',
  SERVICES: 'services',
  PRICING: 'pricing',
  RULES: 'rules',
  POLICY: 'policy',
  PRODUCT: 'product',
  FAQ: 'faq',
  OTHER: 'other',
} as const);

/** The four sections the dashboard offers today, in the order it renders them. */
export const AI_KNOWLEDGE_SECTION_VALUES = Object.freeze([
  AI_KNOWLEDGE_CATEGORIES.COMPANY,
  AI_KNOWLEDGE_CATEGORIES.SERVICES,
  AI_KNOWLEDGE_CATEGORIES.PRICING,
  AI_KNOWLEDGE_CATEGORIES.RULES,
] as const);

export type AiKnowledgeCategory =
  (typeof AI_KNOWLEDGE_CATEGORIES)[keyof typeof AI_KNOWLEDGE_CATEGORIES];

export const AI_KNOWLEDGE_CATEGORY_VALUES = Object.freeze(
  Object.values(AI_KNOWLEDGE_CATEGORIES),
) as readonly [AiKnowledgeCategory, ...AiKnowledgeCategory[]];
