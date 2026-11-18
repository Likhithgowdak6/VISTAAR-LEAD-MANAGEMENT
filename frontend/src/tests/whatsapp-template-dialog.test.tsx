/**
 * Choosing an approved template and filling its blanks.
 *
 * The properties worth holding here are about what the agent CANNOT do, because this is the only
 * message in the product whose wording they did not write:
 *
 *   - the approved text is not editable, because Meta performs the substitution and an edit box
 *     would promise something that cannot happen;
 *   - every blank must be filled, because Meta refuses a mismatch and the agent would see a
 *     bounced message rather than a form error;
 *   - only APPROVED templates are fetched, because a pending one cannot be delivered.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const listAccountTemplates = vi.fn();

vi.mock('../api/endpoints', () => ({
  listAccountTemplates: (...args: unknown[]) => listAccountTemplates(...args),
}));

/**
 * `authedRequest` must be STABLE across renders, exactly as the real AuthContext's is. A fresh
 * function identity each render would re-run the dialog's load effect on every state change,
 * which clears the error banner the moment it is set - a test artifact that looks exactly like a
 * component bug.
 */
const authedRequest = (make: (token: string) => unknown) => Promise.resolve(make('test-token'));

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ authedRequest }),
}));

vi.mock('../hooks/useMobileBackLayer', () => ({
  useMobileBackLayer: () => undefined,
}));

const WhatsAppTemplateDialog = (await import('../components/WhatsAppTemplateDialog')).default;

const template = (overrides: Record<string, unknown> = {}) => ({
  id: 'tpl-1',
  whatsappAccountId: 'acc-cloud',
  name: 'booking_hold',
  language: 'en_US',
  status: 'APPROVED',
  category: 'UTILITY',
  bodyText: 'Hi {{1}}, we are holding {{2}} for you.',
  headerText: null,
  footerText: 'Reply STOP to opt out',
  bodyVariableCount: 2,
  headerVariableCount: 0,
  syncedAt: '2026-08-25T10:00:00.000Z',
  ...overrides,
});

const renderDialog = (templates: unknown[] = [template()], onSend = vi.fn()) => {
  listAccountTemplates.mockResolvedValue({ data: templates });

  render(
    <WhatsAppTemplateDialog accountId="acc-cloud" onClose={vi.fn()} onSend={onSend} />,
  );

  return { onSend };
};

const chooseFirst = async () => {
  await waitFor(() => expect(screen.getByText('booking_hold')).toBeInTheDocument());
  fireEvent.click(screen.getByText('booking_hold'));
};

beforeEach(() => {
  listAccountTemplates.mockReset();
});

describe('loading', () => {
  /** A pending template cannot be delivered; offering one would waste the only opening move. */
  it('asks the API for approved templates only', async () => {
    renderDialog();

    await waitFor(() =>
      expect(listAccountTemplates).toHaveBeenCalledWith(
        expect.objectContaining({ accountId: 'acc-cloud', approvedOnly: true }),
      ),
    );
  });

  it('points at the Sync button when there are none', async () => {
    renderDialog([]);

    await waitFor(() =>
      expect(screen.getByText(/No supported approved text templates on this number yet/i)).toBeInTheDocument(),
    );

    expect(screen.getByText(/Sync templates/i)).toBeInTheDocument();
  });

  it('reports a failure instead of showing an empty list', async () => {
    listAccountTemplates.mockRejectedValue(new Error('network down'));

    render(<WhatsAppTemplateDialog accountId="acc-cloud" onClose={vi.fn()} onSend={vi.fn()} />);

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
  });
});

