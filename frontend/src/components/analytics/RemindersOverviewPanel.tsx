/**
 * Reminders overview: what is still owed, and what is owed next.
 *
 * TWO KINDS OF NUMBER SIT SIDE BY SIDE HERE, and the panel's main job is to stop them being
 * read as one. Pending, overdue and due-today are OUTSTANDING NOW - they are taken at `asOf`
 * and the date range at the top of the page does not touch them. Completed is the only figure
 * counted over the range. Four numbers in a row invite being added up, so each tile says which
 * clock it is on, and the header says it again for the three that share one.
 *
 * THEY ALSO OVERLAP, deliberately. Overdue is a subset of pending; due-today is another subset
 * and it overlaps overdue, because a reminder due at nine this morning is both once it is past
 * nine. Nothing on this panel totals them, and the definition behind each "?" says why.
 *
 * WHY A PERSONAL REMINDER IS NOT A BUTTON. A row that is about a lead opens that conversation.
 * A personal reminder - "review the campaign at five" - has no conversation behind it, so there
 * is nothing to open, and a button that did nothing would teach the owner to distrust the other
 * rows. It renders as plain text and says, in the row and in its tooltip, why.
 *
 * DUE TIMES ARE DRAWN IN THE STUDIO'S ZONE, not the reader's. A reminder was set for five
 * o'clock in the business's own timezone; rendering it in the browser's would show the wrong
 * hour to anyone reading it from anywhere else.
 */
import type { AnalyticsReminders, DefinedCount, ReminderRow } from '../../types/analytics';

import {
  countValue,
  DASH,
  formatCount,
  formatStamp,
  REMINDER_SOURCE_LABELS,
  UNTITLED_REMINDER,
} from './AnalyticsFormat';
import { Card, DefinitionTip, MicroLabel, NotShown } from './AnalyticsPrimitives';

type Props = {
  reminders: AnalyticsReminders | null;
  /** True while a load is in flight. Only shown as "loading" when there is nothing to keep. */
  loading?: boolean;
  /**
   * The page's load failure, if there was one. Shown in place of the numbers rather than
   * beside them - a stale count under a fresh heading is worse than no count. Retrying belongs
   * to the page's own banner, so there is no second Retry button in here.
   */
  error?: string | null;
  /** Opens the conversation a lead-linked reminder belongs to. */
  onOpenConversation?: (conversationId: string) => void;
};

const WHY_NOT_CLICKABLE =
  'A personal reminder is about your own work rather than a lead, so there is no conversation to open.';

/**
 * Why a row does not click through.
 *
 * Two wordings, because there are two reasons and only one of them is "this is personal". A
 * row that claims not to be personal and still carries no conversation id is a malformed row,
 * and saying "personal reminder" about it would be a guess dressed up as an explanation.
 */
const whyNotClickable = (row: ReminderRow): string =>
  row.isPersonal
    ? WHY_NOT_CLICKABLE
    : 'This reminder carries no conversation, so there is nothing to open.';

/** One count, with its definition one press away and its clock stated in the tile. */
const ReminderFigure = ({
  label,
  count,
  basis,
  fallbackDefinition,
}: {
  label: string;
  count: DefinedCount | undefined;
  /** Which clock this number is on. Printed, not implied. */
  basis: string;
  fallbackDefinition: string;
}) => {
  const text = formatCount(countValue(count));

  return (
    <div
      data-reminder-metric={label}
      className="grid grid-cols-[1fr_auto] items-start gap-2 rounded-[var(--m-radius-card)] border border-hairline bg-ink px-3 py-2"
    >
      <span className="min-w-0">
        <span className="block font-mono text-[0.6875rem] uppercase tracking-[0.06em] text-muted">
          {label}
        </span>
        <span
          className={`block text-2xl font-semibold tabular-nums ${
            text === DASH ? 'text-muted' : 'text-bone'
          }`}
          data-unknown={text === DASH ? 'true' : 'false'}
        >
          {text}
        </span>
        <span className="mt-0.5 block font-mono text-[0.625rem] uppercase tracking-[0.06em] text-key-soft">
          {basis}
        </span>
      </span>

      <DefinitionTip text={count?.definition ?? fallbackDefinition} label={label} />
    </div>
  );
};

/** The body of a row, identical whether or not the row turns out to be clickable. */
const RowBody = ({ row, timeZone }: { row: ReminderRow; timeZone: string | undefined }) => (
  <>
    <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
      <span
        className={`truncate text-sm font-medium ${row.title ? 'text-bone' : 'text-muted'}`}
      >
        {/* Null is a real state on this model. Said plainly rather than filled in from the
            note or the lead's name, which would put words in the owner's mouth. */}
        {row.title ?? UNTITLED_REMINDER}
      </span>

      {row.overdue ? (
        <span className="font-mono text-[0.625rem] uppercase tracking-[0.06em] text-danger">
          Overdue
        </span>
      ) : null}
    </span>

    <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs">
      <span className={row.isPersonal ? 'text-muted' : 'truncate text-bone-dim'}>
        {/* A personal reminder gets this label, never a borrowed lead name. A lead row with no
            display name gets the dash - the server did not send one, and inventing one here
            would be the same mistake one layer up. */}
        {row.isPersonal ? 'Personal reminder' : (row.leadName ?? DASH)}
      </span>

      <span className="font-mono tabular-nums text-key">{formatStamp(row.dueAt, timeZone)}</span>

      <span className="text-muted">{REMINDER_SOURCE_LABELS[row.source] ?? row.source}</span>

      {/* Absent for a manual reminder, and for an extracted one whose quote was not kept.
          Nothing is printed in that case rather than an empty pair of quote marks. */}
      {row.sourceQuote ? (
        <span className="min-w-0 basis-full truncate italic text-bone-dim" title={row.sourceQuote}>
          “{row.sourceQuote}”
        </span>
      ) : null}
    </span>

    <span className="truncate text-xs text-muted">
      {/* Unassigned is impossible on this model - assignedTo is required - so a missing name
          means the lookup found no user, which is stated rather than guessed at. */}
      {row.assignedToName ?? 'Assignee not found'}
    </span>
  </>
);

