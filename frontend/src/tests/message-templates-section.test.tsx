/**
 * Writing a few versions of an offer and sending one, from the lead panel.
 *
 * THE FAILURE WORTH MOST OF THIS FILE is sending to the wrong person. The owner generates for
 * one lead, clicks another in the inbox, and sends - and a quote meant for a December wedding
 * lands on a stranger who asked about a birthday. That is not recoverable and not detectable
 * afterwards, so the targeting tests outnumber everything else here.
 *
 * The rest is about not making the owner's life worse: a failed generation must not eat the
 * description they just typed, two clicks must not send two messages, and "Send" must not
 * claim delivery it cannot know about.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  generateTemplates: vi.fn(),
  sendMessage: vi.fn(),
  useAuth: vi.fn(),
}));

vi.mock('../api/endpoints', () => ({
  generateTemplates: mocks.generateTemplates,
  sendMessage: mocks.sendMessage,
}));

vi.mock('../auth/AuthContext', () => ({ useAuth: mocks.useAuth }));

const MessageTemplatesSection = (await import('../components/lead/MessageTemplatesSection'))
  .default;

const templates = [
  { title: 'Clean list', body: 'Wedding package — candid, traditional, album.' },
  { title: 'Value-led', body: 'We cover the whole day, candid and traditional, plus an album.' },
  { title: 'Short', body: 'Candid + traditional + album. Want the details?' },
  { title: 'Warm', body: 'Would love to shoot your wedding — here is what we do.' },
];

const renderSection = (conversationId = 'conv-1') =>
  render(
    <MessageTemplatesSection
      conversationId={conversationId}
      aiCategory="wedding"
      aiFacts={{ event_date: '13 Dec 2026', city: 'Bangalore' }}
    />,
  );

/** Types an offer and generates, leaving the options on screen. */
const generate = async (offer = 'Wedding package with candid, traditional and an album') => {
  fireEvent.change(screen.getByLabelText('What would you like to offer?'), {
    target: { value: offer },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Generate templates' }));

  await waitFor(() => expect(mocks.generateTemplates).toHaveBeenCalled());
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.useAuth.mockReturnValue({
    authedRequest: (make: (token: string | null) => Promise<unknown>) => make('token'),
  });
  mocks.generateTemplates.mockResolvedValue({ data: { templates } });
  mocks.sendMessage.mockResolvedValue({ data: { id: 'msg-1' } });
});

describe('generating options', () => {
  it('shows the section in the open lead\'s panel', () => {
    renderSection();

    expect(screen.getByText('Message templates')).toBeInTheDocument();
    expect(screen.getByLabelText('What would you like to offer?')).toBeInTheDocument();
  });

  it('produces four distinct options', async () => {
    renderSection();
    await generate();

    await waitFor(() => expect(screen.getByText(/Option 1/)).toBeInTheDocument());
    expect(screen.getByText(/Option 4/)).toBeInTheDocument();

    // Four presentations of one offer, not four offers - the writer's own framing.
    expect(screen.getByText(/Clean list/)).toBeInTheDocument();
    expect(screen.getByText(/Warm/)).toBeInTheDocument();
  });

  it('sends the lead\'s own service and facts as context', async () => {
    renderSection();
    await generate('Wedding package');

    const [[params]] = mocks.generateTemplates.mock.calls;
    const rawDetails = String((params as { rawDetails: string }).rawDetails);

    // Reuses the existing single free-text field rather than adding a conversationId to the
    // API - the writer is already told to use only what it is given.
    expect(rawDetails).toContain('Wedding package');
    expect(rawDetails).toContain('wedding');
    expect(rawDetails).toContain('13 Dec 2026');
  });

  it('refuses to generate from an empty description', () => {
    renderSection();

    expect(screen.getByRole('button', { name: 'Generate templates' })).toBeDisabled();
  });

  it('shows a loading state while writing', async () => {
    let release: (value: unknown) => void = () => {};
    mocks.generateTemplates.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );

    renderSection();
    await generate();

    expect(screen.getByRole('button', { name: 'Writing…' })).toBeInTheDocument();

    release({ data: { templates } });
  });

  it('KEEPS the typed description when generation fails', async () => {
    mocks.generateTemplates.mockRejectedValue(new Error('ai-brain unavailable'));

    renderSection();
    await generate('Wedding package with an album');

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    // Retyping the offer after a failed call is the most annoying thing this could do.
    expect(screen.getByLabelText('What would you like to offer?')).toHaveValue(
      'Wedding package with an album',
    );
  });

  it('explains it when nothing usable comes back', async () => {
    mocks.generateTemplates.mockResolvedValue({ data: { templates: [] } });

    renderSection();
    await generate();

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
  });
});

