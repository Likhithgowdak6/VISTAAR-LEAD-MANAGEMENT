import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import ConversationSummaryPanel from '../components/ConversationSummaryPanel';
import * as endpointsApi from '../api/endpoints';
import { PERMISSIONS } from '../lib/permissions';
import { AUTH_PAYLOAD, renderAuthed } from './lead-helpers';

// Tests may use `any` for Vitest mocks of untyped endpoint modules.
const endpoints = endpointsApi as any;

vi.mock('../api/endpoints');

const SUMMARY = {
  headline: 'Riya wants candid wedding photography in Pune on 14 Feb.',
  whatTheyAskedFor: 'Two days of candid coverage for a wedding in Pune.',
  whereItStands: 'We quoted the two-photographer option; she said she would check with family.',
  openQuestions: ['Is 14 Feb confirmed?'],
  suggestedNextStep: 'Ask whether 14 Feb is fixed before blocking the team.',
  generatedAt: '2026-08-30T09:00:00.000Z',
  messageCount: 12,
  currentMessageCount: 12,
  stale: false,
};

beforeEach(() => {
  endpoints.refresh.mockResolvedValue(
    AUTH_PAYLOAD({ role: 'admin', permissions: [PERMISSIONS.AI_GENERATE] }),
  );
  endpoints.getConversationSummary.mockResolvedValue({ data: null });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('ConversationSummaryPanel', () => {
  it('renders every section of a stored summary', async () => {
    endpoints.getConversationSummary.mockResolvedValue({ data: SUMMARY });

    renderAuthed(<ConversationSummaryPanel conversationId="c1" />);

    expect(await screen.findByText(SUMMARY.headline)).toBeInTheDocument();
    expect(screen.getByText('What they asked for')).toBeInTheDocument();
    expect(screen.getByText(SUMMARY.whereItStands)).toBeInTheDocument();
    expect(screen.getByText('Is 14 Feb confirmed?')).toBeInTheDocument();
    expect(screen.getByText(SUMMARY.suggestedNextStep)).toBeInTheDocument();
    expect(screen.getByText('Up to date')).toBeInTheDocument();
  });

  it('never generates on open - it only reads what is stored', async () => {
    renderAuthed(<ConversationSummaryPanel conversationId="c1" />);

    await waitFor(() => expect(endpoints.getConversationSummary).toHaveBeenCalledTimes(1));
    expect(endpoints.regenerateConversationSummary).not.toHaveBeenCalled();
    expect(
      screen.getByText(/Summarise the thread to see where it stands without reading it/),
    ).toBeInTheDocument();
  });

  it('flags a summary read before the latest messages, and says how many are missing', async () => {
    endpoints.getConversationSummary.mockResolvedValue({
      data: { ...SUMMARY, currentMessageCount: 15, stale: true },
    });

    renderAuthed(<ConversationSummaryPanel conversationId="c1" />);

    expect(await screen.findByText('Out of date')).toBeInTheDocument();
    expect(screen.getByText('3 newer message(s) are not in this summary.')).toBeInTheDocument();
    // Still shown, not hidden: out of date is more useful to the owner than blank.
    expect(screen.getByText(SUMMARY.headline)).toBeInTheDocument();
  });

  it('regenerates on demand and shows the new read', async () => {
    endpoints.getConversationSummary.mockResolvedValue({
      data: { ...SUMMARY, currentMessageCount: 15, stale: true },
    });
    endpoints.regenerateConversationSummary.mockResolvedValue({
      data: {
        ...SUMMARY,
        headline: 'Riya confirmed 14 Feb and asked for the advance details.',
        messageCount: 15,
        currentMessageCount: 15,
        stale: false,
      },
      meta: { regenerated: true, unavailable: false },
    });

    renderAuthed(<ConversationSummaryPanel conversationId="c1" />);

    fireEvent.click(await screen.findByRole('button', { name: 'Update summary' }));

    await waitFor(() =>
      expect(endpoints.regenerateConversationSummary).toHaveBeenCalledWith(
        expect.objectContaining({ conversationId: 'c1', force: true }),
      ),
    );
    expect(
      await screen.findByText('Riya confirmed 14 Feb and asked for the advance details.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Up to date')).toBeInTheDocument();
  });

  it('offers "Summarise this thread" when there has never been one', async () => {
    renderAuthed(<ConversationSummaryPanel conversationId="c1" />);

    expect(
      await screen.findByRole('button', { name: 'Summarise this thread' }),
    ).toBeInTheDocument();
  });

  it('says the summariser is unavailable without losing the stored summary', async () => {
    endpoints.getConversationSummary.mockResolvedValue({
      data: { ...SUMMARY, currentMessageCount: 15, stale: true },
    });
    endpoints.regenerateConversationSummary.mockResolvedValue({
      data: { ...SUMMARY, currentMessageCount: 15, stale: true },
      meta: { regenerated: false, unavailable: true },
    });

    renderAuthed(<ConversationSummaryPanel conversationId="c1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Update summary' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The summariser is unavailable right now',
    );
    expect(screen.getByText(SUMMARY.headline)).toBeInTheDocument();
  });

  it('surfaces a thrown request as an error without blanking the panel', async () => {
    endpoints.getConversationSummary.mockResolvedValue({ data: SUMMARY });
    endpoints.regenerateConversationSummary.mockRejectedValue(new Error('Network unreachable.'));

    renderAuthed(<ConversationSummaryPanel conversationId="c1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Update summary' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Network unreachable.');
    expect(screen.getByText(SUMMARY.headline)).toBeInTheDocument();
  });

  it('stays quiet when the summary cannot even be loaded - the thread must still open', async () => {
    endpoints.getConversationSummary.mockRejectedValue(new Error('boom'));

    renderAuthed(<ConversationSummaryPanel conversationId="c1" />);

    expect(await screen.findByText('Summary')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('hides the regenerate affordance from someone without AI generate permission', async () => {
    endpoints.refresh.mockResolvedValue(AUTH_PAYLOAD({ role: 'staff', permissions: [] }));
    endpoints.getConversationSummary.mockResolvedValue({ data: SUMMARY });

    renderAuthed(<ConversationSummaryPanel conversationId="c1" />);

    expect(await screen.findByText(SUMMARY.headline)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /summar/i })).not.toBeInTheDocument();
  });

  it('collapses and re-expands the body', async () => {
    endpoints.getConversationSummary.mockResolvedValue({ data: SUMMARY });

    renderAuthed(<ConversationSummaryPanel conversationId="c1" />);

    fireEvent.click(await screen.findByRole('button', { name: 'Hide' }));
    expect(screen.queryByText(SUMMARY.headline)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Show' }));
    expect(screen.getByText(SUMMARY.headline)).toBeInTheDocument();
  });

  it('renders nothing for the empty sections rather than printing blank labels', async () => {
    endpoints.getConversationSummary.mockResolvedValue({
      data: {
        ...SUMMARY,
        whatTheyAskedFor: '',
        openQuestions: [],
        suggestedNextStep: '',
      },
    });

    renderAuthed(<ConversationSummaryPanel conversationId="c1" />);

    expect(await screen.findByText(SUMMARY.headline)).toBeInTheDocument();
    expect(screen.queryByText('What they asked for')).not.toBeInTheDocument();
    expect(screen.queryByText('Still open')).not.toBeInTheDocument();
    expect(screen.queryByText('Next step')).not.toBeInTheDocument();
  });
});