const ROW_LAYOUT =
  'grid w-full gap-x-3 gap-y-0.5 py-2 text-left md:grid-cols-[minmax(0,1.3fr)_minmax(0,2fr)_minmax(0,0.7fr)] md:items-baseline';

const RemindersOverviewPanel = ({
  reminders,
  loading = false,
  error = null,
  onOpenConversation,
}: Props) => {
  const counts = reminders?.counts;
  const rows = reminders?.next ?? [];
  const timeZone = reminders?.range.timeZone;

  const asOf = reminders?.asOf ? new Date(reminders.asOf) : null;
  /**
   * Drawn in the STUDIO's zone, not the reader's browser zone.
   *
   * Every due time above it is rendered in `range.timeZone`, and the counts were bucketed
   * against that same zone. A bare `toLocaleString()` here would print the reader's local time
   * with no suffix - so an owner opening this abroad would see due times at 09:30 IST beside an
   * "as of 04:00" line and conclude the overdue count was wrong.
   */
  const asOfText =
    asOf && !Number.isNaN(asOf.getTime()) && timeZone
      ? `${new Intl.DateTimeFormat('en-GB', {
          timeZone,
          day: 'numeric',
          month: 'short',
          hour: '2-digit',
          minute: '2-digit',
        }).format(asOf)} ${timeZone}`
      : null;

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <MicroLabel>Reminders overview</MicroLabel>
        <span className="font-mono text-[0.625rem] uppercase tracking-[0.06em] text-key-soft">
          Outstanding now, except where marked
        </span>
      </div>

      {loading && !reminders ? (
        <p className="py-6 text-center text-sm text-muted">Loading…</p>
      ) : !reminders ? (
        <p data-reminders-error="true" className="py-6 text-center text-sm text-muted">
          {/* The failure, in the server's own words, where the numbers would have been. Never
              a zero: "0 pending" would be a confident claim that nothing is owed. */}
          {error ?? 'Reminder figures were not returned by the server.'}
        </p>
      ) : (
        <>
          <div className="mt-2 grid grid-cols-2 gap-2 xl:grid-cols-4">
            <ReminderFigure
              label="Pending"
              count={counts?.pending}
              basis="As of now"
              fallbackDefinition="Reminders still pending. Definition not supplied by the server."
            />
            <ReminderFigure
              label="Overdue"
              count={counts?.overdue}
              basis="As of now"
              fallbackDefinition="Pending reminders whose due time has passed. A subset of pending."
            />
            <ReminderFigure
              label="Due today"
              count={counts?.dueToday}
              basis={timeZone ? `Today, ${timeZone}` : 'Today'}
              fallbackDefinition="Pending reminders due inside today's local calendar day. A subset of pending that overlaps overdue."
            />
            <ReminderFigure
              label="Completed"
              count={counts?.completed}
              basis="In the range"
              fallbackDefinition="Reminders completed inside the selected range, counted on their completion time."
            />
          </div>

          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-hairline pt-2">
            <MicroLabel>Next up</MicroLabel>
            <span className="font-mono text-[0.625rem] uppercase tracking-[0.06em] text-muted">
              Soonest first{timeZone ? ` · times in ${timeZone}` : ''}
            </span>
          </div>

          {rows.length === 0 ? (
            <div className="py-6 text-center">
              <p className="text-sm text-muted">Nothing is pending right now.</p>
              <p className="mt-1 text-[0.6875rem] text-muted">
                Reminders appear here as soon as one is set — by hand, from something a lead
                said, or from a message you send yourself on WhatsApp.
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-hairline">
              {rows.map((row) => {
                // Both conditions, resolved once. `isPersonal` is the server's own judgement
                // and the null id is the fact behind it; a row that somehow disagreed with
                // itself is treated as personal, which is the side that opens nothing.
                const opens = row.isPersonal ? null : row.conversationId;

                return (
                  <li key={row.id} data-reminder-row={row.id}>
                    {opens === null ? (
                      <div className={ROW_LAYOUT} title={whyNotClickable(row)}>
                        <RowBody row={row} timeZone={timeZone} />
                        <span className="col-span-full font-mono text-[0.625rem] text-muted">
                          {whyNotClickable(row)}
                        </span>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => onOpenConversation?.(opens)}
                        className={`${ROW_LAYOUT} transition-colors hover:bg-ink/60`}
                      >
                        <RowBody row={row} timeZone={timeZone} />
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          <NotShown>
            {reminders.definitions.next ??
              'The nearest pending reminders, soonest first. A preview, not the whole list.'}
            {asOfText ? ` Outstanding counts taken ${asOfText}.` : ''}
          </NotShown>
        </>
      )}
    </Card>
  );
};

export default RemindersOverviewPanel;
