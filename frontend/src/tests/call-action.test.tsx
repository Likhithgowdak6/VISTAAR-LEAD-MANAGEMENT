/**
 * The Call button, and the honesty of what it records.
 *
 * THE ORDER IS THE BEHAVIOUR. Reveal the number, record that the dialler is opening, THEN open
 * it. Recording afterwards would be a write that may never land: once the system dialler takes
 * the foreground, this WebView can be frozen or killed, and the call would vanish from the
 * lead's history entirely.
 *
 * AND THE RECORD MUST NOT OVERCLAIM. Opening the dialler is not a call. The row says
 * `initiated`, the outcome comes from a human afterwards, and nothing here may imply a customer
 * conversation took place.
 */
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import CallAction from '../components/lead/CallAction';
import * as endpointsApi from '../api/endpoints';
import * as dialerApi from '../lib/native-dialer';
import { PERMISSIONS } from '../lib/permissions';
import { AUTH_PAYLOAD, renderAuthed } from './lead-helpers';

// Tests may use `any` for Vitest mocks of untyped endpoint modules.
const endpoints = endpointsApi as any;

vi.mock('../api/endpoints');

const CONVERSATION_ID = '68f1a2b3c4d5e6f708192a3b';
const CONTACT_ID = '6ab4c2037469f65204cfe333';
const CALL_ID = '6adf2dd59f91cdd63f09e0f3';

const signedIn = (permissions: string[]) =>
  endpoints.refresh.mockResolvedValue(AUTH_PAYLOAD({ role: 'admin', permissions }));

const FULL = [PERMISSIONS.CLIENT_PII_REVEAL, PERMISSIONS.CONVERSATIONS_READ_ALL];

const render = (contactId: string | null = CONTACT_ID) =>
  renderAuthed(<CallAction conversationId={CONVERSATION_ID} contactId={contactId} />);

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('placing a call', () => {
  it('reveals the number, records the call, THEN opens the dialler', async () => {
    signedIn(FULL);
    endpoints.revealPhone.mockResolvedValue({ data: { phone: '+919876543210' } });
    endpoints.startCall.mockResolvedValue({ data: { id: CALL_ID, status: 'initiated' } });
    const open = vi.spyOn(dialerApi, 'openDialler').mockResolvedValue(undefined);

    render();

    fireEvent.click(await screen.findByRole('button', { name: 'Call this lead' }));

    await waitFor(() => expect(open).toHaveBeenCalledWith('+919876543210'));

    // The record must exist before the dialler steals the foreground, or a frozen WebView
    // loses the call entirely.
    const revealOrder = endpoints.revealPhone.mock.invocationCallOrder[0];
    const startOrder = endpoints.startCall.mock.invocationCallOrder[0];
    const openOrder = open.mock.invocationCallOrder[0];

    expect(revealOrder).toBeLessThan(startOrder);
    expect(startOrder).toBeLessThan(openOrder);
  });

  it('NEVER SENDS THE PHONE NUMBER TO OUR OWN API', async () => {
    // The server does not need it and must not store it on a call row: the contact already
    // holds it, encrypted, behind its own permission.
    signedIn(FULL);
    endpoints.revealPhone.mockResolvedValue({ data: { phone: '+919876543210' } });
    endpoints.startCall.mockResolvedValue({ data: { id: CALL_ID } });
    vi.spyOn(dialerApi, 'openDialler').mockResolvedValue(undefined);

    render();

    fireEvent.click(await screen.findByRole('button', { name: 'Call this lead' }));

    await waitFor(() => expect(endpoints.startCall).toHaveBeenCalled());
    expect(JSON.stringify(endpoints.startCall.mock.calls[0]![0])).not.toContain('919876543210');
  });

  it('sends a fresh idempotency key per tap', async () => {
    // A retry on a flaky connection must not litter the timeline with duplicate calls.
    signedIn(FULL);
    endpoints.revealPhone.mockResolvedValue({ data: { phone: '+919876543210' } });
    endpoints.startCall.mockResolvedValue({ data: { id: CALL_ID } });
    vi.spyOn(dialerApi, 'openDialler').mockResolvedValue(undefined);

    render();

    fireEvent.click(await screen.findByRole('button', { name: 'Call this lead' }));

    await waitFor(() => expect(endpoints.startCall).toHaveBeenCalled());
    expect(endpoints.startCall.mock.calls[0]![0].idempotencyKey).toMatch(/^call-/);
  });
});

describe('when there is nothing to dial', () => {
  it('says so when the contact has no number on file', async () => {
    signedIn(FULL);
    endpoints.revealPhone.mockResolvedValue({ data: { phone: null } });
    const open = vi.spyOn(dialerApi, 'openDialler');

    render();

    fireEvent.click(await screen.findByRole('button', { name: 'Call this lead' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('No phone number on file');
    // No call row for a call that cannot happen.
    expect(endpoints.startCall).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it('explains rather than offering a dead button when there is no contact', async () => {
    signedIn(FULL);

    render(null);

    expect(await screen.findByText('No contact on file for this lead.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Call this lead' })).toBeDisabled();
  });

  it('REPORTS AN UNDIALLABLE NUMBER WITHOUT ECHOING IT', async () => {
    signedIn(FULL);
    endpoints.revealPhone.mockResolvedValue({ data: { phone: 'call via reception' } });
    endpoints.startCall.mockResolvedValue({ data: { id: CALL_ID } });

    render();

    fireEvent.click(await screen.findByRole('button', { name: 'Call this lead' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('can’t be dialled');
    expect(alert.textContent).not.toContain('reception');
  });
});

describe('permissions', () => {
  it('RENDERS NOTHING without client_pii.reveal', async () => {
    // Without it the agent cannot see the number at all, so a Call button would be a dead end -
    // and the reveal route would refuse the request anyway.
    signedIn([PERMISSIONS.CONVERSATIONS_READ_ALL]);

    const { container } = render();

    await waitFor(() => expect(endpoints.refresh).toHaveBeenCalled());
    expect(container.querySelector('button')).toBeNull();
    expect(endpoints.revealPhone).not.toHaveBeenCalled();
  });
});
