import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import MessageComposer from '../components/MessageComposer';

describe('MessageComposer', () => {
  it('disables Send when the input is empty and enables it with text', () => {
    render(<MessageComposer onSend={vi.fn()} onSuggest={vi.fn() as any} />);

    const sendButton = screen.getByRole('button', { name: 'Send' });
    expect(sendButton).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Hi' } });
    expect(sendButton).toBeEnabled();
  });

  it('calls onSend with a unique idempotency key and clears the input on success', async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    render(<MessageComposer onSend={onSend} onSuggest={vi.fn() as any} />);

    const input = screen.getByLabelText('Message');
    fireEvent.change(input, { target: { value: 'Hello there' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    const args = onSend.mock.calls[0][0];
    expect(args.body).toBe('Hello there');
    expect(typeof args.idempotencyKey).toBe('string');
    expect(args.idempotencyKey.length).toBeGreaterThanOrEqual(8);

    await waitFor(() => expect(input).toHaveValue(''));
  });

  it('surfaces an error and keeps the text when sending fails', async () => {
    const onSend = vi.fn().mockRejectedValue(new Error('Network down'));
    render(<MessageComposer onSend={onSend} onSuggest={vi.fn() as any} />);

    const input = screen.getByLabelText('Message');
    fireEvent.change(input, { target: { value: 'Keep me' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Network down');
    expect(input).toHaveValue('Keep me');
  });
});

const TEMPLATES = [
  { id: 't1', title: 'Clean list', body: '*Wedding* — ₹45,000', kind: 'pricing' as const,
    sourceDetails: '', createdBy: null, createdAt: null, updatedAt: null },
];

describe('MessageComposer — templates', () => {
  it('has no picker when nothing is saved', () => {
    render(<MessageComposer onSend={vi.fn()} />);

    expect(screen.queryByLabelText('Insert a template')).not.toBeInTheDocument();
  });

  it('loads a template into the box for editing rather than sending it', async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    render(<MessageComposer onSend={onSend} templates={TEMPLATES} />);

    fireEvent.change(screen.getByLabelText('Insert a template'), { target: { value: 't1' } });

    // A quote goes out under the studio's name, so it gets the same human look as an AI draft.
    expect(screen.getByLabelText('Message')).toHaveValue('*Wedding* — ₹45,000');
    expect(onSend).not.toHaveBeenCalled();
  });

  it('confirms before overwriting a half-typed reply, and keeps it when declined', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<MessageComposer onSend={vi.fn()} templates={TEMPLATES} />);

    const input = screen.getByLabelText('Message');
    fireEvent.change(input, { target: { value: 'Half typed reply' } });
    fireEvent.change(screen.getByLabelText('Insert a template'), { target: { value: 't1' } });

    expect(confirm).toHaveBeenCalled();
    expect(input).toHaveValue('Half typed reply');

    confirm.mockReturnValue(true);
    fireEvent.change(screen.getByLabelText('Insert a template'), { target: { value: 't1' } });
    expect(input).toHaveValue('*Wedding* — ₹45,000');

    confirm.mockRestore();
  });

  it('does not report an inserted template as an approved AI draft', async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    const onSuggest = vi.fn().mockResolvedValue({ draftId: 'd1', draftText: 'An AI draft' });
    render(
      <MessageComposer onSend={onSend} onSuggest={onSuggest} canSuggest templates={TEMPLATES} />,
    );

    fireEvent.click(screen.getByRole('button', { name: '✨ Suggest reply' }));
    await waitFor(() => expect(screen.getByLabelText('Message')).toHaveValue('An AI draft'));

    // Replacing the draft with a template must clear the draft id, or the feedback metadata
    // records a template as the draft having been approved-with-edits.
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.change(screen.getByLabelText('Insert a template'), { target: { value: 't1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend.mock.calls[0][0].draftId).toBeNull();

    vi.restoreAllMocks();
  });
});
