import { type AiKnowledgeCategory } from '../types';

/**
 * Every category the API accepts, in the order the AI context builder thinks about a studio:
 * who we are, what we sell, what it costs, what we will not do, then the long tail.
 *
 * Shared rather than declared per-component so the add form and the inline edit form cannot
 * drift apart - which is exactly how `company`, `services` and `rules` ended up unreachable
 * from the UI while the backend had accepted them all along.
 */
export const AI_KNOWLEDGE_CATEGORIES: readonly AiKnowledgeCategory[] = [
  'company',
  'services',
  'pricing',
  'rules',
  'policy',
  'product',
  'faq',
  'other',
] as const;

/** Category names are single lowercase words, so the UI can title-case them for display. */
export const AI_KNOWLEDGE_CATEGORY_HINTS: Record<AiKnowledgeCategory, string> = {
  company: 'Who you are — studio, city, years running, team size.',
  services: 'What you offer — wedding films, brand shoots, ad campaigns.',
  pricing: 'Packages and rates the AI may quote.',
  rules: 'Hard limits the AI must never break.',
  policy: 'Terms — deposits, cancellation, travel, delivery time.',
  product: 'Specifics of a deliverable — album sizes, edit lengths.',
  faq: 'A question leads keep asking, and its answer.',
  other: 'Anything that does not fit above.',
};
