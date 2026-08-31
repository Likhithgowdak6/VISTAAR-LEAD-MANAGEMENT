/**
 * The canonical form parser, which is pure and therefore worth testing hard: everything the AI
 * knows about a lead before they have written a word comes through here.
 *
 * No `config/env.js` mock, unlike most suites here: neither lead-field-rules.ts nor
 * category-playbooks.ts imports anything at all, so the real env module is never reached.
 */
import { describe, expect, it } from 'vitest';

import { DEFAULT_CATEGORY_REQUIRED_FIELDS } from '../ai-brain/category-playbooks.js';
import {
  buildLeadFormFacts,
  CATEGORY_HINTS,
  classifyCategory,
  deriveFacts,
  isBlankAnswer,
  isUnansweredValue,
  keyForLabel,
  LABEL_RULES,
  LEAD_CATEGORIES,
  looksLikeForm,
  parseFormFields,
  parsePastedForm,
  slugifyLabel,
  UNKNOWN_LEAD_CATEGORY,
} from './lead-field-rules.js';

/** The real thing, headers and typos included, as one pasted click-to-WhatsApp message. */
const PASTED_FORM = [
  'Hello! I filled out your form. Here are my answers:',
  'Full Name: Riya Sharma',
  'Phone Number: +91 98765-43210',
  'How would you describe this event?: House Warming',
  'Event Date: 12 January 2026',
  'Location / Area: Indiranagar, Bengaluru',
  'Approx Number of Guest: 250',
  'Choose Your Candid & Cinematic P&V Pacakage: Only Photography',
  'What is most important for you while choosing am Event Photography Partner: Good Communication with Guest Coordination',
].join('\n');

describe('LABEL_RULES', () => {
  it('is an ordered array, because the order is the behaviour', () => {
    expect(Array.isArray(LABEL_RULES)).toBe(true);
  });

  it('tests "event name" before the bare "name" fallback', () => {
    const eventNameIndex = LABEL_RULES.findIndex((rule) => rule.match === 'event name');
    const nameIndex = LABEL_RULES.findIndex((rule) => rule.match === 'name');

    expect(eventNameIndex).toBeGreaterThanOrEqual(0);
    expect(eventNameIndex).toBeLessThan(nameIndex);
    expect(nameIndex).toBe(LABEL_RULES.length - 1);
  });

  it('keeps the live form\'s "pacakage" typo', () => {
    expect(LABEL_RULES.some((rule) => rule.match === 'pacakage')).toBe(true);
  });
});

describe('keyForLabel', () => {
  it('reads "Event Name" as the event, not as the lead', () => {
    expect(keyForLabel('Event Name')).toBe('event_name');
    expect(keyForLabel('Full Name')).toBe('name');
    expect(keyForLabel('What is your name?')).toBe('name');
  });

  it('reads the sheet\'s machine headers and the pasted form\'s human labels the same way', () => {
    expect(keyForLabel('how_would_you_describe_this_event?')).toBe('event_type');
    expect(keyForLabel('How would you describe this event?')).toBe('event_type');
    expect(keyForLabel('event-date')).toBe('event_date');
    expect(keyForLabel('full__name')).toBe('name');
  });

  it('matches the live form\'s misspelt package question', () => {
    expect(keyForLabel('Choose Your Candid & Cinematic P&V Pacakage')).toBe('package_interest');
  });

  it('returns null when no rule matches, so the caller can keep the answer under its own slug', () => {
    expect(keyForLabel('Do you have a pet?')).toBeNull();
    expect(keyForLabel('')).toBeNull();
  });
});

describe('slugifyLabel', () => {
  it('keeps an unknown question under its own text', () => {
    expect(slugifyLabel('How did you hear about us?')).toBe('how_did_you_hear_about_us');
  });

  it('always produces a usable key', () => {
    expect(slugifyLabel('   ')).toBe('field');
    expect(slugifyLabel('***')).toBe('field');
  });
});

