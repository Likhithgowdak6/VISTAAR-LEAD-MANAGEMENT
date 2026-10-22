/**
 * The analytics screen's contract with the truth.
 *
 * Most of these assertions are about the difference between a ZERO and an ABSENCE, because
 * that is the single thing this dashboard can get wrong in a way nobody notices. "0 enquiries"
 * is a fact the owner should act on. "— enquiries" means the server did not tell us, and
 * printing it as 0 would invent a quiet, confident, wrong answer. The same applies to a rate
 * whose denominator was zero: "0%" claims that nobody converted, when in truth nobody was
 * counted at all.
 *
 * The missing-bucket test is the load-bearing one. The screen renders the six AI statuses from
 * a canonical list rather than from the response, so a bucket the backend stops sending leaves
 * a visible hole instead of silently vanishing and making the remaining five look complete.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AnalyticsAiPerformance,
  AnalyticsAttentionList,
  AnalyticsBreakdowns,
  AnalyticsOverview,
  AnalyticsReminders,
  AnalyticsTrends,
  ReminderRow,
} from '../types/analytics';

const mocks = vi.hoisted(() => ({
  getAnalyticsOverview: vi.fn(),
  getAnalyticsTrends: vi.fn(),
  getAnalyticsAiPerformance: vi.fn(),
  getAnalyticsBreakdowns: vi.fn(),
  getAnalyticsReminders: vi.fn(),
  getAnalyticsAttention: vi.fn(),
  downloadAttentionCsv: vi.fn(),
  useAuth: vi.fn(),
}));

vi.mock('../api/endpoints', () => ({
  getAnalyticsOverview: mocks.getAnalyticsOverview,
  getAnalyticsTrends: mocks.getAnalyticsTrends,
  getAnalyticsAiPerformance: mocks.getAnalyticsAiPerformance,
  getAnalyticsBreakdowns: mocks.getAnalyticsBreakdowns,
  getAnalyticsReminders: mocks.getAnalyticsReminders,
  getAnalyticsAttention: mocks.getAnalyticsAttention,
  downloadAttentionCsv: mocks.downloadAttentionCsv,
}));

vi.mock('../auth/AuthContext', () => ({ useAuth: mocks.useAuth }));

const AnalyticsPage = (await import('../pages/AnalyticsPage')).default;

const range = {
  preset: 'last_30_days' as const,
  from: '2026-09-20T00:00:00.000Z',
  to: '2026-10-20T00:00:00.000Z',
  timeZone: 'Asia/Kolkata',
  days: 30,
};

const defined = (value: number, definition = 'A definition.') => ({ value, definition });

const overview = (patch: Partial<AnalyticsOverview> = {}): AnalyticsOverview => ({
  range,
  totalConversations: defined(48, 'Conversations created in the range.'),
  uniqueContacts: defined(40),
  // Deliberately zero: a real, counted none.
  enquiries: defined(0, 'Conversations classified as a genuine potential customer.'),
  notEnquiries: defined(31),
  needsReview: defined(17),
  enquiryRate: { value: 0, numerator: 0, denominator: 48, definition: 'Enquiries over total.' },
  awaitingAiReply: defined(5),
  needsAttention: defined(9),
  aiStatusCounts: [
    { status: 'ai_replied', count: 12 },
    { status: 'awaiting_ai_reply', count: 5 },
    { status: 'ai_paused', count: 3 },
    { status: 'ai_reply_failed', count: 0 },
    { status: 'ai_not_needed', count: 11 },
    { status: 'needs_review', count: 17 },
  ],
  enquiryClassCounts: [
    { enquiryClass: 'enquiry', count: 0 },
    { enquiryClass: 'not_enquiry', count: 31 },
    { enquiryClass: 'needs_review', count: 17 },
  ],
  ...patch,
});

const trends = (patch: Partial<AnalyticsTrends> = {}): AnalyticsTrends => ({
  range,
  points: [
    {
      day: '2026-10-18',
      conversationsCreated: 3,
      enquiriesConfirmed: 1,
      inboundMessages: 9,
      outboundMessagesDelivered: 7,
    },
    {
      day: '2026-10-19',
      conversationsCreated: 5,
      enquiriesConfirmed: 2,
      inboundMessages: 14,
      outboundMessagesDelivered: 11,
    },
  ],
  definitions: { conversationsCreated: 'Bucketed on Conversation.createdAt.' },
  ...patch,
});

const performance = (patch: Partial<AnalyticsAiPerformance> = {}): AnalyticsAiPerformance => ({
  range,
  enquiriesWithAiReply: defined(12),
  enquiriesAwaitingReply: defined(5),
  pausedOrOwnerHandled: defined(3),
  coverageRate: { value: 60, numerator: 12, denominator: 20, definition: 'Coverage.' },
  aiMessagesDelivered: defined(140),
  aiMessagesFailed: defined(2),
  aiMessagesPending: defined(1),
  firstResponseSeconds: {
    median: null,
    average: null,
    sampleSize: 0,
    definition: 'Seconds between an inbound message and the AI reply after it.',
  },
  ...patch,
});

const breakdowns = (patch: Partial<AnalyticsBreakdowns> = {}): AnalyticsBreakdowns => ({
  range,
  asOf: '2026-10-20T09:00:00.000Z',
  currentStageCounts: [{ stage: 'new', label: 'New', count: 20 }],
  bySource: [
    { sourceId: 's1', sourceName: 'WhatsApp', conversations: 30, enquiries: 10, enquiryRate: 33.3 },
  ],
  byOwner: [{ userId: 'u1', userName: 'Himanshu', conversations: 22, enquiries: 8, needsAttention: 4 }],
  definitions: {},
  unavailable: [
    { metric: 'Conversion funnel', reason: 'No stage-transition history is recorded.' },
    { metric: 'Revenue', reason: 'This system stores no deal value.' },
  ],
  ...patch,
});

const reminderRow = (patch: Partial<ReminderRow> = {}): ReminderRow => ({
  id: 'rem-1',
  title: 'Send the Goa package',
  dueAt: '2026-10-20T11:30:00.000Z',
  source: 'lead_commitment',
  sourceQuote: 'send it across after four',
  assignedToName: 'Himanshu',
  conversationId: 'conv-9',
  leadName: 'Rahul Menon',
  isPersonal: false,
  overdue: false,
  ...patch,
});

const reminders = (patch: Partial<AnalyticsReminders> = {}): AnalyticsReminders => ({
  range,
  asOf: '2026-10-20T09:00:00.000Z',
  counts: {
    pending: defined(7, 'Reminder records still pending right now. CURRENT OUTSTANDING.'),
    // Deliberately zero: a real, counted none, which must not render as a dash.
    overdue: defined(0, 'Pending reminders past their due time.'),
    dueToday: defined(3, "Pending reminders due inside today's local day in Asia/Kolkata."),
    completed: defined(11, 'Reminders completed inside the selected range.'),
  },
  next: [reminderRow()],
  limit: 5,
  definitions: { next: 'A preview, not the whole list.' },
  ...patch,
});

const attention = (patch: Partial<AnalyticsAttentionList> = {}): AnalyticsAttentionList => ({
  range,
  rows: [
    {
      conversationId: 'conv-1',
      displayName: 'Priya Nair',
      phone: null,
      enquiryClass: 'enquiry',
      aiResponseStatus: 'awaiting_ai_reply',
      stage: 'new',
      assignedToName: null,
      lastInboundAt: '2026-10-20T06:00:00.000Z',
      waitingMinutes: 185,
      reason: 'Enquiry waiting on a reply for over an hour.',
    },
  ],
  total: 1,
  limit: 25,
  skip: 0,
  ...patch,
});

type Overrides = {
  overview?: AnalyticsOverview | null;
  trends?: AnalyticsTrends | null;
  performance?: AnalyticsAiPerformance | null;
  breakdowns?: AnalyticsBreakdowns | null;
  reminders?: AnalyticsReminders | null;
  attention?: AnalyticsAttentionList | null;
};

const renderPage = (overrides: Overrides = {}) => {
  const onDrillDown = vi.fn();
  const onOpenConversation = vi.fn();

  mocks.useAuth.mockReturnValue({
    authedRequest: (make: (token: string | null) => Promise<unknown>) => make('token'),
  });
  mocks.getAnalyticsOverview.mockResolvedValue({ data: overrides.overview ?? overview() });
  mocks.getAnalyticsTrends.mockResolvedValue({ data: overrides.trends ?? trends() });
  mocks.getAnalyticsAiPerformance.mockResolvedValue({ data: overrides.performance ?? performance() });
  mocks.getAnalyticsBreakdowns.mockResolvedValue({ data: overrides.breakdowns ?? breakdowns() });
  mocks.getAnalyticsReminders.mockResolvedValue({ data: overrides.reminders ?? reminders() });
  mocks.getAnalyticsAttention.mockResolvedValue({ data: overrides.attention ?? attention() });

  render(<AnalyticsPage onDrillDown={onDrillDown} onOpenConversation={onOpenConversation} />);

  return { onDrillDown, onOpenConversation };
};

/**
 * The card or chip carrying a given metric.
 *
 * Scoped by `data-metric` rather than by text, so "0" in one card can never be satisfied by a
 * "0" somewhere else on a screen that is mostly numbers.
 */
