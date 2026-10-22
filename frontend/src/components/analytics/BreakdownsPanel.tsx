/**
 * Where things stand, cut four ways - and a list of the cuts this schema cannot make.
 *
 * THE "CURRENT STATE" LABEL IS LOAD-BEARING, not a caveat. There is no stage-transition history
 * in this database: the one activity-log call site that records a stage change is the manual
 * dashboard edit, it stores only the new stage, and all three automated transition paths skip
 * it. So these are counts of where conversations sit at `asOf`, and nothing here can become a
 * funnel, a time-in-stage, or a win rate over time. Owner counts have the same problem for the
 * same reason - assignment history stores no user id - so they are current assignment only.
 *
 * The unavailable list is rendered as a plain, quiet list because a reader who wonders where
 * the funnel went deserves a one-line answer rather than silence. It is the server's list, not
 * this component's opinion: if the backend stops sending it the block disappears rather than
 * this file asserting limitations it cannot verify.
 */
import type { AnalyticsBreakdowns } from '../../types/analytics';

import { DASH } from './AnalyticsFormat';
import { Card, MicroLabel, NotShown } from './AnalyticsPrimitives';

/** A labelled row with a proportional bar. The bar is scaled to the biggest row, not to a total. */
const BarRow = ({ label, count, max, note }: { label: string; count: number; max: number; note?: string }) => (
  <li className="grid grid-cols-[1fr_auto] items-center gap-x-2 gap-y-0.5 py-1">
    <span className="truncate text-xs text-bone-dim" title={label}>
      {label}
    </span>
    <span className="font-mono text-xs tabular-nums text-bone">{count.toLocaleString()}</span>
    <span className="col-span-full h-1 overflow-hidden rounded-full bg-ink">
      <span
        className="block h-full rounded-full bg-key/40"
        style={{ width: max > 0 ? `${(count / max) * 100}%` : '0%' }}
      />
    </span>
    {note ? <span className="col-span-full font-mono text-[0.625rem] text-muted">{note}</span> : null}
  </li>
);

const BreakdownsPanel = ({ breakdowns }: { breakdowns: AnalyticsBreakdowns | null }) => {
  const stages = breakdowns?.currentStageCounts ?? [];
  const sources = breakdowns?.bySource ?? [];
  const owners = breakdowns?.byOwner ?? [];
  const unavailable = breakdowns?.unavailable ?? [];

  const stageMax = stages.reduce((best, entry) => Math.max(best, entry.count), 0);
  const sourceMax = sources.reduce((best, entry) => Math.max(best, entry.conversations), 0);
  const ownerMax = owners.reduce((best, entry) => Math.max(best, entry.conversations), 0);

  const asOf = breakdowns?.asOf ? new Date(breakdowns.asOf) : null;
  const asOfText = asOf && !Number.isNaN(asOf.getTime()) ? asOf.toLocaleString() : null;

  return (
    <div className="grid gap-2 lg:grid-cols-2">
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <MicroLabel>Current stage</MicroLabel>
          {/* Said plainly and in the panel itself, because a reader who takes this for a funnel
              will draw conclusions about conversion that the data cannot support. */}
          <span className="font-mono text-[0.625rem] uppercase tracking-[0.06em] text-key-soft">
            Current state, not history
          </span>
        </div>

        {stages.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted">No stage counts returned.</p>
        ) : (
          <ul className="mt-1">
            {stages.map((entry) => (
              <BarRow
                key={entry.stage}
                // `label` is the display name when the server sends one; the raw key is a
                // readable fallback and is never replaced with a placeholder.
                label={entry.label ?? entry.stage}
                count={entry.count}
                max={stageMax}
              />
            ))}
          </ul>
        )}

        <NotShown>
          A snapshot{asOfText ? ` taken ${asOfText}` : ''}, not an aggregate over the range. This
          schema keeps no stage-transition history, so time-in-stage and conversion between
          stages cannot be computed.
        </NotShown>
      </Card>

      <Card>
        <MicroLabel>By source</MicroLabel>

        {sources.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted">No sources returned.</p>
        ) : (
          <ul className="mt-1">
            {sources.map((entry) => (
              <BarRow
                key={entry.sourceId ?? `unattributed-${entry.sourceName}`}
                label={entry.sourceName}
                count={entry.conversations}
                max={sourceMax}
                note={`${entry.enquiries.toLocaleString()} enquiries · rate ${
                  typeof entry.enquiryRate === 'number' ? `${entry.enquiryRate}%` : DASH
                }`}
              />
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <MicroLabel>By owner</MicroLabel>
          <span className="font-mono text-[0.625rem] uppercase tracking-[0.06em] text-key-soft">
            Current assignment
          </span>
        </div>

        {owners.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted">No owners returned.</p>
        ) : (
          <ul className="mt-1">
            {owners.map((entry) => (
              <BarRow
                key={entry.userId ?? `unassigned-${entry.userName}`}
                label={entry.userName}
                count={entry.conversations}
                max={ownerMax}
                note={`${entry.enquiries.toLocaleString()} enquiries · ${entry.needsAttention.toLocaleString()} need attention`}
              />
            ))}
          </ul>
        )}

        <NotShown>
          Who holds a conversation now. Reassignment history stores no user id, so this cannot
          be attributed over time.
        </NotShown>
      </Card>

      {/* Reminder counts used to sit here as well. They are now rendered once, in the Reminders
          overview, which carries all four of them with their definitions - two cards showing
          the same "overdue" under two different wordings is how a dashboard loses an argument
          with its reader. The response still carries followUps; nothing on this page reads it. */}
      <Card>
        <MicroLabel>Not shown, and why</MicroLabel>

        {unavailable.length > 0 ? (
          <ul className="mt-1 space-y-1">
            {unavailable.map((entry) => (
              <li key={entry.metric} className="text-[0.6875rem] leading-relaxed text-muted">
                <span className="text-bone-dim">{entry.metric}</span> — {entry.reason}
              </li>
            ))}
          </ul>
        ) : (
          <p className="py-4 text-center text-sm text-muted">
            The server did not send the list of metrics this schema cannot support.
          </p>
        )}
      </Card>
    </div>
  );
};

export default BreakdownsPanel;
