/**
 * Reading a Meta lead form's answers into the canonical facts the AI brain works in - ported
 * from vistaar-agent's app/services/lead_form.py.
 *
 * The same form reaches this CRM by two completely different routes and both end up here,
 * because the question labels are identical either way:
 *
 *  1. THE SHEET. Meta writes form submissions into a Google Sheet, the CRM polls its CSV export
 *     (see lead-import.service.ts). Every non-standard column is one form question.
 *  2. CLICK-TO-WHATSAPP. Meta hands the answers to the LEAD, who pastes them to us as their
 *     first WhatsApp message - one block of "Label: value" lines opening with "Hello! I filled
 *     out your form...". Until this existed, the AI read that block as ordinary chatter and then
 *     asked for the event date the lead had typed two lines above.
 *
 * On matching: labels are matched by KEYWORD SUBSTRING, not by exact string. The live form reads
 * "What is most important for you while choosing am Event Photography Partner" and "Choose Your
 * Candid & Cinematic P&V Pacakage" - with the typos. Anyone can edit a form label in Ads Manager
 * without telling the CRM, so an exact-match table is a table that is already wrong. Nothing is
 * ever dropped: a label nothing recognises is kept under a slug of its own text, so a new
 * question shows up in the facts rather than vanishing.
 *
 * Everything here is pure: no database, no I/O, no throwing. It runs on the inbound-webhook path
 * where an exception loses a lead's first message, and inside a sheet poll where it must not
 * abandon the rest of the rows.
 */

/** One keyword -> canonical fact key mapping. */
export interface LabelRule {
  readonly match: string;
  readonly key: string;
}

/**
 * Label keyword -> the fact key the answer is stored under.
 *
 * ORDER IS LOAD-BEARING and it is an array, not an object, for exactly that reason: the first
 * entry whose keyword appears in the label wins, so the specific ones come first. "Event Name"
 * must not be read as the lead's name, and the bare "name" fallback is deliberately last.
 *
 * The canonical keys on the right are the vocabulary of ai-brain/category-playbooks.ts
 * (`event_type`, `event_date`, `city`, `timing`, `service_interest`, ...); a key added here that
 * that file does not know is still useful context for the AI, but only these count towards the
 * "what must I learn before drafting" list.
 */
export const LABEL_RULES: readonly LabelRule[] = Object.freeze([
  { match: 'email', key: 'email' },
  { match: 'phone', key: 'phone' },
  { match: 'mobile', key: 'phone' },
  { match: 'whatsapp number', key: 'phone' },
  { match: 'full name', key: 'name' },
  { match: 'your name', key: 'name' },
  { match: 'event name', key: 'event_name' },
  { match: 'describe this event', key: 'event_type' },
  { match: 'kind of event', key: 'event_type' },
  { match: 'type of event', key: 'event_type' },
  { match: 'what is the event', key: 'event_type' },
  { match: 'occasion', key: 'event_type' },
  { match: 'location', key: 'city' },
  { match: 'area', key: 'city' },
  { match: 'venue', key: 'city' },
  { match: 'city', key: 'city' },
  { match: 'date', key: 'event_date' },
  { match: 'when', key: 'event_date' },
  { match: 'duration', key: 'timing' },
  { match: 'time', key: 'timing' },
  { match: 'guest', key: 'guest_count' },
  { match: 'package', key: 'package_interest' },
  // The live form's own spelling. Keep it: the sheet header really is "..._pacakage".
  { match: 'pacakage', key: 'package_interest' },
  { match: 'budget', key: 'budget_range' },
  { match: 'important for you', key: 'what_matters' },
  { match: 'looking for', key: 'service_interest' },
  { match: 'service', key: 'service_interest' },
  { match: 'interested in', key: 'service_interest' },
  // Last: only when nothing more specific matched.
  { match: 'name', key: 'name' },
]);