describe('filling a template', () => {
  it('shows one input per declared placeholder', async () => {
    renderDialog();
    await chooseFirst();

    expect(screen.getByLabelText('Message value 1')).toBeInTheDocument();
    expect(screen.getByLabelText('Message value 2')).toBeInTheDocument();
    expect(screen.queryByLabelText('Message value 3')).not.toBeInTheDocument();
  });

  it('adds header inputs only when the template has a text header', async () => {
    renderDialog([template({ headerText: '{{1}} Events', headerVariableCount: 1 })]);
    await chooseFirst();

    expect(screen.getByLabelText('Header value 1')).toBeInTheDocument();
  });

  /** The approved wording is Meta's. An edit box would promise something that cannot happen. */
  it('does not offer a way to edit the wording', async () => {
    renderDialog();
    await chooseFirst();

    expect(screen.queryByRole('textbox', { name: /wording|body text/i })).not.toBeInTheDocument();
    expect(screen.getByText(/cannot be edited here/i)).toBeInTheDocument();
  });

  it('previews the message as the customer will receive it', async () => {
    renderDialog();
    await chooseFirst();

    fireEvent.change(screen.getByLabelText('Message value 1'), { target: { value: 'Riya' } });
    fireEvent.change(screen.getByLabelText('Message value 2'), { target: { value: '12 Dec' } });

    expect(screen.getByText('Hi Riya, we are holding 12 Dec for you.')).toBeInTheDocument();
  });

  /** A blank left visible is a blank the agent can see. Erasing it would hide the omission. */
  it('leaves an unfilled placeholder visible in the preview', async () => {
    renderDialog();
    await chooseFirst();

    fireEvent.change(screen.getByLabelText('Message value 1'), { target: { value: 'Riya' } });

    expect(screen.getByText('Hi Riya, we are holding {{2}} for you.')).toBeInTheDocument();
  });
});

describe('sending', () => {
  it('will not send until every blank is filled', async () => {
    const { onSend } = renderDialog();
    await chooseFirst();

    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Message value 1'), { target: { value: 'Riya' } });
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Message value 2'), { target: { value: '12 Dec' } });
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();

    expect(onSend).not.toHaveBeenCalled();
  });

  /** Whitespace is not a value: Meta would substitute it and the customer reads "Hi ,". */
  it('treats a whitespace-only value as unfilled', async () => {
    renderDialog();
    await chooseFirst();

    fireEvent.change(screen.getByLabelText('Message value 1'), { target: { value: '   ' } });
    fireEvent.change(screen.getByLabelText('Message value 2'), { target: { value: '12 Dec' } });

    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  /** The name and the values travel; the wording does not. */
  it('sends the template name, language and trimmed values', async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);

    renderDialog([template()], onSend);
    await chooseFirst();

    fireEvent.change(screen.getByLabelText('Message value 1'), { target: { value: ' Riya ' } });
    fireEvent.change(screen.getByLabelText('Message value 2'), { target: { value: '12 Dec' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() =>
      expect(onSend).toHaveBeenCalledWith({
        name: 'booking_hold',
        language: 'en_US',
        bodyParameters: ['Riya', '12 Dec'],
        headerParameters: [],
      }),
    );
  });

  it('surfaces a send failure and stays open so the agent can retry', async () => {
    const onSend = vi.fn().mockRejectedValue(new Error('WhatsApp refused this template.'));

    renderDialog([template()], onSend);
    await chooseFirst();

    fireEvent.change(screen.getByLabelText('Message value 1'), { target: { value: 'Riya' } });
    fireEvent.change(screen.getByLabelText('Message value 2'), { target: { value: '12 Dec' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument();
  });

  /** Switching template must not carry the previous one's values into a different sentence. */
  it('clears the filled values when a different template is chosen', async () => {
    renderDialog([template(), template({ id: 'tpl-2', name: 'followup', bodyVariableCount: 1 })]);
    await chooseFirst();

    fireEvent.change(screen.getByLabelText('Message value 1'), { target: { value: 'Riya' } });
    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    fireEvent.click(screen.getByText('followup'));

    expect(screen.getByLabelText('Message value 1')).toHaveValue('');
  });
});