describe('parseFormFields', () => {
  it('maps recognised questions onto canonical keys', () => {
    const { facts } = parseFormFields([
      { label: 'How would you describe this event?', value: 'House Warming' },
      { label: 'Event Date', value: '12 January 2026' },
      { label: 'Location / Area', value: 'Indiranagar, Bengaluru' },
    ]);

    expect(facts).toEqual({
      event_type: 'House Warming',
      event_date: '12 January 2026',
      city: 'Indiranagar, Bengaluru',
    });
  });

  it('skips blank and "n/a"-style answers rather than storing the placeholder', () => {
    const { facts, unmapped } = parseFormFields([
      { label: 'Event Date', value: '   ' },
      { label: 'Location', value: 'n/a' },
      { label: 'Approx Number of Guest', value: '-' },
      { label: 'How did you hear about us?', value: 'none' },
    ]);

    expect(facts).toEqual({});
    expect(unmapped).toEqual({});
  });

  it('skips a label with fewer than three letters - a clock time is not a question', () => {
    const { facts, unmapped } = parseFormFields([{ label: '10', value: '30 pm' }]);

    expect(facts).toEqual({});
    expect(unmapped).toEqual({});
  });

  it('skips the URL half of a line that only split because a URL has a colon in it', () => {
    const { facts, unmapped } = parseFormFields([{ label: 'https', value: '//example.com/promo' }]);

    expect(facts).toEqual({});
    expect(unmapped).toEqual({});
  });

  it('skips Meta\'s own preamble line', () => {
    const { facts, unmapped } = parseFormFields([
      { label: 'Hello! I filled out your form. Here are my answers', value: 'House Warming' },
    ]);

    expect(facts).toEqual({});
    expect(unmapped).toEqual({});
  });

  it('never drops an unrecognised question - it keeps it under a slug of its own text', () => {
    const { facts, unmapped } = parseFormFields([
      { label: 'Do you need a drone?', value: 'Yes please' },
    ]);

    expect(facts).toEqual({});
    expect(unmapped).toEqual({ do_you_need_a_drone: 'Yes please' });
  });

  it('keeps both answers when two questions map to the same fact', () => {
    const { facts, unmapped } = parseFormFields([
      { label: 'What kind of event is it?', value: 'House Warming' },
      { label: 'How would you describe this event?', value: 'Griha Pravesh with lunch' },
    ]);

    expect(facts.event_type).toBe('House Warming');
    expect(unmapped.how_would_you_describe_this_event).toBe('Griha Pravesh with lunch');
  });

  it('does not duplicate an answer that repeats verbatim', () => {
    const { facts, unmapped } = parseFormFields([
      { label: 'What kind of event is it?', value: 'Wedding' },
      { label: 'Type of event', value: 'Wedding' },
    ]);

    expect(facts).toEqual({ event_type: 'Wedding' });
    expect(unmapped).toEqual({});
  });

  it('strips a phone answer down to digits', () => {
    const { facts } = parseFormFields([{ label: 'Phone Number', value: '+91 98765-43210' }]);

    expect(facts.phone).toBe('919876543210');
  });

  it('drops a phone answer with no digits in it at all', () => {
    const { facts } = parseFormFields([{ label: 'Phone Number', value: 'will share later' }]);

    expect(facts.phone).toBeUndefined();
  });

  it('never throws, whatever it is handed', () => {
    expect(() => parseFormFields(null)).not.toThrow();
    expect(() => parseFormFields(undefined)).not.toThrow();
    expect(parseFormFields([null, undefined, {}] as never).facts).toEqual({});
    expect(
      parseFormFields([{ label: 'Event Date', value: 12 as never }]).facts.event_date,
    ).toBe('12');
  });
});

describe('deriveFacts', () => {
  it('reads "Only Photography" out of the package answer instead of asking about it', () => {
    expect(deriveFacts({ package_interest: 'Only Photography' }).photo_or_video).toBe(
      'photography only',
    );
  });

  it('spots that a candid & cinematic package is both', () => {
    expect(
      deriveFacts({ package_interest: 'Candid Photography + Cinematic Video' }).photo_or_video,
    ).toBe('photo and video');
  });

  it('spots photography alone and videography alone', () => {
    expect(deriveFacts({ service_interest: 'Photography' }).photo_or_video).toBe('photography');
    expect(deriveFacts({ service_interest: 'Videography team' }).photo_or_video).toBe(
      'videography',
    );
  });

  it('infers nothing when the answers never mention either', () => {
    expect(deriveFacts({ city: 'Bengaluru' }).photo_or_video).toBeUndefined();
  });

  it('never overwrites an answer that is already there', () => {
    expect(
      deriveFacts({ photo_or_video: 'photo and video', package_interest: 'Only Photography' })
        .photo_or_video,
    ).toBe('photo and video');
  });

  it('is pure - the facts it was given come back unchanged', () => {
    const facts = { package_interest: 'Only Photography' };

    deriveFacts(facts);

    expect(facts).toEqual({ package_interest: 'Only Photography' });
  });
});

