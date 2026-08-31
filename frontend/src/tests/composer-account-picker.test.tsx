import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import MessageComposer from '../components/MessageComposer';

const ACCOUNTS = [
  { id: 'acc-1', name: 'Studio Main', brandKey: 'studio-main' },
  { id: 'acc-2', name: 'Studio Events', brandKey: 'studio-events' },
];

const typeAndSend = (text: string) => {
  fireEvent.change(screen.getByLabelText('Message'), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
};

describe('MessageComposer — send-from picker', () => {
  it('stays hidden when there is only one number to send from', () => {
    render(
      <MessageComposer
        onSend={vi.fn()}
        sendableAccounts={[ACCOUNTS[0]]}
        currentAccountId="acc-1"
      />,
    );

    expect(screen.queryByLabelText('Send from')).not.toBeInTheDocument();
  });

  it('pre-selects the number the thread is already on', () => {
    render(
      <MessageComposer onSend={vi.fn()} sendableAccounts={ACCOUNTS} currentAccountId="acc-2" />,
    );

    expect(screen.getByLabelText('Send from')).toHaveValue('acc-2');
  });

  it('sends the thread’s own number when nothing is changed', async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    render(
      <MessageComposer onSend={onSend} sendableAccounts={ACCOUNTS} currentAccountId="acc-1" />,
    );

    typeAndSend('Hello');

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend.mock.calls[0][0]).toMatchObject({
      body: 'Hello',
      whatsappAccountId: 'acc-1',
    });
  });

  it('sends the chosen number and warns that the lead will move', async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    render(
      <MessageComposer onSend={onSend} sendableAccounts={ACCOUNTS} currentAccountId="acc-1" />,
    );

    fireEvent.change(screen.getByLabelText('Send from'), { target: { value: 'acc-2' } });

    expect(screen.getByText(/lead will move to the selected number/i)).toBeInTheDocument();

    typeAndSend('Hello from the other number');

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend.mock.calls[0][0]).toMatchObject({ whatsappAccountId: 'acc-2' });
  });

  it('shows the thread’s disconnected number as an unselectable option', () => {
    render(
      <MessageComposer
        onSend={vi.fn()}
        sendableAccounts={ACCOUNTS}
        currentAccountId="acc-offline"
        currentAccountName="Studio Old"
      />,
    );

    const option = screen.getByRole('option', { name: 'Studio Old (not connected)' });

    expect(option).toBeDisabled();
    // Selected, so the picker never displays a number other than the one a plain send uses.
    expect(screen.getByLabelText('Send from')).toHaveValue('acc-offline');
  });
});
