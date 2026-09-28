/**
 * The one place stored knowledge becomes what the AI actually sees. What is checked here is the
 * SEPARATION: pricing is the catalog, rules are constraints, everything else is general
 * knowledge, and exactly one service brief goes out per call.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AI_KNOWLEDGE_CATEGORIES } from '../../constants/ai-knowledge-statuses.js';
import { DEFAULT_AI_RULES } from '../../constants/ai-knowledge-defaults.js';

// ai-knowledge.repository.ts pulls in the Mongoose model, which reaches the real env module
// (it calls process.exit(1) when validation fails) - mocked exactly as every other suite does.
vi.mock('../../config/env.js', () => ({
  env: { NODE_ENV: 'test', LOG_LEVEL: 'silent' },
}));

const mocks = vi.hoisted(() => ({
  findActiveKnowledgeForOrganization: vi.fn(),
}));

vi.mock('../ai-knowledge/ai-knowledge.repository.js', () => ({
  findActiveKnowledgeForOrganization: mocks.findActiveKnowledgeForOrganization,
}));

const { buildAiBrainContext, todayInBusinessTimezone } = await import(
  './ai-brain-context.service.js'
);

describe('todayInBusinessTimezone', () => {
  // 20:30 UTC on the 27th is already 02:00 on the 28th in Kolkata. This is the case that matters:
  // an evening enquiry anchored to the server's UTC date resolves "next Saturday" a day early,
  // and a day early is a shoot booked on the wrong date.
  const eveningUtc = new Date('2026-09-27T20:30:00.000Z');

  it('uses the business day, not the UTC day', () => {
    expect(todayInBusinessTimezone(eveningUtc, 'Asia/Kolkata')).toBe('2026-09-28');
    expect(eveningUtc.toISOString().slice(0, 10)).toBe('2026-09-27');
  });

  it('formats as YYYY-MM-DD, which is what event-date.ts can parse back', () => {
    expect(todayInBusinessTimezone(new Date('2026-01-05T06:00:00.000Z'), 'Asia/Kolkata')).toBe(
      '2026-01-05',
    );
  });

  it('handles a timezone behind UTC too', () => {
    // 01:00 UTC on the 28th is still the 27th in New York.
    expect(todayInBusinessTimezone(new Date('2026-09-28T01:00:00.000Z'), 'America/New_York')).toBe(
      '2026-09-27',
    );
  });

  it('falls back to the UTC date rather than throwing on a bad timezone', () => {
    // A day out is survivable and the prompt still tells the model to confirm an uncertain date.
    // Throwing here would take down every AI reply for the sake of a malformed config value.
    expect(todayInBusinessTimezone(eveningUtc, 'Not/AZone')).toBe('2026-09-27');
  });
});

const organizationId = 'org-1';

const entry = (category: string, label: string, content: string) => ({
  category,
  label,
  content,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findActiveKnowledgeForOrganization.mockResolvedValue([]);
});

describe('the four sections', () => {
  it('keeps rules out of the knowledge blob and pricing out of both', async () => {
    mocks.findActiveKnowledgeForOrganization.mockResolvedValue([
      entry(AI_KNOWLEDGE_CATEGORIES.COMPANY, 'Where we are', 'Bangalore, since 2016.'),
      entry(AI_KNOWLEDGE_CATEGORIES.SERVICES, 'Weddings', 'Candid and cinematic coverage.'),
      entry(AI_KNOWLEDGE_CATEGORIES.PRICING, 'Birthday', 'Birthday photography: starting ₹12,000.'),
      entry(AI_KNOWLEDGE_CATEGORIES.RULES, 'Availability', 'Never promise availability.'),
    ]);

    const context = await buildAiBrainContext({ organizationId, category: 'birthday' });

    expect(context.catalogText).toBe('- Birthday: Birthday photography: starting ₹12,000.');
    expect(context.rulesText).toBe('- Availability: Never promise availability.');

    // The whole point of the split: a prohibition in a list of facts reads as trivia.
    expect(context.knowledgeText).toContain('Where we are');
    expect(context.knowledgeText).toContain('Weddings');
    expect(context.knowledgeText).not.toContain('Never promise availability');
    expect(context.knowledgeText).not.toContain('starting ₹12,000');
  });

  it('reads company and services as one general-knowledge blob', async () => {
    mocks.findActiveKnowledgeForOrganization.mockResolvedValue([
      entry(AI_KNOWLEDGE_CATEGORIES.COMPANY, 'Team', 'Eight photographers.'),
      entry(AI_KNOWLEDGE_CATEGORIES.SERVICES, 'Real estate', 'Listings and brochures.'),
    ]);

    const context = await buildAiBrainContext({ organizationId, category: 'wedding' });

    expect(context.knowledgeText).toBe('- Team: Eight photographers.\n- Real estate: Listings and brochures.');
  });

  it('still reads a row written under one of the older categories as general knowledge', async () => {
    // policy / product / faq / other predate the four sections. Rows already saved under them
    // must keep loading and must keep meaning exactly what they always meant.
    mocks.findActiveKnowledgeForOrganization.mockResolvedValue([
      entry(AI_KNOWLEDGE_CATEGORIES.POLICY, 'Travel', 'We travel across Karnataka.'),
      entry(AI_KNOWLEDGE_CATEGORIES.FAQ, 'Turnaround', 'Albums take three weeks.'),
      entry(AI_KNOWLEDGE_CATEGORIES.OTHER, 'Parking', 'Venue parking is the client’s.'),
    ]);

    const context = await buildAiBrainContext({ organizationId, category: 'wedding' });

    expect(context.knowledgeText).toContain('Travel');
    expect(context.knowledgeText).toContain('Turnaround');
    expect(context.knowledgeText).toContain('Parking');
    expect(context.catalogText).toContain('no plans configured');
  });

  it('reads only ACTIVE rows - archiving is how a business retires a rule or a price', async () => {
    await buildAiBrainContext({ organizationId, category: 'wedding' });

    expect(mocks.findActiveKnowledgeForOrganization).toHaveBeenCalledWith({ organizationId });
  });
});

describe('the rules a fresh install is bound by', () => {
  it('sends the seven defaults when nobody has written any rules yet', async () => {
    const context = await buildAiBrainContext({ organizationId, category: 'wedding' });

    expect(DEFAULT_AI_RULES).toHaveLength(7);

    for (const rule of DEFAULT_AI_RULES) {
      expect(context.rulesText).toContain(rule.content);
    }
  });

  it('never sends an empty rules block, whatever else is missing', async () => {
    const context = await buildAiBrainContext({ organizationId, category: 'wedding' });

    expect(context.rulesText.trim()).not.toBe('');
    expect(context.catalogText).toContain('no plans configured');
    expect(context.knowledgeText).toContain('no knowledge base yet');
  });

  it('hands over wholesale to an organization that wrote its own', async () => {
    mocks.findActiveKnowledgeForOrganization.mockResolvedValue([
      entry(AI_KNOWLEDGE_CATEGORIES.RULES, 'Ours', 'Never shoot outside Karnataka.'),
    ]);

    const context = await buildAiBrainContext({ organizationId, category: 'wedding' });

    expect(context.rulesText).toBe('- Ours: Never shoot outside Karnataka.');
    expect(context.rulesText).not.toContain('Never promise availability');
  });
});

describe('the one service brief that goes out', () => {
  it('picks the brief and the required fields for THIS conversation only', async () => {
    const wedding = await buildAiBrainContext({ organizationId, category: 'wedding' });
    const carDelivery = await buildAiBrainContext({ organizationId, category: 'car_delivery' });

    expect(wedding.serviceBrief).not.toBe(carDelivery.serviceBrief);
    expect(wedding.serviceBrief).toContain('functions');
    expect(carDelivery.serviceBrief).toContain('showroom');

    // Never all sixteen: the token ceiling is the reason this is one string and not a list.
    expect(wedding.serviceBrief).not.toContain('showroom');
    expect(wedding.requiredFields).toContain('guest_count');
    expect(carDelivery.requiredFields).not.toContain('guest_count');
  });

  it('falls back sensibly for a category nobody configured, rather than throwing', async () => {
    const context = await buildAiBrainContext({ organizationId, category: 'moon_landing' });

    expect(context.serviceBrief).toContain('Nobody has worked out what this lead wants yet');
    expect(context.requiredFields).toEqual(['service_interest', 'city', 'timeline']);
  });

  it('still resolves an aiCategory written before the sixteen existed', async () => {
    const context = await buildAiBrainContext({
      organizationId,
      category: 'event_photography',
    });

    expect(context.serviceBrief).toContain('An event of some kind');
    expect(context.requiredFields).toContain('event_type');
  });
});
