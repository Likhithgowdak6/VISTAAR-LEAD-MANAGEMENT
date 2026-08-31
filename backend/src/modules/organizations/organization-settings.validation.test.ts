/**
 * The owner-number body schema: what an admin may type into the dashboard field, what is
 * normalized away, and what is refused outright.
 */
import { describe, expect, it } from 'vitest';

import { updateOrganizationSettingsBodySchema } from './organization-settings.validation.js';

const parse = (ownerWhatsappNumber: unknown) =>
  updateOrganizationSettingsBodySchema.safeParse({ ownerWhatsappNumber });

describe('updateOrganizationSettingsBodySchema', () => {
  it('strips spaces, plus signs and dashes down to digits', () => {
    const result = parse('+91 81830-03081');

    expect(result.success).toBe(true);
    expect(result.data?.ownerWhatsappNumber).toBe('918183003081');
  });

  it('accepts a plain digits-only number unchanged', () => {
    expect(parse('8183003081').data?.ownerWhatsappNumber).toBe('8183003081');
  });

  it('accepts null as "clear it"', () => {
    const result = parse(null);

    expect(result.success).toBe(true);
    expect(result.data?.ownerWhatsappNumber).toBeNull();
  });

  it('accepts an empty (or whitespace-only) string as "clear it"', () => {
    expect(parse('').data?.ownerWhatsappNumber).toBeNull();
    expect(parse('   ').data?.ownerWhatsappNumber).toBeNull();
  });

  it('rejects a number that is too short to match an inbound sender safely', () => {
    expect(parse('1234567').success).toBe(false);
  });

  it('rejects a number longer than E.164 allows', () => {
    expect(parse('9184738299991234').success).toBe(false);
  });

  it('rejects text with no usable digits rather than silently clearing the setting', () => {
    expect(parse('not a phone').success).toBe(false);
  });

  it('rejects a non-string, non-null value', () => {
    expect(parse(918183003081).success).toBe(false);
    expect(parse(undefined).success).toBe(false);
  });
});
