/**
 * Sixteen services, five bundled .docx shells. This checks the mapping covers every category the
 * rest of the codebase can produce and that every file it names is actually on disk - a missing
 * template is a `readFileSync` throw in the middle of an owner asking for a proposal.
 *
 * No `config/env.js` mock needed: proposal-templates.ts imports only node builtins.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { CATEGORY_PLAYBOOKS } from './category-playbooks.js';
import { loadTemplateBase64ForCategory, templateFileForCategory } from './proposal-templates.js';

const TEMPLATES_DIR = fileURLToPath(new URL('../../../templates/proposals/', import.meta.url));

describe('templateFileForCategory', () => {
  it('maps every category a playbook exists for - all sixteen services included', () => {
    for (const category of Object.keys(CATEGORY_PLAYBOOKS)) {
      const file = templateFileForCategory(category);

      expect(file, category).toMatch(/\.docx$/);
      expect(existsSync(`${TEMPLATES_DIR}${file}`), `${category} -> ${file}`).toBe(true);
    }
  });

  it('pours family occasions into the warm wedding shell', () => {
    for (const category of [
      'wedding',
      'birthday',
      'anniversary',
      'car_delivery',
      'house_warming',
      'half_saree',
      'ear_piercing',
      'social_private_event',
      'festival_event',
      'baby_shower',
      'party_shoot',
      'event_photography',
    ]) {
      expect(templateFileForCategory(category), category).toBe('proposal_wedding.docx');
    }
  });

  it('pours work commissioned by a business into the generic shell', () => {
    for (const category of [
      'sports_event',
      'corporate_event',
      'podcast_talking_head',
      'real_estate_shoot',
      'interior_article_shoot',
      'corporate_commercial',
    ]) {
      expect(templateFileForCategory(category), category).toBe('proposal_generic.docx');
    }
  });

  it('leaves the non-shoot service lines on the shells they already had', () => {
    expect(templateFileForCategory('ecommerce_web')).toBe('proposal_ecommerce.docx');
    expect(templateFileForCategory('marketing_retainer')).toBe('proposal_retainer.docx');
    expect(templateFileForCategory('social_branding')).toBe('proposal_branding.docx');
  });

  it('falls back to the generic shell for anything it has never heard of', () => {
    expect(templateFileForCategory('moon_landing')).toBe('proposal_generic.docx');
    expect(templateFileForCategory('')).toBe('proposal_generic.docx');
    // Inherited Object.prototype keys are not filenames.
    expect(templateFileForCategory('constructor')).toBe('proposal_generic.docx');
    expect(templateFileForCategory('toString')).toBe('proposal_generic.docx');
  });
});

describe('loadTemplateBase64ForCategory', () => {
  it('reads a real file for one of the new services', () => {
    const encoded = loadTemplateBase64ForCategory('half_saree');

    expect(encoded.length).toBeGreaterThan(0);
    // A .docx is a zip: "PK" -> "UEs" once base64-encoded.
    expect(encoded.startsWith('UEs')).toBe(true);
  });

  it('reads the fallback for an unrecognised category rather than throwing', () => {
    expect(() => loadTemplateBase64ForCategory('moon_landing')).not.toThrow();
  });
});
