import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import ConversationList from '../components/ConversationList';
import * as endpointsApi from '../api/endpoints';
import { AUTH_PAYLOAD, renderAuthed } from './lead-helpers';

// Tests may use `any` for Vitest mocks of untyped endpoint modules.
const endpoints = endpointsApi as any;

vi.mock('../api/endpoints');

const TAGS = [
  { id: 't1', name: 'Budget 50L+', slug: 'budget-50l', status: 'active' },
  { id: 't2', name: 'Walk-in', slug: 'walk-in', status: 'active' },
  { id: 't3', name: 'Retired', slug: 'retired', status: 'archived' },
];

const lastListCall = () =>
  endpoints.listConversations.mock.calls[endpoints.listConversations.mock.calls.length - 1][0];

beforeEach(() => {
  endpoints.refresh.mockResolvedValue(AUTH_PAYLOAD({ role: 'admin', permissions: [] }));
  endpoints.listConversations.mockResolvedValue({ data: [] });
  endpoints.listTags.mockResolvedValue({ data: TAGS });
  endpoints.listStages.mockResolvedValue({
    data: [{ id: 's1', key: 'hot-lead', label: 'Hot Lead', color: '#f80', status: 'active' }],
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('inbox filters', () => {
  const renderList = () => renderAuthed(<ConversationList selectedId={null} onSelect={vi.fn()} />);

  it('sends no stage or tag filter by default', async () => {
    renderList();

    await waitFor(() => expect(endpoints.listConversations).toHaveBeenCalled());
    expect(lastListCall().stage).toBeNull();
    expect(lastListCall().tagIds).toEqual([]);
  });

  it('filters by a custom stage, not just the built-ins', async () => {
    renderList();

    const stageFilter = await screen.findByLabelText('Filter by stage');
    fireEvent.change(stageFilter, { target: { value: 'hot-lead' } });

    await waitFor(() => expect(lastListCall().stage).toBe('hot-lead'));
  });

  it('accumulates tag filters and keeps the stage filter applied alongside', async () => {
    renderList();

    fireEvent.change(await screen.findByLabelText('Filter by stage'), {
      target: { value: 'hot-lead' },
    });
    fireEvent.change(screen.getByLabelText('Filter by tag'), { target: { value: 't1' } });
    await waitFor(() => expect(lastListCall().tagIds).toEqual(['t1']));

    fireEvent.change(screen.getByLabelText('Filter by tag'), { target: { value: 't2' } });

    await waitFor(() => expect(lastListCall().tagIds).toEqual(['t1', 't2']));
    // Stage and tags narrow together.
    expect(lastListCall().stage).toBe('hot-lead');
  });

  it('does not offer archived tags as a filter', async () => {
    renderList();

    const tagFilter = await screen.findByLabelText('Filter by tag');
    expect(within(tagFilter).queryByText('Retired')).not.toBeInTheDocument();
    expect(within(tagFilter).getByText('Budget 50L+')).toBeInTheDocument();
  });

  it('removes a single tag filter without clearing the rest', async () => {
    renderList();

    const tagFilter = await screen.findByLabelText('Filter by tag');
    fireEvent.change(tagFilter, { target: { value: 't1' } });
    await waitFor(() => expect(lastListCall().tagIds).toEqual(['t1']));
    fireEvent.change(screen.getByLabelText('Filter by tag'), { target: { value: 't2' } });
    await waitFor(() => expect(lastListCall().tagIds).toEqual(['t1', 't2']));

    fireEvent.click(screen.getByLabelText('Remove Budget 50L+ filter'));

    await waitFor(() => expect(lastListCall().tagIds).toEqual(['t2']));
  });

  it('clears every filter at once', async () => {
    renderList();

    fireEvent.change(await screen.findByLabelText('Filter by stage'), {
      target: { value: 'hot-lead' },
    });
    fireEvent.change(screen.getByLabelText('Filter by tag'), { target: { value: 't1' } });
    await waitFor(() => expect(lastListCall().tagIds).toEqual(['t1']));

    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));

    await waitFor(() => expect(lastListCall().stage).toBeNull());
    expect(lastListCall().tagIds).toEqual([]);
  });

  it('explains an empty result differently when filters are active', async () => {
    renderList();

    expect(await screen.findByText('No conversations yet')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Filter by stage'), { target: { value: 'hot-lead' } });

    expect(await screen.findByText('No matching conversations')).toBeInTheDocument();
  });
});
