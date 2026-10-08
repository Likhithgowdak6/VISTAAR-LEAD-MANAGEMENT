/**
 * Grouping a customer's rapid messages into one turn.
 *
 * The failure this prevents is five replies to one person who was still typing. The failure it
 * must not introduce is a lost turn, or two turns running at once and answering twice.
 *
 * Timers are injected, so nothing here waits out a real debounce.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createInboundBurstCollector, joinBurstTexts } from './inbound-burst.js';

/** A controllable clock: `tick()` fires every timer whose window has closed. */
const createScheduler = () => {
  let pending: { id: number; fn: () => void }[] = [];
  let nextId = 1;

  return {
    setTimer: ((fn: () => void) => {
      const id = nextId++;
      pending.push({ id, fn });
      return id as unknown as ReturnType<typeof setTimeout>;
    }) as never,
    clearTimer: ((handle: number) => {
      pending = pending.filter((entry) => entry.id !== handle);
    }) as never,
    /** Close every open window. */
    tick: () => {
      const due = pending;
      pending = [];
      due.forEach((entry) => entry.fn());
    },
    get count() {
      return pending.length;
    },
  };
};

const createCollector = (debounceMs = 3000) => {
  const scheduler = createScheduler();
  const flush = vi.fn(async () => undefined);
  const collector = createInboundBurstCollector({
    debounceMs,
    setTimer: scheduler.setTimer,
    clearTimer: scheduler.clearTimer,
    logger: { error: vi.fn() },
  });

  const send = (text: string, messageId = `msg-${text.length}-${Math.random()}`) =>
    collector.collect({ conversationId: 'conv-1', messageId, text, flush });

  return { collector, scheduler, flush, send };
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('joinBurstTexts', () => {
  it('joins the messages in the order they were sent', () => {
    expect(joinBurstTexts(['Hi', 'I need a photographer', 'For my wedding'])).toBe(
      'Hi I need a photographer For my wedding',
    );
  });

  it('drops blanks rather than leaving double spaces', () => {
    expect(joinBurstTexts(['Hi', '', '   ', 'December 15'])).toBe('Hi December 15');
  });
});

describe('one turn per burst', () => {
  it('turns two rapid messages into a single flush', async () => {
    const h = createCollector();

    h.send('Hi');
    h.send('I need a photographer');
    h.scheduler.tick();
    await h.collector.flushAll();

    expect(h.flush).toHaveBeenCalledTimes(1);
    expect(h.flush).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Hi I need a photographer', messageCount: 2 }),
    );
  });

  it('turns five rapid messages into a single flush', async () => {
    const h = createCollector();

    ['Hi', 'I need a photographer', 'For my wedding', 'December 15', 'Are you available?'].forEach(
      (text) => h.send(text),
    );
    h.scheduler.tick();
    await h.collector.flushAll();

    expect(h.flush).toHaveBeenCalledTimes(1);
    expect(h.flush).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Hi I need a photographer For my wedding December 15 Are you available?',
        messageCount: 5,
      }),
    );
  });

  it('passes a lone message through as a burst of one', async () => {
    const h = createCollector();

    h.send('I need a photographer for my wedding');
    h.scheduler.tick();
    await h.collector.flushAll();

    expect(h.flush).toHaveBeenCalledTimes(1);
    expect(h.flush).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'I need a photographer for my wedding', messageCount: 1 }),
    );
  });

  it('keeps the LAST message id as the turn identity', async () => {
    const h = createCollector();

    h.send('Hi', 'msg-1');
    h.send('I need a photographer', 'msg-2');
    h.scheduler.tick();
    await h.collector.flushAll();

    // Downstream keys the AI reply on this, so one burst can only ever produce one reply.
    expect(h.flush).toHaveBeenCalledWith(expect.objectContaining({ lastMessageId: 'msg-2' }));
  });

  it('restarts the window on every new message, rather than running from the first', async () => {
    const h = createCollector();

    h.send('I need a photographer');
    expect(h.scheduler.count).toBe(1);

    h.send('For my wedding');
    // The first timer was cancelled, not left to fire early on a half-finished burst.
    expect(h.scheduler.count).toBe(1);

    h.scheduler.tick();
    await h.collector.flushAll();
    expect(h.flush).toHaveBeenCalledTimes(1);
  });
});

describe('separate turns', () => {
  it('treats messages after the window closed as a new turn', async () => {
    const h = createCollector();

    h.send('I need a photographer');
    h.scheduler.tick();
    await h.collector.flushAll();

    h.send('Actually, make it December');
    h.scheduler.tick();
    await h.collector.flushAll();

    expect(h.flush).toHaveBeenCalledTimes(2);
    expect(h.flush).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ text: 'Actually, make it December', messageCount: 1 }),
    );
  });

  it('keeps two conversations apart', async () => {
    const scheduler = createScheduler();
    const flushA = vi.fn(async () => undefined);
    const flushB = vi.fn(async () => undefined);
    const collector = createInboundBurstCollector({
      debounceMs: 3000,
      setTimer: scheduler.setTimer,
      clearTimer: scheduler.clearTimer,
    });

    collector.collect({ conversationId: 'conv-a', messageId: 'm1', text: 'Hi', flush: flushA });
    collector.collect({ conversationId: 'conv-b', messageId: 'm2', text: 'Hello', flush: flushB });
    scheduler.tick();
    await collector.flushAll();

    expect(flushA).toHaveBeenCalledWith(expect.objectContaining({ text: 'Hi' }));
    expect(flushB).toHaveBeenCalledWith(expect.objectContaining({ text: 'Hello' }));
  });
});

