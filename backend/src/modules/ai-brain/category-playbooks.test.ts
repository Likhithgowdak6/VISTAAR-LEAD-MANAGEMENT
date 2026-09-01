/**
 * The sixteen services the client actually sells, and the six broader groups they extend.
 *
 * No `config/env.js` mock: category-playbooks.ts imports nothing at all, so the real env module
 * (which calls `process.exit(1)`) is never reached - same as lead-field-rules.test.ts.
 */
import { describe, expect, it } from 'vitest';

import {
  CATEGORY_PLAYBOOKS,
  DEFAULT_CATEGORY_REQUIRED_FIELDS,
  playbookForCategory,
  requiredFieldsForCategory,
  serviceBriefForCategory,
} from './category-playbooks.js';
import { LEAD_CATEGORIES, UNKNOWN_LEAD_CATEGORY } from '../lead-sources/lead-field-rules.js';

/** The client's sixteen, in their words, as the keys this codebase spells them. */
const SIXTEEN_SERVICES = [
  'wedding',
  'birthday',
  'anniversary',
  'car_delivery',
  'house_warming',
  'half_saree',
  'ear_piercing',
  'social_private_event',
  'sports_event',
  'corporate_event',
  'podcast_talking_head',
  'festival_event',
  'baby_shower',
  'real_estate_shoot',
  'interior_article_shoot',
  'party_shoot',
] as const;

/** The seven keys that existed before the sixteen. Stored `aiCategory` values still hold these. */
const LEGACY_CATEGORIES = [
  'event_photography',
  'corporate_commercial',
  'ecommerce_web',
  'marketing_retainer',
  'social_branding',
  'seo_search',
  'unknown',
] as const;

/**
 * Every fact key any playbook may require. This is lead-sources/lead-field-rules.ts's vocabulary
 * - a key nothing maps a form label onto is a question the AI can only ever ask out loud, and a
 * key conversations/lead-score.ts has never heard of is a fact that never scores.
 */
const KNOWN_FACT_KEYS = new Set([
  'event_type',
  'event_date',
  'city',
  'timing',
  'photo_or_video',
  'guest_count',
  'shoot_type',
  'shoot_date',
  'deliverables_needed',
  'business_type',
  'site_purpose',
  'product_count',
  'timeline',
  'primary_goal',
  'current_channels',
  'monthly_budget',
  'what_they_need',
  'has_existing_identity',
  'website_url',
  'target_locations',
  'service_interest',
]);

describe('the sixteen services', () => {
  it.each(SIXTEEN_SERVICES)('%s resolves to a playbook of its own', (service) => {
    expect(CATEGORY_PLAYBOOKS[service]).toBeDefined();
    expect(playbookForCategory(service)).not.toBe(CATEGORY_PLAYBOOKS.unknown);
  });

  it('gives every one of them its own brief - no two services share wording', () => {
    const briefs = SIXTEEN_SERVICES.map((service) => serviceBriefForCategory(service));

    expect(new Set(briefs).size).toBe(SIXTEEN_SERVICES.length);
  });

  it('keeps every brief short enough to send on every single call', () => {
    // ~50 tokens each. Every token is billed on every call, and exactly one of
    // these is interpolated per call; a brief that grows into a page is how that gets breached.
    for (const service of SIXTEEN_SERVICES) {
      const brief = serviceBriefForCategory(service);

      expect(brief.length).toBeGreaterThan(40);
      expect(brief.length).toBeLessThanOrEqual(400);
    }
  });

  it('asks every one of them for the city, because that is what the lead score reads as a venue', () => {
    for (const service of SIXTEEN_SERVICES) {
      expect(requiredFieldsForCategory(service)).toContain('city');
    }
  });

  it('asks every one of them for a date under a key conversations/event-date.ts knows', () => {
    for (const service of SIXTEEN_SERVICES) {
      const fields = requiredFieldsForCategory(service);

      expect(fields.includes('event_date') || fields.includes('shoot_date')).toBe(true);
    }
  });

  it('invents no fact key the rest of the codebase has never heard of', () => {
    for (const [category, playbook] of Object.entries(CATEGORY_PLAYBOOKS)) {
      for (const field of playbook.requiredFields) {
        expect(KNOWN_FACT_KEYS, `${category}.${field}`).toContain(field);
      }
    }
  });

  it('keeps each list short - every field is one more question before a price', () => {
    for (const playbook of Object.values(CATEGORY_PLAYBOOKS)) {
      expect(playbook.requiredFields.length).toBeLessThanOrEqual(5);
      expect(playbook.requiredFields.length).toBeGreaterThan(0);
    }
  });
});

describe('the categories that came before them', () => {
  it.each(LEGACY_CATEGORIES)('%s still resolves to a real playbook, not the fallback', (legacy) => {
    // A conversation whose `aiCategory` was written months ago must keep working.
    expect(CATEGORY_PLAYBOOKS[legacy]).toBeDefined();
  });

  it('leaves the four non-shoot service lines exactly as they were', () => {
    expect(requiredFieldsForCategory('ecommerce_web')).toEqual([
      'business_type',
      'site_purpose',
      'product_count',
      'timeline',
    ]);
    expect(requiredFieldsForCategory('marketing_retainer')).toEqual([
      'business_type',
      'primary_goal',
      'current_channels',
      'monthly_budget',
    ]);
    expect(requiredFieldsForCategory('seo_search')).toEqual([
      'business_type',
      'website_url',
      'target_locations',
      'primary_goal',
    ]);
    expect(requiredFieldsForCategory('social_branding')).toEqual([
      'business_type',
      'what_they_need',
      'has_existing_identity',
      'timeline',
    ]);
  });
});

describe('resolving a category nothing knows', () => {
  it('falls back rather than throwing, whatever it is handed', () => {
    for (const junk of ['moon_landing', '', 'EVENT_PHOTOGRAPHY', 'constructor', '__proto__']) {
      expect(() => requiredFieldsForCategory(junk)).not.toThrow();
      expect(requiredFieldsForCategory(junk)).toEqual(
        CATEGORY_PLAYBOOKS[UNKNOWN_LEAD_CATEGORY]!.requiredFields,
      );
      expect(serviceBriefForCategory(junk)).toBe(
        CATEGORY_PLAYBOOKS[UNKNOWN_LEAD_CATEGORY]!.brief,
      );
    }
  });

  it('never returns an empty brief - the prompt always has something to interpolate', () => {
    expect(serviceBriefForCategory('nonsense').trim()).not.toBe('');
  });
});

describe('DEFAULT_CATEGORY_REQUIRED_FIELDS', () => {
  it('is derived from the playbooks, so the two cannot drift', () => {
    expect(Object.keys(DEFAULT_CATEGORY_REQUIRED_FIELDS).sort()).toEqual(
      Object.keys(CATEGORY_PLAYBOOKS).sort(),
    );

    for (const [category, fields] of Object.entries(DEFAULT_CATEGORY_REQUIRED_FIELDS)) {
      expect(fields).toBe(CATEGORY_PLAYBOOKS[category]!.requiredFields);
    }
  });

  it('has an entry for every category the form parser can produce', () => {
    for (const category of Object.values(LEAD_CATEGORIES)) {
      expect(DEFAULT_CATEGORY_REQUIRED_FIELDS[category]).toBeDefined();
    }

    expect(DEFAULT_CATEGORY_REQUIRED_FIELDS[UNKNOWN_LEAD_CATEGORY]).toBeDefined();
  });
});
