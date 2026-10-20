/**
 * One back gesture, one layer closed.
 *
 * THE PROBLEM THIS SOLVES. Navigation in this app is React state, not routes: `view` and
 * `selectedId` live in AppShell, `detailsOpen` lives in ConversationView. Nothing ever touched
 * `history`, so on a phone the URL stayed `/` however deep you drilled - and the back gesture,
 * finding no entry of ours to pop, left the app entirely. Opening a lead and swiping back did
 * not return you to the inbox; it closed the dashboard.
 *
 * WHY NOT A ROUTER. Adding one would mean rewriting AppShell, ConversationView and every page
 * around route params, which is precisely the broad refactor that risks the desktop layout the
 * owner is happy with. This keeps the state where it is and teaches it to pair each dismissible
 * layer with one history entry, which is all the back gesture actually needs.
 *
 * THE INVARIANT: `layers.length === appliedDepth`. Every registered layer owns exactly one
 * history entry we pushed. Two directions keep them equal:
 *
 *   - the person presses back  -> the browser drops an entry, we pop the top layer and close it;
 *   - the app closes a layer   -> we remove it and hand the entry back with `history.go(-n)`.
 *
 * and the thing that makes that safe is that each direction knows about the other. A popstate
 * removes the layer BEFORE calling `onBack`, so the React state change that follows finds
 * nothing left to unregister and cannot trigger a second `history.go`.
 *
 * WHY CHANGES ARE BATCHED INTO A MICROTASK. One React commit can close one layer and open
 * another - the add-lead dialog does exactly this, dismissing itself and opening the new thread.
 * Applied immediately that is `go(-1)` racing a `pushState`, and the two interleave differently
 * depending on how fast the browser delivers popstate. Reconciling once per microtask makes the
 * pair cancel out to a net depth change of zero, and no history operation happens at all.
 *
 * MOBILE ONLY. Callers gate registration on viewport width (see useMobileBackLayer), so on a
 * desktop viewport nothing is ever pushed and browser history behaves exactly as it did before.
 */

export interface BackLayer {
  readonly id: number;
  readonly onBack: () => void;
}

/** Marks the entries we pushed, so a reload can recognise and clean up its own leftovers. */
const DEPTH_KEY = '__vistaarBackDepth';

/**
 * A reload cannot restore how deep the person was - the app always starts at the inbox - but the
 * history entries survive it. Without a ceiling a corrupted or hand-edited state value would
 * send `history.go` arbitrarily far back, out of the app. No real stack is deeper than
 * section -> conversation -> details -> dialog.
 */
const MAX_ADOPTABLE_DEPTH = 8;

let nextLayerId = 1;
let layers: BackLayer[] = [];
/** History entries we have pushed and not yet given back. */
let appliedDepth = 0;
/**
 * Traversals this module asked for and has not yet seen land. Each one swallows exactly one
 * popstate.
 *
 * COUNTED PER CALL, NOT PER ENTRY, and that distinction is the whole of a bug worth recording.
 * `history.go(-2)` moves two entries but fires ONE popstate - the spec traverses to the
 * destination and notifies once. Incrementing by the number of entries left a surplus behind,
 * and the surplus swallowed the person's next real back gesture: closing the lead panel with
 * the in-app arrow, reopening a thread and swiping back left the thread on screen while the
 * history quietly moved underneath it. Observed in the browser, not reasoned about.
 */
let pendingTraversals = 0;
let reconcileQueued = false;
let started = false;

const hasHistory = (): boolean =>
  typeof window !== 'undefined' && typeof window.history !== 'undefined';

const readDepth = (state: unknown): number => {
  const depth = (state as Record<string, unknown> | null)?.[DEPTH_KEY];
  return typeof depth === 'number' && Number.isFinite(depth) && depth > 0
    ? Math.min(Math.floor(depth), MAX_ADOPTABLE_DEPTH)
    : 0;
};

const reconcile = (): void => {
  reconcileQueued = false;

  if (!hasHistory()) {
    return;
  }

  const desired = layers.length;

  if (desired > appliedDepth) {
    while (appliedDepth < desired) {
      appliedDepth += 1;
      window.history.pushState({ [DEPTH_KEY]: appliedDepth }, '');
    }

    return;
  }

  if (desired < appliedDepth) {
    const surplus = appliedDepth - desired;
    appliedDepth = desired;
    // One traversal, however many entries it covers, so one popstate to swallow.
    pendingTraversals += 1;
    window.history.go(-surplus);
  }
};

const scheduleReconcile = (): void => {
  if (reconcileQueued) {
    return;
  }

  reconcileQueued = true;
  queueMicrotask(reconcile);
};

const handlePopState = (): void => {
  if (pendingTraversals > 0) {
    pendingTraversals -= 1;
    return;
  }

  const layer = layers[layers.length - 1];

  if (!layer) {
    // Nothing of ours is open. The browser has already left this entry; in a tab that means the
    // previous page, and in the Android shell the listener in capacitor-back.ts has already
    // decided to exit rather than reaching this point.
    return;
  }

  // Removed BEFORE the callback runs, so the state update it causes finds no layer to
  // unregister and cannot hand the same entry back twice.
  layers = layers.slice(0, -1);
  appliedDepth = Math.max(0, appliedDepth - 1);

  layer.onBack();
};

/**
 * Idempotent, and safe to call from a component: the listener and the reload cleanup are
 * attached once per document however many layers mount.
 */
export const startMobileBackStack = (): void => {
  if (started || !hasHistory()) {
    return;
  }

  started = true;
  window.addEventListener('popstate', handlePopState);

  // Entries this app pushed before a reload are still in the stack, but the view they stood for
  // is gone - the app has started at the inbox again. Adopt them so the reconcile below hands
  // them back, rather than leaving entries that make the first back gesture appear to do nothing.
  appliedDepth = readDepth(window.history.state);

  if (appliedDepth > 0) {
    scheduleReconcile();
  }
};

/** Registers an open layer and takes a history entry for it. */
export const pushBackLayer = (onBack: () => void): BackLayer => {
  const layer: BackLayer = { id: nextLayerId++, onBack };
  layers = [...layers, layer];
  scheduleReconcile();

  return layer;
};

/**
 * Closes a layer from the app side - an in-app back button, or a state change that dismissed it.
 * A no-op when a popstate already consumed it, which is what stops the two paths colliding.
 */
export const removeBackLayer = (layer: BackLayer | null | undefined): void => {
  if (!layer || !layers.some((candidate) => candidate.id === layer.id)) {
    return;
  }

  layers = layers.filter((candidate) => candidate.id !== layer.id);
  scheduleReconcile();
};

/** How many layers are open. The Android shell reads this to decide between back and exit. */
export const backStackDepth = (): number => layers.length;

/** Test seam: drops every layer and listener so one case cannot leak into the next. */
export const resetMobileBackStack = (): void => {
  if (started && hasHistory()) {
    window.removeEventListener('popstate', handlePopState);
  }

  layers = [];
  appliedDepth = 0;
  pendingTraversals = 0;
  reconcileQueued = false;
  started = false;
  nextLayerId = 1;
};
