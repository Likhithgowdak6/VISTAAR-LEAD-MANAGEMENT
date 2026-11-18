/**
 * Meta's template components, reduced to what the composer needs.
 *
 * The variable count is the part worth being careful about: the composer uses it to decide how
 * many inputs to show, and Meta rejects a mismatch with a 132-series error the agent sees as a
 * bounced message rather than a form error. `{{1}} {{1}}` is one variable used twice, not two.
 */
import { describe, expect, it } from 'vitest';

import {
  countTemplateVariables,
  normalizeTemplateStatus,
  parseTemplateComponents,
  renderTemplatePreview,
} from './whatsapp-template.parser.js';

describe('countTemplateVariables', () => {
  it('counts consecutive placeholders', () => {
    expect(countTemplateVariables('Hi {{1}}, your booking on {{2}} is confirmed.')).toBe(2);
  });

  /**
   * The highest index, not the number of matches. Counting matches would demand two values for a
   * template that declares one, and Meta would refuse the send.
   */
  it('counts a repeated placeholder once', () => {
    expect(countTemplateVariables('Hi {{1}}, see you soon {{1}}!')).toBe(1);
  });

  it('uses the highest index when Meta numbers them oddly', () => {
    expect(countTemplateVariables('{{2}} only')).toBe(2);
  });

  it('tolerates whitespace inside the braces', () => {
    expect(countTemplateVariables('Hi {{ 1 }}')).toBe(1);
  });

  it.each([null, undefined, '', 'No placeholders here', 123, {}])(
    'returns 0 for %s',
    (input) => {
      expect(countTemplateVariables(input)).toBe(0);
    },
  );

  /** A global regex walked with `exec` is the classic way to get an infinite loop here. */
  it('terminates on a long run of placeholders', () => {
    const text = Array.from({ length: 30 }, (_, index) => `{{${index + 1}}}`).join(' ');

    expect(countTemplateVariables(text)).toBe(30);
  });
});

describe('normalizeTemplateStatus', () => {
  it.each([
    ['approved', 'APPROVED'],
    ['APPROVED', 'APPROVED'],
    ['  rejected ', 'REJECTED'],
    ['PENDING', 'PENDING'],
  ])('normalizes %s to %s', (input, expected) => {
    expect(normalizeTemplateStatus(input)).toBe(expected);
  });

  it.each([null, undefined, '', 'SOMETHING_NEW', 42])(
    'maps %s to UNKNOWN rather than guessing',
    (input) => {
      expect(normalizeTemplateStatus(input)).toBe('UNKNOWN');
    },
  );
});

describe('parseTemplateComponents', () => {
  it('reads body, text header and footer with their variable counts', () => {
    expect(
      parseTemplateComponents([
        { type: 'HEADER', format: 'TEXT', text: '{{1}} Events' },
        { type: 'BODY', text: 'Hi {{1}}, your date {{2}} is held.' },
        { type: 'FOOTER', text: 'Reply STOP to opt out' },
      ]),
    ).toEqual({
      headerText: '{{1}} Events',
      headerVariableCount: 1,
      bodyText: 'Hi {{1}}, your date {{2}} is held.',
      bodyVariableCount: 2,
      footerText: 'Reply STOP to opt out',
    });
  });

  /**
   * A media header takes a handle rather than a string. Storing the format name would show the
   * agent "IMAGE" as if it were the header's wording.
   */
  it('ignores a header that is not a text header', () => {
    const parsed = parseTemplateComponents([
      { type: 'HEADER', format: 'IMAGE' },
      { type: 'BODY', text: 'Hello' },
    ]);

    expect(parsed.headerText).toBeNull();
    expect(parsed.headerVariableCount).toBe(0);
  });

  it('accepts lowercase component types', () => {
    expect(parseTemplateComponents([{ type: 'body', text: 'Hello' }]).bodyText).toBe('Hello');
  });

  it('ignores a component type it does not recognize', () => {
    const parsed = parseTemplateComponents([
      { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Yes' }] },
      { type: 'BODY', text: 'Hello' },
    ]);

    expect(parsed.bodyText).toBe('Hello');
  });

  it.each([null, undefined, 'nonsense', 42, {}])('returns empty for %s', (input) => {
    expect(parseTemplateComponents(input)).toEqual({
      bodyText: null,
      headerText: null,
      footerText: null,
      bodyVariableCount: 0,
      headerVariableCount: 0,
    });
  });
});

describe('renderTemplatePreview', () => {
  it('substitutes values in order', () => {
    expect(renderTemplatePreview('Hi {{1}}, your date {{2}} is held.', ['Riya', '12 Dec'])).toBe(
      'Hi Riya, your date 12 Dec is held.',
    );
  });

  it('substitutes a repeated placeholder everywhere it appears', () => {
    expect(renderTemplatePreview('Hi {{1}}, bye {{1}}', ['Riya'])).toBe('Hi Riya, bye Riya');
  });

  /**
   * An unfilled placeholder stays visible as itself. Blanking it would show a sentence with a
   * hole in it and no hint that a value is missing.
   */
  it('leaves an unfilled placeholder in place', () => {
    expect(renderTemplatePreview('Hi {{1}}, your date {{2}}', ['Riya'])).toBe(
      'Hi Riya, your date {{2}}',
    );
  });

  it('leaves a placeholder given an empty value in place', () => {
    expect(renderTemplatePreview('Hi {{1}}', [''])).toBe('Hi {{1}}');
  });

  it.each([null, undefined, ''])('returns an empty string for %s', (input) => {
    expect(renderTemplatePreview(input)).toBe('');
  });

  it('renders a template with no placeholders unchanged', () => {
    expect(renderTemplatePreview('Thanks for getting in touch.', [])).toBe(
      'Thanks for getting in touch.',
    );
  });
});
