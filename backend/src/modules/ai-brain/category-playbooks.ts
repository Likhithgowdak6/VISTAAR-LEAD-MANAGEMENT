/**
 * ONE PLAYBOOK PER SERVICE: what the AI must learn before it can draft a reply, and a short
 * brief telling it how this particular job differs from every other one.
 *
 * The client's instruction was "think like for birthday separate agent, anniversary separate
 * agent". This table is that, without sixteen agents: the qualifying prompt is the same prompt,
 * and exactly ONE service's `requiredFields` and `brief` are interpolated into it per call - see
 * ai-brain-context.service.ts. Sending all sixteen briefs would cost roughly 900 tokens a turn
 * against an 8,000-per-minute ceiling that is already being hit; sending the relevant one costs
 * about 50.
 *
 * THE SIXTEEN EXTEND THE OLD SEVEN, THEY DO NOT REPLACE THEM. Three reasons:
 *
 *  1. `Conversation.aiCategory` is a stored string. Rows written before this table existed hold
 *     `event_photography` and friends, and a lead must not break because the vocabulary moved on.
 *  2. Four of the old seven - `ecommerce_web`, `marketing_retainer`, `social_branding`,
 *     `seo_search` - are real service lines (websites, ads, branding, SEO) that the client's
 *     sixteen shoot types simply do not cover. Dropping them would send an SEO enquiry to the
 *     generic fallback.
 *  3. `event_photography` and `corporate_commercial` stay useful as the GROUP fallbacks: a lead
 *     who says only "I need event photography" has not told us which of the sixteen it is, and
 *     "product shoot" is commercial work with no home among the sixteen.
 *
 * So lead-sources/lead-field-rules.ts's CATEGORY_HINTS now prefers a specific service whenever
 * the lead names the actual occasion, and falls back to a group key when they do not. Both
 * resolve here; anything unrecognised resolves to `unknown` rather than throwing.
 *
 * ON THE FACT KEYS: every key below already exists in lead-sources/lead-field-rules.ts's
 * vocabulary (`event_date`, `city`, `timing`, `photo_or_video`, `guest_count`, `shoot_type`,
 * `shoot_date`, `deliverables_needed`, ...). Not one new key was invented for the sixteen -
 * a key nothing maps a form label onto is a question the AI can only ever ask out loud.
 *
 * ON LENGTH: short lists on purpose. Every field added here is another question a lead has to
 * survive before hearing a price, and `city` in particular is load-bearing - it is what
 * conversations/lead-score.ts scores as "venue given".
 */

export interface CategoryPlaybook {
  /** What must be answered before the AI may move on from qualifying. */
  readonly requiredFields: readonly string[];
  /** How THIS job differs. Written for the model, not the owner: plain, factual, imperative. */
  readonly brief: string;
}

/** The lead's own event, hour by hour, is what these five ask about. */
const EVENT_FIELDS = Object.freeze(['event_date', 'city', 'timing', 'photo_or_video']);
const EVENT_FIELDS_WITH_GUESTS = Object.freeze([...EVENT_FIELDS, 'guest_count']);
/** A commissioned shoot: what is being shot, when, where, and what has to come out of it. */
const COMMISSIONED_FIELDS = Object.freeze([
  'shoot_type',
  'shoot_date',
  'city',
  'deliverables_needed',
]);

