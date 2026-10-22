/**
 * The window every number on the screen is computed over.
 *
 * The presets are sent as presets rather than resolved to dates here, deliberately: the day
 * boundary belongs to the ORGANISATION'S timezone, which only the server knows. A browser in a
 * different zone resolving "today" itself would quietly ask for the wrong 24 hours, and the
 * numbers would be subtly wrong in a way nobody would catch. The server echoes back the range
 * it actually used, and that - not what was clicked - is what the screen reports.
 */
import type { AnalyticsRange, DateRangePreset } from '../../types/analytics';

import { MicroLabel } from './AnalyticsPrimitives';

const PRESETS: { key: Exclude<DateRangePreset, 'custom'>; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: 'last_7_days', label: '7 days' },
  { key: 'last_30_days', label: '30 days' },
  { key: 'last_90_days', label: '90 days' },
];

type Props = {
  preset: DateRangePreset;
  fromDate: string;
  toDate: string;
  /** The range the SERVER resolved, echoed back. Null until the first response lands. */
  resolved: AnalyticsRange | null;
  onPresetChange: (preset: DateRangePreset) => void;
  onCustomChange: (from: string, to: string) => void;
};

const DateRangeControl = ({
  preset,
  fromDate,
  toDate,
  resolved,
  onPresetChange,
  onCustomChange,
}: Props) => (
  <div className="rounded-[var(--m-radius-card)] border border-hairline bg-panel p-3">
    <div className="flex flex-wrap items-center gap-2">
      <MicroLabel className="mr-1">Range</MicroLabel>

      {PRESETS.map((entry) => (
        <button
          key={entry.key}
          type="button"
          aria-pressed={preset === entry.key}
          onClick={() => onPresetChange(entry.key)}
          className={`min-h-11 rounded-[var(--m-radius-card)] border px-3 font-mono text-[0.6875rem] uppercase tracking-[0.06em] transition-colors sm:min-h-0 sm:py-1.5 ${
            preset === entry.key
              ? 'border-key/40 bg-key/10 text-key'
              : 'border-hairline text-bone-dim hover:border-key/40 hover:text-key'
          }`}
        >
          {entry.label}
        </button>
      ))}

      <button
        type="button"
        aria-pressed={preset === 'custom'}
        onClick={() => onPresetChange('custom')}
        className={`min-h-11 rounded-[var(--m-radius-card)] border px-3 font-mono text-[0.6875rem] uppercase tracking-[0.06em] transition-colors sm:min-h-0 sm:py-1.5 ${
          preset === 'custom'
            ? 'border-key/40 bg-key/10 text-key'
            : 'border-hairline text-bone-dim hover:border-key/40 hover:text-key'
        }`}
      >
        Custom
      </button>
    </div>

    {preset === 'custom' ? (
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block font-mono text-[0.6875rem] uppercase tracking-[0.06em] text-muted">
            From
          </span>
          <input
            type="date"
            value={fromDate}
            max={toDate === '' ? undefined : toDate}
            onChange={(event) => onCustomChange(event.target.value, toDate)}
            className="min-h-11 w-full rounded-[var(--m-radius-card)] border border-hairline bg-ink px-3 text-sm text-bone"
          />
        </label>
        <label className="block">
          <span className="mb-1 block font-mono text-[0.6875rem] uppercase tracking-[0.06em] text-muted">
            To
          </span>
          <input
            type="date"
            value={toDate}
            min={fromDate === '' ? undefined : fromDate}
            onChange={(event) => onCustomChange(fromDate, event.target.value)}
            className="min-h-11 w-full rounded-[var(--m-radius-card)] border border-hairline bg-ink px-3 text-sm text-bone"
          />
        </label>
      </div>
    ) : null}

    {/* What the SERVER used, not what was clicked. If the two ever disagree, this is the one
        that explains the numbers on screen. */}
    {resolved ? (
      <p className="mt-2 text-[0.6875rem] text-muted">
        Showing {resolved.days} {resolved.days === 1 ? 'day' : 'days'} to{' '}
        {new Date(resolved.to).toLocaleDateString()} · day boundaries in {resolved.timeZone}
      </p>
    ) : null}
  </div>
);

export default DateRangeControl;