/**
 * The lead's own identity, which is never a qualifying fact.
 *
 * These keys exist so the parser recognises the questions (and so a second "name" question does
 * not become a junk fact), but `buildLeadFormFacts` strips them before anything is written to
 * `Conversation.aiFacts`. ADR-005: name, email, phone and inbox URL never reach the AI provider,
 * exactly as lead-context.service.ts already refuses to include them. The contact record is
 * where identity lives.
 */
export const CONTACT_FACT_KEYS: readonly string[] = Object.freeze(['name', 'email', 'phone']);

/**
 * The lead categories, which MUST stay a subset of the keys of ai-brain/category-playbooks.ts's
 * CATEGORY_PLAYBOOKS - that table is the contract, and a category it does not know silently
 * falls back to the generic field list. Duplicated as literals rather than imported so this pure
 * module stays free of any module dependency; lead-field-rules.test.ts asserts the two agree.
 *
 * THE SIXTEEN SERVICES the client actually sells come first. They EXTEND the six broader groups
 * below them rather than replacing them - see the header of category-playbooks.ts for why - so
 * an `aiCategory` of `event_photography` written months ago still resolves to a real playbook,
 * and the four non-shoot service lines (websites, ads, branding, SEO) keep a home of their own.
 */
export const LEAD_CATEGORIES = Object.freeze({
  WEDDING: 'wedding',
  BIRTHDAY: 'birthday',
  ANNIVERSARY: 'anniversary',
  CAR_DELIVERY: 'car_delivery',
  HOUSE_WARMING: 'house_warming',
  HALF_SAREE: 'half_saree',
  EAR_PIERCING: 'ear_piercing',
  SOCIAL_PRIVATE_EVENT: 'social_private_event',
  SPORTS_EVENT: 'sports_event',
  CORPORATE_EVENT: 'corporate_event',
  PODCAST_TALKING_HEAD: 'podcast_talking_head',
  FESTIVAL_EVENT: 'festival_event',
  BABY_SHOWER: 'baby_shower',
  REAL_ESTATE_SHOOT: 'real_estate_shoot',
  INTERIOR_ARTICLE_SHOOT: 'interior_article_shoot',
  PARTY_SHOOT: 'party_shoot',

  // The broader groups, kept: two of them are what a lead who names no specific occasion still
  // lands in, and four of them are service lines the sixteen do not cover at all.
  EVENT_PHOTOGRAPHY: 'event_photography',
  CORPORATE_COMMERCIAL: 'corporate_commercial',
  ECOMMERCE_WEB: 'ecommerce_web',
  MARKETING_RETAINER: 'marketing_retainer',
  SOCIAL_BRANDING: 'social_branding',
  SEO_SEARCH: 'seo_search',
} as const);

/** The `Conversation.aiCategory` default: "nobody has worked out what this lead wants yet". */
export const UNKNOWN_LEAD_CATEGORY = 'unknown';

export interface CategoryHint {
  readonly match: string;
  readonly category: string;
}

/**
 * Words in the ANSWERS that say what kind of work this is. ORDER IS THE BEHAVIOUR - first match
 * wins - so the sixteen named services come before the broader groups, and inside each block the
 * more specific phrase comes first: "real estate photography" must not be read as an event
 * shoot, and "corporate event" must not be read as generic corporate work.
 */