describe('editing an option', () => {
  it('edits one option without touching the others', async () => {
    renderSection();
    await generate();
    await waitFor(() => expect(screen.getByText(/Option 1/)).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Option 1 message'), {
      target: { value: 'My own wording' },
    });

    // Collapse option 1, open option 2: its body must be the generated one, untouched.
    fireEvent.click(screen.getByRole('button', { name: /Option 1/ }));
    fireEvent.click(screen.getByRole('button', { name: /Option 2/ }));

    expect(screen.getByText(templates[1]!.body)).toBeInTheDocument();
  });

  it('keeps an edit when the owner switches between options', async () => {
    renderSection();
    await generate();
    await waitFor(() => expect(screen.getByText(/Option 1/)).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Option 1 message'), {
      target: { value: 'My own wording' },
    });

    fireEvent.click(screen.getByRole('button', { name: /Option 2/ }));
    fireEvent.click(screen.getByRole('button', { name: /Option 1/ }));

    expect(screen.getByLabelText('Option 1 message')).toHaveValue('My own wording');
  });

  it('will not send an empty message', async () => {
    renderSection();
    await generate();
    await waitFor(() => expect(screen.getByText(/Option 1/)).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Option 1 message'), { target: { value: '   ' } });

    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });
});

describe('sending goes to the open thread and nowhere else', () => {
  it('sends with the conversation id, not a name', async () => {
    renderSection('conv-42');
    await generate();
    await waitFor(() => expect(screen.getByText(/Option 1/)).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() =>
      expect(mocks.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ conversationId: 'conv-42', body: templates[0]!.body }),
      ),
    );
  });

  it('REFUSES to send a batch written for a different lead', async () => {
    // The component is keyed on the conversation in LeadPanel so this is normally a remount -
    // but the stamp is what makes it safe on any path where it is not.
    const { rerender } = renderSection('conv-A');
    await generate();
    await waitFor(() => expect(screen.getByText(/Option 1/)).toBeInTheDocument());

    rerender(
      <MessageTemplatesSection conversationId="conv-B" aiCategory="wedding" aiFacts={{}} />,
    );

    expect(screen.getByText(/written for a different lead/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });

  it('SYNCHRONOUS rapid clicks produce exactly one request', async () => {
    // FOUND IN A BROWSER, NOT HERE. The original guard checked `sendingIndex` state; three
    // clicks in one task all read the same rendered value because React has not re-rendered
    // between them, and two POSTs went out. `fireEvent.click` hides this - it flushes state
    // between calls - so this dispatches the events directly on the node instead.
    //
    // Only one message was ever created, because the idempotency key collapsed them at the
    // backend. But the second request should not have left the browser.
    let release: (value: unknown) => void = () => {};
    mocks.sendMessage.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );

    renderSection();
    await generate();
    await waitFor(() => expect(screen.getByText(/Option 1/)).toBeInTheDocument());

    const send = screen.getByRole('button', { name: 'Send' });
    const click = () =>
      send.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    click();
    click();
    click();

    expect(mocks.sendMessage).toHaveBeenCalledTimes(1);

    release({ data: { id: 'msg-1' } });
  });

  it('reuses one idempotency key so a double click cannot send twice', async () => {
    let release: (value: unknown) => void = () => {};
    mocks.sendMessage.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );

    renderSection();
    await generate();
    await waitFor(() => expect(screen.getByText(/Option 1/)).toBeInTheDocument());

    const send = screen.getByRole('button', { name: 'Send' });
    fireEvent.click(send);
    fireEvent.click(send);
    fireEvent.click(send);

    // Guarded in the UI by the sending state, and again at the backend by the key.
    expect(mocks.sendMessage).toHaveBeenCalledTimes(1);

    release({ data: { id: 'msg-1' } });
  });

  it('keeps the same key when a failed send is retried', async () => {
    mocks.sendMessage.mockRejectedValueOnce(new Error('network'));

    renderSection();
    await generate();
    await waitFor(() => expect(screen.getByText(/Option 1/)).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(mocks.sendMessage).toHaveBeenCalledTimes(2));

    const [[first], [second]] = mocks.sendMessage.mock.calls;

    // If the first actually landed before the error, the retry must collapse into it rather
    // than producing a second message to the customer.
    expect((first as { idempotencyKey: string }).idempotencyKey).toBe(
      (second as { idempotencyKey: string }).idempotencyKey,
    );
  });

  it('issues a new key once the text is edited', async () => {
    renderSection();
    await generate();
    await waitFor(() => expect(screen.getByText(/Option 1/)).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(mocks.sendMessage).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Option 1 message'), {
      target: { value: 'A different message entirely' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(mocks.sendMessage).toHaveBeenCalledTimes(2));

    const [[first], [second]] = mocks.sendMessage.mock.calls;

    // Different text is a different message. Reusing the key would silently suppress it.
    expect((first as { idempotencyKey: string }).idempotencyKey).not.toBe(
      (second as { idempotencyKey: string }).idempotencyKey,
    );
  });

  it('says QUEUED, not sent', async () => {
    renderSection();
    await generate();
    await waitFor(() => expect(screen.getByText(/Option 1/)).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    // The request was accepted; the outbound runner decides delivery, and quiet hours or a
    // dead socket can still hold it. Claiming "Sent" would assert something this cannot know.
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Queued'));
  });

  it('reports a failed send without pretending otherwise', async () => {
    mocks.sendMessage.mockRejectedValue(new Error('opted out'));

    renderSection();
    await generate();
    await waitFor(() => expect(screen.getByText(/Option 1/)).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    // Opt-out, manual takeover and every other restriction are enforced by the existing
    // endpoint. This surfaces the refusal rather than routing around it.
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
