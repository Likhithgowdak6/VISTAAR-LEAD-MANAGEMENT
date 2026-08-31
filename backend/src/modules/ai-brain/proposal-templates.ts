/**
 * .docx templates for proposal rendering, ported from vistaar-agent's templates/ folder (they
 * are plain docxtpl `{{ }}` templates, not category-specific logic - ai-brain-service just fills
 * in placeholders, so any of these works with any category's content). Kept in this repo rather
 * than fetched from ai-brain-service because wam-crm-ai is the one that knows which category a
 * lead is in and is the thing a human interacts with to download the result.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const TEMPLATES_DIR = fileURLToPath(new URL('../../../templates/proposals/', import.meta.url));

/**
 * Category -> bundled .docx. SIXTEEN SERVICES DO NOT NEED SIXTEEN TEMPLATES: these are plain
 * docxtpl `{{ }}` shells with no category-specific logic in them, so the only thing a mapping
 * decides is which cover and section furniture a proposal is poured into. Three groups:
 *
 *  - proposal_wedding.docx  every occasion shot for a FAMILY - the whole event side of the
 *                           sixteen, plus the old `event_photography` group key. Warm layout,
 *                           written for a day rather than a brief.
 *  - proposal_generic.docx  every shoot commissioned by a BUSINESS - corporate, sports, podcast,
 *                           real estate, interiors - and the fallback for anything unrecognised.
 *  - the three existing specialist shells (ecommerce / retainer / branding) keep the four
 *     non-shoot service lines exactly where they already were.
 */
const TEMPLATE_FILES = Object.freeze({
  // Family occasions.
  wedding: 'proposal_wedding.docx',
  birthday: 'proposal_wedding.docx',
  anniversary: 'proposal_wedding.docx',
  car_delivery: 'proposal_wedding.docx',
  house_warming: 'proposal_wedding.docx',
  half_saree: 'proposal_wedding.docx',
  ear_piercing: 'proposal_wedding.docx',
  social_private_event: 'proposal_wedding.docx',
  festival_event: 'proposal_wedding.docx',
  baby_shower: 'proposal_wedding.docx',
  party_shoot: 'proposal_wedding.docx',
  event_photography: 'proposal_wedding.docx',

  // Commissioned by a business.
  sports_event: 'proposal_generic.docx',
  corporate_event: 'proposal_generic.docx',
  podcast_talking_head: 'proposal_generic.docx',
  real_estate_shoot: 'proposal_generic.docx',
  interior_article_shoot: 'proposal_generic.docx',
  corporate_commercial: 'proposal_generic.docx',
  seo_search: 'proposal_generic.docx',

  // The non-shoot service lines, unchanged.
  ecommerce_web: 'proposal_ecommerce.docx',
  marketing_retainer: 'proposal_retainer.docx',
  social_branding: 'proposal_branding.docx',

  unknown: 'proposal_generic.docx',
} as const);

const DEFAULT_TEMPLATE_FILE = TEMPLATE_FILES.unknown;

/** `Object.hasOwn`, not a plain lookup: `aiCategory` is a string off a document, and an
 *  inherited `constructor` or `toString` must not be read as a filename. */
export const templateFileForCategory = (category: string): string =>
  Object.hasOwn(TEMPLATE_FILES, category)
    ? TEMPLATE_FILES[category as keyof typeof TEMPLATE_FILES]
    : DEFAULT_TEMPLATE_FILE;

/** Reads the .docx template for a category and returns it base64-encoded, ready for the wire. */
export const loadTemplateBase64ForCategory = (category: string): string => {
  const fileName = templateFileForCategory(category);
  const bytes = readFileSync(`${TEMPLATES_DIR}${fileName}`);
  return bytes.toString('base64');
};
