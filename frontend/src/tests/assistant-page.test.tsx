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

import { ApiError } from '../api/client';
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

describe('AssistantPage rate limiting', () => {
  const rateLimited = (message: string, retryAfterSeconds = 60) => {
    const error = new ApiError({
      status: 429,
      code: 'ASSISTANT_RATE_LIMITED',
      message,
      details: { scope: 'minute', retryAfterSeconds },
    });

    endpoints.askAssistant.mockRejectedValue(error);
  };

  it('SHOWS THE LIMIT AS A STATUS, NOT AS AN ERROR', async () => {
    // A red "something went wrong" box tells the user the feature is broken, and the
    // reasonable response to that is to retry immediately - the exact behaviour the limit
    // exists to stop.
    asAdmin();
    rateLimited('You are asking faster than the assistant can keep up.');

    renderAuthed(<AssistantPage />);
    await ask('one too many');

    // Asserted on the TEXT, not on role=status alone: the "Looking through your CRM…"
    // indicator is also a status, so a bare role query races the loading state and matches
    // whichever rendered first.
    expect(await screen.findByText(/asking faster/i)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it("uses the backend's wording rather than its own", async () => {
    // Which counter tripped is decided server-side; a frontend string would eventually
    // describe a limit that no longer exists.
    asAdmin();
    rateLimited('Your organisation has reached its hourly limit for assistant questions.');

    renderAuthed(<AssistantPage />);
    await ask('q');

    expect(await screen.findByText(/your organisation has reached/i)).toBeInTheDocument();
  });

  it('tells the user how long to wait', async () => {
    asAdmin();
    rateLimited('Slow down.', 120);

    renderAuthed(<AssistantPage />);
    await ask('q');

    expect(await screen.findByText(/ask again in about 2 minutes/i)).toBeInTheDocument();
  });

  it('THE QUESTION IS NOT LOST WHEN THE LIMIT IS HIT', async () => {
    // It matters more here than for a network error: the user is being asked to wait and then
    // retry, so losing what they typed makes the wait pointless.
    asAdmin();
    rateLimited('Slow down.');

    renderAuthed(<AssistantPage />);
    await ask('the question I still want answered');

    await screen.findByText(/slow down/i);

    expect(screen.getByLabelText('Ask the assistant')).toHaveValue(
      'the question I still want answered',
    );
  });

  it('does not leave an unanswered question in the transcript', async () => {
    asAdmin();
    rateLimited('Slow down.');

    renderAuthed(<AssistantPage />);
    await ask('q');

    await screen.findByText(/slow down/i);

    expect(screen.queryByTestId('assistant-question')).not.toBeInTheDocument();
  });

  it('the banner clears when the next question is sent', async () => {
    asAdmin();
    rateLimited('Slow down.');

    renderAuthed(<AssistantPage />);
    await ask('first');
    await screen.findByText(/slow down/i);

    endpoints.askAssistant.mockResolvedValue(answer());
    await ask('second');

    expect(await screen.findByText('Four leads are hot.')).toBeInTheDocument();
    expect(screen.queryByText(/slow down/i)).not.toBeInTheDocument();
  });

  it('a non-429 failure still renders as an error', async () => {
    // The two states must stay distinguishable in both directions.
    asAdmin();
    endpoints.askAssistant.mockRejectedValue(new Error('Network unreachable'));

    renderAuthed(<AssistantPage />);
    await ask('q');

    expect(await screen.findByRole('alert')).toHaveTextContent('Network unreachable');
  });

  it('a 500 is an error, not a rate limit', async () => {
    asAdmin();
    endpoints.askAssistant.mockRejectedValue(
      new ApiError({ status: 500, code: 'INTERNAL', message: 'Server exploded', details: null }),
    );

    renderAuthed(<AssistantPage />);
    await ask('q');

    expect(await screen.findByRole('alert')).toHaveTextContent('Server exploded');
  });
});

describe('AssistantPage temporary unavailability', () => {
  const unavailable = (retryAfterSeconds = 15) => {
    endpoints.askAssistant.mockRejectedValue(
      new ApiError({
        status: 503,
        code: 'ASSISTANT_UNAVAILABLE',
        message:
          'The assistant is temporarily unavailable. Everything else in the CRM is working ' +
          'normally — please try your question again in a few moments.',
        details: { retryAfterSeconds },
      }),
    );
  };

  it('SHOWS A TEMPORARY-UNAVAILABLE MESSAGE, NOT AN ERROR', async () => {
    // Nothing the user did caused this and nothing else is broken. A red "something went
    // wrong" box says the feature is broken and invites an immediate retry.
    asAdmin();
    unavailable();

    renderAuthed(<AssistantPage />);
    await ask('a question during an outage');

    expect(await screen.findByText(/temporarily unavailable/i)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('reassures the user the rest of the CRM is fine', async () => {
    asAdmin();
    unavailable();

    renderAuthed(<AssistantPage />);
    await ask('q');

    expect(await screen.findByText(/working normally/i)).toBeInTheDocument();
  });

  it('THE UNSENT QUESTION IS PRESERVED', async () => {
    // They are being asked to wait and retry. Losing what they typed makes the wait pointless.
    asAdmin();
    unavailable();

    renderAuthed(<AssistantPage />);
    await ask('the question I still want answered');

    await screen.findByText(/temporarily unavailable/i);

    expect(screen.getByLabelText('Ask the assistant')).toHaveValue(
      'the question I still want answered',
    );
  });

  it('advises a short wait rather than an hour', async () => {
    asAdmin();
    unavailable(15);

    renderAuthed(<AssistantPage />);
    await ask('q');

    expect(await screen.findByText(/ask again in about 15 seconds/i)).toBeInTheDocument();
  });

  it('does not leave an unanswered question in the transcript', async () => {
    asAdmin();
    unavailable();

    renderAuthed(<AssistantPage />);
    await ask('q');

    await screen.findByText(/temporarily unavailable/i);

    expect(screen.queryByTestId('assistant-question')).not.toBeInTheDocument();
  });

  it('RECOVERS WITHOUT A RELOAD', async () => {
    // Redis coming back must restore the assistant in place. Needing a refresh would make a
    // transient outage look permanent.
    asAdmin();
    unavailable();

    renderAuthed(<AssistantPage />);
    await ask('during the outage');
    await screen.findByText(/temporarily unavailable/i);

    endpoints.askAssistant.mockResolvedValue(answer());
    await ask('after it recovers');

    expect(await screen.findByText('Four leads are hot.')).toBeInTheDocument();
    expect(screen.queryByText(/temporarily unavailable/i)).not.toBeInTheDocument();
  });

  it('a 503 body carries no infrastructure detail to render', async () => {
    // Pinned on the component's side too: whatever the backend sends is what gets shown, so
    // the frontend must not add its own technical wording.
    asAdmin();
    unavailable();

    const { container } = renderAuthed(<AssistantPage />);
    await ask('q');

    await screen.findByText(/temporarily unavailable/i);

    expect(container.textContent?.toLowerCase()).not.toContain('redis');
    expect(container.textContent?.toLowerCase()).not.toContain('503');
  });
});
