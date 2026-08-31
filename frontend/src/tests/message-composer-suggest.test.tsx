import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import MessageComposer from '../components/MessageComposer';

describe('MessageComposer — AI suggest reply', () => {
  it('hides the Suggest reply button without canSuggest', () => {
    render(<MessageComposer onSend={vi.fn()} onSuggest={vi.fn() as any} />);

    expect(screen.queryByRole('button', { name: /suggest reply/i })).not.toBeInTheDocument();
  });

  it('fills the composer with the AI draft without sending it', async () => {
    const onSuggest = vi
      .fn()
      .mockResolvedValue({ draftId: 'd1', draftText: 'Yes, still available!' });
    const onSend = vi.fn();
    render(<MessageComposer onSend={onSend} onSuggest={onSuggest} canSuggest />);

    fireEvent.click(screen.getByRole('button', { name: /suggest reply/i }));

    await waitFor(() => expect(onSuggest).toHaveBeenCalledTimes(1));
    expect(await screen.findByDisplayValue('Yes, still available!')).toBeInTheDocument();
    expect(onSend).not.toHaveBeenCalled();
  });

  it('sends an unedited draft with wasEdited: false and the draftId', async () => {
    const onSuggest = vi
      .fn()
      .mockResolvedValue({ draftId: 'd1', draftText: 'Yes, still available!' });
    const onSend = vi.fn().mockResolvedValue(undefined);
    render(<MessageComposer onSend={onSend} onSuggest={onSuggest} canSuggest />);

    fireEvent.click(screen.getByRole('button', { name: /suggest reply/i }));
    await screen.findByDisplayValue('Yes, still available!');

    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend.mock.calls[0][0]).toMatchObject({
      body: 'Yes, still available!',
      draftId: 'd1',
      wasEdited: false,
    });
  });

  it('sends an edited draft with wasEdited: true', async () => {
    const onSuggest = vi
      .fn()
      .mockResolvedValue({ draftId: 'd1', draftText: 'Yes, still available!' });
    const onSend = vi.fn().mockResolvedValue(undefined);
    render(<MessageComposer onSend={onSend} onSuggest={onSuggest} canSuggest />);

    fireEvent.click(screen.getByRole('button', { name: /suggest reply/i }));
    const input = await screen.findByDisplayValue('Yes, still available!');

    fireEvent.change(input, { target: { value: 'Yes, still available! Move-in ready.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend.mock.calls[0][0]).toMatchObject({
      body: 'Yes, still available! Move-in ready.',
      draftId: 'd1',
      wasEdited: true,
    });
  });

  it('a manually typed message (no suggestion) sends with no draftId', async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    render(<MessageComposer onSend={onSend} onSuggest={vi.fn()} canSuggest />);

    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Hi there' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend.mock.calls[0][0]).toMatchObject({ body: 'Hi there', draftId: null });
  });

  it('surfaces an error when suggesting fails', async () => {
    const onSuggest = vi.fn().mockRejectedValue(new Error('AI is disabled.'));
    render(<MessageComposer onSend={vi.fn()} onSuggest={onSuggest} canSuggest />);

    fireEvent.click(screen.getByRole('button', { name: /suggest reply/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('AI is disabled.');
  });
});
