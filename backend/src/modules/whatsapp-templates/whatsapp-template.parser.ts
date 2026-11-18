/**
 * Meta's `components` array, reduced to the handful of facts the composer needs.
 *
 * Pure and defensive: the array arrives from Meta, its shape varies by template type, and new
 * component kinds appear without warning. Anything unrecognised is ignored rather than thrown on,
 * because one odd template must not fail the sync for every other template on the account.
 */
import {
  WHATSAPP_TEMPLATE_STATUSES,
  type WhatsAppTemplateStatus,
} from './whatsapp-template.model.js';

/**
 * Matches a WhatsApp placeholder: `{{1}}`, `{{2}}`, ...
 *
 * Meta numbers them from 1 and they must be consecutive for a template to be approved, so the
 * HIGHEST index is the count rather than the number of matches. A body reading `{{1}} {{1}}`
 * declares one variable used twice, and counting matches would demand two values and be rejected.
 */
const PLACEHOLDER_PATTERN = /\{\{\s*(\d+)\s*\}\}/g;

/** Fail closed for formats the sender cannot fill. This also covers old cache rows. */
export const isSupportedTemplate = (components: unknown): boolean => {
  if (!Array.isArray(components) || components.length === 0) return false;
  let body = false;
  for (const component of components) {
    if (!component || typeof component !== 'object') return false;
    const kind = String(component.type ?? '').toUpperCase();
    if (!['BODY', 'HEADER', 'FOOTER'].includes(kind)) return false;
    if (kind === 'HEADER' && String(component.format ?? 'TEXT').toUpperCase() !== 'TEXT') return false;
    if (typeof component.text !== 'string') return false;
    if (component.text.replace(/\{\{\s*[1-9]\d*\s*\}\}/g, '').includes('{{')) return false;
    if (kind === 'BODY') body = component.text.trim() !== '';
  }
  return body;
};

export const countTemplateVariables = (text: unknown): number => {
  if (typeof text !== 'string' || text === '') {
    return 0;
  }

  let highest = 0;

  // `matchAll` rather than a loop over `exec`, which would need the lastIndex reset and is the
  // classic way to get an infinite loop out of a global regex.
  for (const match of text.matchAll(PLACEHOLDER_PATTERN)) {
    const index = Number(match[1]);

    if (Number.isInteger(index) && index > highest) {
      highest = index;
    }
  }

  return highest;
};

export const normalizeTemplateStatus = (value: unknown): WhatsAppTemplateStatus => {
  const status = typeof value === 'string' ? value.trim().toUpperCase() : '';

  return (
    (Object.values(WHATSAPP_TEMPLATE_STATUSES) as string[]).includes(status)
      ? status
      : WHATSAPP_TEMPLATE_STATUSES.UNKNOWN
  ) as WhatsAppTemplateStatus;
};

export interface ParsedTemplateComponents {
  bodyText: string | null;
  headerText: string | null;
  footerText: string | null;
  bodyVariableCount: number;
  headerVariableCount: number;
}

/**
 * Pulls the readable parts out of a template's components.
 *
 * A header is only read when its format is TEXT. An IMAGE, VIDEO or DOCUMENT header takes a media
 * handle rather than a string, which this integration does not support sending - so it is
 * deliberately left null rather than storing a format name the composer would render as if it
 * were the header's wording.
 */
export const parseTemplateComponents = (components: unknown): ParsedTemplateComponents => {
  const parsed: ParsedTemplateComponents = {
    bodyText: null,
    headerText: null,
    footerText: null,
    bodyVariableCount: 0,
    headerVariableCount: 0,
  };

  if (!Array.isArray(components)) {
    return parsed;
  }

  for (const entry of components) {
    const component = (entry ?? {}) as { type?: unknown; format?: unknown; text?: unknown };
    const type = typeof component.type === 'string' ? component.type.toUpperCase() : '';
    const text = typeof component.text === 'string' ? component.text : null;

    if (type === 'BODY' && text !== null) {
      parsed.bodyText = text;
      parsed.bodyVariableCount = countTemplateVariables(text);
      continue;
    }

    if (type === 'HEADER') {
      const format = typeof component.format === 'string' ? component.format.toUpperCase() : 'TEXT';

      if (format === 'TEXT' && text !== null) {
        parsed.headerText = text;
        parsed.headerVariableCount = countTemplateVariables(text);
      }

      continue;
    }

    if (type === 'FOOTER' && text !== null) {
      parsed.footerText = text;
    }
  }

  return parsed;
};

/**
 * Substitutes values into an approved body, for PREVIEW ONLY.
 *
 * What is actually sent is the template name plus the values - Meta performs the substitution on
 * its side. This exists so an agent can read the message as the customer will receive it before
 * pressing send, and it must never be used to construct a message body: a template rendered
 * locally and sent as free text would be refused outside the service window and would bypass the
 * approved wording inside it.
 */
export const renderTemplatePreview = (
  text: string | null | undefined,
  values: readonly string[] = [],
): string => {
  if (typeof text !== 'string' || text === '') {
    return '';
  }

  return text.replace(PLACEHOLDER_PATTERN, (match, rawIndex: string) => {
    const index = Number(rawIndex);

    if (!Number.isInteger(index) || index < 1) {
      return match;
    }

    const value = values[index - 1];

    // An unfilled placeholder stays visible as itself. Replacing it with an empty string would
    // show the agent a sentence with a hole in it and no hint that a value is missing.
    return typeof value === 'string' && value !== '' ? value : match;
  });
};