export const CATEGORY_HINTS: readonly CategoryHint[] = Object.freeze([
  // The sixteen named services first: the moment a lead names the actual occasion, that is the
  // playbook they get. Only when they say something vaguer ("event photography", "commercial
  // shoot") do the broader groups at the bottom of this list pick it up.
  { match: 'half saree', category: LEAD_CATEGORIES.HALF_SAREE },
  { match: 'halfsaree', category: LEAD_CATEGORIES.HALF_SAREE },
  { match: 'langa voni', category: LEAD_CATEGORIES.HALF_SAREE },
  { match: 'ritu kala', category: LEAD_CATEGORIES.HALF_SAREE },
  { match: 'ear piercing', category: LEAD_CATEGORIES.EAR_PIERCING },
  { match: 'earpiercing', category: LEAD_CATEGORIES.EAR_PIERCING },
  { match: 'karnavedha', category: LEAD_CATEGORIES.EAR_PIERCING },
  { match: 'car delivery', category: LEAD_CATEGORIES.CAR_DELIVERY },
  { match: 'new car', category: LEAD_CATEGORIES.CAR_DELIVERY },
  { match: 'car handover', category: LEAD_CATEGORIES.CAR_DELIVERY },
  { match: 'house warming', category: LEAD_CATEGORIES.HOUSE_WARMING },
  { match: 'housewarming', category: LEAD_CATEGORIES.HOUSE_WARMING },
  { match: 'griha', category: LEAD_CATEGORIES.HOUSE_WARMING },
  { match: 'baby shower', category: LEAD_CATEGORIES.BABY_SHOWER },
  { match: 'babyshower', category: LEAD_CATEGORIES.BABY_SHOWER },
  { match: 'seemantham', category: LEAD_CATEGORIES.BABY_SHOWER },
  { match: 'godh bharai', category: LEAD_CATEGORIES.BABY_SHOWER },
  { match: 'maternity', category: LEAD_CATEGORIES.BABY_SHOWER },
  { match: 'real estate', category: LEAD_CATEGORIES.REAL_ESTATE_SHOOT },
  { match: 'property shoot', category: LEAD_CATEGORIES.REAL_ESTATE_SHOOT },
  { match: 'apartment shoot', category: LEAD_CATEGORIES.REAL_ESTATE_SHOOT },
  { match: 'villa shoot', category: LEAD_CATEGORIES.REAL_ESTATE_SHOOT },
  { match: 'interior', category: LEAD_CATEGORIES.INTERIOR_ARTICLE_SHOOT },
  { match: 'article shoot', category: LEAD_CATEGORIES.INTERIOR_ARTICLE_SHOOT },
  { match: 'furniture', category: LEAD_CATEGORIES.INTERIOR_ARTICLE_SHOOT },
  { match: 'podcast', category: LEAD_CATEGORIES.PODCAST_TALKING_HEAD },
  { match: 'talking head', category: LEAD_CATEGORIES.PODCAST_TALKING_HEAD },
  { match: 'corporate event', category: LEAD_CATEGORIES.CORPORATE_EVENT },
  { match: 'conference', category: LEAD_CATEGORIES.CORPORATE_EVENT },
  { match: 'annual day', category: LEAD_CATEGORIES.CORPORATE_EVENT },
  { match: 'agm', category: LEAD_CATEGORIES.CORPORATE_EVENT },
  { match: 'product launch', category: LEAD_CATEGORIES.CORPORATE_EVENT },
  { match: 'award', category: LEAD_CATEGORIES.CORPORATE_EVENT },
  { match: 'offsite', category: LEAD_CATEGORIES.CORPORATE_EVENT },
  { match: 'sports', category: LEAD_CATEGORIES.SPORTS_EVENT },
  { match: 'tournament', category: LEAD_CATEGORIES.SPORTS_EVENT },
  { match: 'marathon', category: LEAD_CATEGORIES.SPORTS_EVENT },
  { match: 'match day', category: LEAD_CATEGORIES.SPORTS_EVENT },
  { match: 'festival', category: LEAD_CATEGORIES.FESTIVAL_EVENT },
  { match: 'ganesh', category: LEAD_CATEGORIES.FESTIVAL_EVENT },
  { match: 'navratri', category: LEAD_CATEGORIES.FESTIVAL_EVENT },
  { match: 'dussehra', category: LEAD_CATEGORIES.FESTIVAL_EVENT },
  { match: 'diwali', category: LEAD_CATEGORIES.FESTIVAL_EVENT },
  { match: 'christmas', category: LEAD_CATEGORIES.FESTIVAL_EVENT },
  { match: 'anniversary', category: LEAD_CATEGORIES.ANNIVERSARY },
  { match: 'birthday', category: LEAD_CATEGORIES.BIRTHDAY },
  { match: 'bday', category: LEAD_CATEGORIES.BIRTHDAY },
  { match: 'get together', category: LEAD_CATEGORIES.SOCIAL_PRIVATE_EVENT },
  { match: 'farewell', category: LEAD_CATEGORIES.SOCIAL_PRIVATE_EVENT },
  { match: 'reunion', category: LEAD_CATEGORIES.SOCIAL_PRIVATE_EVENT },
  { match: 'private event', category: LEAD_CATEGORIES.SOCIAL_PRIVATE_EVENT },
  { match: 'wedding', category: LEAD_CATEGORIES.WEDDING },
  { match: 'shaadi', category: LEAD_CATEGORIES.WEDDING },
  { match: 'marriage', category: LEAD_CATEGORIES.WEDDING },
  { match: 'engagement', category: LEAD_CATEGORIES.WEDDING },
  { match: 'reception', category: LEAD_CATEGORIES.WEDDING },
  { match: 'haldi', category: LEAD_CATEGORIES.WEDDING },
  { match: 'mehendi', category: LEAD_CATEGORIES.WEDDING },
  { match: 'mehndi', category: LEAD_CATEGORIES.WEDDING },
  { match: 'sangeet', category: LEAD_CATEGORIES.WEDDING },
  // After the wedding block: "wedding party" is a wedding, not a club night.
  { match: 'party', category: LEAD_CATEGORIES.PARTY_SHOOT },
  { match: 'club night', category: LEAD_CATEGORIES.PARTY_SHOOT },
  { match: 'new year', category: LEAD_CATEGORIES.PARTY_SHOOT },

  // The broader groups. Everything above named an occasion; these only say what KIND of work it
  // is, which is all some enquiries ever give us.
  { match: 'commercial', category: LEAD_CATEGORIES.CORPORATE_COMMERCIAL },
  { match: 'corporate', category: LEAD_CATEGORIES.CORPORATE_COMMERCIAL },
  { match: 'product shoot', category: LEAD_CATEGORIES.CORPORATE_COMMERCIAL },
  { match: 'e-commerce', category: LEAD_CATEGORIES.ECOMMERCE_WEB },
  { match: 'ecommerce', category: LEAD_CATEGORIES.ECOMMERCE_WEB },
  { match: 'website', category: LEAD_CATEGORIES.ECOMMERCE_WEB },
  { match: 'web design', category: LEAD_CATEGORIES.ECOMMERCE_WEB },
  { match: 'seo', category: LEAD_CATEGORIES.SEO_SEARCH },
  { match: 'search engine', category: LEAD_CATEGORIES.SEO_SEARCH },
  { match: 'social media', category: LEAD_CATEGORIES.MARKETING_RETAINER },
  { match: 'advertis', category: LEAD_CATEGORIES.MARKETING_RETAINER },
  { match: 'marketing', category: LEAD_CATEGORIES.MARKETING_RETAINER },
  { match: 'influencer', category: LEAD_CATEGORIES.MARKETING_RETAINER },
  { match: 'logo', category: LEAD_CATEGORIES.SOCIAL_BRANDING },
  { match: 'branding', category: LEAD_CATEGORIES.SOCIAL_BRANDING },
  { match: 'naming', category: LEAD_CATEGORIES.EVENT_PHOTOGRAPHY },
  { match: 'event', category: LEAD_CATEGORIES.EVENT_PHOTOGRAPHY },
  { match: 'photograph', category: LEAD_CATEGORIES.EVENT_PHOTOGRAPHY },
  { match: 'videograph', category: LEAD_CATEGORIES.EVENT_PHOTOGRAPHY },
]);