export const CATEGORY_PLAYBOOKS: Readonly<Record<string, CategoryPlaybook>> = Object.freeze({
  // ---------------------------------------------------------------- the sixteen
  wedding: {
    requiredFields: EVENT_FIELDS_WITH_GUESTS,
    brief:
      'Months of planning and the largest budget in this list. Rarely one day - haldi, mehendi, sangeet and reception are usually asked about together, so find out how many functions before anything else. Families decide jointly, so slow replies are normal, not disinterest.',
  },
  birthday: {
    requiredFields: EVENT_FIELDS_WITH_GUESTS,
    brief:
      'Booked two to four weeks out, a few hours at one venue. Milestone years - first, eighteenth, sixtieth - carry a noticeably bigger budget than the rest, so ask whose birthday it is. The family candids matter more than the cake-cutting.',
  },
  anniversary: {
    requiredFields: EVENT_FIELDS,
    brief:
      'Often arranged as a surprise by one partner, so never assume both are in the chat. Ranges from a two-hour couple shoot to a full party - ask which before quoting anything.',
  },
  car_delivery: {
    requiredFields: EVENT_FIELDS,
    brief:
      'A one-hour shoot at a showroom, booked days and sometimes hours ahead. The dealer fixes the delivery slot, so the date and the exact time are the whole conversation. A small job - do not over-scope it or stall it with questions.',
  },
  house_warming: {
    requiredFields: EVENT_FIELDS_WITH_GUESTS,
    brief:
      'Griha pravesh: rituals in the morning, guests through the day. Ask what time the pooja starts, not just the date - the schedule and the light both turn on it. The house itself becomes part of the memory here.',
  },
  half_saree: {
    requiredFields: EVENT_FIELDS_WITH_GUESTS,
    brief:
      'A South Indian coming-of-age ceremony for a girl, run at the scale of a small wedding: rituals, a change into the half saree, guests, and family portraits. Ask how many hours and whether formal family portraits are wanted. Let the family describe their own customs; do not assume them.',
  },
  ear_piercing: {
    requiredFields: EVENT_FIELDS,
    brief:
      'Karnavedha: a short ceremony for a baby or young child, an hour or two at home or a temple, sometimes with a gathering after. Small and booked close to the date. Ask the child’s age and whether family are coming.',
  },
  social_private_event: {
    requiredFields: Object.freeze(['event_type', ...EVENT_FIELDS]),
    brief:
      'A get-together with no ritual attached - a farewell, a reunion, a private dinner. Ask what the occasion actually is, in their words, before anything else: the answer changes the whole job.',
  },
  sports_event: {
    requiredFields: Object.freeze(['event_type', 'event_date', 'city', 'timing', 'deliverables_needed']),
    brief:
      'A match or tournament day: long hours, fast action, a lot of footage cut down to very little. Ask how many hours of play and what they need out of it - a highlights film, stills for social, or both. Deliverables matter more than guest counts here.',
  },
  corporate_event: {
    requiredFields: Object.freeze(['event_type', 'event_date', 'city', 'timing', 'deliverables_needed']),
    brief:
      'A conference, awards night, launch or offsite booked by a company. There is a written brief, a budget that someone else signs off, and usually a fast turnaround expectation. Ask what the footage is for and who approves it.',
  },
  podcast_talking_head: {
    requiredFields: Object.freeze(['shoot_date', 'city', 'timing', 'deliverables_needed']),
    brief:
      'A controlled studio-style shoot, and more often recurring than one-off. Ask how many episodes, how long each runs, and whether they need multiple cameras and edited cuts. A monthly arrangement is likelier here than a single booking.',
  },
  festival_event: {
    requiredFields: Object.freeze(['event_type', ...EVENT_FIELDS]),
    brief:
      'Ganesh Chaturthi, Navratri, Diwali, Christmas and the rest - community or apartment scale, on a date the calendar fixed long ago. Everyone books late for the same few days, so availability is tight. Ask which day and how many hours.',
  },
  baby_shower: {
    requiredFields: EVENT_FIELDS_WITH_GUESTS,
    brief:
      'Seemantham or a modern shower: a few hours, usually indoors, family-heavy. The mother-to-be gets the extra attention and it is worth saying so. Booked a few weeks out and rarely moved.',
  },
  real_estate_shoot: {
    requiredFields: COMMISSIONED_FIELDS,
    brief:
      'A property, not a person: apartments, villas, plots or a builder’s whole inventory. Ask how many properties and what the images are for - a listing, a brochure or ads. Drone and twilight shots come up constantly; never promise drone without checking. This is quoted custom, never off a band.',
  },
  interior_article_shoot: {
    requiredFields: COMMISSIONED_FIELDS,
    brief:
      'Interiors, furniture, decor or individual articles, shot for a designer, brand or catalogue. Ask how many rooms or articles and where the images will be used. Styling and lighting time drives the cost, not the number of hours on site.',
  },
  party_shoot: {
    requiredFields: EVENT_FIELDS_WITH_GUESTS,
    brief:
      'An evening job - a club night, a venue birthday, a New Year party. Candid coverage in low light rather than posed portraits. Ask the hours and the venue: the venue’s lighting decides the whole setup.',
  },

  // ------------------------------------------------ the older, broader service groups
  // Still reached: by a lead who names no specific occasion, and by every conversation whose
  // `aiCategory` was written before the sixteen existed.
  event_photography: {
    requiredFields: Object.freeze(['event_type', 'event_date', 'city', 'timing', 'photo_or_video']),
    brief:
      'An event of some kind, not yet pinned down. Get the occasion in their own words first - a wedding, a birthday and a car delivery are three completely different jobs - and then the date, the place and the hours.',
  },
  corporate_commercial: {
    requiredFields: COMMISSIONED_FIELDS,
    brief:
      'A commissioned shoot for a business rather than a family - product, commercial or brand work. There is a brief and an approval chain behind it. Ask what the images are for before quoting anything.',
  },
  ecommerce_web: {
    requiredFields: Object.freeze(['business_type', 'site_purpose', 'product_count', 'timeline']),
    brief:
      'A website or storefront build, not a shoot. The size of the catalogue and the launch date are what decide the job. Ask what they sell and how many products before talking about anything else.',
  },
  marketing_retainer: {
    requiredFields: Object.freeze([
      'business_type',
      'primary_goal',
      'current_channels',
      'monthly_budget',
    ]),
    brief:
      'An ongoing monthly arrangement, not a one-off. What matters is what they want to change and what they are already running. Ask the goal and the current channels; the monthly budget follows from those, not the other way round.',
  },
  social_branding: {
    requiredFields: Object.freeze([
      'business_type',
      'what_they_need',
      'has_existing_identity',
      'timeline',
    ]),
    brief:
      'Identity work - a logo, a rebrand, a consistent look. Find out whether anything already exists before offering to build it: rebuilding around an existing identity is a different job from starting clean.',
  },
  seo_search: {
    requiredFields: Object.freeze(['business_type', 'website_url', 'target_locations', 'primary_goal']),
    brief:
      'Search work, which compounds slowly - never imply a fast result. Ask what the site is, where they want to be found, and what a win looks like to them.',
  },

  // ------------------------------------------------------------------- the fallback
  unknown: {
    requiredFields: Object.freeze(['service_interest', 'city', 'timeline']),
    brief:
      'Nobody has worked out what this lead wants yet. Find out what the occasion or the shoot is before anything else - every other question depends on the answer.',
  },
});

