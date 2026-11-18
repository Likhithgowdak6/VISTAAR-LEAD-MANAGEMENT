/**
 * What the Cloud API changes about the composer.
 *
 * The behaviour being pinned: on a Cloud number, once the 24-hour service window has closed, free
 * text is refused BEFORE it is sent, with a message that says what to do instead. The alternative
 * - letting it through and surfacing Meta's rejection afterwards - is how an agent ends up
 * believing a lead was answered when they were not.
 *
 * Equally important, and tested just as hard: NONE of this appears on a Baileys number. That
 * provider has no window, and showing it a countdown would be describing a rule it does not have.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import MessageComposer from '../components/MessageComposer';

const CLOUD = {
  id: 'acc-cloud',
  name: 'Official Number',
  brandKey: 'official',
  provider: 'cloud' as const,
};

const BAILEYS = {
  id: 'acc-baileys',
  name: 'Studio Main',
  brandKey: 'studio-main',
  provider: 'baileys' as const,
};

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

const typeAndSend = (text: string) => {
  fireEvent.change(screen.getByLabelText('Message'), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
};

const renderComposer = (props: Record<string, unknown> = {}) => {
  const onSend = vi.fn().mockResolvedValue(undefined);

  render(
    <MessageComposer
      onSend={onSend}
      sendableAccounts={[CLOUD]}
      currentAccountId={CLOUD.id}
      {...props}
    />,
  );

  return { onSend };
};

describe('a Cloud number with the window open', () => {
  it('shows no window notice at all', () => {
    renderComposer({ lastInboundAt: hoursAgo(1) });

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('sends free text normally', async () => {
    const { onSend } = renderComposer({ lastInboundAt: hoursAgo(1) });

    typeAndSend('Yes, the 12th is free.');

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend.mock.calls[0]![0]).toMatchObject({ body: 'Yes, the 12th is free.' });
  });
});

describe('a Cloud number with the window closing', () => {
  it('warns with the time left but still sends', async () => {
    const { onSend } = renderComposer({ lastInboundAt: hoursAgo(23.5) });

    expect(screen.getByRole('status')).toHaveTextContent(/left to reply freely/i);

    typeAndSend('One more thing');

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
  });
});

describe('a Cloud number with the window closed', () => {
  it('explains that only a template will send', () => {
    renderComposer({ lastInboundAt: hoursAgo(30) });

    expect(screen.getByRole('status')).toHaveTextContent(/more than 24 hours/i);
    expect(screen.getByRole('status')).toHaveTextContent(/approved template/i);
  });

  /** THE test. A doomed message must not leave the browser believing it was sent. */
  it('refuses to send free text', async () => {
    const { onSend } = renderComposer({ lastInboundAt: hoursAgo(30) });

    typeAndSend('Are you still interested?');

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(onSend).not.toHaveBeenCalled();
  });

  /** Nothing the agent typed is thrown away by the refusal. */
  it('keeps the typed message in the box', async () => {
    renderComposer({ lastInboundAt: hoursAgo(30) });

    typeAndSend('Are you still interested?');

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByLabelText('Message')).toHaveValue('Are you still interested?');
  });

  it('offers the template picker when one is available', () => {
    const onOpenWhatsAppTemplates = vi.fn();

    renderComposer({ lastInboundAt: hoursAgo(30), onOpenWhatsAppTemplates });

    fireEvent.click(screen.getByRole('button', { name: 'Choose a template' }));

    expect(onOpenWhatsAppTemplates).toHaveBeenCalledTimes(1);
    expect(onOpenWhatsAppTemplates).toHaveBeenCalledWith(CLOUD.id);
  });

  it('still explains the situation when no picker is wired up', () => {
    renderComposer({ lastInboundAt: hoursAgo(30) });

    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Choose a template' })).not.toBeInTheDocument();
  });
});

describe('a Cloud number the lead has never messaged', () => {
  /** The Meta Lead Ads case: a form submission is not a message, so the window never opened. */
  it('says they have never messaged rather than that the window expired', () => {
    renderComposer({ lastInboundAt: null });

    expect(screen.getByRole('status')).toHaveTextContent(/never messaged you/i);
  });

  it('refuses to send free text', async () => {
    const { onSend } = renderComposer({ lastInboundAt: null });

    typeAndSend('Hi, saw your enquiry');

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(onSend).not.toHaveBeenCalled();
  });
});

describe('a Baileys number', () => {
  /** No window exists on Baileys. Showing one would describe a rule that does not apply. */
  it.each([
    ['never messaged', null],
    ['silent for 30 hours', hoursAgo(30)],
  ])('shows no window notice when %s', (_label, lastInboundAt) => {
    render(
      <MessageComposer
        onSend={vi.fn()}
        sendableAccounts={[BAILEYS]}
        currentAccountId={BAILEYS.id}
        lastInboundAt={lastInboundAt}
      />,
    );

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('sends free text after 30 hours of silence', async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);

    render(
      <MessageComposer
        onSend={onSend}
        sendableAccounts={[BAILEYS]}
        currentAccountId={BAILEYS.id}
        lastInboundAt={hoursAgo(30)}
      />,
    );

    typeAndSend('Still interested?');

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
  });
});

describe('switching the send-from number', () => {
  /**
   * The rule follows the number the message would ACTUALLY go out on, not the one the thread
   * started on - so an agent learns about the window before they type, not after it bounces.
   */
  it('applies the Cloud window after switching from Baileys to Cloud', async () => {
    render(
      <MessageComposer
        onSend={vi.fn()}
        sendableAccounts={[BAILEYS, CLOUD]}
        currentAccountId={BAILEYS.id}
        lastInboundAt={hoursAgo(30)}
      />,
    );

    expect(screen.queryByRole('status')).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Send from'), { target: { value: CLOUD.id } });

    await waitFor(() => expect(screen.getByRole('status')).toBeInTheDocument());
  });

  it('drops the Cloud window after switching from Cloud to Baileys', async () => {
    render(
      <MessageComposer
        onSend={vi.fn()}
        sendableAccounts={[BAILEYS, CLOUD]}
        currentAccountId={CLOUD.id}
        lastInboundAt={hoursAgo(30)}
      />,
    );

    expect(screen.getByRole('status')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Send from'), { target: { value: BAILEYS.id } });

    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
  });
});
