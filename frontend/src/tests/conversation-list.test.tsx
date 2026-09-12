import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import App from '../App';
import * as endpointsApi from '../api/endpoints';

// Tests may use `any` for Vitest mocks of untyped endpoint modules.
const endpoints = endpointsApi as any;

vi.mock('../api/endpoints');

const authPayload = {
  data: {
    accessToken: 'access-token-1',
    user: { id: 'u1', name: 'Asha Menon' },
    organization: { id: 'o1', name: 'Acme' },
    permissions: ['conversations.read_all'],
  },
};

const conversations = [
  {
    id: 'c1',
    displayName: 'Riya Sharma',
    stage: 'qualified',
    unreadCount: 3,
    lastMessagePreview: 'Is the flat still available?',
    lastMessageAt: new Date().toISOString(),
    leadId: 'LEAD-20260724-ABC123',
    leadScore: 85,
    leadScoreBand: 'hot',
    leadScoreSignals: ['event_date', 'venue', 'budget', 'quotation_requested', 'replied'],
    aiAutomationEnabled: true,
  },
  {
    id: 'c2',
    displayName: 'WhatsApp Lead',
    stage: 'new',
    unreadCount: 0,
    lastMessagePreview: 'Hello',
    lastMessageAt: new Date().toISOString(),
    leadId: 'LEAD-20260724-DEF456',
    leadScore: 0,
    leadScoreBand: 'low_intent',
    leadScoreSignals: [],
  },
];

beforeEach(() => {
  endpoints.refresh.mockResolvedValue(authPayload);
  endpoints.listConversations.mockResolvedValue({ data: conversations });
  endpoints.getConversation.mockResolvedValue({
    data: {
      conversation: conversations[0],
      contact: { id: 'ct1', leadId: 'LEAD-20260724-ABC123' },
    },
  });
  endpoints.getMessages.mockResolvedValue({
    data: [
      {
        id: 'm2',
        direction: 'out',
        body: 'Yes it is available.',
        status: 'sent',
        sentAt: new Date().toISOString(),
      },
      {
        id: 'm1',
        direction: 'in',
        body: 'Is the flat still available?',
        status: 'received',
        sentAt: new Date(Date.now() - 60000).toISOString(),
      },
    ],
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('inbox and thread', () => {
  it('renders conversations with unread and stage, and opens a thread on select', async () => {
    render(<App />);

    const [riyaRow] = await screen.findAllByText('Riya Sharma');
    expect(riyaRow).toBeInTheDocument();
    // "Qualified" also appears as a stage-filter <option>, so match the badge specifically.
    expect(screen.getByText('Qualified', { selector: ':not(option)' })).toBeInTheDocument();
    expect(screen.getByLabelText('3 unread')).toBeInTheDocument();

    fireEvent.click(riyaRow);

    await waitFor(() =>
      expect(endpoints.getMessages).toHaveBeenCalledWith(
        expect.objectContaining({ conversationId: 'c1' }),
      ),
    );

    // The outbound message body and its status label are unique to the thread.
    expect(await screen.findByText('Yes it is available.')).toBeInTheDocument();
    expect(screen.getByText('Sent')).toBeInTheDocument();
  });

  it('shows how warm a lead is in the list, so a hot one is visible without opening it', async () => {
    render(<App />);

    await screen.findAllByText('Riya Sharma');

    expect(screen.getByText('Hot')).toBeInTheDocument();
    // The unscored lead gets no badge at all - an inbox where every row says "low intent" tells
    // the owner nothing.
    expect(screen.queryByText('Low intent')).not.toBeInTheDocument();
  });

  it('never renders a phone field from conversation data', async () => {
    const { container } = render(<App />);
    await screen.findAllByText('Riya Sharma');
    expect(container.innerHTML).not.toMatch(/phone/i);
  });

  it('sends a reply with a generated idempotency key and clears the composer', async () => {
    endpoints.sendMessage.mockResolvedValue({
      data: {
        id: 'm3',
        direction: 'out',
        body: 'On my way',
        status: 'queued',
        sentAt: new Date().toISOString(),
      },
      meta: { queued: true },
    });

    render(<App />);
    const [riyaRow] = await screen.findAllByText('Riya Sharma');
    fireEvent.click(riyaRow);

    const input = await screen.findByLabelText('Message');
    fireEvent.change(input, { target: { value: 'On my way' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(endpoints.sendMessage).toHaveBeenCalledTimes(1));
    const sendArgs = endpoints.sendMessage.mock.calls[0][0];
    expect(sendArgs).toMatchObject({ conversationId: 'c1', body: 'On my way' });
    expect(sendArgs.idempotencyKey).toMatch(/[0-9a-f-]{8,}/i);

    await waitFor(() => expect(input).toHaveValue(''));
  });

  it('turns the AI off for one lead straight from the row', async () => {
    endpoints.setAiAutomation.mockResolvedValue({ data: {} });

    render(<App />);
    await screen.findAllByText('Riya Sharma');

    const toggle = await screen.findByRole('switch', {
      name: 'Turn the AI off for Riya Sharma',
    });
    expect(toggle).toBeChecked();

    fireEvent.click(toggle);

    await waitFor(() =>
      expect(endpoints.setAiAutomation).toHaveBeenCalledWith(
        expect.objectContaining({ conversationId: 'c1', enabled: false }),
      ),
    );
  });

  it('does not open the thread when the switch is clicked', async () => {
    endpoints.setAiAutomation.mockResolvedValue({ data: {} });

    render(<App />);
    await screen.findAllByText('Riya Sharma');

    fireEvent.click(
      await screen.findByRole('switch', { name: 'Turn the AI off for Riya Sharma' }),
    );

    // The row is a button and the switch sits on top of it. Silencing the AI must not also
    // navigate you into the conversation you were trying to silence.
    await waitFor(() => expect(endpoints.setAiAutomation).toHaveBeenCalled());
    expect(endpoints.getConversation).not.toHaveBeenCalled();
  });

  it('puts the switch back when the server refuses', async () => {
    endpoints.setAiAutomation.mockRejectedValue(new Error('nope'));

    render(<App />);
    await screen.findAllByText('Riya Sharma');

    const toggle = await screen.findByRole('switch', {
      name: 'Turn the AI off for Riya Sharma',
    });
    fireEvent.click(toggle);

    // Optimistic while in flight, but the server is the truth: a switch left showing "off" when
    // the AI is still running is the worst possible lie for this particular control.
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.getByRole('switch', { name: 'Turn the AI off for Riya Sharma' }),
      ).toBeChecked(),
    );
  });
});