/**
 * The required-field lists alone, keyed by category. Derived from CATEGORY_PLAYBOOKS rather than
 * written twice, so the two can never drift; lead-sources/lead-field-rules.test.ts asserts that
 * every category the form parser can produce has an entry here.
 */
export const DEFAULT_CATEGORY_REQUIRED_FIELDS: Readonly<Record<string, readonly string[]>> =
  Object.freeze(
    Object.fromEntries(
      Object.entries(CATEGORY_PLAYBOOKS).map(([category, playbook]) => [
        category,
        playbook.requiredFields,
      ]),
    ),
  );

/** The `unknown` playbook - what any category this table has never heard of resolves to. */
const FALLBACK_PLAYBOOK = CATEGORY_PLAYBOOKS.unknown!;

/**
 * Never throws and never returns undefined: an `aiCategory` written by an older version of this
 * code, or hand-edited in the database, still gets a usable list.
 *
 * `Object.hasOwn` rather than a plain lookup because `aiCategory` is a string off a document and
 * a plain object inherits `constructor`, `toString` and the rest from Object.prototype - a lead
 * filed under "constructor" would otherwise resolve to a function and crash the caller.
 */
export const playbookForCategory = (category: string): CategoryPlaybook =>
  Object.hasOwn(CATEGORY_PLAYBOOKS, category) ? CATEGORY_PLAYBOOKS[category]! : FALLBACK_PLAYBOOK;

export const requiredFieldsForCategory = (category: string): readonly string[] =>
  playbookForCategory(category).requiredFields;

/** The one service brief that goes into this call's qualifying prompt. */
export const serviceBriefForCategory = (category: string): string =>
  playbookForCategory(category).brief;
