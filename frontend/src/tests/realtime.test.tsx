import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import App from '../App';
import * as endpointsApi from '../api/endpoints';
import { parseSseBuffer } from '../realtime/parse-sse';

// Tests may use `any` for Vitest mocks of untyped endpoint modules.
const endpoints = endpointsApi as any;

vi.mock('../api/endpoints');

describe('parseSseBuffer', () => {
  it('extracts complete frames and keeps the trailing partial', () => {
    const { events, rest } = parseSseBuffer(
      'event: conversation.changed\ndata: {"conversationId":"c1"}\n\ndata: {"conve',
    );

    expect(events).toEqual([{ conversationId: 'c1' }]);
    expect(rest).toBe('data: {"conve');
  });

  it('assembles an event split across two chunks', () => {
    const first = parseSseBuffer('data: {"conversationId":');
    expect(first.events).toEqual([]);

    const second = parseSseBuffer(`${first.rest}"c2"}\n\n`);
    expect(second.events).toEqual([{ conversationId: 'c2' }]);
    expect(second.rest).toBe('');
  });

  it('ignores heartbeat/comment frames', () => {
    const { events } = parseSseBuffer(': ping\n\n: connected\n\n');
    expect(events).toEqual([]);
  });
});

// --- Integration: a realtime event drives an inbox refetch ---

const authPayload = {
  data: {
    accessToken: 'token-1',
    user: { id: 'u1', name: 'Asha', role: 'admin' },
    organization: { id: 'o1', name: 'Acme' },
    permissions: ['conversations.read_all'],
  },
};

// A controllable fake SSE stream: the test pushes frames through `emit`.
const makeStreamController = () => {
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined;
  const stream = new ReadableStream({
    start(controller) {
      controllerRef = controller;
    },
  });
  const encoder = new TextEncoder();
  return {
    response: { ok: true, body: stream },
    emit: (event: unknown) =>
      controllerRef!.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)),
  };
};

describe('realtime inbox refresh', () => {
  let streamController: ReturnType<typeof makeStreamController>;

  beforeEach(() => {
    endpoints.refresh.mockResolvedValue(authPayload);
    endpoints.listConversations.mockResolvedValue({ data: [] });

    streamController = makeStreamController();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => streamController.response),
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('refetches the inbox when a conversation.changed event arrives', async () => {
    render(<App />);

    // Leads is the landing screen now, so get to the inbox first - and count calls RELATIVE to
    // whatever that navigation cost, since both screens read the same endpoint. An absolute
    // count here would be asserting how many times the app happens to fetch on startup, which
    // is not what this test is about.
    fireEvent.click(await screen.findByRole('button', { name: 'Inbox' }));
    await waitFor(() => expect(endpoints.listConversations).toHaveBeenCalled());

    // The realtime stream connected via fetch.
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        expect.stringMatching(/\/realtime\/stream$/),
        expect.objectContaining({ credentials: 'include' }),
      ),
    );

    const before = endpoints.listConversations.mock.calls.length;

    streamController.emit({ type: 'conversation.changed', conversationId: 'c1' });

    await waitFor(() =>
      expect(endpoints.listConversations.mock.calls.length).toBe(before + 1),
    );
  });
});
