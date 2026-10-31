/**
 * The call detail screen, and the honesty of its empty states.
 *
 * THE FAILURE THIS FILE GUARDS AGAINST is a screen that looks finished when nothing has
 * happened: a blank "Summary" heading that implies one is coming, a spinner over a call that
 * will never be processed, or an Agent/Customer split drawn over a transcript nobody diarised.
 *
 * So most of these tests assert WORDING. "Not applicable" and "Queued" mean different things -
 * the first is settled, the second is waiting - and a user who cannot tell them apart cannot
 * tell a working system from a stuck one.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
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
    recordingStatus: 'unavailable',
    hasRecording: false,
    transcriptionStatus: 'not_applicable',
    summaryStatus: 'not_applicable',
    ...overrides,
  },
});

const analysis = (data: unknown) => ({ data });

const render = () => renderAuthed(<CallDetailDialog callId={CALL_ID} onClose={() => {}} />);

afterEach(() => {
  vi.clearAllMocks();
});

describe('a call with no recording', () => {
  it('SAYS WHY rather than leaving an empty panel', async () => {
    signedIn();
    endpoints.getCall.mockResolvedValue(call());
    endpoints.getCallAnalysis.mockResolvedValue(analysis(null));

    render();

    expect(await screen.findByText('No recording')).toBeInTheDocument();
    // The explanation matters: an agent who thinks the app should have recorded will report a
    // bug that is not one.
    expect(screen.getByText(/can’t record calls/)).toBeInTheDocument();
  });

  it('calls the transcript NOT APPLICABLE, not pending', async () => {
    // A settled answer. "Queued" over a call with no audio is a job that can never run, and
    // reads as a stuck system.
    signedIn();
    endpoints.getCall.mockResolvedValue(call());
    endpoints.getCallAnalysis.mockResolvedValue(analysis(null));

    render();

    // Two rows say it - the transcript and the summary - and both are correct: with no audio
    // there is nothing to do for either.
    expect(
      (await screen.findAllByText(/Not applicable — there is no recording/)).length,
    ).toBe(2);
  });

  it('offers the upload action with a consent tick', async () => {
    signedIn();
    endpoints.getCall.mockResolvedValue(call());
    endpoints.getCallAnalysis.mockResolvedValue(analysis(null));

    render();

    const consent = await screen.findByLabelText(
      'Confirm everyone on the call was told it was being recorded',
    );
    expect(consent).toBeInTheDocument();
    // The file picker is unusable until consent is given, so the order cannot be reversed.
    expect(screen.getByLabelText('Recording file')).toBeDisabled();

    fireEvent.click(consent);
    expect(screen.getByLabelText('Recording file')).not.toBeDisabled();
  });

  it('does not fetch audio there is none of', async () => {
    signedIn();
    endpoints.getCall.mockResolvedValue(call());
    endpoints.getCallAnalysis.mockResolvedValue(analysis(null));

    render();

    await screen.findByText('No recording');
    expect(endpoints.fetchCallRecording).not.toHaveBeenCalled();
  });
});

describe('a call awaiting a transcription provider', () => {
  it('SAYS NOTHING WILL HAPPEN until one is configured', async () => {
    // The production default. Without this line the call sits on "Queued" forever and looks
    // like a backlog rather than a decision nobody has made yet.
    signedIn();
    endpoints.getCall.mockResolvedValue(
      call({ hasRecording: true, recordingStatus: 'uploaded', transcriptionStatus: 'pending' }),
    );
    endpoints.getCallAnalysis.mockResolvedValue(analysis(null));
    endpoints.fetchCallRecording.mockResolvedValue(new Blob(['x']));

    render();

    expect(
      await screen.findByText(/no transcription service is configured yet/),
    ).toBeInTheDocument();
  });

  it('reports a failed transcription as failed', async () => {
    signedIn();
    endpoints.getCall.mockResolvedValue(
      call({ hasRecording: true, transcriptionStatus: 'failed' }),
    );
    endpoints.getCallAnalysis.mockResolvedValue(analysis(null));
    endpoints.fetchCallRecording.mockResolvedValue(new Blob(['x']));

    render();

    expect(await screen.findByText('Failed')).toBeInTheDocument();
  });
});

describe('a transcribed call', () => {
  const withTranscript = (diarized: boolean, segments: unknown[]) =>
    analysis({
      callId: CALL_ID,
      transcript: {
        segments,
        text: 'x',
        detectedLanguage: diarized ? 'en-IN' : 'kn-IN',
        diarized,
        provider: 'mock',
      },
      summary: null,
      suggestions: [],
    });

  it('shows speaker labels when the provider supplied them', async () => {
    signedIn();
    endpoints.getCall.mockResolvedValue(
      call({ hasRecording: true, transcriptionStatus: 'completed' }),
    );
    endpoints.getCallAnalysis.mockResolvedValue(
      withTranscript(true, [
        { startSeconds: 0, endSeconds: 2, text: 'Hello, this is Vistaar.', speaker: 'agent' },
      ]),
    );
    endpoints.fetchCallRecording.mockResolvedValue(new Blob(['x']));

    render();

    expect(await screen.findByText(/Hello, this is Vistaar./)).toBeInTheDocument();
    expect(screen.getByText(/speakers identified/)).toBeInTheDocument();
  });

  it('SAYS SO when speakers are not identified, rather than guessing', async () => {
    // The expected Kannada outcome. Inventing "Agent:" from turn order would be wrong the
    // moment the customer speaks first.
    signedIn();
    endpoints.getCall.mockResolvedValue(
      call({ hasRecording: true, transcriptionStatus: 'completed' }),
    );
    endpoints.getCallAnalysis.mockResolvedValue(
      withTranscript(false, [{ startSeconds: null, endSeconds: null, text: 'ಒಂದು ನಿಮಿಷ', speaker: null }]),
    );
    endpoints.fetchCallRecording.mockResolvedValue(new Blob(['x']));

    render();

    expect(await screen.findByText(/speakers not identified/)).toBeInTheDocument();
    expect(screen.queryByText(/agent:/i)).toBeNull();
  });
});

describe('the summary', () => {
  const summarised = (summary: Record<string, unknown>) =>
    analysis({
      callId: CALL_ID,
      transcript: { segments: [], text: 'x', detectedLanguage: null, diarized: false, provider: 'mock' },
      summary: {
        overview: 'Vaishu asked about wedding packages.',
        customerRequirements: [],
        budget: null,
        expectedTimeline: null,
        preferences: [],
        questionsAsked: [],
        concerns: [],
        decisions: [],
        nextSteps: [],
        inferences: [],
        lowConfidence: false,
        ...summary,
      },
      suggestions: [],
    });

  const renderSummary = (summary: Record<string, unknown>) => {
    signedIn();
    endpoints.getCall.mockResolvedValue(
      call({ hasRecording: true, transcriptionStatus: 'completed', summaryStatus: 'completed' }),
    );
    endpoints.getCallAnalysis.mockResolvedValue(summarised(summary));
    endpoints.fetchCallRecording.mockResolvedValue(new Blob(['x']));
    render();
  };

  it('says NOT DISCUSSED for budget rather than hiding the field', async () => {
    // The absence is information: it tells the agent price never came up.
    renderSummary({});

    expect(await screen.findByText('Vaishu asked about wedding packages.')).toBeInTheDocument();
    expect(screen.getAllByText('Not discussed').length).toBeGreaterThanOrEqual(2);
  });

  it('KEEPS AI INFERENCE UNDER ITS OWN HEADING', async () => {
    // The whole summary is worthless if a reader cannot tell "she said 2 lakh" from "she seems
    // price-sensitive".
    renderSummary({ inferences: ['Seems price-sensitive'], budget: 'Around 2 lakh' });

    const panel = await screen.findByText(/AI reading — not stated on the call/);
    expect(panel).toBeInTheDocument();
    expect(within(panel.parentElement!).getByText('Seems price-sensitive')).toBeInTheDocument();
    expect(screen.getByText('Around 2 lakh')).toBeInTheDocument();
  });

  it('warns when the model doubted its own reading', async () => {
    renderSummary({ lowConfidence: true });

    expect(await screen.findByText(/may be incomplete/)).toBeInTheDocument();
  });
});

describe('suggestions', () => {
  const withSuggestion = (overrides: Record<string, unknown> = {}) =>
    analysis({
      callId: CALL_ID,
      transcript: { segments: [], text: 'x', detectedLanguage: null, diarized: false, provider: 'mock' },
      summary: null,
      suggestions: [
        {
          commitmentId: 'c0',
          title: 'Send the package PDF',
          evidence: 'send me the packages',
          dueAt: null,
          status: 'suggested',
          taskId: null,
          decidedAt: null,
          ...overrides,
        },
      ],
    });

  const renderSuggestions = (
    overrides: Record<string, unknown> = {},
    permissions: string[] = [PERMISSIONS.CRM_TASKS_MANAGE],
  ) => {
    signedIn(permissions);
    endpoints.getCall.mockResolvedValue(
      call({ hasRecording: true, transcriptionStatus: 'completed', summaryStatus: 'completed' }),
    );
    endpoints.getCallAnalysis.mockResolvedValue(withSuggestion(overrides));
    endpoints.fetchCallRecording.mockResolvedValue(new Blob(['x']));
    render();
  };

  it('SAYS NOTHING IS SCHEDULED until the agent confirms', async () => {
    renderSuggestions();

    expect(await screen.findByText(/Nothing is scheduled until you confirm/)).toBeInTheDocument();
    expect(screen.getByText('Send the package PDF')).toBeInTheDocument();
  });

  it('asks for a date when the call did not give one', async () => {
    renderSuggestions();

    expect(await screen.findByText(/didn’t give a date/)).toBeInTheDocument();
  });

  it('confirms with the date the agent picked', async () => {
    renderSuggestions();
    endpoints.confirmCallSuggestion.mockResolvedValue({ data: { id: 't1' } });

    const field = await screen.findByLabelText('Due time for Send the package PDF');
    fireEvent.change(field, { target: { value: '2026-11-06T10:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add task' }));

    await waitFor(() =>
      expect(endpoints.confirmCallSuggestion).toHaveBeenCalledWith(
        expect.objectContaining({ callId: CALL_ID, commitmentId: 'c0' }),
      ),
    );
    expect(endpoints.confirmCallSuggestion.mock.calls[0]![0].dueAt).toBeTruthy();
  });

  it('DISMISSES WITHOUT CREATING ANYTHING', async () => {
    renderSuggestions();
    endpoints.dismissCallSuggestion.mockResolvedValue({ data: {} });

    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss' }));

    await waitFor(() => expect(endpoints.dismissCallSuggestion).toHaveBeenCalled());
    expect(endpoints.confirmCallSuggestion).not.toHaveBeenCalled();
  });

  it('shows a decided suggestion as decided, with no buttons', async () => {
    renderSuggestions({ status: 'confirmed', taskId: 't1' });

    expect(await screen.findByText('Added to tasks')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add task' })).toBeNull();
  });

  it('OFFERS NO CONFIRM without crm.tasks.manage', async () => {
    // Confirming creates a reminder; reading a lead and scheduling work on it are different
    // privileges, and the server enforces the same split.
    renderSuggestions({}, [PERMISSIONS.CONVERSATIONS_READ_ALL]);

    expect(await screen.findByText(/don’t have permission to add tasks/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add task' })).toBeNull();
  });
});

describe('failures', () => {
  it('reports a call that could not be loaded', async () => {
    signedIn();
    endpoints.getCall.mockRejectedValue(new Error('Call not found.'));
    endpoints.getCallAnalysis.mockResolvedValue(analysis(null));

    render();

    expect(await screen.findByRole('alert')).toHaveTextContent('Call not found.');
  });

  it('still shows the call when the ANALYSIS fetch fails', async () => {
    // A missing analysis is the normal case; an error fetching it must not hide the call's
    // own metadata, which is the part that always exists.
    signedIn();
    endpoints.getCall.mockResolvedValue(call());
    endpoints.getCallAnalysis.mockRejectedValue(new Error('boom'));

    render();

    expect(await screen.findByText('Spoke to the lead')).toBeInTheDocument();
  });

  it('reports audio that could not be fetched', async () => {
    signedIn();
    endpoints.getCall.mockResolvedValue(call({ hasRecording: true }));
    endpoints.getCallAnalysis.mockResolvedValue(analysis(null));
    endpoints.fetchCallRecording.mockRejectedValue(new Error('Network down'));

    render();

    expect(await screen.findByText('Network down')).toBeInTheDocument();
  });
});
