/**
 * Opening a specific lead from a link sent over WhatsApp.
 *
 * WHY A QUERY PARAMETER AND NOT A ROUTE. This app has no router: AppShell holds `view` and
 * `selectedId` in state, and the only established way in from outside is a parameter read once
 * on load and then wiped from the address bar. The Meta OAuth callback already returns that way
 * - see meta-connect.ts, which this deliberately mirrors rather than inventing a second shape.
 *
 * WIPING MATTERS, for the same reason it does there. Left in place, a refresh would re-open the
 * thread the owner had just navigated away from, and a shared URL would carry somebody else's
 * lead id around forever.
 *
 * THE ID GRANTS NOTHING. It names a record; it does not authorise reading one. An unauthenticated
 * visitor lands on the sign-in screen, and after signing in the parameter is still in the URL -
 * no navigation happens during login because the app is state-driven - so the thread opens then.
 * The fetch is authorised server-side like any other, scoped to the caller's organisation.
 */

/** Mongo ObjectId as it appears in a URL. Anything else did not come from our link builder. */
const OBJECT_ID_PATTERN = /^[a-f\d]{24}$/i;

export interface DeepLinkTarget {
  conversationId: string;
  /**
   * The reminder the link was about, when it was a reminder notification.
   *
   * Carried through but UNUSED TODAY: there is no reminder-detail view to open, so the link
   * resolves to the lead. Kept so the day that view exists, the links already in people's
   * WhatsApp history point at the right reminder rather than needing to be re-sent.
   */
  reminderId: string | null;
}

/**
 * The lead a link asked for, or null for an ordinary page load.
 *
 * Does not mutate anything - `clearDeepLinkTarget` does that - because reading and clearing at
 * different moments is what lets the shell act on it only once it has a signed-in user.
 */
export const readDeepLinkTarget = (
  search: string = typeof window === 'undefined' ? '' : window.location.search,
): DeepLinkTarget | null => {
  if (!search) {
    return null;
  }

  const params = new URLSearchParams(search);
  const conversationId = (params.get('conversation') ?? '').trim();

  // A malformed id is treated as no link at all. Passing it on would mean a failed fetch and an
  // error screen, which reads as "the app is broken" rather than "that link was not valid".
  if (!OBJECT_ID_PATTERN.test(conversationId)) {
    return null;
  }

  const reminderId = (params.get('reminder') ?? '').trim();

  return {
    conversationId,
    reminderId: OBJECT_ID_PATTERN.test(reminderId) ? reminderId : null,
  };
};

/** Strips both parameters, leaving any others the app might care about. */
export const clearDeepLinkTarget = (): void => {
  if (typeof window === 'undefined' || !window.history?.replaceState) {
    return;
  }

  const url = new URL(window.location.href);

  url.searchParams.delete('conversation');
  url.searchParams.delete('reminder');

  window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
};