describe('no overlapping work for one conversation', () => {
  it('holds a second burst behind the first instead of running both', async () => {
    const scheduler = createScheduler();
    const order: string[] = [];
    // A gate the test opens by hand, so the first turn is provably still running when the
    // second burst arrives. Built up front rather than inside the mock: assigning the resolver
    // from within the executor leaves TypeScript narrowing it to `never`.
    let releaseFirst = () => {};
    const firstTurnGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const firstFlush = vi.fn(async () => {
      order.push('first:start');
      await firstTurnGate;
      order.push('first:end');
    });
    const secondFlush = vi.fn(async () => {
      order.push('second:start');
    });

    const collector = createInboundBurstCollector({
      debounceMs: 3000,
      setTimer: scheduler.setTimer,
      clearTimer: scheduler.clearTimer,
    });

    collector.collect({ conversationId: 'c', messageId: 'm1', text: 'one', flush: firstFlush });
    scheduler.tick();
    await Promise.resolve();

    collector.collect({ conversationId: 'c', messageId: 'm2', text: 'two', flush: secondFlush });
    scheduler.tick();
    await Promise.resolve();

    // The second turn has NOT started while the first is still generating a reply.
    expect(order).toEqual(['first:start']);

    releaseFirst();
    await collector.flushAll();

    expect(order).toEqual(['first:start', 'first:end', 'second:start']);
  });

  it('does not let a failing turn block the next one', async () => {
    const scheduler = createScheduler();
    const failing = vi.fn(async () => {
      throw new Error('ai-brain unreachable');
    });
    const succeeding = vi.fn(async () => undefined);
    const collector = createInboundBurstCollector({
      debounceMs: 3000,
      setTimer: scheduler.setTimer,
      clearTimer: scheduler.clearTimer,
      logger: { error: vi.fn() },
    });

    collector.collect({ conversationId: 'c', messageId: 'm1', text: 'one', flush: failing });
    scheduler.tick();
    await collector.flushAll();

    collector.collect({ conversationId: 'c', messageId: 'm2', text: 'two', flush: succeeding });
    scheduler.tick();
    await collector.flushAll();

    expect(succeeding).toHaveBeenCalledTimes(1);
  });
});

describe('batching turned off', () => {
  it('flushes immediately when the window is zero', async () => {
    const h = createCollector(0);

    h.send('I need a photographer');
    await h.collector.flushAll();

    // No timer was ever scheduled - the turn went straight through.
    expect(h.scheduler.count).toBe(0);
    expect(h.flush).toHaveBeenCalledTimes(1);
  });
});

describe('flushAll', () => {
  it('closes an open window and waits for the work', async () => {
    const h = createCollector();

    h.send('Hi');
    h.send('I need a photographer');

    expect(h.collector.isPending('conv-1')).toBe(true);

    await h.collector.flushAll();

    expect(h.collector.isPending('conv-1')).toBe(false);
    expect(h.flush).toHaveBeenCalledTimes(1);
  });
});

// --------------------------------------------------------------------------
// Batching knows nothing about what the business sells, and must not start to.
//
// A customer describing a website build across four messages is the same shape as one
// describing a wedding shoot across four: one person, one request, one answer. If a burst
// mentions two services it is still ONE turn - the reply should address the whole thing, not
// fire once per service named.
// --------------------------------------------------------------------------
describe('bursts are service-agnostic', () => {
  it.each([
    [
      'a website enquiry',
      ['we need a website', 'for our company', 'ecommerce', 'can you help?'],
      'we need a website for our company ecommerce can you help?',
    ],
    [
      'an event-marketing enquiry',
      ['we need marketing', 'for our event', 'social media and ads'],
      'we need marketing for our event social media and ads',
    ],
    [
      'a content enquiry',
      ['we need content', 'videos and podcasts'],
      'we need content videos and podcasts',
    ],
    [
      'a greeting followed by a web enquiry',
      ['hi', 'we need a website', 'for our new company', 'can you help?'],
      'hi we need a website for our new company can you help?',
    ],
    [
      'a social enquiry spanning two services',
      ['hello', 'we need someone to manage our instagram', 'and google ads'],
      'hello we need someone to manage our instagram and google ads',
    ],
    [
      'Hinglish across services',
      ['bhai website banwana hai', 'aur insta bhi manage karna hai'],
      'bhai website banwana hai aur insta bhi manage karna hai',
    ],
  ])('turns %s into one turn', async (_label, messages, expected) => {
    const h = createCollector();

    (messages as string[]).forEach((text) => h.send(text));
    h.scheduler.tick();
    await h.collector.flushAll();

    // One flush, whatever was mentioned in it - never one per service.
    expect(h.flush).toHaveBeenCalledTimes(1);
    expect(h.flush).toHaveBeenCalledWith(
      expect.objectContaining({ text: expected, messageCount: (messages as string[]).length }),
    );
  });
});
