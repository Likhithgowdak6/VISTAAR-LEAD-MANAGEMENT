/**
 * Reading the query string Facebook's callback sends the browser back with.
 *
 * The backend cannot hand the result to a React state atom: it redirects a real browser to
 * `/?metaConnect=1&metaConnectResult=...`, which reloads the whole app. So the outcome arrives as
 * a URL, is read once here, and is wiped from the address bar before anything else happens.
 *
 * WIPING MATTERS. Left in place, a refresh or a shared link would replay "connected" forever, and
 * the wizard would keep reopening itself at a step the person has long since finished.
 */

export type MetaConnectOutcome = 'connected' | 'cancelled' | 'failed';

export interface MetaConnectReturn {
  outcome: MetaConnectOutcome;
  /** The backend's own sentence about what went wrong. Absent on success. */
  message: string | null;
}

const OUTCOMES: readonly string[] = ['connected', 'cancelled', 'failed'];

/**
 * The outcome in the current URL, or null when this is an ordinary page load.
 *
 * Does not mutate anything — `clearMetaConnectReturn` does that — because two components read
 * this (the shell, to choose the opening view; the page, to show the banner) and the first read
 * must not blind the second.
 */
export const readMetaConnectReturn = (
  search: string = typeof window === 'undefined' ? '' : window.location.search,
): MetaConnectReturn | null => {
  if (!search) {
    return null;
  }

  const params = new URLSearchParams(search);

  if (params.get('metaConnect') !== '1') {
    return null;
  }

  const outcome = params.get('metaConnectResult') ?? '';

  // An unrecognised value is treated as a failure rather than ignored: something came back from
  // the callback, and silently dropping it would leave a blank screen after a real attempt.
  return {
    outcome: (OUTCOMES.includes(outcome) ? outcome : 'failed') as MetaConnectOutcome,
    message: params.get('metaConnectMessage'),
  };
};

/** Strips the three parameters, leaving any others the app might care about. */
export const clearMetaConnectReturn = (): void => {
  if (typeof window === 'undefined' || !window.history?.replaceState) {
    return;
  }

  const url = new URL(window.location.href);

  url.searchParams.delete('metaConnect');
  url.searchParams.delete('metaConnectResult');
  url.searchParams.delete('metaConnectMessage');

  window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
};
