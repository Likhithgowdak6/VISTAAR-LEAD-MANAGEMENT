/**
 * The per-thread takeover control.
 *
 * THE CONTROL IS A PROMISE: press it and the bot stops answering this thread. Two ways that
 * promise breaks — showing the button where it cannot work, and showing the wrong state so
 * somebody thinks they have the thread when they do not.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  useAuth: vi.fn(),
  setInstagramTakeover: vi.fn(),
}));

vi.mock('../api/instagram', () => ({ setInstagramTakeover: mocks.setInstagramTakeover }));
vi.mock('../auth/AuthContext', () => ({ useAuth: mocks.useAuth }));

const InstagramTakeover = (await import('../components/InstagramTakeover')).default;

const conversation = (over: Record<string, unknown> = {}) =>
  ({ id: 'conv1', channel: 'instagram', aiAutomationEnabled: true, ...over }) as never;

const asUser = (permissions: string[]) =>
  mocks.useAuth.mockReturnValue({
    permissions,
    authedRequest: (make: (token: string) => unknown) => Promise.resolve(make('t')),
  });

beforeEach(() => {
  vi.clearAllMocks();
  asUser(['messages.send']);
});

describe('where the control appears', () => {
  it('appears on an Instagram thread', () => {
    render(<InstagramTakeover conversation={conversation()} automationAvailable />);

    expect(screen.getByRole('button', { name: 'Take over' })).toBeInTheDocument();
  });

  it('does not appear on a WhatsApp thread', () => {
    // WhatsApp has its own, older handover wiring. Two switches for one idea is worse than one.
    const { container } = render(
      <InstagramTakeover conversation={conversation({ channel: 'whatsapp' })} automationAvailable />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('does not appear on a thread with no channel at all', () => {
    // A conversation written before the field existed. These are all WhatsApp.
    const { container } = render(
      <InstagramTakeover conversation={conversation({ channel: undefined })} automationAvailable />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('does not appear when the workspace has automation switched off', () => {
    // Nothing would ever answer over anybody, so the button would be a lie about the system.
    const { container } = render(
      <InstagramTakeover conversation={conversation()} automationAvailable={false} />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('does not appear for somebody who may not send messages', () => {
    asUser(['conversations.read_all']);

    const { container } = render(
      <InstagramTakeover conversation={conversation()} automationAvailable />,
    );

    expect(container).toBeEmptyDOMElement();
  });
});

describe('the state it shows', () => {
  it('says auto-replies are on when they are', () => {
    render(<InstagramTakeover conversation={conversation()} automationAvailable />);

    expect(screen.getByText('Auto-replies on')).toBeInTheDocument();
  });

  it('says you have the thread once taken over', () => {
    render(
      <InstagramTakeover
        conversation={conversation({ aiAutomationEnabled: false })}
        automationAvailable
      />,
    );

    expect(screen.getByText('You have this thread')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Resume automation' })).toBeInTheDocument();
  });
});

describe('taking over', () => {
  it('pauses automation on this thread', async () => {
    mocks.setInstagramTakeover.mockResolvedValue({
      data: { id: 'conv1', aiAutomationEnabled: false, aiAutomationPausedReason: 'human_takeover' },
    });

    const onChanged = vi.fn();

    render(
      <InstagramTakeover conversation={conversation()} automationAvailable onChanged={onChanged} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Take over' }));

    await waitFor(() =>
      expect(mocks.setInstagramTakeover.mock.calls[0]![0]).toMatchObject({
        conversationId: 'conv1',
        resume: false,
      }),
    );

    // The parent is told what the SERVER decided, not what we assumed.
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(false));
  });

  it('hands it back on resume', async () => {
    mocks.setInstagramTakeover.mockResolvedValue({
      data: { id: 'conv1', aiAutomationEnabled: true, aiAutomationPausedReason: null },
    });

    render(
      <InstagramTakeover
        conversation={conversation({ aiAutomationEnabled: false })}
        automationAvailable
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Resume automation' }));

    await waitFor(() =>
      expect(mocks.setInstagramTakeover.mock.calls[0]![0]).toMatchObject({ resume: true }),
    );
  });

  it('surfaces a failure rather than pretending it worked', async () => {
    // Believing you have a thread you do not is exactly how a customer gets two answers.
    mocks.setInstagramTakeover.mockRejectedValue(new Error('That conversation does not exist here.'));

    render(<InstagramTakeover conversation={conversation()} automationAvailable />);

    fireEvent.click(screen.getByRole('button', { name: 'Take over' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/does not exist here/i);
  });
});
