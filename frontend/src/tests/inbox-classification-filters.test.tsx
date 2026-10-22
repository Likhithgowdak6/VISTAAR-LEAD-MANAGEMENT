/**
 * The inbox's enquiry-class and AI-response filters.
 *
 * THE BUG THESE TESTS EXIST TO PREVENT: filtering the rows already in memory. The search box
 * directly above these controls deliberately narrows the loaded page and says so on its label,
 * and the obvious way to add "show me the enquiries" is to write one more `.filter()` next to
 * it. That would be wrong in a way nobody would notice in a demo org and everybody would notice
 * at scale - it hides every match past row fifty. So the assertions here are about the REQUEST:
 * which parameters travel, that they combine, and that changing one asks for page one again.
 *
 * The second thing being pinned down is that an absent classification renders nothing. Printing
 * "Needs review" for a row the server never classified would manufacture a review queue.
 */
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import ConversationList from '../components/ConversationList';
import * as endpointsApi from '../api/endpoints';
import { AUTH_PAYLOAD, renderAuthed } from './lead-helpers';

// Tests may use `any` for Vitest mocks of untyped endpoint modules.
const endpoints = endpointsApi as any;

vi.mock('../api/endpoints');

const CLASSIFIED = [
  {
    id: 'c1',
    displayName: 'Riya Sharma',
    stage: 'qualified',
    unreadCount: 0,
    lastMessagePreview: 'Is the hall free on the 12th?',
    lastMessageAt: new Date().toISOString(),
    leadId: 'LEAD-1',
    leadScore: 0,
    leadScoreBand: 'low_intent',
    leadScoreSignals: [],
    enquiryClass: 'enquiry',
    aiResponseStatus: 'awaiting_ai_reply',
    needsAttention: true,
  },
  {
    id: 'c2',
    displayName: 'Vendor Calls',
    stage: 'new',
    unreadCount: 0,
    lastMessagePreview: 'Printer cartridges?',
    lastMessageAt: new Date().toISOString(),
    leadId: 'LEAD-2',
    leadScore: 0,
    leadScoreBand: 'low_intent',
    leadScoreSignals: [],
    enquiryClass: 'not_enquiry',
    aiResponseStatus: 'ai_not_needed',
    needsAttention: false,
  },
  {
    // A row from a server that does not derive the classifications - the fields are simply
    // absent, which is NOT the same as `needs_review`.
    id: 'c3',
    displayName: 'Older Thread',
    stage: 'new',
    unreadCount: 0,
    lastMessagePreview: 'Hello',
    lastMessageAt: new Date().toISOString(),
    leadId: 'LEAD-3',
    leadScore: 0,
    leadScoreBand: 'low_intent',
    leadScoreSignals: [],
  },
];

const lastListCall = () =>
  endpoints.listConversations.mock.calls[endpoints.listConversations.mock.calls.length - 1][0];

const renderList = () => renderAuthed(<ConversationList selectedId={null} onSelect={vi.fn()} />);

/** Makes `useIsMobileViewport` report a narrow screen, the way a real phone would. */
const stubNarrowViewport = () => {
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({
      matches: true,
      addEventListener: () => {},
      removeEventListener: () => {},
    })),
  );
};

