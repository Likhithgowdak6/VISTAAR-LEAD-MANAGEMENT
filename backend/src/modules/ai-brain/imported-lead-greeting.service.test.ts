/**
 * The opening message to an ad-form lead.
 *
 * This is the only path where the agent speaks first, to someone who never messaged it, so what
 * is checked here is that the message is shaped to be RECOGNISED: a stranger who cannot place why
 * you are in their WhatsApp is a stranger who reports you, and on an unofficial connection that
 * costs the number every conversation on it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: { NODE_ENV: 'test', LOG_LEVEL: 'silent' },
}));

const { buildGreetingDirective, createImportedLeadGreetingService } = await import(
  './imported-lead-greeting.service.js'
);

const conversation = { _id: { toString: () => 'conv-1' } } as never;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('the directive', () => {
  it('names the form, so the first line can be placed instantly', () => {
    const directive = buildGreetingDirective({
      sourceLabel: 'Wedding Genie — Aug 2026',
      category: 'wedding',
    });

    expect(directive).toContain('Wedding Genie — Aug 2026');
    expect(directive).toContain('FIRST message');
    expect(directive).toContain('never messaged us');
  });

  it('says what they enquired about, in words', () => {
    expect(buildGreetingDirective({ sourceLabel: 'F', category: 'house_warming' })).toContain(
      'house warming',
    );
  });

  it('admits when the service is unknown rather than guessing one', () => {
    // Inventing "wedding" here would have the opening confidently reference something they never
    // asked for, in the first sentence they ever read from us.
    const directive = buildGreetingDirective({ sourceLabel: 'F', category: 'unknown' });

    expect(directive).toContain('did not say which service');
  });
});

describe('the directive for a hand-added lead', () => {
  it('never claims they filled in a form, because they did not', () => {
    const directive = buildGreetingDirective({
      sourceLabel: 'our enquiry form',
      category: 'birthday',
      origin: 'manual',
    });

    // The form variant instructs the model to open by naming the form. Sent to someone the owner
    // typed in by hand, that asserts something the person knows perfectly well never happened -
    // which is the fastest possible way to be reported.
    expect(directive).toContain('did NOT fill in a form');
    expect(directive).not.toContain('our enquiry form');
  });

  it('writes as the studio, never as someone running the owner\'s errand', () => {
    const directive = buildGreetingDirective({
      sourceLabel: 'unused',
      category: 'car_delivery',
      origin: 'manual',
    });

    // The real message this pins down: "Himanshu asked me to get in touch about your car delivery
    // shoot" - which reads as an assistant relaying an errand. At a two-person studio the client
    // expects to be talking to the studio, and a note from "their helper" is colder and stranger
    // than one from the business itself.
    expect(directive).toContain('WRITE AS THE STUDIO ITSELF, IN THE FIRST PERSON');
    expect(directive).toContain('never say anyone asked or told you to make contact');
    expect(directive).toContain('There is no third party in this conversation');
  });

  it('uses the owner\'s own words for how they know the lead', () => {
    const directive = buildGreetingDirective({
      sourceLabel: 'unused',
      category: 'wedding',
      origin: 'manual',
      originNote: 'met at the wedding expo on Sunday',
    });

    expect(directive).toContain('met at the wedding expo on Sunday');
  });

  it('forbids inventing a reason when the owner gave no context', () => {
    const directive = buildGreetingDirective({
      sourceLabel: 'unused',
      category: 'wedding',
      origin: 'manual',
      originNote: null,
    });

    // A vague honest opening is recoverable. A confident false one is not.
    expect(directive).toContain('Do not invent a reason');
    expect(directive).toContain('do not imply they contacted us');
  });

  it.each([undefined, '', '   '])('treats %p as no context at all', (note) => {
    const directive = buildGreetingDirective({
      sourceLabel: 'unused',
      origin: 'manual',
      originNote: note,
    });

    expect(directive).toContain('Do not invent a reason');
  });

  it('still names the service, which is the one thing the owner did tell us', () => {
    expect(
      buildGreetingDirective({ sourceLabel: 'unused', category: 'car_delivery', origin: 'manual' }),
    ).toContain('car delivery');
  });
});

describe('sending it', () => {
  it('runs the normal qualifying graph with no inbound text', async () => {
    const handleInboundMessageForAutomation = vi.fn().mockResolvedValue(undefined);
    const service = createImportedLeadGreetingService({ handleInboundMessageForAutomation });

    await service.greetImportedLead({
      organizationId: 'org-1',
      conversation,
      sourceLabel: 'Wedding Genie',
      category: 'wedding',
    });

    // No second "first contact" prompt: same voice, same rules, same refusal to quote a price it
    // was not given. A separate prompt would be a second place for those to live, and they drift.
    expect(handleInboundMessageForAutomation).toHaveBeenCalledWith(
      expect.objectContaining({
        inboundText: '',
        inboundMessageId: 'auto-greet:conv-1',
        ownerInstruction: expect.stringContaining('Wedding Genie'),
      }),
    );
  });
});

describe('the call-scheduling opening for Meta ad leads', () => {
  const directive = (overrides: Record<string, unknown> = {}) =>
    buildGreetingDirective({
      sourceLabel: 'Wedding Sept-Dec',
      category: 'wedding',
      origin: 'form_call_scheduling',
      ...overrides,
    } as never);

  it('asks for a call today', () => {
    // The whole purpose of this variant. Without it the opening is the ordinary qualifying
    // greeting and nobody is asked for a time.
    expect(directive().toLowerCase()).toContain('call');
    expect(directive().toLowerCase()).toContain('today');
  });

  it('asks for ONE thing, not the usual qualifying questions too', () => {
    // A message that asks for a call AND the date AND the venue gets answered on the easiest
    // question and the call never happens.
    expect(directive()).toContain('ONE clear ask');
  });

  it('DESCRIBES the emotional point instead of dictating a sentence', () => {
    const text = directive();

    // THE REQUIREMENT THIS FILE EXISTS FOR. The brief contained a specific sentence about
    // "the people, emotions and little moments". Shipping that sentence as required output
    // would send every single lead the identical paragraph - a mass campaign by definition,
    // and recognisable as one the moment two recipients compare notes.
    expect(text).not.toContain("isn't just covering the event");
    expect(text).not.toContain('little moments you');

    // The intent is stated, and the wording is left to the model.
    expect(text).toContain('IN YOUR OWN WORDS AND DIFFERENTLY EACH TIME');
    expect(text.toLowerCase()).toContain('small moments');
  });

  it('tells the model not to reuse a stock sentence', () => {
    expect(directive().toLowerCase()).toContain('do not reuse a stock sentence');
  });

  it('forbids inventing anything it was not given', () => {
    const text = directive().toLowerCase();

    // The lead gave a form, not a quote. Everything commercial is off limits.
    for (const claim of ['prices', 'packages', 'availability', 'deliverables', 'discounts']) {
      expect(text).toContain(claim);
    }
    expect(text).toContain('no urgency');
  });

  it('refuses to guess a missing occasion or date', () => {
    expect(directive().toLowerCase()).toContain('only where you actually have them');
    expect(directive().toLowerCase()).toContain('never guess');
  });

  it('handles a lead whose service was never identified', () => {
    const text = directive({ category: null });

    // Neutral wording rather than a guess - and no placeholder left behind.
    expect(text).toContain('They did not say which service.');
    expect(text).not.toContain('undefined');
    expect(text).not.toContain('{{');
  });

  it('still names the form, so a stranger can place the message', () => {
    expect(directive()).toContain('"Wedding Sept-Dec"');
  });

  it('leaves the ordinary form greeting untouched', () => {
    const ordinary = buildGreetingDirective({
      sourceLabel: 'Wedding Sept-Dec',
      category: 'wedding',
      origin: 'form',
    } as never);

    // The general-purpose opening must not have acquired a call ask for every other source.
    expect(ordinary).toContain('ask your opening questions');
    expect(ordinary).not.toContain('ONE clear ask');
  });

  it('leaves the manual greeting untouched', () => {
    const manual = buildGreetingDirective({
      sourceLabel: 'ignored',
      category: 'wedding',
      origin: 'manual',
    } as never);

    // A hand-typed lead filled in no form and must never be told they did.
    expect(manual).toContain('did NOT fill in a form');
    expect(manual).not.toContain('ONE clear ask');
  });
});

describe('the form name is not an answer the customer gave', () => {
  /**
   * OBSERVED IN A REAL MODEL CALL, which is the only reason this exists. A lead with no service
   * answer, on a form the owner had named "Wedding Sept-Dec", was greeted with "thanks for
   * filling in the wedding form" - the studio telling a stranger what they want, based on the
   * owner's own filing system. A wedding-named form collects birthday and corporate enquiries
   * too, and being told you asked about a wedding when you did not is the kind of wrong that
   * gets a WhatsApp number reported.
   */
  const unknownService = () =>
    buildGreetingDirective({
      sourceLabel: 'Wedding Sept-Dec',
      category: 'unknown',
      origin: 'form_call_scheduling',
    } as never);

  const verifiedWedding = () =>
    buildGreetingDirective({
      sourceLabel: 'Wedding Sept-Dec',
      category: 'wedding',
      origin: 'form_call_scheduling',
    } as never);

  it('tells the model the form name is OURS, not theirs', () => {
    const text = unknownService();

    expect(text).toContain('that is OUR name for it');
    expect(text).toContain('not evidence of their occasion');
  });

  it('forbids naming a service they did not ask for', () => {
    expect(unknownService()).toContain('Do not call it "the wedding form"');
  });

  it('asks what they want instead of guessing', () => {
    const text = unknownService();

    expect(text).toContain('ASK what');
    expect(text).toContain('neutral terms');
  });

  it('keeps the warmth general when there is no occasion to be warm about', () => {
    // "the feeling of the day" presumes a day. Without a service there may not be one.
    expect(unknownService()).toContain('Keep the warmth general');
  });

  it('still asks for a call today even with nothing else known', () => {
    expect(unknownService().toLowerCase()).toContain('time today for a short call');
  });

  it('says NOTHING of the sort when the service really was answered', () => {
    const text = verifiedWedding();

    // A verified wedding enquiry should read as one - the caution only applies when we are
    // guessing, and applying it always would make every message vague.
    expect(text).toContain('They enquired about wedding.');
    expect(text).not.toContain('that is OUR name for it');
    expect(text).not.toContain('ASK what');
  });

  /**
   * BOTH FORM VARIANTS, and this test used to assert the opposite.
   *
   * The guard was first written for the call-scheduling opening because that is where the bad
   * message was observed, and this case pinned that scope down. It was the wrong line to draw:
   * the form's name is the owner's filing whichever opening is being written, and the ordinary
   * variant's "confirm we do the thing they asked about" is if anything a stronger invitation to
   * invent an occasion than anything in the scheduling one.
   */
  const ordinaryUnknown = () =>
    buildGreetingDirective({
      sourceLabel: 'Wedding Sept-Dec',
      category: 'unknown',
      origin: 'form',
    } as never);

  it('guards the ordinary form greeting too', () => {
    const text = ordinaryUnknown();

    expect(text).toContain('that is OUR name for it');
    expect(text).toContain('Do not call it "the wedding form"');
  });

  it('drops "confirm we do the thing they asked about" when they asked about nothing', () => {
    // They named no service, so there is no "thing they asked about" to confirm - following that
    // instruction means picking one, which is the whole defect.
    expect(ordinaryUnknown()).not.toContain('confirm we do the thing they asked about');
    expect(ordinaryUnknown()).toContain('say what we do');
  });

  it('keeps that line when the service really was answered', () => {
    const text = buildGreetingDirective({
      sourceLabel: 'Wedding Sept-Dec',
      category: 'wedding',
      origin: 'form',
    } as never);

    expect(text).toContain('confirm we do the thing they asked about');
    expect(text).not.toContain('that is OUR name for it');
  });

  it('does not turn the ordinary greeting into the call-scheduling one', () => {
    // The guard is shared; the call ask is not.
    expect(ordinaryUnknown()).toContain('ask your opening questions');
    expect(ordinaryUnknown()).not.toContain('ONE clear ask');
  });

  it('never leaves a placeholder behind in either variant', () => {
    for (const text of [ordinaryUnknown(), unknownService()]) {
      expect(text).not.toContain('undefined');
      expect(text).not.toContain('{{');
    }
  });
});
