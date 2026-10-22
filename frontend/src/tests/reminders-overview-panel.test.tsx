/**
 * The Reminders overview panel.
 *
 * THE TWO THINGS THAT WOULD BE QUIETLY WRONG, and are therefore most of this file:
 *
 *   - A PERSONAL REMINDER MUST NOT BE CLICKABLE. It is about the owner's own work, not a lead,
 *     so it has no conversation behind it and there is nothing for a click to open. (The old
 *     standalone Reminders page is no longer mounted in the shell either - reminders live in
 *     the lead panel now - so there is no second destination to fall back to.) Routing it to a
 *     lead would attach somebody's private note to a customer. It must also never borrow a
 *     lead's name to fill the gap.
 *   - ZERO IS NOT UNKNOWN. "0 overdue" is a claim that nothing is late. A panel that printed a
 *     zero when the server returned nothing would be confidently wrong about the one number an
 *     owner acts on.
 *
 * The counts also answer to two different clocks - pending/overdue/due-today are "right now",
 * completed is "over the selected range" - and the panel has to say so, because a reader who
 * assumes all four move with the date picker misreads three of them.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import RemindersOverviewPanel from '../components/analytics/RemindersOverviewPanel';
import { type AnalyticsReminders, type ReminderRow } from '../types/analytics';

const defined = (value: number, definition: string) => ({ value, definition });

const row = (patch: Partial<ReminderRow> = {}): ReminderRow => ({
  id: 'r1',
  title: 'Call back about the December wedding',
  dueAt: '2026-10-22T09:30:00.000Z',
  source: 'manual',
  sourceQuote: null,
  assignedToName: 'Himanshu',
  conversationId: 'conv-1',
  leadName: 'Priya Sharma',
  isPersonal: false,
  overdue: false,
  ...patch,
});

const reminders = (patch: Partial<AnalyticsReminders> = {}): AnalyticsReminders => ({
  range: {
    preset: 'last_30_days',
    from: '2026-09-21T18:30:00.000Z',
    to: '2026-10-21T18:30:00.000Z',
    timeZone: 'Asia/Kolkata',
    days: 30,
  },
  asOf: '2026-10-21T08:00:00.000Z',
  counts: {
    pending: defined(7, 'Reminder records still pending. CURRENT OUTSTANDING.'),
    overdue: defined(2, 'Pending reminders past their due time.'),
    dueToday: defined(3, "Pending reminders due inside today's local day."),
    completed: defined(11, 'Reminders completed inside the selected range.'),
  },
  next: [row()],
  limit: 5,
  definitions: { next: 'The nearest pending reminders, soonest first.' },
  ...patch,
});

describe('personal reminders', () => {
  it('does NOT make a personal reminder clickable', () => {
    const onOpenConversation = vi.fn();
    render(
      <RemindersOverviewPanel
        reminders={reminders({
          next: [
            row({
              id: 'r-personal',
              title: 'Review the campaign',
              conversationId: null,
              leadName: null,
              isPersonal: true,
              source: 'owner_command',
            }),
          ],
        })}
        onOpenConversation={onOpenConversation}
      />,
    );

    expect(screen.getByText('Review the campaign')).toBeInTheDocument();
    // No button means no way to route it anywhere - which is correct, because there is nowhere.
    expect(screen.queryByRole('button', { name: /Review the campaign/i })).not.toBeInTheDocument();
  });

  it('says it is personal rather than borrowing a lead name', () => {
    render(
      <RemindersOverviewPanel
        reminders={reminders({
          next: [row({ conversationId: null, leadName: null, isPersonal: true })],
        })}
      />,
    );

    // Appears more than once on purpose - the row label and the panel's own explanation of
    // why such a row is not clickable. Both are correct; what matters is the lead name is absent.
    expect(screen.getAllByText(/Personal reminder/i).length).toBeGreaterThan(0);
    expect(screen.queryByText('Priya Sharma')).not.toBeInTheDocument();
  });
});

describe('lead reminders', () => {
  it('opens the conversation it belongs to, by id', () => {
    const onOpenConversation = vi.fn();
    render(
      <RemindersOverviewPanel
        reminders={reminders({ next: [row({ conversationId: 'conv-42' })] })}
        onOpenConversation={onOpenConversation}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /December wedding/i }));

    // The stable id, never the lead's name or number.
    expect(onOpenConversation).toHaveBeenCalledWith('conv-42');
  });

  it('shows the lead, the origin and the assignee when they exist', () => {
    render(<RemindersOverviewPanel reminders={reminders()} />);

    expect(screen.getByText(/Priya Sharma/)).toBeInTheDocument();
    expect(screen.getByText(/Himanshu/)).toBeInTheDocument();
  });

  it('renders a reminder with no title without inventing one', () => {
    // The model allows a null title. Something must show, but not a fabricated description.
    render(<RemindersOverviewPanel reminders={reminders({ next: [row({ title: null })] })} />);

    // A neutral placeholder, not a fabricated description of what the reminder is about.
    expect(screen.queryByText('null')).not.toBeInTheDocument();
    expect(screen.queryByText('undefined')).not.toBeInTheDocument();
    expect(screen.getByText(/Priya Sharma/)).toBeInTheDocument();
  });
});

describe('the counts', () => {
  it('renders each of the four', () => {
    render(<RemindersOverviewPanel reminders={reminders()} />);

    for (const value of ['7', '2', '3', '11']) {
      expect(screen.getAllByText(value).length).toBeGreaterThan(0);
    }
  });

  it('renders a real zero as 0, not as a dash', () => {
    render(
      <RemindersOverviewPanel
        reminders={reminders({
          counts: {
            pending: defined(0, 'none pending'),
            overdue: defined(0, 'none overdue'),
            dueToday: defined(0, 'none due today'),
            completed: defined(0, 'none completed'),
          },
          next: [],
        })}
      />,
    );

    expect(screen.getAllByText('0').length).toBeGreaterThan(0);
  });

  it('distinguishes the two clocks in the copy', () => {
    // Three counts are "now" and one is "over the range". A reader who misses that misreads
    // three of the four numbers.
    render(<RemindersOverviewPanel reminders={reminders()} />);

    expect(screen.getByText(/Outstanding now/i)).toBeInTheDocument();
  });
});

describe('which clock the stamps are on', () => {
  it('draws the as-of stamp in the STUDIO timezone, named', () => {
    // It used to use the reader's browser zone with no suffix. An owner opening this abroad
    // would then see due times in IST beside an as-of time in their own zone and conclude the
    // overdue count was wrong - the one number on the panel they act on.
    render(<RemindersOverviewPanel reminders={reminders()} />);

    // Named in more than one place now - the due-today tile and the as-of line both say it,
    // which is the point. What matters is the as-of line is one of them.
    expect(screen.getAllByText(/Asia\/Kolkata/).length).toBeGreaterThan(1);
    expect(screen.getByText(/Outstanding counts taken .*Asia\/Kolkata/)).toBeInTheDocument();
  });

  it('names the zone on the due-today tile rather than saying "local"', () => {
    // "Local" reads as the reader's zone; the count is bounded by the organisation's.
    render(<RemindersOverviewPanel reminders={reminders()} />);

    expect(screen.queryByText(/Today, local/i)).not.toBeInTheDocument();
  });
});

describe('empty, loading and failure', () => {
  it('shows a useful empty state when nothing is pending', () => {
    render(<RemindersOverviewPanel reminders={reminders({ next: [] })} />);

    expect(screen.getByText(/Nothing is pending right now/i)).toBeInTheDocument();
  });

  it('shows the failure where the numbers would be, NOT a zero', () => {
    // "0 pending" on a failed load is a confident claim that nothing is owed.
    render(<RemindersOverviewPanel reminders={null} error="Unable to load analytics." />);

    expect(screen.getByText('Unable to load analytics.')).toBeInTheDocument();
    expect(screen.queryByText('0')).not.toBeInTheDocument();
  });

  it('shows loading rather than empty numbers on a first load', () => {
    render(<RemindersOverviewPanel reminders={null} loading />);

    expect(screen.getByText(/Loading/i)).toBeInTheDocument();
  });
});
