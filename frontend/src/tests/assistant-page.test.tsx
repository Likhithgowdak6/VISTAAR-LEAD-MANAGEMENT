/**
 * The assistant screen.
 *
 * ----------------------------------------------------------------------------------------------
 * WHAT A UI TEST CAN ACTUALLY DEFEND HERE
 * ----------------------------------------------------------------------------------------------
 * Not answer quality — that is the model's, and no assertion here can speak to it. What this
 * file defends is everything around the answer, which is where a correct backend can still be
 * made to mislead:
 *
 * - **Scope honesty.** A staff member sees only their assigned leads. If the screen does not say
 *   so, "4 hot leads" reads as the whole pipeline, and the person acts on a number that is true
 *   but not the one they think they are reading.
 * - **Read-only honesty.** A premium assistant UI invites "message her back". The screen must
 *   never imply it can act, and the claim must come from the API rather than a local constant
 *   that would keep saying read-only after it stopped being true.
 * - **Not losing what somebody typed.** A question cleared from the box and then lost to a failed
 *   request is the fastest way to make a feature untrusted.
 * - **Context continuity.** The second question must carry the thread id, or every follow-up
 *   silently starts a new conversation and "why is that one hot?" has nothing to resolve.
 */
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as endpointsApi from '../api/endpoints';
import { PERMISSIONS } from '../lib/permissions';
import AssistantPage from '../pages/AssistantPage';
import { AUTH_PAYLOAD, renderAuthed } from './lead-helpers';

const endpoints = endpointsApi as any;

vi.mock('../api/endpoints');

const CAPABILITIES = {
  tools: [
    { name: 'search_leads', description: 'Find leads.' },
    { name: 'get_lead_intelligence', description: 'Explain a score.' },
  ],
  maxSteps: 6,
  readOnly: true,
};

const answer = (over: Record<string, unknown> = {}) => ({
  data: {
    threadId: 'thread-1',
    answer: 'Four leads are hot.',
    steps: [{ tool: 'search_leads', ok: true, resultSummary: '4 result(s)' }],
    stoppedEarly: false,
    usedHistory: false,
    ...over,
  },
});

beforeEach(() => {
  endpoints.getAssistantCapabilities.mockResolvedValue({ data: CAPABILITIES });
  endpoints.listAssistantThreads.mockResolvedValue({ data: [] });
  endpoints.askAssistant.mockResolvedValue(answer());
});

afterEach(() => {
  vi.clearAllMocks();
});

const asAdmin = () =>
  endpoints.refresh.mockResolvedValue(
    AUTH_PAYLOAD({ role: 'admin', permissions: [PERMISSIONS.CONVERSATIONS_READ_ALL] }),
  );

const asStaff = () =>
  endpoints.refresh.mockResolvedValue(
    AUTH_PAYLOAD({ role: 'staff', permissions: ['conversations.read_assigned'] }),
  );

const ask = async (text: string) => {
  const box = await screen.findByLabelText('Ask the assistant');

  fireEvent.change(box, { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: 'Send question' }));
};

