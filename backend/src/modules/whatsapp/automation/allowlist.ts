/**
 * Test-phase safety net: a hard allowlist of phone numbers, enforced in BOTH directions when
 * `WHATSAPP_TEST_ALLOWED_NUMBERS` is non-empty:
 *
 *  - outbound: every send (AI or human-authored) must be addressed to an allowed number
 *  - inbound:  every incoming message must come from an allowed number, or it is dropped
 *              before it is ever persisted - so a personal number used for testing does not
 *              fill the dashboard with the owner's real chats
 *
 * An empty allowlist means unrestricted in both directions - the default, production behavior.
 * Clearing the env var is the single switch that turns the whole test-only mode off.
 */

const onlyDigits = (value: unknown): string => String(value ?? '').replace(/\D/g, '');

/**
 * Digits of the phone in a JID, or '' when the JID carries no phone. A `<id>@lid` is an opaque
 * LinkedID with no number in it at all, so it deliberately yields '' rather than the id's digits
 * - treating those digits as a phone would let an unrelated sender match the allowlist.
 */
export const phoneDigitsFromJid = (jid: unknown): string => {
  const value = typeof jid === 'string' ? jid.trim().toLowerCase() : '';

  if (value === '' || value.endsWith('@lid')) {
    return '';
  }

  // Strip the domain, then Baileys' device suffix (`1234:5@s.whatsapp.net`).
  const [local = ''] = value.split('@');
  const [bare = ''] = local.split(':');

  return onlyDigits(bare);
};

export const parseTestAllowedNumbers = (csv: string): Set<string> =>
  new Set(
    csv
      .split(',')
      .map((entry) => onlyDigits(entry))
      .filter((digits) => digits !== ''),
  );

/**
 * Numbers are compared on their trailing digits so a saved `8183003081` still matches the
 * `918183003081` WhatsApp actually delivers. The shorter of the two must be at least 8 digits
 * for a suffix match to count, which keeps a stray 3-digit entry from matching everything.
 */
const MIN_SUFFIX_MATCH_DIGITS = 8;

const sameNumber = (a: string, b: string): boolean => {
  if (a === '' || b === '') {
    return false;
  }

  if (a === b) {
    return true;
  }

  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];

  return shorter.length >= MIN_SUFFIX_MATCH_DIGITS && longer.endsWith(shorter);
};

/**
 * Digits to compare against the allowlist for one candidate, which may be a bare phone string
 * ('918183003081') or a full JID ('918183003081@s.whatsapp.net', '<id>@lid').
 */
const candidateDigits = (value: unknown): string => {
  const text = typeof value === 'string' ? value.trim() : '';

  return text.includes('@') ? phoneDigitsFromJid(text) : onlyDigits(text);
};

export interface NumberAllowlist {
  /** False only while the allowlist is empty - i.e. unrestricted, normal production mode. */
  active: boolean;
  /**
   * True when a message may be SENT to any of these candidates. Always true when the allowlist
   * is empty. Pass every identifier known for the recipient - the send address is often an
   * opaque `<id>@lid` carrying no phone, so the contact's stored phone has to be offered
   * alongside it or a legitimate recipient is refused on a technicality.
   */
  permits: (...candidates: Array<string | null | undefined>) => boolean;
  /**
   * True when a message FROM these JIDs may be ingested. Always true when the allowlist is
   * empty. Fails CLOSED while active: a candidate set with no readable phone is refused,
   * because the whole point of test mode is that nothing unexpected reaches the dashboard.
   */
  permitsInboundJid: (...jids: Array<string | null | undefined>) => boolean;
}

export const createNumberAllowlist = (csv: string): NumberAllowlist => {
  const allowed = [...parseTestAllowedNumbers(csv)];
  const active = allowed.length > 0;

  const anyMatches = (candidates: Array<string | null | undefined>): boolean =>
    candidates.some((candidate) => {
      const digits = candidateDigits(candidate);

      return digits !== '' && allowed.some((entry) => sameNumber(entry, digits));
    });

  const permits = (...candidates: Array<string | null | undefined>): boolean =>
    !active || anyMatches(candidates);

  const permitsInboundJid = (...jids: Array<string | null | undefined>): boolean =>
    !active || anyMatches(jids);

  return { active, permits, permitsInboundJid };
};

/** @deprecated Use {@link createNumberAllowlist}; kept so existing outbound callers compile. */
export const createOutboundAllowlist = createNumberAllowlist;

export type OutboundAllowlist = NumberAllowlist;