/** The sentence Meta puts at the top of a click-to-WhatsApp form. Matched loosely: it has been
 *  reworded before, and an admin can edit it away entirely. */
export const FORM_PREAMBLE_HINTS: readonly string[] = Object.freeze([
  'filled out your form',
  'filled your form',
  'i filled out',
]);

/** `Label: value`. The 2-80 char label bound is what stops a whole paragraph with one colon in
 *  it from being read as a field. */
const LABELLED_LINE = /^\s*([^:\n]{2,80}?)\s*:\s*(.+?)\s*$/;

/** Three labelled lines is not a conversation. */
const MIN_LABELLED_LINES = 3;

/** Answers that mean "the lead left this blank". */
const BLANK_VALUES = new Set(['', '-', '--', '?', 'n/a', 'na', 'none', 'null']);

/**
 * "They wrote nothing here." The one place this judgement lives: the form parser below drops
 * these rather than storing them as answers, and conversations/lead-score.ts refuses to score
 * them. Safe for any input - a number, a null, an object off a hand-edited sheet.
 */
export const isBlankAnswer = (value: unknown): boolean =>
  BLANK_VALUES.has(String(value ?? '').trim().toLowerCase());

/**
 * Answers that are a REPLY but not an ANSWER: the lead wrote something, it just does not say
 * when/where/how much. "Not decided yet" is the commonest one on a wedding enquiry and it is not
 * a date - conversations/event-date.ts already refuses to read it as one, for the same reason.
 *
 * Matched as a substring of the normalised answer (punctuation stripped, whitespace collapsed),
 * because these arrive with every possible decoration: "Not decided yet!!", "abhi decide nahi kiya".
 * Kept separate from BLANK_VALUES on purpose: the form parser must keep storing "not decided yet"
 * as the lead's actual words - the AI reads the facts blob to know it already asked - while lead
 * scoring must not count it as a fact the lead has given us.
 */
