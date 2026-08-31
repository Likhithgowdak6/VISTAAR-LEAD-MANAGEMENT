type Props = {
  /** ISO timestamp of the lead's event, or null when they have not given a date we can read. */
  eventDate?: string | null;
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * The backend stores an event date as a day-only value anchored at UTC midnight (see the
 * backend's conversations/event-date.ts), so it is read back in UTC too. Reading it in the
 * browser's own timezone would show a wedding on the 12th as the 11th for anyone west of UTC.
 */
const formatEventDate = (value: string): string | null => {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()] ?? ''} ${date.getUTCFullYear()}`;
};

const daysUntil = (value: string, now: number = Date.now()): number | null => {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  const today = new Date(now);

  return Math.round(
    (Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) -
      Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())) /
      MS_PER_DAY,
  );
};

const describeRemaining = (days: number): string => {
  if (days === 0) {
    return 'Today';
  }

  if (days === 1) {
    return 'Tomorrow';
  }

  if (days === -1) {
    return 'Was yesterday';
  }

  return days > 0 ? `In ${days} days` : `Passed ${Math.abs(days)} days ago`;
};

/**
 * The single most important fact about a lead in this business: the day their event happens.
 * It decides whether the lead is still worth chasing at all (the nurture cadence stops at it)
 * and, once the deal is won, when the owner gets reminded - so it is worth a line of its own
 * rather than being buried in the form answers below. Renders nothing until we know the date,
 * which is the normal state of a fresh enquiry.
 */
const EventDateSection = ({ eventDate }: Props) => {
  if (!eventDate) {
    return null;
  }

  const formatted = formatEventDate(eventDate);
  const remaining = daysUntil(eventDate);

  if (formatted === null || remaining === null) {
    return null;
  }

  const tone =
    remaining < 0 ? 'text-slate-400' : remaining <= 7 ? 'text-amber-700' : 'text-slate-500';

  return (
    <div className="rounded-lg border border-slate-200 p-3">
      <span className="text-xs font-semibold uppercase text-slate-500">Event date</span>
      <p className="mt-1 text-sm font-medium text-slate-800">
        <time dateTime={eventDate}>{formatted}</time>
      </p>
      <p className={`mt-0.5 text-xs ${tone}`}>{describeRemaining(remaining)}</p>
    </div>
  );
};

export default EventDateSection;
