/**
 * The per-lead follow-up switch.
 *
 * THE DISTINCTION THIS GUARDS. Stopping the chasing must not stop the AI REPLYING - that is the
 * entire reason this control exists rather than reusing the AI assistant toggle beside it. A
 * regression that wired it to `setAiAutomation` would look identical on screen and silence the
 * agent completely, so the test asserts which endpoint is called, not just that something was.
 *
 * The copy is asserted too, because "turning this back on starts the sequence again" is not
 * decoration: an owner who expects the paused messages to arrive at once would be alarmed when
 * they did not, and an owner who expects nothing would be alarmed when they did.
 */
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import NurtureSection from '../components/lead/NurtureSection';
import * as endpointsApi from '../api/endpoints';
import { PERMISSIONS } from '../lib/permissions';
import { AUTH_PAYLOAD, renderAuthed } from './lead-helpers';

// Tests may use `any` for Vitest mocks of untyped endpoint modules.
const endpoints = endpointsApi as any;

vi.mock('../api/endpoints');

const CONVERSATION = '68f1a2b3c4d5e6f708192a3b';

const render = (props: Record<string, unknown> = {}) =>
  renderAuthed(
    <NurtureSection conversationId={CONVERSATION} nurtureEnabled {...props} />,
  );

const signedIn = (permissions: string[] = [PERMISSIONS.AI_AUTOMATION_MANAGE]) =>
  endpoints.refresh.mockResolvedValue(AUTH_PAYLOAD({ role: 'admin', permissions }));

/** Awaited, because the toggle only renders once the auth payload has resolved. */
const toggle = () =>
  screen.findByRole('checkbox', { name: /Chase this lead when they go quiet/ });

beforeEach(() => {
  signedIn();
  endpoints.setNurture.mockResolvedValue({ data: { nurtureEnabled: false } });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('turning chasing off', () => {
  it('CALLS THE NURTURE ENDPOINT, not the AI automation one', async () => {
    // The regression that matters. Wiring this to setAiAutomation would silence replies too.
    render();

    fireEvent.click(await toggle());

    await waitFor(() =>
      expect(endpoints.setNurture).toHaveBeenCalledWith(
        expect.objectContaining({ conversationId: CONVERSATION, enabled: false }),
      ),
    );
    expect(endpoints.setAiAutomation).not.toHaveBeenCalled();
  });

  it('SAYS REPLIES STILL WORK, so nobody reads this as silencing the AI', async () => {
    endpoints.setNurture.mockResolvedValue({ data: { nurtureEnabled: false } });

    render();

    fireEvent.click(await toggle());

    expect(await screen.findByText(/still replies if they message you/)).toBeInTheDocument();
  });

  it('warns that re-enabling restarts rather than catches up', async () => {
    render({ nurtureEnabled: false });

    expect(screen.getByText(/starts the sequence again from two hours/)).toBeInTheDocument();
    expect(screen.getByText(/won’t send the messages it skipped/)).toBeInTheDocument();
  });
});

describe('turning chasing on', () => {
  it('sends enabled: true and reflects the server’s answer', async () => {
    endpoints.setNurture.mockResolvedValue({ data: { nurtureEnabled: true } });

    render({ nurtureEnabled: false });

    fireEvent.click(await toggle());

    await waitFor(() =>
      expect(endpoints.setNurture).toHaveBeenCalledWith(
        expect.objectContaining({ enabled: true }),
      ),
    );
    expect(await screen.findByText(/nudges this lead if they go quiet/)).toBeInTheDocument();
  });
});

describe('leads nobody may chase', () => {
  it('OFFERS NO TOGGLE AT ALL for an opted-out lead', async () => {
    // A switch that cannot change what the system does would be a lie about what it will do.
    render({ optedOutAt: '2026-10-01T00:00:00.000Z' });

    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.getByText(/opted out/)).toBeInTheDocument();
  });

  it('is read-only without the automation permission', async () => {
    signedIn([]);

    render();

    await waitFor(() => expect(screen.queryByRole('checkbox')).not.toBeInTheDocument());
    expect(screen.getByText('On')).toBeInTheDocument();
  });
});

describe('failures', () => {
  it('reports a failed save and leaves the switch where it was', async () => {
    endpoints.setNurture.mockRejectedValue(new Error('Network down'));

    render();

    fireEvent.click(await toggle());

    expect(await screen.findByRole('alert')).toHaveTextContent(/Network down|Unable to change/);
    expect(await toggle()).toBeChecked();
  });
});