describe('classifyCategory', () => {
  // The sixteen named services: when the lead says what the occasion IS, that is the playbook
  // they get, because a birthday and a car delivery are not sold the same way.
  it.each([
    ['House Warming shoot', LEAD_CATEGORIES.HOUSE_WARMING],
    ['Wedding + reception', LEAD_CATEGORIES.WEDDING],
    ['My son\'s 1st birthday', LEAD_CATEGORIES.BIRTHDAY],
    ['25th wedding anniversary party', LEAD_CATEGORIES.ANNIVERSARY],
    ['New car delivery at the showroom', LEAD_CATEGORIES.CAR_DELIVERY],
    ['Half saree function', LEAD_CATEGORIES.HALF_SAREE],
    ['Ear piercing ceremony', LEAD_CATEGORIES.EAR_PIERCING],
    ['A farewell get together', LEAD_CATEGORIES.SOCIAL_PRIVATE_EVENT],
    ['Cricket tournament coverage', LEAD_CATEGORIES.SPORTS_EVENT],
    ['Corporate AGM coverage', LEAD_CATEGORIES.CORPORATE_EVENT],
    ['Podcast episodes, multi camera', LEAD_CATEGORIES.PODCAST_TALKING_HEAD],
    ['Ganesh Chaturthi festival coverage', LEAD_CATEGORIES.FESTIVAL_EVENT],
    ['Baby shower at home', LEAD_CATEGORIES.BABY_SHOWER],
    ['Real estate photography', LEAD_CATEGORIES.REAL_ESTATE_SHOOT],
    ['Interior shoot for a designer', LEAD_CATEGORIES.INTERIOR_ARTICLE_SHOOT],
    ['New year party at a club', LEAD_CATEGORIES.PARTY_SHOOT],
  ])('reads %s as %s', (answer, expected) => {
    expect(classifyCategory({ service_interest: answer })).toBe(expected);
  });

  // The broader groups still catch everything the sixteen do not name.
  it.each([
    ['Need an ecommerce catalogue site', LEAD_CATEGORIES.ECOMMERCE_WEB],
    ['Monthly social media handling', LEAD_CATEGORIES.MARKETING_RETAINER],
    ['New logo and branding', LEAD_CATEGORIES.SOCIAL_BRANDING],
    ['SEO for my clinic', LEAD_CATEGORIES.SEO_SEARCH],
    ['Product shoot for my brand', LEAD_CATEGORIES.CORPORATE_COMMERCIAL],
    ['Just some event photography', LEAD_CATEGORIES.EVENT_PHOTOGRAPHY],
    ['Naming ceremony', LEAD_CATEGORIES.EVENT_PHOTOGRAPHY],
  ])('reads %s as the broader %s', (answer, expected) => {
    expect(classifyCategory({ service_interest: answer })).toBe(expected);
  });

  it('reads the whole form, not one field', () => {
    expect(
      classifyCategory({ event_date: '12 Jan', package_interest: 'Candid wedding package' }),
    ).toBe(LEAD_CATEGORIES.WEDDING);
  });

  it('reads a wedding party as a wedding, not as a club night', () => {
    // "party" is one of the sixteen and it is a substring of "wedding party" - the order of
    // CATEGORY_HINTS is what stops that going wrong.
    expect(classifyCategory({ service_interest: 'Wedding party coverage' })).toBe(
      LEAD_CATEGORIES.WEDDING,
    );
  });

  it('puts real-estate photography with the property work, not the events', () => {
    expect(classifyCategory({ service_interest: 'Real estate photography' })).toBe(
      LEAD_CATEGORIES.REAL_ESTATE_SHOOT,
    );
  });

  it('falls back to unknown rather than guessing', () => {
    expect(classifyCategory({})).toBe(UNKNOWN_LEAD_CATEGORY);
    expect(classifyCategory({ what_matters: 'Good communication' })).toBe(UNKNOWN_LEAD_CATEGORY);
  });

  it('only ever returns a category ai-brain/category-playbooks.ts knows', () => {
    const playbookCategories = Object.keys(DEFAULT_CATEGORY_REQUIRED_FIELDS);

    expect(playbookCategories).toContain(UNKNOWN_LEAD_CATEGORY);

    for (const category of Object.values(LEAD_CATEGORIES)) {
      expect(playbookCategories).toContain(category);
    }

    for (const hint of CATEGORY_HINTS) {
      expect(playbookCategories).toContain(hint.category);
    }
  });
});

describe('looksLikeForm', () => {
  it('recognises Meta\'s preamble', () => {
    expect(looksLikeForm('Hello! I filled out your form. Here are my answers:')).toBe(true);
  });

  it('recognises three or more labelled lines even with the preamble edited away', () => {
    expect(looksLikeForm('Name: Riya\nEvent: Wedding\nDate: 12 Jan')).toBe(true);
  });

  it('is not fooled by one chatty line with a colon in it', () => {
    expect(looksLikeForm('Hi there: do you shoot house-warmings?')).toBe(false);
    expect(looksLikeForm('Hi\nQuestion: are you free on 12 Jan?')).toBe(false);
  });

  it('says no to nothing at all', () => {
    expect(looksLikeForm('')).toBe(false);
    expect(looksLikeForm(null)).toBe(false);
    expect(looksLikeForm(undefined)).toBe(false);
  });
});

