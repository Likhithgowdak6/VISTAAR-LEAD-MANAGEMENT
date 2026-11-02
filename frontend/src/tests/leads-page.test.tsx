/**
 * The Leads screen: the landing screen, its search, and what it refuses to invent.
 *
 * THE TWO THINGS MOST WORTH PINNING HERE are both about honesty rather than wiring. Search runs
 * in the DATABASE - the whole reason the backend grew a `search` parameter - so a test that only
 * checked "the list got shorter" would pass just as happily against the inbox's old
 * loaded-page-only filter, which cannot find lead fifty-one. It therefore asserts the request.
 *
 * And the enquiry line NEVER MAKES ANYTHING UP. A lead with no summary and no messages shows a
 * blank-state sentence, not a plausible-sounding one; getting that wrong would put invented
 * detail about a real customer on screen.
 */
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import LeadsPage from '../pages/LeadsPage';
import * as endpointsApi from '../api/endpoints';
import { PERMISSIONS } from '../lib/permissions';
import { AUTH_PAYLOAD, renderAuthed } from './lead-helpers';

// Tests may use `any` for Vitest mocks of untyped endpoint modules.
const endpoints = endpointsApi as any;

vi.mock('../api/endpoints');

const lead = (overrides: Record<string, unknown> = {}) => ({
  id: '68f1a2b3c4d5e6f708192a3b',
  displayName: 'Riya Sharma',
  stage: 'contacted',
  tags: [],
  summary: 'Wedding photography for December, outdoor venue.',
  lastMessagePreview: 'Hey! Yes, we do wedding photography',
  lastMessageAt: new Date('2026-10-30T09:00:00.000Z').toISOString(),
  ...overrides,
});

const render = (onOpenLead = vi.fn()) => renderAuthed(<LeadsPage onOpenLead={onOpenLead} />);

beforeEach(() => {
  endpoints.refresh.mockResolvedValue(
    AUTH_PAYLOAD({ role: 'admin', permissions: [PERMISSIONS.CONVERSATIONS_READ_ALL] }),
  );
  endpoints.listStages.mockResolvedValue({ data: [] });
  endpoints.listTags.mockResolvedValue({ data: [] });
  endpoints.listConversations.mockResolvedValue({ data: [lead()] });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('the leads list', () => {
  it('shows the lead with its enquiry summary', async () => {
    render();

    expect(await screen.findByText('Riya Sharma')).toBeInTheDocument();
    expect(
      screen.getByText('Wedding photography for December, outdoor venue.'),
    ).toBeInTheDocument();
  });

  it('PREFERS THE SUMMARY over the last message', async () => {
    // The last message is often our own follow-up. The summary is what the lead is about.
    render();

    await screen.findByText('Riya Sharma');

    expect(screen.queryByText(/Hey! Yes, we do wedding photography/)).not.toBeInTheDocument();
  });

  it('falls back to the last message when there is no summary', async () => {
    endpoints.listConversations.mockResolvedValue({ data: [lead({ summary: null })] });

    render();

    expect(
      await screen.findByText('Hey! Yes, we do wedding photography'),
    ).toBeInTheDocument();
  });

  it('INVENTS NOTHING for a lead with no enquiry information', async () => {
    endpoints.listConversations.mockResolvedValue({
      data: [lead({ summary: null, lastMessagePreview: null })],
    });

    render();

    expect(await screen.findByText('No enquiry details yet')).toBeInTheDocument();
  });

  it('opens the lead that was tapped', async () => {
    const onOpenLead = vi.fn();

    render(onOpenLead);

    fireEvent.click(await screen.findByText('Riya Sharma'));

    expect(onOpenLead).toHaveBeenCalledWith('68f1a2b3c4d5e6f708192a3b');
  });
});

describe('searching', () => {
  it('SENDS THE SEARCH TO THE SERVER rather than filtering what is loaded', async () => {
    // The assertion that matters. Filtering in the browser would pass a "list got shorter"
    // test while silently failing to find any lead past the first page.
    render();

    await screen.findByText('Riya Sharma');

    fireEvent.change(screen.getByLabelText('Search leads by name'), {
      target: { value: 'riya' },
    });

    await waitFor(() =>
      expect(endpoints.listConversations).toHaveBeenCalledWith(
        expect.objectContaining({ search: 'riya' }),
      ),
    );
  });

  it('DEBOUNCES, so a typed name is one request and not one per letter', async () => {
    render();

    await screen.findByText('Riya Sharma');

    const calls = endpoints.listConversations.mock.calls.length;
    const input = screen.getByLabelText('Search leads by name');

    fireEvent.change(input, { target: { value: 'r' } });
    fireEvent.change(input, { target: { value: 'ri' } });
    fireEvent.change(input, { target: { value: 'riy' } });
    fireEvent.change(input, { target: { value: 'riya' } });

    await waitFor(() =>
      expect(endpoints.listConversations).toHaveBeenCalledWith(
        expect.objectContaining({ search: 'riya' }),
      ),
    );

    // Four keystrokes, one extra request - not four.
    expect(endpoints.listConversations.mock.calls.length).toBe(calls + 1);
  });

  it('says a SEARCH matched nothing, not that there are no leads', async () => {
    // Different states, different next actions: "try another word" versus "nothing has come in".
    render();

    await screen.findByText('Riya Sharma');

    endpoints.listConversations.mockResolvedValue({ data: [] });

    fireEvent.change(screen.getByLabelText('Search leads by name'), {
      target: { value: 'zzz' },
    });

    expect(await screen.findByText('No leads match that search')).toBeInTheDocument();
  });

  it('says there are no leads at all when nothing is being searched', async () => {
    endpoints.listConversations.mockResolvedValue({ data: [] });

    render();

    expect(await screen.findByText('No leads yet')).toBeInTheDocument();
  });
});