describe('AssistantPage', () => {
  describe('scope honesty', () => {
    it('TELLS A STAFF MEMBER THE ANSWERS COVER ONLY THEIR OWN LEADS', async () => {
      // The whole point: the count is correct but partial, and silence would let it be read as
      // organisation-wide.
      asStaff();
      renderAuthed(<AssistantPage />);

      expect(
        await screen.findByText(/limited to the leads assigned to you/i),
      ).toBeInTheDocument();
    });

    it('tells an admin the answers cover the organisation', async () => {
      asAdmin();
      renderAuthed(<AssistantPage />);

      expect(
        await screen.findByText(/across the whole organisation/i),
      ).toBeInTheDocument();
    });
  });

  describe('read-only honesty', () => {
    it('SHOWS THE READ-ONLY STATE FROM THE API', async () => {
      asAdmin();
      renderAuthed(<AssistantPage />);

      expect(await screen.findByText('Read-only')).toBeInTheDocument();
    });

    it('does not claim read-only when the API does not say so', async () => {
      // A hardcoded badge would keep reassuring the user after the backend changed. This is
      // what makes the claim mean something.
      asAdmin();
      endpoints.getAssistantCapabilities.mockResolvedValue({
        data: { ...CAPABILITIES, readOnly: false },
      });

      renderAuthed(<AssistantPage />);
      await screen.findByText('Assistant');

      expect(screen.queryByText('Read-only')).not.toBeInTheDocument();
    });

    it('repeats that it cannot message anyone next to the composer', async () => {
      asAdmin();
      renderAuthed(<AssistantPage />);

      expect(await screen.findByText(/it cannot message anyone/i)).toBeInTheDocument();
    });
  });

  describe('asking', () => {
    it('shows the answer', async () => {
      asAdmin();
      renderAuthed(<AssistantPage />);
      await ask('how many hot leads?');

      expect(await screen.findByText('Four leads are hot.')).toBeInTheDocument();
    });

    it('shows the question immediately rather than after the answer', async () => {
      asAdmin();
      endpoints.askAssistant.mockImplementation(() => new Promise(() => {}));

      renderAuthed(<AssistantPage />);
      await ask('how many hot leads?');

      expect(await screen.findByText('how many hot leads?')).toBeInTheDocument();
      expect(screen.getByRole('status')).toHaveTextContent(/looking through your crm/i);
    });

    it('A FAILED QUESTION IS PUT BACK IN THE BOX', async () => {
      // Clearing the composer and then losing the text to a network error is the single
      // fastest way to make somebody stop trusting a feature.
      asAdmin();
      endpoints.askAssistant.mockRejectedValue(new Error('Network unreachable'));

      renderAuthed(<AssistantPage />);
      await ask('what happened to Ananya?');

      expect(await screen.findByRole('alert')).toHaveTextContent('Network unreachable');
      await waitFor(() =>
        expect(screen.getByLabelText('Ask the assistant')).toHaveValue(
          'what happened to Ananya?',
        ),
      );
    });

    it('removes the orphaned question when the request fails', async () => {
      // Otherwise a question sits in the transcript with no answer under it, looking like the
      // assistant ignored it.
      asAdmin();
      endpoints.askAssistant.mockRejectedValue(new Error('nope'));

      renderAuthed(<AssistantPage />);
      await ask('orphan question');

      await screen.findByRole('alert');

      expect(screen.queryByTestId('assistant-question')).not.toBeInTheDocument();
    });

    it('does not send an empty question', async () => {
      asAdmin();
      renderAuthed(<AssistantPage />);
      await screen.findByLabelText('Ask the assistant');

      fireEvent.click(screen.getByRole('button', { name: 'Send question' }));

      expect(endpoints.askAssistant).not.toHaveBeenCalled();
    });

    it('sends on Enter but not on Shift+Enter', async () => {
      asAdmin();
      renderAuthed(<AssistantPage />);

      const box = await screen.findByLabelText('Ask the assistant');

      fireEvent.change(box, { target: { value: 'first' } });
      fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });

      expect(endpoints.askAssistant).not.toHaveBeenCalled();

      fireEvent.keyDown(box, { key: 'Enter' });

      await waitFor(() => expect(endpoints.askAssistant).toHaveBeenCalledTimes(1));
    });
  });

  describe('conversation context', () => {
    it('THE FOLLOW-UP CARRIES THE THREAD ID', async () => {
      // Without this every follow-up silently starts a new conversation, and "why is that one
      // hot?" has nothing to resolve "that one" against.
      asAdmin();
      renderAuthed(<AssistantPage />);

      await ask('which lead is hottest?');
      await screen.findByText('Four leads are hot.');

      endpoints.askAssistant.mockResolvedValue(
        answer({ answer: 'Because she gave a date.' }),
      );
      await ask('why?');

      await waitFor(() => expect(endpoints.askAssistant).toHaveBeenCalledTimes(2));

      expect(endpoints.askAssistant.mock.calls[0][0].threadId).toBeNull();
      expect(endpoints.askAssistant.mock.calls[1][0].threadId).toBe('thread-1');
    });

    it('starting a new conversation drops the thread', async () => {
      asAdmin();
      renderAuthed(<AssistantPage />);

      await ask('first question');
      await screen.findByText('Four leads are hot.');

      fireEvent.click(screen.getByRole('button', { name: 'New conversation' }));
      await ask('unrelated question');

      await waitFor(() => expect(endpoints.askAssistant).toHaveBeenCalledTimes(2));

      expect(endpoints.askAssistant.mock.calls[1][0].threadId).toBeNull();
    });

    it('opening a past thread loads its transcript', async () => {
      asAdmin();
      endpoints.listAssistantThreads.mockResolvedValue({
        data: [
          {
            id: 'thread-9',
            title: 'Pipeline questions',
            createdAt: null,
            updatedAt: null,
            messageCount: 2,
          },
        ],
      });
      endpoints.getAssistantThread.mockResolvedValue({
        data: {
          id: 'thread-9',
          title: 'Pipeline questions',
          createdAt: null,
          updatedAt: null,
          messageCount: 2,
          turns: [
            { role: 'user', content: 'who went quiet?' },
            { role: 'assistant', content: 'Three leads.' },
          ],
        },
      });

      renderAuthed(<AssistantPage />);

      fireEvent.click(await screen.findByRole('button', { name: 'Pipeline questions' }));

      expect(await screen.findByText('Three leads.')).toBeInTheDocument();
      expect(screen.getByText('who went quiet?')).toBeInTheDocument();
    });
  });

  describe('showing its work', () => {
    it('reports how many lookups it made', async () => {
      asAdmin();
      renderAuthed(<AssistantPage />);
      await ask('how many hot leads?');

      expect(await screen.findByText('1 lookup')).toBeInTheDocument();
    });

    it('A REFUSED LOOKUP IS SURFACED, NOT HIDDEN', async () => {
      // "You do not have access to this conversation" explains an incomplete answer that would
      // otherwise look like the assistant simply missing something.
      asAdmin();
      endpoints.askAssistant.mockResolvedValue(
        answer({
          answer: 'That lead is not assigned to you.',
          steps: [
            {
              tool: 'get_lead_detail',
              ok: false,
              error: 'You do not have access to this conversation.',
            },
          ],
        }),
      );

      renderAuthed(<AssistantPage />);
      await ask('tell me about Rahul');

      fireEvent.click(await screen.findByRole('button', { name: /1 lookup/ }));

      expect(
        screen.getByText(/You do not have access to this conversation/),
      ).toBeInTheDocument();
    });

    it('warns when the answer stopped at the step limit', async () => {
      asAdmin();
      endpoints.askAssistant.mockResolvedValue(answer({ stoppedEarly: true }));

      renderAuthed(<AssistantPage />);
      await ask('something enormous');

      expect(await screen.findByText(/may be incomplete/i)).toBeInTheDocument();
    });

    it('the trace is collapsed until asked for', async () => {
      // It is provenance, not the answer. Expanded by default it would bury the thing the
      // person actually asked for.
      asAdmin();
      renderAuthed(<AssistantPage />);
      await ask('how many hot leads?');

      await screen.findByText('Four leads are hot.');

      expect(screen.getByRole('button', { name: /1 lookup/ })).toHaveAttribute(
        'aria-expanded',
        'false',
      );
    });
  });

  describe('resilience', () => {
    it('STILL WORKS WHEN THE CAPABILITIES CALL FAILS', async () => {
      // The badge is a nicety. Blocking the whole screen because a secondary request failed
      // would turn a cosmetic problem into an outage.
      asAdmin();
      endpoints.getAssistantCapabilities.mockRejectedValue(new Error('down'));

      renderAuthed(<AssistantPage />);
      await ask('how many hot leads?');

      expect(await screen.findByText('Four leads are hot.')).toBeInTheDocument();
    });

    it('still works when the thread list fails to load', async () => {
      asAdmin();
      endpoints.listAssistantThreads.mockRejectedValue(new Error('down'));

      renderAuthed(<AssistantPage />);
      await ask('how many hot leads?');

      expect(await screen.findByText('Four leads are hot.')).toBeInTheDocument();
    });

    it('offers starting points on an empty screen', async () => {
      asAdmin();
      renderAuthed(<AssistantPage />);

      expect(
        await screen.findByRole('button', { name: 'Which leads need attention today?' }),
      ).toBeInTheDocument();
    });

    it('a suggestion asks the question directly', async () => {
      asAdmin();
      renderAuthed(<AssistantPage />);

      fireEvent.click(
        await screen.findByRole('button', { name: 'Who has gone quiet this week?' }),
      );

      await waitFor(() =>
        expect(endpoints.askAssistant).toHaveBeenCalledWith(
          expect.objectContaining({ question: 'Who has gone quiet this week?' }),
        ),
      );
    });
  });
});