export const UNDECIDED_ANSWER_HINTS: readonly string[] = Object.freeze([
  'not decided',
  'not yet decided',
  'undecided',
  'not finalized',
  'not finalised',
  'not fixed',
  'not confirmed',
  'not sure',
  'no idea',
  'dont know',
  'to be decided',
  'to be confirmed',
  'tbd',
  'tba',
  'decide nahi',
  'decided nahi',
  'nahi pata',
  'pata nahi',
  'nahi decide',
  'fix nahi',
  'abhi nahi',
]);

/** Lowercased, punctuation-free, whitespace-collapsed - so "Not decided yet!!" and "not-decided"
 *  both reduce to the same thing. Same normalise-then-match approach as
 *  whatsapp/automation/opt-out.ts. */
const normalizeAnswer = (value: unknown): string =>
  String(value ?? '')
    .toLowerCase()
    .replace(/[\u2018\u2019']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/**
 * True when an answer carries no usable information: blank, or one of the "haven't decided"
 * phrases above. What lead scoring asks before crediting a fact.
 */
export const isUnansweredValue = (value: unknown): boolean => {
  if (isBlankAnswer(value)) {
    return true;
  }

  const normalized = normalizeAnswer(value);

  if (normalized === '') {
    return true;
  }

  return UNDECIDED_ANSWER_HINTS.some((hint) => normalized.includes(hint));
};

/** Not every colon is a form field: a bare URL line splits into `https` + `//example.com/x`. */
const URL_SCHEME_LABELS = new Set(['http', 'https', 'ftp', 'www']);

/** A question needs real words in it. Guards against "1:", "A:" and clock times. */
const MIN_LABEL_LETTERS = 3;

const MAX_FACTS = 60;
const MAX_FACT_VALUE_LENGTH = 1000;
const MAX_SLUG_LENGTH = 60;

const countLetters = (value: string): number => (value.match(/[A-Za-z]/g) ?? []).length;

const containsAnyHint = (haystack: string, hints: readonly string[]): boolean =>
  hints.some((hint) => haystack.includes(hint));

/**
 * A label with no rule keeps its own text as the key: `How would you describe this event?` ->
 * `how_would_you_describe_this_event`. Never empty, so a key always exists.
 */
export const slugifyLabel = (label: string): string => {
  const slug = String(label ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/_+$/g, '');

  return slug === '' ? 'field' : slug;
};

/**
 * The canonical fact key for one form label, or null when no rule matches (the caller then keeps
 * the answer under `slugifyLabel`).
 *
 * Underscores and hyphens become spaces first: the sheet sends machine headers
 * (`how_would_you_describe_this_event?`), the pasted click-to-WhatsApp form sends human ones
 * ("How would you describe this event?"), and LABEL_RULES is written once for both.
 */
export const keyForLabel = (label: string): string | null => {
  const normalized = String(label ?? '')
    .toLowerCase()
    .replace(/[_-]/g, ' ')
    // Collapsed so a double underscore cannot hide "full name" behind "full  name".
    .replace(/\s+/g, ' ')
    .trim();

  if (normalized === '') {
    return null;
  }

  return LABEL_RULES.find((rule) => normalized.includes(rule.match))?.key ?? null;
};

export interface FormFieldEntry {
  label: string;
  value: string;
}

export interface ParsedFormFields {
  /** Answers under a canonical key from LABEL_RULES. */
  facts: Record<string, string>;
  /** Answers to questions no rule knows, kept under a slug of the question text. Never dropped:
   *  a brand-new form question must show up in the facts rather than vanishing. */
  unmapped: Record<string, string>;
}

const truncateValue = (value: string): string =>
  value.length > MAX_FACT_VALUE_LENGTH ? value.slice(0, MAX_FACT_VALUE_LENGTH) : value;

/**
 * Form answers -> canonical facts + everything else.
 *
 * Never throws and never returns null: a form half-understood is still worth more than nothing,
 * and both callers run somewhere an exception costs a lead.
 */
export const parseFormFields = (
  entries: readonly FormFieldEntry[] | null | undefined,
): ParsedFormFields => {
  const facts: Record<string, string> = {};
  const unmapped: Record<string, string> = {};

  const isFull = (): boolean => Object.keys(facts).length + Object.keys(unmapped).length >= MAX_FACTS;

  const keepUnmapped = (label: string, value: string): void => {
    const slug = slugifyLabel(label);

    if (unmapped[slug] === undefined && !isFull()) {
      unmapped[slug] = value;
    }
  };

  try {
    for (const entry of entries ?? []) {
      try {
        const label = String(entry?.label ?? '').trim();
        const rawValue = String(entry?.value ?? '').trim();

        if (isBlankAnswer(rawValue)) {
          continue;
        }

        // Meta's own preamble line ("Hello! I filled out your form: ...") is not a question.
        if (containsAnyHint(label.toLowerCase(), FORM_PREAMBLE_HINTS)) {
          continue;
        }

        if (URL_SCHEME_LABELS.has(label.toLowerCase())) {
          continue;
        }

        if (countLetters(label) < MIN_LABEL_LETTERS) {
          continue;
        }

        const key = keyForLabel(label);

        if (key === null) {
          keepUnmapped(label, truncateValue(rawValue));
          continue;
        }

        // A phone answer is typed however the lead felt like typing it ("+91 98765-43210").
        const value = truncateValue(key === 'phone' ? rawValue.replace(/\D/g, '') : rawValue);

        if (value === '') {
          continue;
        }

        if (facts[key] === undefined) {
          if (!isFull()) {
            facts[key] = value;
          }

          continue;
        }

        if (facts[key] !== value) {
          // Two questions mapped to the same fact - the live form asks about the event type
          // twice, in different words. Keep both rather than letting the second overwrite.
          keepUnmapped(label, value);
        }
      } catch {
        // One unreadable answer must not cost the rest of the form.
        continue;
      }
    }
  } catch {
    // Not even iterable. Whatever was gathered before that is still returned.
  }

  return { facts, unmapped };
};

/**
 * Answers that already contain a later question's answer.
 *
 * The form's package question routinely says "Only Photography", which is exactly what the AI
 * would otherwise ask about next. Reading it here is the difference between confirming something
 * and interrogating someone. Pure: returns a new record, the input is untouched.
 */
export const deriveFacts = (facts: Record<string, string>): Record<string, string> => {
  const derived: Record<string, string> = { ...(facts ?? {}) };

  try {
    const blob = Object.values(derived)
      .map((value) => String(value ?? '').toLowerCase())
      .join(' ');

    if (derived.photo_or_video === undefined) {
      const photo = blob.includes('photograph') || blob.includes('photo');
      const video =
        blob.includes('videograph') || blob.includes('cinematic') || blob.includes('video');

      if (blob.includes('only photography') || blob.includes('photography only')) {
        derived.photo_or_video = 'photography only';
      } else if (photo && video) {
        derived.photo_or_video = 'photo and video';
      } else if (photo) {
        derived.photo_or_video = 'photography';
      } else if (video) {
        derived.photo_or_video = 'videography';
      }
    }
  } catch {
    // Fall through with whatever was copied in.
  }

  return derived;
};

/**
 * Best guess at the service group, from everything the form said.
 *
 * Reads all the answers rather than one field: the live form never asks "which service?", it
 * asks what kind of event and which package, and the answer is spread across both.
 */
export const classifyCategory = (facts: Record<string, string>): string => {
  try {
    const blob = Object.values(facts ?? {})
      .map((value) => String(value ?? '').toLowerCase())
      .join(' ');

    return CATEGORY_HINTS.find((hint) => blob.includes(hint.match))?.category ?? UNKNOWN_LEAD_CATEGORY;
  } catch {
    return UNKNOWN_LEAD_CATEGORY;
  }
};

/**
 * Is this first message a pasted lead form rather than someone saying hello?
 *
 * Two independent signals, because either alone gets it wrong: Meta's preamble can be edited
 * away, and a chatty person can write one line with a colon in it.
 */
export const looksLikeForm = (text: string | null | undefined): boolean => {
  try {
    if (!text) {
      return false;
    }

    if (containsAnyHint(text.toLowerCase(), FORM_PREAMBLE_HINTS)) {
      return true;
    }

    const labelledLines = text
      .split(/\r?\n/)
      .filter((line) => LABELLED_LINE.test(line)).length;

    return labelledLines >= MIN_LABELLED_LINES;
  } catch {
    return false;
  }
};

/** The `Label: value` lines of a pasted form, in the order the lead sent them. */
export const splitPastedFormEntries = (text: string | null | undefined): FormFieldEntry[] => {
  try {
    return (text ?? '')
      .split(/\r?\n/)
      .map((line) => LABELLED_LINE.exec(line))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => ({ label: match[1] ?? '', value: (match[2] ?? '').trim() }));
  } catch {
    return [];
  }
};

/** A pasted click-to-WhatsApp form, read exactly like a sheet row's columns. */
export const parsePastedForm = (text: string | null | undefined): ParsedFormFields =>
  parseFormFields(splitPastedFormEntries(text));

export interface LeadFormFacts {
  /** Ready to merge into `Conversation.aiFacts`: canonical keys first, every unrecognised
   *  question kept under its slug, derived answers filled in, identity stripped out. */
  facts: Record<string, string>;
  /** A key of ai-brain/category-playbooks.ts, or `unknown`. */
  category: string;
}

/** Everything except the lead's own name, email and phone. See CONTACT_FACT_KEYS. */
export const omitContactFacts = (facts: Record<string, string>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(facts ?? {}).filter(([key]) => !CONTACT_FACT_KEYS.includes(key)),
  );

/**
 * The whole read, in the shape both writers need: the sheet importer and the pasted-form branch
 * of inbound ingestion each call this and merge the result onto the conversation.
 *
 * Canonical keys win over slugged ones on a collision (they cannot actually collide - a slug is
 * only used when no rule matched - but the order says which is authoritative).
 */
export const buildLeadFormFacts = ({ facts, unmapped }: ParsedFormFields): LeadFormFacts => {
  const merged = omitContactFacts({ ...unmapped, ...facts });
  const withDerived = deriveFacts(merged);

  return { facts: withDerived, category: classifyCategory(withDerived) };
};
