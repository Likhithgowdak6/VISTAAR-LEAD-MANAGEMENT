import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as endpoints from '../api/endpoints';
import ReplySuggestionDialog from '../components/ReplySuggestionDialog';
import MessageComposer from '../components/MessageComposer';
import { AUTH_PAYLOAD, renderAuthed } from './lead-helpers';

vi.mock('../api/endpoints');

beforeEach(() => {
  vi.mocked(endpoints.refresh).mockResolvedValue(AUTH_PAYLOAD({ permissions: ['ai.generate', 'messages.send'] }) as never);
  vi.mocked(endpoints.generateAiDraft).mockResolvedValue({ data: { id: 'd1', draftText: 'What date is your event?' } } as never);
});
afterEach(() => vi.resetAllMocks());

describe('reviewed reply suggestions', () => {
  it('generates only on request for this thread, lets the user edit, and never sends', async () => {
    const onUse = vi.fn();
    renderAuthed(<ReplySuggestionDialog conversationId="c1" onClose={vi.fn()} onUse={onUse} />);
    expect(endpoints.generateAiDraft).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Use draft' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Generate draft' }));
    const draft = await screen.findByDisplayValue('What date is your event?');
    expect(endpoints.generateAiDraft).toHaveBeenCalledWith(expect.objectContaining({ conversationId: 'c1' }));
    fireEvent.change(draft, { target: { value: 'Which city and date should we plan for?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Use draft' }));
    expect(onUse).toHaveBeenCalledWith('Which city and date should we plan for?');
    expect(endpoints.sendMessage).not.toHaveBeenCalled();
  });

  it('shows provider errors and allows retry without fabricating a reply', async () => {
    vi.mocked(endpoints.generateAiDraft).mockRejectedValueOnce(new Error('AI reply suggestions are not configured.'));
    renderAuthed(<ReplySuggestionDialog conversationId="c1" onClose={vi.fn()} onUse={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Generate draft' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('AI reply suggestions are not configured.');
    expect(screen.getByRole('button', { name: 'Use draft' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Generate draft' }));
    await screen.findByDisplayValue('What date is your event?');
    expect(screen.getByRole('button', { name: 'Use draft' })).toBeEnabled();
  });

  it('cancels a pending request on unmount so it cannot fill a different conversation', async () => {
    let finish!: (value: never) => void;
    vi.mocked(endpoints.generateAiDraft).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const onUse = vi.fn();
    const view = renderAuthed(<ReplySuggestionDialog conversationId="old" onClose={vi.fn()} onUse={onUse} />);
    fireEvent.click(screen.getByRole('button', { name: 'Generate draft' }));
    await waitFor(() => expect(endpoints.generateAiDraft).toHaveBeenCalledTimes(1));
    const signal = vi.mocked(endpoints.generateAiDraft).mock.calls[0][0].signal;
    expect(screen.getByRole('button', { name: 'Use draft' })).toBeDisabled();
    view.unmount();
    expect(signal?.aborted).toBe(true);
    await act(async () => finish({ data: { draftText: 'Old reply' } } as never));
    expect(onUse).not.toHaveBeenCalled();
    expect(endpoints.sendMessage).not.toHaveBeenCalled();
  });

  it('keeps the template writer and opens suggestions only when offered', () => {
    const onSuggestion = vi.fn();
    const onTemplates = vi.fn();
    const view = render(<MessageComposer onSend={vi.fn()} canUseTemplates onOpenTemplates={onTemplates} />);
    expect(screen.queryByRole('button', { name: 'Suggest reply' })).not.toBeInTheDocument();
    view.rerender(<MessageComposer onSend={vi.fn()} canUseTemplates onOpenTemplates={onTemplates} onOpenSuggestion={onSuggestion} />);
    fireEvent.click(screen.getByRole('button', { name: 'Suggest reply' }));
    expect(onSuggestion).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: /Message templates/ }));
    expect(onTemplates).toHaveBeenCalledTimes(1);
  });

  it('protects existing text before inserting a reviewed draft', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const onSend = vi.fn();
    const view = render(<MessageComposer onSend={onSend} />);
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'My reply in progress' } });
    view.rerender(<MessageComposer onSend={onSend} starredInsert={{ body: 'AI draft', nonce: 1, source: 'suggestion' }} />);
    expect(screen.getByLabelText('Message')).toHaveValue('My reply in progress');
    confirm.mockReturnValue(true);
    view.rerender(<MessageComposer onSend={onSend} starredInsert={{ body: 'AI draft', nonce: 2, source: 'suggestion' }} />);
    expect(screen.getByLabelText('Message')).toHaveValue('AI draft');
    expect(onSend).not.toHaveBeenCalled();
    confirm.mockRestore();
  });
});