beforeEach(() => {
  endpoints.refresh.mockResolvedValue(AUTH_PAYLOAD({ role: 'admin', permissions: [] }));
  endpoints.listConversations.mockResolvedValue({ data: [] });
  endpoints.listTags.mockResolvedValue({ data: [] });
  endpoints.listStages.mockResolvedValue({
    data: [{ id: 's1', key: 'hot-lead', label: 'Hot Lead', color: '#f80', status: 'active' }],
  });
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('inbox classification filters', () => {
  it('asks for page one with no classification filter by default', async () => {
    renderList();

    await waitFor(() => expect(endpoints.listConversations).toHaveBeenCalled());
    expect(lastListCall().enquiryClass).toBeNull();
    expect(lastListCall().aiStatus).toBeNull();
    expect(lastListCall().needsAttention).toBeUndefined();
    expect(lastListCall().skip).toBe(0);
  });

  it('sends enquiryClass when Enquiries is chosen', async () => {
    renderList();

    fireEvent.change(await screen.findByLabelText('Filter by enquiry type'), {
      target: { value: 'enquiry' },
    });

    await waitFor(() => expect(lastListCall().enquiryClass).toBe('enquiry'));
  });

  it('combines the two dimensions in a single request', async () => {
    renderList();

    fireEvent.change(await screen.findByLabelText('Filter by enquiry type'), {
      target: { value: 'enquiry' },
    });
    await waitFor(() => expect(lastListCall().enquiryClass).toBe('enquiry'));

    fireEvent.change(screen.getByLabelText('Filter by AI response'), {
      target: { value: 'awaiting_ai_reply' },
    });

    // Independent questions, so the second must NARROW the first rather than replace it.
    await waitFor(() => expect(lastListCall().aiStatus).toBe('awaiting_ai_reply'));
    expect(lastListCall().enquiryClass).toBe('enquiry');
  });

  it('adds needs attention on top of both, and drops it again when switched off', async () => {
    renderList();

    fireEvent.change(await screen.findByLabelText('Filter by enquiry type'), {
      target: { value: 'needs_review' },
    });
    fireEvent.change(screen.getByLabelText('Filter by AI response'), {
      target: { value: 'ai_reply_failed' },
    });

    const toggle = screen.getByRole('button', { name: 'Needs attention' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(toggle);

    await waitFor(() => expect(lastListCall().needsAttention).toBe(true));
    expect(lastListCall().enquiryClass).toBe('needs_review');
    expect(lastListCall().aiStatus).toBe('ai_reply_failed');

    fireEvent.click(screen.getByRole('button', { name: 'Needs attention' }));

    // Omitted, never `false`: the server reads an absent value as "do not filter on it", and
    // `false` would ask for the threads that do NOT need attention.
    await waitFor(() => expect(lastListCall().needsAttention).toBeUndefined());
  });

  it('refetches page one on every change instead of narrowing the loaded rows', async () => {
    renderList();

    await waitFor(() => expect(endpoints.listConversations).toHaveBeenCalled());
    const before = endpoints.listConversations.mock.calls.length;

    fireEvent.change(screen.getByLabelText('Filter by AI response'), {
      target: { value: 'ai_paused' },
    });

    await waitFor(() =>
      expect(endpoints.listConversations.mock.calls.length).toBeGreaterThan(before),
    );
    expect(lastListCall().aiStatus).toBe('ai_paused');
    expect(lastListCall().skip).toBe(0);
  });

  it('keeps the stage and tag filters travelling in the same call', async () => {
    endpoints.listTags.mockResolvedValue({
      data: [{ id: 't1', name: 'Budget 50L+', slug: 'budget-50l', status: 'active' }],
    });

    renderList();

    fireEvent.change(await screen.findByLabelText('Filter by stage'), {
      target: { value: 'hot-lead' },
    });
    fireEvent.change(screen.getByLabelText('Filter by tag'), { target: { value: 't1' } });
    fireEvent.change(screen.getByLabelText('Filter by enquiry type'), {
      target: { value: 'enquiry' },
    });

    await waitFor(() => expect(lastListCall().enquiryClass).toBe('enquiry'));
    expect(lastListCall().stage).toBe('hot-lead');
    expect(lastListCall().tagIds).toEqual(['t1']);
  });

  it('clears both dimensions and the attention toggle together', async () => {
    renderList();

    fireEvent.change(await screen.findByLabelText('Filter by enquiry type'), {
      target: { value: 'enquiry' },
    });
    fireEvent.change(screen.getByLabelText('Filter by AI response'), {
      target: { value: 'ai_replied' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Needs attention' }));
    await waitFor(() => expect(lastListCall().needsAttention).toBe(true));

    fireEvent.click(screen.getByRole('button', { name: 'Clear classification filters' }));

    await waitFor(() => expect(lastListCall().enquiryClass).toBeNull());
    expect(lastListCall().aiStatus).toBeNull();
    expect(lastListCall().needsAttention).toBeUndefined();
  });

  it('removes one active filter without disturbing the other', async () => {
    renderList();

    fireEvent.change(await screen.findByLabelText('Filter by enquiry type'), {
      target: { value: 'enquiry' },
    });
    fireEvent.change(screen.getByLabelText('Filter by AI response'), {
      target: { value: 'ai_replied' },
    });
    await waitFor(() => expect(lastListCall().aiStatus).toBe('ai_replied'));

    fireEvent.click(screen.getByLabelText('Remove the AI replied filter'));

    await waitFor(() => expect(lastListCall().aiStatus).toBeNull());
    expect(lastListCall().enquiryClass).toBe('enquiry');
  });
});

describe('the classification label on a row', () => {
  beforeEach(() => {
    endpoints.listConversations.mockResolvedValue({ data: CLASSIFIED });
  });

  it('shows both answers in one chip', async () => {
    renderList();

    expect(await screen.findByText('Enquiry · Awaiting AI')).toBeInTheDocument();
    expect(screen.getByText('Not an enquiry · No reply owed')).toBeInTheDocument();
  });

  it('shows nothing at all for a row the server did not classify', async () => {
    renderList();

    await screen.findByText('Older Thread');

    // "Needs review" is a real answer meaning "we looked and could not tell". A row that simply
    // arrived without the fields must not borrow it. The `:not(option)` scope is because the
    // filter dropdown legitimately offers that wording as a choice.
    expect(screen.queryByText('Needs review', { selector: ':not(option)' })).toBeNull();
    expect(screen.queryByText(/AI status unknown/)).toBeNull();
  });
});

describe('on a narrow screen', () => {
  beforeEach(() => {
    stubNarrowViewport();
    endpoints.listConversations.mockResolvedValue({ data: CLASSIFIED });
  });

  it('keeps the controls inside the existing collapsible filter area', async () => {
    renderList();

    await screen.findByText('Riya Sharma');
    // No second always-visible bar: on 360px that is a row of leads traded for a row of chrome.
    expect(screen.queryByLabelText('Filter by enquiry type')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Filters' }));

    expect(await screen.findByLabelText('Filter by enquiry type')).toBeInTheDocument();
    expect(screen.getByLabelText('Filter by AI response')).toBeInTheDocument();
  });

  it('leaves the loaded-rows search box alone', async () => {
    renderList();

    await screen.findByText('Riya Sharma');
    await waitFor(() => expect(endpoints.listConversations).toHaveBeenCalled());
    const before = endpoints.listConversations.mock.calls.length;

    fireEvent.change(screen.getByLabelText('Search the leads already loaded'), {
      target: { value: 'riya' },
    });

    // The search box is the one control here that is NOT a server query, and it must stay that
    // way - it is labelled as searching only what is loaded.
    expect(screen.queryByText('Vendor Calls')).toBeNull();
    expect(endpoints.listConversations.mock.calls.length).toBe(before);
  });
});

describe('listConversations (the request it actually builds)', () => {
  const okResponse = () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ data: [] }),
  });

  /** The URL the client asked for. Resolved against a base so a relative API root parses too. */
  const requestedUrl = (fetchMock: { mock: { calls: unknown[][] } }) =>
    new URL(String(fetchMock.mock.calls[0][0]), 'http://inbox.test');

  it('carries the three filters as query parameters', async () => {
    const fetchMock = vi.fn(async () => okResponse());
    vi.stubGlobal('fetch', fetchMock);

    // The real module: every other test in this file runs against the auto-mock.
    const actual: any = await vi.importActual('../api/endpoints');

    await actual.listConversations({
      token: 'tok',
      stage: 'new',
      enquiryClass: 'enquiry',
      aiStatus: 'awaiting_ai_reply',
      needsAttention: true,
      limit: 50,
      skip: 0,
    });

    const url = requestedUrl(fetchMock);
    expect(url.pathname.endsWith('/conversations')).toBe(true);
    expect(url.searchParams.get('enquiryClass')).toBe('enquiry');
    expect(url.searchParams.get('aiStatus')).toBe('awaiting_ai_reply');
    expect(url.searchParams.get('needsAttention')).toBe('true');
    expect(url.searchParams.get('stage')).toBe('new');
    expect(url.searchParams.get('skip')).toBe('0');
  });

  it('omits every one of them when unset, and never sends needsAttention=false', async () => {
    const fetchMock = vi.fn(async () => okResponse());
    vi.stubGlobal('fetch', fetchMock);

    const actual: any = await vi.importActual('../api/endpoints');

    await actual.listConversations({
      token: 'tok',
      enquiryClass: null,
      aiStatus: null,
      needsAttention: false,
      limit: 50,
    });

    const url = requestedUrl(fetchMock);
    expect(url.searchParams.has('enquiryClass')).toBe(false);
    expect(url.searchParams.has('aiStatus')).toBe(false);
    // Absent means "do not filter on it"; `false` would mean something else entirely.
    expect(url.searchParams.has('needsAttention')).toBe(false);
  });
});

describe('the list itself', () => {
  it('still renders rows and does not leak a contact number', async () => {
    endpoints.listConversations.mockResolvedValue({ data: CLASSIFIED });

    const { container } = renderList();

    await screen.findByText('Riya Sharma');
    expect(container.innerHTML).not.toMatch(/phone/i);
  });
});