describe('parsePastedForm', () => {
  it('reads a real pasted click-to-WhatsApp form', () => {
    const { facts, unmapped } = parsePastedForm(PASTED_FORM);

    expect(facts).toMatchObject({
      name: 'Riya Sharma',
      phone: '919876543210',
      event_type: 'House Warming',
      event_date: '12 January 2026',
      city: 'Indiranagar, Bengaluru',
      guest_count: '250',
      package_interest: 'Only Photography',
      what_matters: 'Good Communication with Guest Coordination',
    });
    expect(unmapped).toEqual({});
  });

  it('never throws on a message that is not a form at all', () => {
    expect(() => parsePastedForm('hi')).not.toThrow();
    expect(parsePastedForm(null).facts).toEqual({});
  });
});

describe('buildLeadFormFacts', () => {
  it('turns a pasted form into what the conversation should know', () => {
    const { facts, category } = buildLeadFormFacts(parsePastedForm(PASTED_FORM));

    expect(category).toBe(LEAD_CATEGORIES.HOUSE_WARMING);
    expect(facts).toMatchObject({
      event_type: 'House Warming',
      event_date: '12 January 2026',
      city: 'Indiranagar, Bengaluru',
      guest_count: '250',
      // Derived: the package answer already settled the question the AI would have asked next.
      photo_or_video: 'photography only',
    });
  });

  it('never puts the lead\'s own name, email or phone in the facts - ADR-005', () => {
    const { facts } = buildLeadFormFacts(parsePastedForm(PASTED_FORM));

    expect(facts.name).toBeUndefined();
    expect(facts.phone).toBeUndefined();
    expect(facts.email).toBeUndefined();
  });

  it('keeps unrecognised questions alongside the canonical ones', () => {
    const { facts } = buildLeadFormFacts(
      parseFormFields([
        { label: 'How would you describe this event?', value: 'Birthday' },
        { label: 'Do you need a drone?', value: 'Yes please' },
      ]),
    );

    expect(facts.event_type).toBe('Birthday');
    expect(facts.do_you_need_a_drone).toBe('Yes please');
  });

  it('classifies on the answers alone, never on an email address', () => {
    const { category } = buildLeadFormFacts(
      parseFormFields([{ label: 'Email', value: 'weddingphotos@example.com' }]),
    );

    expect(category).toBe(UNKNOWN_LEAD_CATEGORY);
  });
});

// --------------------------------------------------------------------------
// Blank handling: the one place this codebase decides whether a lead actually answered a
// question. The form parser drops blanks; conversations/lead-score.ts refuses to score either
// kind, which is why the "not decided yet" family lives here too rather than in a second list.
// --------------------------------------------------------------------------
describe('isBlankAnswer', () => {
  it.each(['', ' ', '-', '--', '?', 'n/a', 'N/A', 'na', 'none', 'NULL'])(
    'reads %j as blank',
    (value) => {
      expect(isBlankAnswer(value)).toBe(true);
    },
  );

  it.each(['12 September', '0', 'no', 'not decided yet'])('reads %j as written-in', (value) => {
    expect(isBlankAnswer(value)).toBe(false);
  });

  it('is safe for null, undefined and non-strings', () => {
    expect(isBlankAnswer(null)).toBe(true);
    expect(isBlankAnswer(undefined)).toBe(true);
    expect(isBlankAnswer(12)).toBe(false);
  });
});

describe('isUnansweredValue', () => {
  it('treats every blank as unanswered too', () => {
    expect(isUnansweredValue('')).toBe(true);
    expect(isUnansweredValue('n/a')).toBe(true);
  });

  it.each([
    'not decided yet',
    'Not Decided',
    'not decided yet!!',
    'not sure',
    'not fixed',
    'TBD',
    'to be decided',
    'undecided',
    'abhi decide nahi kiya',
    'pata nahi',
  ])('reads %j as a reply that is not an answer', (value) => {
    expect(isUnansweredValue(value)).toBe(true);
  });

  it.each(['12 September 2026', 'Whitefield, Bangalore', '1.2 lakh', 'Sure, 50000'])(
    'reads %j as a real answer',
    (value) => {
      expect(isUnansweredValue(value)).toBe(false);
    },
  );

  it('is safe for null, undefined and non-strings', () => {
    expect(isUnansweredValue(null)).toBe(true);
    expect(isUnansweredValue(undefined)).toBe(true);
    expect(isUnansweredValue({})).toBe(false);
  });
});

describe('the form parser keeps storing "not decided yet"', () => {
  it('stores the lead\'s actual words, so the AI knows it already asked', () => {
    const { facts } = parseFormFields([
      { label: 'Event date', value: 'Not decided yet' },
      { label: 'Venue', value: '-' },
    ]);

    expect(facts.event_date).toBe('Not decided yet');
    expect(facts.city).toBeUndefined();
  });
});