const scoped = async (selector: string) =>
  waitFor(() => {
    const found = document.querySelectorAll<HTMLElement>(selector);

    // Exactly one: two matches would make every assertion below ambiguous.
    expect(found).toHaveLength(1);

    return found[0];
  });

/** A KPI card, as a scoped query root. */
const metric = async (label: string) => within(await scoped(`[data-metric="${label}"]`));

/** A reminders-overview tile, scoped the same way so "0" cannot be satisfied from elsewhere. */
const reminderMetric = async (label: string) =>
  within(await scoped(`[data-reminder-metric="${label}"]`));

/** One row of the next-reminders list, by the reminder's id. */
const reminderRowEl = (id: string) => scoped(`[data-reminder-row="${id}"]`);

/**
 * A bucket chip in one of the two partitions, e.g. `ai-status:needs_review`. Returned as the
 * element rather than a query root, because a clickable chip IS the button.
 */
const bucket = (id: string) => scoped(`[data-bucket="${id}"]`);

/** The drill-down target inside a KPI card, as distinct from its "?" affordance. */
const drillButton = (card: ReturnType<typeof within>) =>
  card.getByRole('button', { name: /open in inbox/i });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AnalyticsPage', () => {
  it('renders a counted zero as 0, not as a dash', async () => {
    renderPage();

    const card = await metric('Enquiries');

    expect(card.getByText('0')).toBeInTheDocument();
    expect(card.queryByText('—')).not.toBeInTheDocument();
  });

  it('renders a rate with no denominator as a dash, never as 0%', async () => {
    renderPage({
      overview: overview({
        enquiryRate: {
          value: null,
          numerator: 0,
          denominator: 0,
          definition: 'Enquiries over total.',
        },
      }),
    });

    const card = await metric('Enquiry rate');

    expect(card.getByText('—')).toBeInTheDocument();
    expect(card.queryByText('0%')).not.toBeInTheDocument();
  });

  it('shows a bucket the server did not send as unknown rather than zero', async () => {
    renderPage({
      overview: overview({
        aiStatusCounts: [
          { status: 'ai_replied', count: 12 },
          // 'awaiting_ai_reply' omitted entirely - the server did not report it.
          { status: 'ai_paused', count: 3 },
          { status: 'ai_reply_failed', count: 0 },
          { status: 'ai_not_needed', count: 11 },
          { status: 'needs_review', count: 17 },
        ],
      }),
    });

    const missing = within(await bucket('ai-status:awaiting_ai_reply'));
    const reportedZero = within(await bucket('ai-status:ai_reply_failed'));

    // Absent: a dash, flagged as unknown.
    expect(missing.getByText('—')).toBeInTheDocument();
    expect(missing.getByText('—')).toHaveAttribute('data-unknown', 'true');

    // Reported as zero: a real 0, explicitly NOT flagged as unknown.
    expect(reportedZero.getByText('0')).toBeInTheDocument();
    expect(reportedZero.getByText('0')).toHaveAttribute('data-unknown', 'false');

    expect(
      screen.getByText(/did not report that bucket in this response/i),
    ).toBeInTheDocument();
  });

  it('renders the "not shown, and why" list from the server', async () => {
    renderPage();

    expect(await screen.findByText('Not shown, and why')).toBeInTheDocument();
    expect(screen.getByText('Conversion funnel')).toBeInTheDocument();
    expect(
      screen.getByText(/No stage-transition history is recorded\./i),
    ).toBeInTheDocument();
    expect(screen.getByText(/This system stores no deal value\./i)).toBeInTheDocument();
  });

  it('labels the stage breakdown as current state rather than history', async () => {
    renderPage();

    expect(await screen.findByText('Current state, not history')).toBeInTheDocument();
  });

  it('drills down with the filters the clicked card was computed under', async () => {
    const { onDrillDown } = renderPage();

    fireEvent.click(drillButton(await metric('Needs attention')));
    expect(onDrillDown).toHaveBeenCalledWith({ needsAttention: true });

    fireEvent.click(drillButton(await metric('Awaiting AI reply')));
    expect(onDrillDown).toHaveBeenCalledWith({ aiStatus: 'awaiting_ai_reply' });

    fireEvent.click(drillButton(await metric('Not enquiries')));
    expect(onDrillDown).toHaveBeenCalledWith({ enquiryClass: 'not_enquiry' });

    // A bucket chip drills the same way the card above it does.
    fireEvent.click(await bucket('ai-status:ai_paused'));
    expect(onDrillDown).toHaveBeenCalledWith({ aiStatus: 'ai_paused' });
  });

  it('does not offer a drill-down for metrics no inbox filter can reproduce', async () => {
    renderPage();

    const contacts = await metric('Unique contacts');

    // Only the definition "?" is interactive - there is no filter that yields a count of
    // distinct contacts, so the card must not promise one.
    expect(contacts.queryByRole('button', { name: /open in inbox/i })).not.toBeInTheDocument();
  });

  it('renders attention rows and opens the conversation behind one', async () => {
    const { onOpenConversation } = renderPage();

    const row = await screen.findByText('Priya Nair');

    expect(screen.getByText('Enquiry waiting on a reply for over an hour.')).toBeInTheDocument();
    // 185 minutes, read the way an owner reads a wait.
    expect(screen.getByText('3h 5m')).toBeInTheDocument();
    // Null assignment is stated, not blanked.
    expect(screen.getByText('Unassigned')).toBeInTheDocument();

    fireEvent.click(row);
    expect(onOpenConversation).toHaveBeenCalledWith('conv-1');
  });

  it('shows an empty state when nothing is waiting', async () => {
    renderPage({ attention: attention({ rows: [], total: 0 }) });

    expect(
      await screen.findByText('Nothing is waiting on you in this range.'),
    ).toBeInTheDocument();
  });

  it('shows a trends empty state when every point is zero rather than drawing a flat line', async () => {
    renderPage({
      trends: trends({
        points: [
          {
            day: '2026-10-18',
            conversationsCreated: 0,
            enquiriesConfirmed: 0,
            inboundMessages: 0,
            outboundMessagesDelivered: 0,
          },
        ],
      }),
    });

    expect(
      await screen.findByText(/Nothing happened on any day in this range/i),
    ).toBeInTheDocument();
  });

  it('names a trend series the server omitted instead of plotting it as zero', async () => {
    renderPage({
      trends: trends({
        points: [
          // `enquiriesConfirmed` absent from the wire - the backend currently sends
          // `enquiriesCreated` under a different name.
          {
            day: '2026-10-18',
            conversationsCreated: 3,
            inboundMessages: 9,
            outboundMessagesDelivered: 7,
          } as unknown as AnalyticsTrends['points'][number],
        ],
      }),
    });

    expect(await screen.findByText(/Not plotted, because the server did not return/i)).toHaveTextContent(
      'enquiriesConfirmed',
    );
  });

  it('refetches every section when the date range changes', async () => {
    renderPage();

    await waitFor(() => expect(mocks.getAnalyticsOverview).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: '7 days' }));

    await waitFor(() => {
      expect(mocks.getAnalyticsOverview).toHaveBeenCalledTimes(2);
      expect(mocks.getAnalyticsTrends).toHaveBeenCalledTimes(2);
      expect(mocks.getAnalyticsAiPerformance).toHaveBeenCalledTimes(2);
      expect(mocks.getAnalyticsBreakdowns).toHaveBeenCalledTimes(2);
      // Reminders travel with the batch: three of its counts ignore the range, but
      // "completed in the range" does not, and it must not describe the previous window.
      expect(mocks.getAnalyticsReminders).toHaveBeenCalledTimes(2);
      expect(mocks.getAnalyticsAttention).toHaveBeenCalledTimes(2);
    });

    expect(mocks.getAnalyticsOverview).toHaveBeenLastCalledWith(
      expect.objectContaining({ query: { preset: 'last_7_days' } }),
    );
  });

  it('exports the attention list as a CSV download using the same filters', async () => {
    const blob = new Blob(['a,b\n1,2'], { type: 'text/csv' });
    mocks.downloadAttentionCsv.mockResolvedValue(blob);

    const createObjectURL = vi.fn(() => 'blob:csv');
    const revokeObjectURL = vi.fn();
    // jsdom implements neither; the component is expected to say so rather than no-op, so the
    // happy path has to be stubbed in explicitly.
    Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, configurable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURL, configurable: true });

    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: /export csv/i }));

    await waitFor(() => expect(mocks.downloadAttentionCsv).toHaveBeenCalledTimes(1));
    expect(mocks.downloadAttentionCsv).toHaveBeenCalledWith(
      expect.objectContaining({ query: { preset: 'last_30_days' } }),
    );
    await waitFor(() => expect(createObjectURL).toHaveBeenCalledWith(blob));
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:csv');
  });

  it('surfaces a failure and retries without leaving stale numbers on screen', async () => {
    mocks.useAuth.mockReturnValue({
      authedRequest: (make: (token: string | null) => Promise<unknown>) => make('token'),
    });
    mocks.getAnalyticsOverview.mockRejectedValue(new Error('Analytics is unavailable.'));
    mocks.getAnalyticsTrends.mockResolvedValue({ data: trends() });
    mocks.getAnalyticsAiPerformance.mockResolvedValue({ data: performance() });
    mocks.getAnalyticsBreakdowns.mockResolvedValue({ data: breakdowns() });
    mocks.getAnalyticsReminders.mockResolvedValue({ data: reminders() });
    mocks.getAnalyticsAttention.mockResolvedValue({ data: attention() });

    render(<AnalyticsPage />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Analytics is unavailable.');

    // Nothing from the failed batch is shown as a zero.
    const card = await metric('Conversations');
    expect(card.getByText('—')).toBeInTheDocument();

    mocks.getAnalyticsOverview.mockResolvedValue({ data: overview() });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(mocks.getAnalyticsOverview).toHaveBeenCalledTimes(2));
    const recovered = await metric('Conversations');
    await waitFor(() => expect(recovered.getByText('48')).toBeInTheDocument());
  });

  it('shows the definition behind a number when the ? is pressed', async () => {
    renderPage();

    const card = await metric('Conversations');
    fireEvent.click(card.getByRole('button', { name: /what "Conversations" counts/i }));

    expect(card.getByText('Conversations created in the range.')).toBeInTheDocument();
  });
});

