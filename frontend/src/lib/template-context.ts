/**
 * Folding what we know about a lead into the offer the owner typed.
 *
 * WHY THIS AND NOT A NEW API FIELD. `/templates/generate` takes one free-text `rawDetails` and
 * hands it to a writer that is explicitly instructed to use only what it was given and to
 * invent nothing. Adding a `conversationId` parameter would mean a new contract, new
 * validation, and a second place deciding what context a template may see - all for something
 * the existing field already carries. The owner describes the offer; this adds who it is for.
 *
 * NOTHING IS INVENTED HERE either. Only facts the lead actually gave us, named as they are
 * stored, so the writer can use them or ignore them.
 */

/** Keeps the composed string inside the endpoint's 2000-character validation limit. */
export const RAW_DETAILS_MAX = 1800;

/** The facts worth handing the writer, in the order a person would say them aloud. */
export const CONTEXT_FACT_KEYS = ['event_type', 'event_date', 'shoot_date', 'city', 'guest_count'];

const humanise = (value: string): string => value.replace(/[_-]+/g, ' ').trim();

export const buildRawDetails = (
  offer: string,
  aiCategory?: string | null,
  aiFacts?: Record<string, unknown> | null,
): string => {
  const lines = [offer.trim()];
  const category = (aiCategory ?? '').trim();

  // `unknown` is the placeholder for "not classified yet" and means nothing to a writer.
  if (category !== '' && category !== 'unknown') {
    lines.push(`Service: ${humanise(category)}`);
  }

  const facts = aiFacts ?? {};
  const details = CONTEXT_FACT_KEYS.map((key) => {
    const value = facts[key];

    return typeof value === 'string' && value.trim() !== ''
      ? `${humanise(key)}: ${value.trim()}`
      : null;
  }).filter((entry): entry is string => entry !== null);

  if (details.length > 0) {
    lines.push(`What they have told us - ${details.join('; ')}`);
  }

  return lines.join('\n').slice(0, RAW_DETAILS_MAX);
};
