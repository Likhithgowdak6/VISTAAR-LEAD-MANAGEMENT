/**
 * The call outcome sheet, and the decision it refuses to make for you.
 *
 * THE BEHAVIOUR WORTH PROTECTING is that the AI question is asked HERE, at the moment the owner
 * knows how the call went, and that it has no default. Both defaults are wrong: yes messages a
 * customer the owner may have just promised to handle personally, no silently strands a lead
 * nobody is talking to. So Save stays disabled until it is answered, and the server refuses the
 * request too.
 *
 * The other half is that "resume AI" is not one thing. After a booking it must mean
 * post-booking messages and never another sales pitch, and the screen has to say so - an owner
 * who cannot tell those apart will eventually let the selling agent loose on somebody who has
 * already paid.
 */
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import CallOutcomeDialog from '../components/calls/CallOutcomeDialog';
import * as endpointsApi from '../api/endpoints';
import { PERMISSIONS } from '../lib/permissions';
import { AUTH_PAYLOAD, renderAuthed } from './lead-helpers';

// Tests may use `any` for Vitest mocks of untyped endpoint modules.
const endpoints = endpointsApi as any;

vi.mock('../api/endpoints');

const CONVERSATION = '68f1a2b3c4d5e6f708192a3b';
const TASK = '6adf2dd59f91cdd63f09e0f4';

const render = (props: Record<string, unknown> = {}) =>
  renderAuthed(
    <CallOutcomeDialog
      conversationId={CONVERSATION}
      onClose={vi.fn()}
      onRecorded={vi.fn()}
      {...props}
    />,
  );

const pick = (label: RegExp) => fireEvent.click(screen.getByRole('radio', { name: label }));

beforeEach(() => {
  endpoints.refresh.mockResolvedValue(
    AUTH_PAYLOAD({ role: 'admin', permissions: [PERMISSIONS.CRM_TASKS_MANAGE] }),
  );
  endpoints.recordConversationCallOutcome.mockResolvedValue({ data: {} });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('the AI decision', () => {
  it('REFUSES TO SAVE until the owner answers it', async () => {
    render();

    pick(/customer answered/);

    expect(await screen.findByRole('button', { name: /Save outcome/ })).toBeDisabled();
  });

  it('enables saving once answered', async () => {
    render();

    pick(/customer answered/);
    pick(/^Yes$/);

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Save outcome/ })).not.toBeDisabled(),
    );
  });

  it('sends the decision to the server', async () => {
    render();

    pick(/customer answered/);
    pick(/^Yes$/);
    fireEvent.click(screen.getByRole('button', { name: /Save outcome/ }));

    await waitFor(() =>
      expect(endpoints.recordConversationCallOutcome).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'contacted', resumeAi: true }),
      ),
    );
  });

  it('EXPLAINS THAT A BOOKING RESUMES POST-BOOKING, NOT SELLING', async () => {
    // The owner has to be able to tell this apart from an ordinary resume.
    render();

    pick(/Booking confirmed/);
    pick(/^Yes$/);

    expect(await screen.findByText(/post-booking messages only/)).toBeInTheDocument();
    expect(screen.getByText(/will not try to sell anything else/)).toBeInTheDocument();
  });

  it('DOES NOT OFFER THE QUESTION for a lead who said no', async () => {
    render();

    pick(/Not interested/);

    expect(screen.queryByRole('radio', { name: /^Yes$/ })).not.toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Save outcome/ })).not.toBeDisabled(),
    );
  });

  it('CLEARS A PREVIOUS ANSWER when the outcome changes', async () => {
    // "Booking confirmed, yes" corrected to "not interested" must not leave a yes behind it.
    render();

    pick(/Booking confirmed/);
    pick(/^Yes$/);
    pick(/Interested — decision pending/);

    expect(screen.getByRole('radio', { name: /^Yes$/ })).not.toBeChecked();
    expect(screen.getByRole('button', { name: /Save outcome/ })).toBeDisabled();
  });
});

describe('a callback', () => {
  it('asks for a time and will not save without one', async () => {
    render();

    pick(/Call not received/);
    pick(/^No$/);

    expect(await screen.findByLabelText(/When should we try again/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Save outcome/ })).toBeDisabled();
  });

  it('SAYS THE EXISTING REMINDER MOVES, so nobody expects two', async () => {
    render();

    pick(/asked to call later/);

    expect(await screen.findByText(/Moves the existing reminder/)).toBeInTheDocument();
  });

  it('sends the callback time and the reminder it came from', async () => {
    render({ reminderTaskId: TASK });

    pick(/Call not received/);
    pick(/^No$/);
    fireEvent.change(screen.getByLabelText(/When should we try again/), {
      target: { value: '2026-11-05T16:30' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Save outcome/ }));

    await waitFor(() =>
      expect(endpoints.recordConversationCallOutcome).toHaveBeenCalledWith(
        expect.objectContaining({
          outcome: 'not_received',
          resumeAi: false,
          reminderTaskId: TASK,
          callbackAt: expect.stringContaining('2026-11-05'),
        }),
      ),
    );
  });

  it('does not ask for a time on an outcome that needs none', async () => {
    render();

    pick(/Booking confirmed/);

    expect(screen.queryByLabelText(/When should we try again/)).not.toBeInTheDocument();
  });
});

describe('failures', () => {
  it('reports a save that did not work, and stays open', async () => {
    endpoints.recordConversationCallOutcome.mockRejectedValue(new Error('Network down'));

    render();

    pick(/customer answered/);
    pick(/^No$/);
    fireEvent.click(screen.getByRole('button', { name: /Save outcome/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/Network down|Unable to save/);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});
