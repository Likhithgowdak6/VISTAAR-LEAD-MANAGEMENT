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
