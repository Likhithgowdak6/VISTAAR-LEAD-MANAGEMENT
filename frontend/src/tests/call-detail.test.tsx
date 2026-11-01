/**
 * The call detail screen, and the honesty of what it reports.
 *
 * THE FAILURE THIS FILE GUARDS AGAINST is the screen asserting something Vistaar does not know.
 * The app opens the phone's dialler and Android tells it nothing afterwards, so the ONLY
 * observed fact here is the moment the dialler opened - everything else is a human's account,
 * and the screen has to be readable as such. A length rendered on a call nobody said connected,
 * or an outcome shown as a raw status string, is the app inventing a fact about a customer
 * conversation.
 */
import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import CallDetailDialog from '../components/calls/CallDetailDialog';
import * as endpointsApi from '../api/endpoints';
import { PERMISSIONS } from '../lib/permissions';
import { AUTH_PAYLOAD, renderAuthed } from './lead-helpers';

// Tests may use `any` for Vitest mocks of untyped endpoint modules.
const endpoints = endpointsApi as any;

vi.mock('../api/endpoints');

const CALL_ID = '6adf2dd59f91cdd63f09e0f3';

const signedIn = (permissions: string[] = [PERMISSIONS.CRM_TASKS_MANAGE]) =>
  endpoints.refresh.mockResolvedValue(AUTH_PAYLOAD({ role: 'admin', permissions }));

const call = (overrides: Record<string, unknown> = {}) => ({
  data: {
    id: CALL_ID,
    conversationId: '68f1a2b3c4d5e6f708192a3b',
    direction: 'outbound',
    status: 'completed',
    startedAt: new Date('2026-10-30T09:00:00.000Z').toISOString(),
    durationSeconds: 300,
    ...overrides,
  },
});

const render = () => renderAuthed(<CallDetailDialog callId={CALL_ID} onClose={() => {}} />);

afterEach(() => {
  vi.clearAllMocks();
});

describe('reporting what happened on a call', () => {
  it('renders the outcome in plain words, never the stored status', async () => {
    signedIn();
    endpoints.getCall.mockResolvedValue(call());

    render();

    expect(await screen.findByText('Spoke to the lead')).toBeInTheDocument();
    expect(screen.queryByText('completed')).not.toBeInTheDocument();
  });

  it('ATTRIBUTES THE LENGTH TO THE AGENT rather than presenting it as measured', async () => {
    // The duration is an answer somebody typed, not something the app timed. Rendering it as a
    // bare number would turn a human's estimate into a system measurement.
    signedIn();
    endpoints.getCall.mockResolvedValue(call());

    render();

    expect(await screen.findByText(/5 min 0s/)).toBeInTheDocument();
    expect(screen.getByText(/as reported by the agent/)).toBeInTheDocument();
  });

  it('SHOWS NO LENGTH for a call nobody said connected', async () => {
    // A duration beside "No answer" is a contradiction, and the server already refuses to store
    // one. The screen must not resurrect it from a stale field either.
    signedIn();
    endpoints.getCall.mockResolvedValue(call({ status: 'failed', durationSeconds: null }));

    render();

    expect(await screen.findByText('No answer')).toBeInTheDocument();
    expect(screen.queryByText(/as reported by the agent/)).not.toBeInTheDocument();
  });

  it('says the dialler was opened, NOT that a call was made', async () => {
    // `initiated` is the one thing the app actually witnessed. Wording it as "Called" would
    // claim a customer conversation took place when it may well not have.
    signedIn();
    endpoints.getCall.mockResolvedValue(call({ status: 'initiated', durationSeconds: null }));

    render();

    expect(await screen.findByText('Dialler opened')).toBeInTheDocument();
  });

  it('distinguishes an outgoing call from an incoming one', async () => {
    signedIn();
    endpoints.getCall.mockResolvedValue(call({ direction: 'inbound' }));

    render();

    expect(await screen.findByText('Incoming')).toBeInTheDocument();
  });
});

describe('failures', () => {
  it('reports a call it could not load, instead of an empty dialog', async () => {
    signedIn();
    endpoints.getCall.mockRejectedValue(new Error('Network down'));

    render();

    expect(await screen.findByRole('alert')).toHaveTextContent(/Network down|Unable to load/);
  });

  it('explains a call that is no longer there', async () => {
    signedIn();
    endpoints.getCall.mockResolvedValue({ data: null });

    render();

    expect(await screen.findByText(/no longer here/)).toBeInTheDocument();
  });
});
