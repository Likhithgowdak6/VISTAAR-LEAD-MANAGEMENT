/**
 * Finding the lead's phone number, which on a WhatsApp-first CRM is the whole lead.
 *
 * THE INCIDENT THESE PIN. Production connected a Meta form on 2026-10-27 and imported nothing:
 * both leads were skipped `no_phone` and `totalImported` stayed at 0, while the sync reported
 * `ok`. The cause was that the only header ever matched was `phone_number` - the machine name
 * Meta gives its OWN standard question. A business that asks for a number with a question of its
 * own produces a different machine name, the lookup misses, and the lead is silently unusable.
 *
 * THE OPPOSITE FAILURE IS WORSE, which is why the alias list is short and literal. A form asking
 * "number of guests" must never have that answer read as a telephone number: that would create a
 * contact on a fabricated number and, on a WhatsApp CRM, eventually message a stranger. So every
 * test that proves an alias is matched is paired with one proving a near-miss is not.
 *
 * AND LEADS WITH NO NUMBER MUST STILL BE SKIPPED. Loosening the gate would be the easy way to
 * make the counts look better and the wrong one - see the final block.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: { NODE_ENV: 'test', LOG_LEVEL: 'silent' },
}));

const { mapMetaGraphLead, PHONE_HEADER_ALIASES } = await import('./meta-lead.mapper.js');

/** A Graph lead carrying whatever questions a test needs. */
const graphLead = (fields: { name: string; values: string[] }[]) => ({
  id: 'l:1234567890',
  created_time: '2026-10-27T14:23:06+0000',
  form_id: '2146964952864735',
  platform: 'fb',
  is_organic: false,
  field_data: fields,
});

const mapWith = (
  fields: { name: string; values: string[] }[],
  columnMapping: Record<string, string | null> | null = null,
) => mapMetaGraphLead({ lead: graphLead(fields), columnMapping });

describe("Meta's own standard question", () => {
  it('is read, and remains the primary path', () => {
    const lead = mapWith([{ name: 'phone_number', values: ['+919876543210'] }]);

    expect(lead.phone).toBe('+919876543210');
  });

  it('wins over an alias when the form carries both', () => {
    // A form with Meta's standard question AND a custom one: the standard answer is the one
    // Meta validated, so it is the one to trust.
    const lead = mapWith([
      { name: 'whatsapp_number', values: ['+919000000000'] },
      { name: 'phone_number', values: ['+919876543210'] },
    ]);

    expect(lead.phone).toBe('+919876543210');
  });

  it('still strips Meta’s `p:` identifier prefix', () => {
    const lead = mapWith([{ name: 'phone_number', values: ['p:+919876543210'] }]);

    expect(lead.phone).toBe('+919876543210');
  });
});

describe('aliases, for forms that ask in their own words', () => {
  it.each(PHONE_HEADER_ALIASES.map((alias) => [alias]))('matches %s', (alias: string) => {
    const lead = mapWith([{ name: alias, values: ['+919876543210'] }]);

    expect(lead.phone).toBe('+919876543210');
  });

  it('matches regardless of case and surrounding space', () => {
    const lead = mapWith([{ name: '  WhatsApp Number  ', values: ['+919876543210'] }]);

    expect(lead.phone).toBe('+919876543210');
  });

  it('takes the first alias in list order when a form has two', () => {
    // Deterministic, so the same form never maps differently between runs.
    const lead = mapWith([
      { name: 'whatsapp_number', values: ['+919000000000'] },
      { name: 'mobile', values: ['+919876543210'] },
    ]);

    expect(lead.phone).toBe('+919876543210');
  });
});

