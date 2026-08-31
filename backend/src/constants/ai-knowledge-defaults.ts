/**
 * What the AI is bound by before anybody has typed anything into the dashboard.
 *
 * The RULES section of the knowledge base is the one section a business cannot afford to have
 * empty: every entry in it is a thing the AI must never do, and an empty rules list on a fresh
 * install means an unconstrained agent talking to real customers on day one. So these seven -
 * the client's own list, in their order - are what ai-brain/ai-brain-context.service.ts sends
 * when an organization has written no rules of its own.
 *
 * They are a FLOOR, not a fixture. The moment an organization saves a single `rules` entry of
 * its own, its list replaces this one wholesale - which is what makes the section editable
 * rather than merely visible. An organization that wants these seven plus one of its own writes
 * all eight; that is deliberate, because silently merging a default a customer thought they had
 * deleted is worse than making them re-type it.
 *
 * Written as imperatives and kept to one line each: this block is interpolated into every
 * qualifying and drafting call, and the AI runs against an 8,000-tokens-per-minute ceiling.
 */
export interface AiKnowledgeDefaultRule {
  readonly label: string;
  readonly content: string;
}

export const DEFAULT_AI_RULES: readonly AiKnowledgeDefaultRule[] = Object.freeze([
  {
    label: 'Availability',
    content: 'Never promise availability. Only a human can confirm a team is free on a date.',
  },
  {
    label: 'Pricing',
    content: 'Never invent pricing. Quote only figures the pricing rules below actually give you.',
  },
  {
    label: 'Discounts',
    content: 'Never give a discount, or hint that one exists, without the owner approving it.',
  },
  {
    label: 'Delivery dates',
    content: 'Never promise a delivery date without checking. Say it will be confirmed instead.',
  },
  {
    label: 'Bookings',
    content: 'Never say a booking is confirmed. A human confirms bookings, not you.',
  },
  {
    label: 'Disagreements',
    content: 'Never argue with the customer. Hand it to a human before it becomes an argument.',
  },
  {
    label: 'Scope of what you may say',
    content:
      'Never claim anything the knowledge base does not cover. If it is not written down, hand over.',
  },
]);