/**
 * The reminders overview.
 *
 * THE TWO THINGS THAT MUST SURVIVE A REDESIGN. First, a personal reminder is not clickable:
 * there is no conversation behind it, and a row that looked like the others but did nothing
 * would teach the owner to stop trusting the ones that do work. Second, three of these four
 * counts are as-of-now and one is counted over the range, so the panel has to say which is
 * which - four numbers in a row otherwise read as four slices of one thing.
 */
describe('the reminders overview', () => {
  it('renders the four counts, with a counted zero as 0 rather than a dash', async () => {
    renderPage();

    const pending = await reminderMetric('Pending');
    const overdue = await reminderMetric('Overdue');
    const dueToday = await reminderMetric('Due today');
    const completed = await reminderMetric('Completed');

    expect(pending.getByText('7')).toBeInTheDocument();
    expect(dueToday.getByText('3')).toBeInTheDocument();
    expect(completed.getByText('11')).toBeInTheDocument();

    // Nothing is overdue, which is a finding. A dash would claim we did not measure it.
    expect(overdue.getByText('0')).toBeInTheDocument();
    expect(overdue.getByText('0')).toHaveAttribute('data-unknown', 'false');
    expect(overdue.queryByText('—')).not.toBeInTheDocument();
  });

  it('shows a count the server omitted as unknown instead of zero', async () => {
    renderPage({
      reminders: reminders({
        counts: {
          pending: defined(7),
          overdue: defined(0),
          // Omitted entirely by the server - not measured, as opposed to measured as none.
          dueToday: undefined as unknown as AnalyticsReminders['counts']['dueToday'],
          completed: defined(11),
        },
      }),
    });

    const dueToday = await reminderMetric('Due today');

    expect(dueToday.getByText('—')).toHaveAttribute('data-unknown', 'true');
  });

  it('labels the as-of-now counts apart from the one counted over the range', async () => {
    renderPage();

    expect(within(await scoped('[data-reminder-metric="Pending"]')).getByText('As of now'))
      .toBeInTheDocument();
    expect(within(await scoped('[data-reminder-metric="Completed"]')).getByText('In the range'))
      .toBeInTheDocument();
    expect(await screen.findByText(/Outstanding now, except where marked/i)).toBeInTheDocument();
  });

  it('shows the definition behind a reminder count when the ? is pressed', async () => {
    renderPage();

    const card = await reminderMetric('Pending');
    fireEvent.click(card.getByRole('button', { name: /what "Pending" counts/i }));

    expect(
      card.getByText(/Reminder records still pending right now\. CURRENT OUTSTANDING\./i),
    ).toBeInTheDocument();
  });

  it('renders a lead reminder with its lead, due time, origin, quote and assignee', async () => {
    renderPage();

    const row = within(await reminderRowEl('rem-1'));

    expect(row.getByText('Send the Goa package')).toBeInTheDocument();
    expect(row.getByText('Rahul Menon')).toBeInTheDocument();
    expect(row.getByText('From what the lead said')).toBeInTheDocument();
    expect(row.getByText(/send it across after four/)).toBeInTheDocument();
    expect(row.getByText('Himanshu')).toBeInTheDocument();
  });

  it('opens the conversation behind a lead reminder', async () => {
    const { onOpenConversation } = renderPage();

    fireEvent.click(await screen.findByText('Send the Goa package'));

    expect(onOpenConversation).toHaveBeenCalledWith('conv-9');
  });

  it('leaves a personal reminder unclickable and says why', async () => {
    const { onOpenConversation } = renderPage({
      reminders: reminders({
        next: [
          reminderRow({
            id: 'rem-personal',
            title: 'Review the campaign',
            conversationId: null,
            leadName: null,
            isPersonal: true,
            source: 'owner_command',
            sourceQuote: null,
          }),
        ],
      }),
    });

    const row = within(await reminderRowEl('rem-personal'));

    expect(row.getByText('Personal reminder')).toBeInTheDocument();
    // No button at all: there is nothing to open, so nothing offers to.
    expect(row.queryByRole('button')).not.toBeInTheDocument();
    expect(row.getByText(/no conversation to open/i)).toBeInTheDocument();

    fireEvent.click(row.getByText('Review the campaign'));
    expect(onOpenConversation).not.toHaveBeenCalled();
  });

  it('never borrows a lead name for a personal reminder', async () => {
    renderPage({
      reminders: reminders({
        next: [
          reminderRow({
            id: 'rem-personal',
            conversationId: null,
            leadName: null,
            isPersonal: true,
          }),
        ],
      }),
    });

    const row = within(await reminderRowEl('rem-personal'));

    expect(row.queryByText('Rahul Menon')).not.toBeInTheDocument();
  });

  it('states an absent title rather than inventing one', async () => {
    renderPage({ reminders: reminders({ next: [reminderRow({ title: null })] }) });

    expect(await screen.findByText('Untitled reminder')).toBeInTheDocument();
  });

  it('prints nothing at all for a reminder with no quote', async () => {
    renderPage({ reminders: reminders({ next: [reminderRow({ sourceQuote: null })] }) });

    const row = within(await reminderRowEl('rem-1'));

    // Not an empty pair of quote marks, which would read as a lead who said nothing.
    expect(row.queryByText('“”')).not.toBeInTheDocument();
    expect(row.getByText('Send the Goa package')).toBeInTheDocument();
  });

  it('keeps an overdue reminder on the list and marks it', async () => {
    renderPage({
      reminders: reminders({
        next: [reminderRow({ id: 'rem-late', overdue: true })],
      }),
    });

    const row = within(await reminderRowEl('rem-late'));

    expect(row.getByText('Overdue')).toBeInTheDocument();
    // Still actionable, so still a button.
    expect(row.getByRole('button')).toBeInTheDocument();
  });

  it('shows a useful empty state when nothing is pending', async () => {
    renderPage({
      reminders: reminders({
        counts: {
          pending: defined(0),
          overdue: defined(0),
          dueToday: defined(0),
          completed: defined(4),
        },
        next: [],
      }),
    });

    expect(await screen.findByText('Nothing is pending right now.')).toBeInTheDocument();
    expect(screen.getByText(/Reminders appear here as soon as one is set/i)).toBeInTheDocument();
    // A zero is still printed beside it - the panel is empty because nothing is owed, and it
    // says so with a number rather than only with prose.
    expect(within(await scoped('[data-reminder-metric="Pending"]')).getByText('0')).toBeInTheDocument();
  });

  it('says what went wrong instead of showing zeroes when the load fails', async () => {
    mocks.useAuth.mockReturnValue({
      authedRequest: (make: (token: string | null) => Promise<unknown>) => make('token'),
    });
    mocks.getAnalyticsReminders.mockRejectedValue(new Error('Analytics is unavailable.'));
    mocks.getAnalyticsOverview.mockResolvedValue({ data: overview() });
    mocks.getAnalyticsTrends.mockResolvedValue({ data: trends() });
    mocks.getAnalyticsAiPerformance.mockResolvedValue({ data: performance() });
    mocks.getAnalyticsBreakdowns.mockResolvedValue({ data: breakdowns() });
    mocks.getAnalyticsAttention.mockResolvedValue({ data: attention() });

    render(<AnalyticsPage />);

    await waitFor(() =>
      expect(document.querySelectorAll('[data-reminder-metric]')).toHaveLength(0),
    );

    // The panel states the failure in the space its own numbers would have filled, rather
    // than leaving a silent gap under the heading and relying on the page banner alone.
    expect(await scoped('[data-reminders-error="true"]')).toHaveTextContent(
      'Analytics is unavailable.',
    );
  });

  it('no longer shows the follow-up counts twice on one page', async () => {
    // They used to live in the breakdowns panel as well. Two "Overdue" numbers under two
    // different wordings is how a dashboard loses an argument with the person reading it.
    renderPage();

    await screen.findByText('Not shown, and why');

    expect(document.querySelectorAll('[data-reminder-metric="Overdue"]')).toHaveLength(1);
    expect(screen.getAllByText('Overdue')).toHaveLength(1);
  });
});