describe('NEAR MISSES THAT MUST NOT BE READ AS A PHONE', () => {
  it.each([
    ['number of guests', ['250']],
    ['guest_count', ['250']],
    ['contact_person', ['Riya Sharma']],
    ['contact', ['Riya Sharma']],
    ['preferred_contact_time', ['5pm']],
    ['account_number', ['000123456789']],
    ['phone_model', ['iPhone 15']],
  ])('ignores %s', (name: string, values: string[]) => {
    // Any of these read as a phone would create a contact on a fabricated number, and on this
    // CRM that eventually means messaging someone who never gave us a number.
    const lead = mapWith([{ name, values }]);

    expect(lead.phone).toBeNull();
  });
});

describe('an explicit override always wins', () => {
  it('reads the mapped question even when an alias is also present', () => {
    const lead = mapWith(
      [
        { name: 'mobile', values: ['+919000000000'] },
        { name: 'best_number_to_reach_you', values: ['+919876543210'] },
      ],
      { phone: 'best_number_to_reach_you' },
    );

    expect(lead.phone).toBe('+919876543210');
  });

  it('DOES NOT FALL BACK TO AN ALIAS when the override matches nothing', () => {
    // A wrong mapping must surface as a skipped lead, not be papered over by a guess - otherwise
    // the admin never learns their mapping is broken.
    const lead = mapWith(
      [{ name: 'mobile', values: ['+919876543210'] }],
      { phone: 'a_question_that_does_not_exist' },
    );

    expect(lead.phone).toBeNull();
  });
});

describe('ADR-005: an alias answer must not reach the AI', () => {
  it('does NOT also publish the alias as a custom field', () => {
    /*
     * The subtle half of this change. Custom fields are what the AI context is built from, and
     * identity - name, email, phone - is deliberately kept out of it. An alias header is not a
     * standard column, so without being added to the mapped set it would be read as the phone
     * AND republished as an ordinary question, putting the number in front of the model.
     */
    const lead = mapWith([
      { name: 'whatsapp_number', values: ['+919876543210'] },
      { name: 'how_would_you_describe_this_event?', values: ['house_warming'] },
    ]);

    expect(lead.phone).toBe('+919876543210');

    const keys = lead.customFields.map((field) => field.key);
    expect(keys).not.toContain('whatsapp_number');
    expect(keys).toContain('how_would_you_describe_this_event?');
  });

  it('keeps a non-phone question available to the AI as before', () => {
    const lead = mapWith([
      { name: 'phone_number', values: ['+919876543210'] },
      { name: 'number of guests', values: ['250'] },
    ]);

    expect(lead.customFields.map((field) => field.key)).toContain('number of guests');
  });
});

describe('malformed and missing values', () => {
  it('reports no phone when the form asked for none', () => {
    const lead = mapWith([{ name: 'full_name', values: ['Riya Sharma'] }]);

    expect(lead.phone).toBeNull();
  });

  it('treats an empty answer as no phone', () => {
    expect(mapWith([{ name: 'phone_number', values: [''] }]).phone).toBeNull();
    expect(mapWith([{ name: 'phone_number', values: ['   '] }]).phone).toBeNull();
    expect(mapWith([{ name: 'whatsapp_number', values: [] }]).phone).toBeNull();
  });

  it('does not invent a phone from a missing field_data block', () => {
    const lead = mapMetaGraphLead({
      lead: { id: 'l:1', created_time: '2026-10-27T14:23:06+0000' },
      columnMapping: null,
    });

    expect(lead.phone).toBeNull();
  });

  it('passes a junk value through for the normalizer to reject downstream', () => {
    // The mapper's job is to FIND the answer, not to validate it. `normalizePhoneNumber` in the
    // pipeline decides whether it is dialable, and records `unparsable_phone` when it is not -
    // which is a different, more diagnosable skip reason than `no_phone`.
    expect(mapWith([{ name: 'mobile', values: ['not a number'] }]).phone).toBe('not a number');
    expect(mapWith([{ name: 'mobile', values: ['+'] }]).phone).toBe('+');
  });

  it('joins a multi-value answer rather than dropping it', () => {
    expect(mapWith([{ name: 'mobile', values: ['+9198765', '43210'] }]).phone).toBe(
      '+9198765, 43210',
    );
  });
});
