import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as endpoints from '../api/endpoints';
import ConversationList from '../components/ConversationList';
import { AUTH_PAYLOAD, renderAuthed } from './lead-helpers';

vi.mock('../api/endpoints');

const lead = { id: 'lead-1', displayName: 'Riya Sharma', stage: 'new', unreadCount: 0 };
const assistant = {
  id: 'assistant-1', displayName: 'Owner Assistant', kind: 'owner_assistant', unreadCount: 2,
};

beforeEach(() => {
  vi.mocked(endpoints.refresh).mockResolvedValue(AUTH_PAYLOAD({ permissions: [] }) as never);
  vi.mocked(endpoints.listStages).mockResolvedValue({ data: [] } as never);
  vi.mocked(endpoints.listTags).mockResolvedValue({ data: [] } as never);
  vi.mocked(endpoints.listConversations).mockImplementation(async (params) => ({
    data: params?.kind === 'owner_assistant' ? [assistant] : params?.stage ? [] : [lead, assistant],
  }) as never);
});

afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

describe('separate inbox assistant entry', () => {
  it('opens the existing thread from a separate entry without customer badges or switches', async () => {
    const onSelect = vi.fn();
    renderAuthed(<ConversationList selectedId="assistant-1" onSelect={onSelect} />);
    const entry = screen.getByRole('button', { name: 'Open Owner Assistant' });
    await waitFor(() => expect(entry).toBeEnabled());
    expect(entry).toHaveAttribute('aria-current', 'true');
    expect(within(entry).getByLabelText('2 unread')).toBeInTheDocument();
    expect(within(entry).queryByRole('switch')).not.toBeInTheDocument();
    expect(within(screen.getByRole('list')).queryByText('Owner Assistant')).not.toBeInTheDocument();
    expect(screen.getByText('Riya Sharma')).toBeInTheDocument();
    fireEvent.click(entry);
    expect(onSelect).toHaveBeenCalledWith('assistant-1');
  });

  it('keeps the assistant available when lead filters produce no matches', async () => {
    const onSelect = vi.fn();
    renderAuthed(<ConversationList onSelect={onSelect} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open Owner Assistant' })).toBeEnabled());
    fireEvent.change(screen.getByLabelText('Filter by stage'), { target: { value: 'qualified' } });
    expect(await screen.findByText('No matching conversations')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open Owner Assistant' }));
    expect(onSelect).toHaveBeenCalledWith('assistant-1');
    expect(endpoints.listConversations).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'lead', stage: 'qualified', skip: 0,
    }));
    expect(endpoints.listConversations).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'owner_assistant', limit: 1, skip: 0,
    }));
  });

  it('keeps customer chats usable when the assistant fails to load and allows retry', async () => {
    let failed = false;
    vi.mocked(endpoints.listConversations).mockImplementation(async (params) => {
      if (params?.kind === 'owner_assistant' && !failed) { failed = true; throw new Error('Unavailable'); }
      return { data: params?.kind === 'owner_assistant' ? [assistant] : [lead] } as never;
    });
    const onSelect = vi.fn();
    renderAuthed(<ConversationList onSelect={onSelect} />);
    expect(await screen.findByText('Could not load. Click to retry.')).toBeInTheDocument();
    expect(screen.getByText('Riya Sharma')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open Owner Assistant' }));
    await screen.findByText('Updates and reminders');
    fireEvent.click(screen.getByRole('button', { name: 'Open Owner Assistant' }));
    expect(onSelect).toHaveBeenCalledWith('assistant-1');
  });

  it('shows a stable empty entry without inventing an assistant thread', async () => {
    vi.mocked(endpoints.listConversations).mockResolvedValue({ data: [] } as never);
    const onSelect = vi.fn();
    renderAuthed(<ConversationList onSelect={onSelect} />);
    await screen.findByText('No assistant messages yet');
    expect(screen.getByRole('button', { name: 'Open Owner Assistant' })).toBeDisabled();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('keeps customers named Owner Assistant in the customer list', async () => {
    vi.mocked(endpoints.listConversations).mockImplementation(async (params) => ({
      data: params?.kind === 'owner_assistant' ? [assistant] : [{ ...lead, displayName: 'Owner Assistant' }],
    }) as never);
    renderAuthed(<ConversationList onSelect={vi.fn()} />);
    expect(await within(screen.getByRole('list')).findByText('Owner Assistant')).toBeInTheDocument();
  });

  it('keeps the entry available while searching customer chats on a phone', async () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({
      matches: true, addEventListener: () => {}, removeEventListener: () => {},
    })));
    const onSelect = vi.fn();
    renderAuthed(<ConversationList onSelect={onSelect} />);
    await screen.findByText('Riya Sharma');
    fireEvent.change(screen.getByLabelText('Search the leads already loaded'), {
      target: { value: 'no matching customer' },
    });
    expect(screen.queryByText('Riya Sharma')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open Owner Assistant' }));
    expect(onSelect).toHaveBeenCalledWith('assistant-1');
  });
});
