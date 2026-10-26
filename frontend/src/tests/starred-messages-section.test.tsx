/**
 * The Starred panel: saving a reply, finding it again, and reusing it.
 *
 * THE RULE THAT MATTERS MOST is that reuse INSERTS AND NEVER SENDS. A saved reply is a
 * starting draft - the version used on the last lead is rarely word-for-word right for the
 * next - and a panel that sent on click would put unreviewed text in front of a customer with
 * no undo. So there is a test here asserting the send path is never touched, and it is the one
 * to keep if any of the others are ever dropped.
 *
 * The rest guards the ordinary ways a small CRUD panel goes wrong: search that filters in the
 * browser and silently stops finding things past the server's row cap, a delete with no
 * confirmation, and an edit that saves the row it was not opened on.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listStarredMessages: vi.fn(),
  createStarredMessage: vi.fn(),
  updateStarredMessage: vi.fn(),
  deleteStarredMessage: vi.fn(),
  sendMessage: vi.fn(),
  useAuth: vi.fn(),
}));

vi.mock('../api/endpoints', () => ({
  listStarredMessages: mocks.listStarredMessages,
  createStarredMessage: mocks.createStarredMessage,
  updateStarredMessage: mocks.updateStarredMessage,
  deleteStarredMessage: mocks.deleteStarredMessage,
  sendMessage: mocks.sendMessage,
}));

vi.mock('../auth/AuthContext', () => ({ useAuth: mocks.useAuth }));

const StarredMessagesSection = (await import('../components/starred/StarredMessagesSection'))
  .default;

const saved = (overrides: Record<string, unknown> = {}) => ({
  id: 'starred-1',
  title: 'Drone coverage',
  body: 'Yes, drone coverage is included in the premium package.',
  sourceMessageId: null,
  sourceConversationId: null,
  createdAt: '2026-10-26T09:00:00.000Z',
  updatedAt: '2026-10-26T09:00:00.000Z',
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.useAuth.mockReturnValue({
    authedRequest: (run: (token: string) => Promise<unknown>) => run('test-token'),
  });
  mocks.listStarredMessages.mockResolvedValue({ data: [saved()] });
  mocks.createStarredMessage.mockResolvedValue({ data: saved({ id: 'starred-2' }) });
  mocks.updateStarredMessage.mockResolvedValue({ data: saved({ title: 'Edited' }) });
  mocks.deleteStarredMessage.mockResolvedValue({ data: saved() });
});

describe('reuse', () => {
  it('INSERTS THE TEXT AND NEVER SENDS IT', async () => {
    const onUse = vi.fn();
    render(<StarredMessagesSection onUse={onUse} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Use' }));

    expect(onUse).toHaveBeenCalledWith(
      'Yes, drone coverage is included in the premium package.',
    );
    // The whole point. Anything that reaches sendMessage from here puts unreviewed text in
    // front of a customer.
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });

  it('offers no Use button when there is nowhere to insert into', async () => {
    render(<StarredMessagesSection />);

    await screen.findByText('Drone coverage');

    expect(screen.queryByRole('button', { name: 'Use' })).toBeNull();
  });
});

describe('creating', () => {
  it('saves a title and body and clears the form', async () => {
    const onChanged = vi.fn();
    render(<StarredMessagesSection onChanged={onChanged} />);

    await screen.findByText('Drone coverage');

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Album options' } });
    fireEvent.change(screen.getByLabelText('Message'), {
      target: { value: 'We offer three album sizes.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save message' }));

    await waitFor(() =>
      expect(mocks.createStarredMessage).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Album options', body: 'We offer three album sizes.' }),
      ),
    );

    await waitFor(() => expect(screen.getByLabelText('Title')).toHaveValue(''));
    expect(onChanged).toHaveBeenCalled();
  });

  it('will not save with an empty body', async () => {
    render(<StarredMessagesSection />);

    await screen.findByText('Drone coverage');

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Only a title' } });

    expect(screen.getByRole('button', { name: 'Save message' })).toBeDisabled();
  });
});

describe('search', () => {
  it('ASKS THE SERVER rather than filtering what is already loaded', async () => {
    render(<StarredMessagesSection />);

    await screen.findByText('Drone coverage');

    fireEvent.change(screen.getByLabelText('Search starred messages'), {
      target: { value: 'album' },
    });

    // Client-side filtering would look identical until the user passes the server's 200-row
    // cap, at which point search quietly stops finding older entries.
    await waitFor(() =>
      expect(mocks.listStarredMessages).toHaveBeenCalledWith(
        expect.objectContaining({ search: 'album' }),
      ),
    );
  });

  it('debounces, so typing a word is not one request per letter', async () => {
    render(<StarredMessagesSection />);

    await waitFor(() => expect(mocks.listStarredMessages).toHaveBeenCalledTimes(1));

    const box = screen.getByLabelText('Search starred messages');
    fireEvent.change(box, { target: { value: 'a' } });
    fireEvent.change(box, { target: { value: 'al' } });
    fireEvent.change(box, { target: { value: 'alb' } });

    await waitFor(() =>
      expect(mocks.listStarredMessages).toHaveBeenCalledWith(
        expect.objectContaining({ search: 'alb' }),
      ),
    );

    // The initial load plus one settled search, not four.
    expect(mocks.listStarredMessages).toHaveBeenCalledTimes(2);
  });
});

describe('managing', () => {
  it('edits the row the Edit button was on', async () => {
    render(<StarredMessagesSection />);

    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Edit title for Drone coverage'), {
      target: { value: 'Drone add-on' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(mocks.updateStarredMessage).toHaveBeenCalledWith(
        expect.objectContaining({ starredMessageId: 'starred-1', title: 'Drone add-on' }),
      ),
    );
  });

  it('ASKS BEFORE DELETING, and does nothing when declined', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<StarredMessagesSection />);

    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));

    expect(confirmSpy).toHaveBeenCalled();
    expect(mocks.deleteStarredMessage).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('deletes when confirmed and drops the row', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<StarredMessagesSection />);

    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));

    await waitFor(() =>
      expect(mocks.deleteStarredMessage).toHaveBeenCalledWith(
        expect.objectContaining({ starredMessageId: 'starred-1' }),
      ),
    );
    await waitFor(() => expect(screen.queryByText('Drone coverage')).toBeNull());
    confirmSpy.mockRestore();
  });
});

describe('when the list cannot be loaded', () => {
  it('says so instead of showing an empty list that looks like no saved messages', async () => {
    mocks.listStarredMessages.mockRejectedValue(new Error('offline'));

    render(<StarredMessagesSection />);

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByText('No saved messages yet. Star one in a chat, or write one above.')).toBeNull();
  });
});
