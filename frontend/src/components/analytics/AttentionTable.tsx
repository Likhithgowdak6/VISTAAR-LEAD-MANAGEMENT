/**
 * The list the whole screen exists to produce: conversations somebody has to deal with.
 *
 * ONE RENDERING PATH, NOT TWO. The obvious way to make a table work on a phone is a `<table>`
 * for desktop and a stack of cards for mobile, both in the markup, one hidden by a media
 * query. That ships every row twice to the accessibility tree and to any test that queries by
 * text. Instead each row is a single grid that reflows: stacked label/value pairs on a phone,
 * aligned columns from `md` up, where the per-row labels are hidden and one header row takes
 * over. The row is a button, so it is reachable by keyboard and hits the 44px target.
 *
 * `reason` is given the most room because it is the only column that says what to DO.
 */
import type { AttentionRow } from '../../types/analytics';

import {
  AI_STATUS_LABELS,
  DASH,
  ENQUIRY_CLASS_LABELS,
  formatStamp,
  formatWaiting,
} from './AnalyticsFormat';
import { Card, MicroLabel } from './AnalyticsPrimitives';

type Props = {
  rows: AttentionRow[];
  total: number;
  limit: number;
  skip: number;
  loading: boolean;
  exporting: boolean;
  onPage: (skip: number) => void;
  onExport: () => void;
  onOpenConversation?: (conversationId: string) => void;
};

const COLUMNS = 'md:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,0.9fr)_minmax(0,0.9fr)_minmax(0,0.9fr)_minmax(0,1.6fr)]';

/** A phone-only field label. Hidden from `md` up, where the header row says the same thing. */
const FieldLabel = ({ children }: { children: React.ReactNode }) => (
  <span className="font-mono text-[0.625rem] uppercase tracking-[0.06em] text-muted md:hidden">
    {children}
  </span>
);

const AttentionTable = ({
  rows,
  total,
  limit,
  skip,
  loading,
  exporting,
  onPage,
  onExport,
  onOpenConversation,
}: Props) => {
  const from = total === 0 ? 0 : skip + 1;
  const to = Math.min(skip + rows.length, total);
  const hasPrevious = skip > 0;
  const hasNext = skip + rows.length < total;

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <MicroLabel>Needs attention</MicroLabel>

        <div className="flex items-center gap-2">
          <span className="font-mono text-[0.625rem] uppercase tracking-[0.06em] text-muted">
            {total === 0 ? 'None' : `${from}–${to} of ${total.toLocaleString()}`}
          </span>
          <button
            type="button"
            onClick={onExport}
            disabled={exporting}
            className="min-h-11 rounded-[var(--m-radius-card)] border border-hairline px-3 font-mono text-[0.6875rem] uppercase tracking-[0.06em] text-bone-dim transition-colors hover:border-key/40 hover:text-key disabled:opacity-60 sm:min-h-0 sm:py-1.5"
          >
            {exporting ? 'Exporting…' : 'Export CSV'}
          </button>
        </div>
      </div>

      {/* The header exists only where the columns line up. */}
      <div
        className={`mt-2 hidden gap-2 border-b border-hairline pb-1 md:grid ${COLUMNS}`}
        aria-hidden="true"
      >
        {['Customer', 'Classification', 'AI status', 'Stage', 'Owner', 'Waiting', 'Reason'].map(
          (heading) => (
            <span
              key={heading}
              className="font-mono text-[0.625rem] uppercase tracking-[0.06em] text-muted"
            >
              {heading}
            </span>
          ),
        )}
      </div>

      {loading ? (
        <p className="py-6 text-center text-sm text-muted">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted">
          Nothing is waiting on you in this range.
        </p>
      ) : (
        <ul className="divide-y divide-hairline">
          {rows.map((row) => (
            <li key={row.conversationId}>
              <button
                type="button"
                onClick={() => onOpenConversation?.(row.conversationId)}
                className={`grid w-full gap-x-2 gap-y-1 py-2 text-left transition-colors hover:bg-ink/60 ${COLUMNS} md:items-center`}
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-bone">
                    {row.displayName}
                  </span>
                  {/* Only present when the caller holds the reveal permission; absent is not
                      the same as "no phone number", so nothing is printed when it is null. */}
                  {row.phone ? (
                    <span className="block truncate font-mono text-[0.625rem] text-muted">
                      {row.phone}
                    </span>
                  ) : null}
                </span>

                <span className="min-w-0 text-xs text-bone-dim">
                  <FieldLabel>Classification</FieldLabel>{' '}
                  {ENQUIRY_CLASS_LABELS[row.enquiryClass] ?? row.enquiryClass}
                </span>

                <span className="min-w-0 text-xs text-bone-dim">
                  <FieldLabel>AI status</FieldLabel>{' '}
                  {AI_STATUS_LABELS[row.aiResponseStatus] ?? row.aiResponseStatus}
                </span>

                <span className="min-w-0 truncate text-xs text-bone-dim">
                  <FieldLabel>Stage</FieldLabel> {row.stage}
                </span>

                <span className="min-w-0 truncate text-xs text-bone-dim">
                  <FieldLabel>Owner</FieldLabel> {row.assignedToName ?? 'Unassigned'}
                </span>

                <span className="min-w-0 text-xs">
                  <FieldLabel>Waiting</FieldLabel>{' '}
                  <span
                    className={`font-mono tabular-nums ${
                      formatWaiting(row.waitingMinutes) === DASH ? 'text-muted' : 'text-key'
                    }`}
                    data-unknown={formatWaiting(row.waitingMinutes) === DASH ? 'true' : 'false'}
                    title={`Last inbound ${formatStamp(row.lastInboundAt)}`}
                  >
                    {formatWaiting(row.waitingMinutes)}
                  </span>
                  <span className="ml-1 text-muted">({formatStamp(row.lastInboundAt)})</span>
                </span>

                <span className="min-w-0 text-xs leading-relaxed text-muted">
                  <FieldLabel>Reason</FieldLabel> {row.reason}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {hasPrevious || hasNext ? (
        <div className="mt-2 flex items-center justify-between gap-2 border-t border-hairline pt-2">
          <button
            type="button"
            onClick={() => onPage(Math.max(0, skip - limit))}
            disabled={!hasPrevious || loading}
            className="min-h-11 rounded-[var(--m-radius-card)] border border-hairline px-3 font-mono text-[0.6875rem] uppercase tracking-[0.06em] text-bone-dim transition-colors hover:border-key/40 hover:text-key disabled:opacity-40 sm:min-h-0 sm:py-1.5"
          >
            ← Previous
          </button>
          <button
            type="button"
            onClick={() => onPage(skip + limit)}
            disabled={!hasNext || loading}
            className="min-h-11 rounded-[var(--m-radius-card)] border border-hairline px-3 font-mono text-[0.6875rem] uppercase tracking-[0.06em] text-bone-dim transition-colors hover:border-key/40 hover:text-key disabled:opacity-40 sm:min-h-0 sm:py-1.5"
          >
            Next →
          </button>
        </div>
      ) : null}
    </Card>
  );
};

export default AttentionTable;
