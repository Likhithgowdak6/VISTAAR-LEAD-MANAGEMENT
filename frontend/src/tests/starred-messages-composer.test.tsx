/**
 * The two places Starred touches existing UI: the star on a bubble, and the insert into the
 * composer.
 *
 * WHY THE COMPOSER TESTS ARE THE SERIOUS ONES. MessageComposer is the most load-bearing
 * component in the app and it already carried a template picker, staged attachments, a sending
 * lock and an account selector before any of this. The insert had to arrive without disturbing
 * those, and above all without ever reaching onSend - a saved reply is a draft, and sending one
 * unreviewed is not recoverable.
 *
 * The overwrite confirmation is here too. A half-typed reply is work, and a textarea has no
 * undo, so an insert that silently replaces it loses something the user cannot get back.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import MessageComposer from '../components/MessageComposer';
import MessageThread from '../components/MessageThread';

const message = (overrides: Record<string, unknown> = {}) =>
  ({
    id: 'message-1',
    direction: 'in',
    type: 'text',
    body: 'Do you cover drone shots?',
    status: 'delivered',
    sentAt: '2026-10-26T09:00:00.000Z',
    ...overrides,
  }) as never;

const renderThread = (props: Record<string, unknown> = {}) =>
  render(
    <MessageThread
      messages={[message()]}
      hasMore={false}
      loadingOlder={false}
      onLoadOlder={() => {}}
      {...props}
    />,
  );

beforeEach(() => {
  vi.clearAllMocks();
});

describe('the star on a message', () => {
  it('is not rendered when the thread has no handler', () => {
    renderThread();

    expect(screen.queryByRole('button', { name: /starred messages/i })).toBeNull();
  });

  it('offers to save an unsaved message', () => {
    const onToggleStar = vi.fn();
    renderThread({ onToggleStar });

    fireEvent.click(screen.getByRole('button', { name: 'Save to starred messages' }));

    expect(onToggleStar).toHaveBeenCalledWith(expect.objectContaining({ id: 'message-1' }));
  });

  it('offers to remove one that is already saved, and says so to a screen reader', () => {
    const onToggleStar = vi.fn();
    renderThread({ onToggleStar, starredMessageIds: new Set(['message-1']) });

    const button = screen.getByRole('button', { name: 'Remove from starred messages' });

    // The glyph alone does not say which way the press goes.
    expect(button).toHaveAttribute('aria-pressed', 'true');
  });

  it('IS NOT OFFERED ON A MESSAGE WITH NO TEXT', () => {
    // A photo with no caption. Starring it would save an empty string that does nothing when
    // reused, and the server would reject it anyway.
    render(
      <MessageThread
        messages={[message({ id: 'm-photo', type: 'image', body: '' })]}
        hasMore={false}
        loadingOlder={false}
        onLoadOlder={() => {}}
        onToggleStar={vi.fn()}
      />,
    );

    expect(screen.queryByRole('button', { name: /starred messages/i })).toBeNull();
  });

  it('cannot be double-fired while a save is in flight', () => {
    const onToggleStar = vi.fn();
    renderThread({ onToggleStar, starPendingId: 'message-1' });

    expect(screen.getByRole('button', { name: 'Save to starred messages' })).toBeDisabled();
  });
});

describe('inserting a saved message into the composer', () => {
  const renderComposer = (props: Record<string, unknown> = {}) => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    const utils = render(<MessageComposer onSend={onSend} {...props} />);

    return { onSend, ...utils };
  };

  it('fills the box WITHOUT SENDING', async () => {
    const { onSend } = renderComposer({
      starredInsert: { body: 'Yes, drone coverage is included.', nonce: 1 },
      onStarredInsertHandled: vi.fn(),
    });

    await waitFor(() =>
      expect(screen.getByRole('textbox')).toHaveValue('Yes, drone coverage is included.'),
    );

    // The single most important assertion in this file.
    expect(onSend).not.toHaveBeenCalled();
  });

  it('leaves the text editable afterwards', async () => {
    renderComposer({
      starredInsert: { body: 'Yes, drone coverage is included.', nonce: 1 },
      onStarredInsertHandled: vi.fn(),
    });

    const box = await screen.findByRole('textbox');
    fireEvent.change(box, { target: { value: 'Yes, drone coverage is included. Shall I call?' } });

    expect(box).toHaveValue('Yes, drone coverage is included. Shall I call?');
  });

  it('tells the parent it has handled the insert, so the next one is not swallowed', async () => {
    const onStarredInsertHandled = vi.fn();
    renderComposer({
      starredInsert: { body: 'Saved text', nonce: 1 },
      onStarredInsertHandled,
    });

    await waitFor(() => expect(onStarredInsertHandled).toHaveBeenCalledTimes(1));
  });

  it('ASKS BEFORE OVERWRITING a half-typed reply, and keeps it when declined', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { rerender, onSend } = renderComposer({ onStarredInsertHandled: vi.fn() });

    const box = screen.getByRole('textbox');
    fireEvent.change(box, { target: { value: 'Half-written thought' } });

    rerender(
      <MessageComposer
        onSend={onSend}
        onStarredInsertHandled={vi.fn()}
        starredInsert={{ body: 'Saved text', nonce: 2 }}
      />,
    );

    await waitFor(() => expect(confirmSpy).toHaveBeenCalled());
    expect(box).toHaveValue('Half-written thought');
    confirmSpy.mockRestore();
  });

  it('does not ask when the box is empty', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm');
    renderComposer({
      starredInsert: { body: 'Saved text', nonce: 1 },
      onStarredInsertHandled: vi.fn(),
    });

    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('Saved text'));
    expect(confirmSpy).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('DOES NOT RE-APPLY ON A PARENT RE-RENDER, even after the box is edited', async () => {
    /*
     * What the nonce is actually for. ConversationView passes an inline arrow for
     * `onStarredInsertHandled`, so that dependency is a new function on every parent render and
     * the effect reruns constantly. Keyed on the text instead of the nonce, the rerun would see
     * an edited box, decide the insert had not been applied, and prompt again - wiping the edit
     * the user just made, repeatedly, for as long as the insert stays set.
     */
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const insert = { body: 'Saved text', nonce: 7 };
    const { rerender, onSend } = renderComposer({
      starredInsert: insert,
      onStarredInsertHandled: vi.fn(),
    });

    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('Saved text'));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'my own words' } });

    // A parent re-render with the SAME insert and a fresh callback identity.
    rerender(
      <MessageComposer
        onSend={onSend}
        onStarredInsertHandled={vi.fn()}
        starredInsert={insert}
      />,
    );

    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('my own words'));
    expect(confirmSpy).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('APPLIES THE SAME SAVED MESSAGE TWICE when picked twice', async () => {
    // The nonce exists for this. Comparing the text alone would make the second pick a no-op,
    // and the user would think the panel had broken.
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { rerender, onSend } = renderComposer({
      starredInsert: { body: 'Saved text', nonce: 1 },
      onStarredInsertHandled: vi.fn(),
    });

    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('Saved text'));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'changed my mind' } });

    rerender(
      <MessageComposer
        onSend={onSend}
        onStarredInsertHandled={vi.fn()}
        starredInsert={{ body: 'Saved text', nonce: 2 }}
      />,
    );

    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('Saved text'));
    confirmSpy.mockRestore();
  });
});

describe('the Starred button in the composer toolbar', () => {
  it('opens the panel', () => {
    const onOpenStarred = vi.fn();
    render(<MessageComposer onSend={vi.fn()} onOpenStarred={onOpenStarred} />);

    fireEvent.click(screen.getByRole('button', { name: '★ Starred' }));

    expect(onOpenStarred).toHaveBeenCalledTimes(1);
  });

  it('is absent when the user cannot send, so the toolbar does not grow a dead control', () => {
    render(<MessageComposer onSend={vi.fn()} />);

    expect(screen.queryByRole('button', { name: '★ Starred' })).toBeNull();
  });

  it('does not disturb the existing Message templates button', () => {
    render(
      <MessageComposer
        onSend={vi.fn()}
        onOpenStarred={vi.fn()}
        canUseTemplates
        onOpenTemplates={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: '✨ Message templates' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '★ Starred' })).toBeInTheDocument();
  });
});
