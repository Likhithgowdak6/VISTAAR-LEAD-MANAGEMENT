/**
 * The class strings the wizard's steps share.
 *
 * Lifted out so six files cannot drift into six slightly different inputs. They are the same
 * strings AddMetaLeadSourceForm and AddLeadDialog already use: the lead-sources area is in the
 * light slate idiom, and a wizard that arrived in the dark one would look like a different
 * product bolted on beside the form it sits next to.
 */

export const inputClass =
  'w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none disabled:opacity-60';

export const labelClass = 'mb-1 block text-xs font-medium text-slate-600';

/**
 * `disabled:opacity-60` on top of the dimmed fill, unlike the older forms next door.
 *
 * The palette remap in index.css turns `blue-300` into a muted tungsten (#8a541f) rather than a
 * pale grey-blue, so the fill change alone is a subtle signal — and this wizard is the one screen
 * that shows two disabled primaries side by side (Connect and Next on step one, before any
 * Facebook account is authorised). Verified in the browser: fill alone read as clickable.
 */
export const primaryButtonClass =
  'rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:bg-blue-300 disabled:opacity-60';

export const secondaryButtonClass =
  'rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50';

/** A pickable row (a page, a form). Selection is a ring rather than a fill, so the name stays readable. */
export const choiceRowClass =
  'flex w-full items-center gap-3 rounded-xl border p-3 text-left transition-colors disabled:opacity-50';

export const choiceRowSelectedClass = 'border-blue-500 bg-blue-50 ring-1 ring-blue-500';

export const choiceRowIdleClass = 'border-slate-200 bg-white hover:bg-slate-50';

/** `event_date` -> `Event date`. The stored keys are snake_case; people are not. */
export const prettyFactKey = (key: string): string => {
  const spaced = key.replace(/_/g, ' ');

  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
};
