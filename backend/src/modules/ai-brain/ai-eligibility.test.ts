/**
 * The one rule: a service enquiry gets an answer, everything else gets silence.
 *
 * The cases below are not hypothetical. The marketing blasts, membership-renewal notices,
 * webinar invitations and bot menus are the exact messages that received the standard Vistaar
 * Verse introduction in production, and the empty-string cases are the shape that let them
 * through: a `templateMessage` or `listMessage` has no body the Baileys extractor can read, so
 * `inboundText` arrived as "" and the old gate skipped itself rather than refusing.
 *
 * The second half matters as much as the first. Silence must never be a pause - "hi" followed a
 * minute later by "I need a photographer for December" has to be answered, and that only holds
 * if ignoring the first message wrote nothing at all.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: { NODE_ENV: 'test', LOG_LEVEL: 'silent' },
}));

const { canAiRespondToInbound, AI_ELIGIBILITY_REASONS } = await import('./ai-eligibility.js');

const silentLogger = { error: vi.fn() };

/** A classifier that answers with `intent` and records whether it was consulted at all. */
const classifierSaying = (intent: string) => vi.fn(async () => ({ intent, confidence: 0.9, reason: '' }));

const ask = (
  inboundText: unknown,
  {
    intent = 'sales_lead',
    transcript = [] as { role: string; text: string }[],
    ownerInstruction = '',
    leadQualified = false,
    classifyIntent = classifierSaying(intent),
  } = {},
) =>
  canAiRespondToInbound({
    inboundText: inboundText as string,
    ownerInstruction,
    leadQualified,
    transcript,
    classifyIntent,
    logger: silentLogger,
  });

describe('messages with nothing readable in them', () => {
  // THE PRODUCTION BUG. A template/button/list message has no extractable body, so this is
  // precisely what the gate saw fifty times in four minutes.
  it.each([
    ['an empty string, as a templateMessage arrives', ''],
    ['whitespace only', '   '],
    ['null', null],
    ['undefined', undefined],
    ['an emoji only', '👍'],
    ['punctuation only', '???'],
    ['an ellipsis', '...'],
  ])('stays silent on %s', async (_label, text) => {
    const classifyIntent = classifierSaying('sales_lead');

    const verdict = await canAiRespondToInbound({
      inboundText: text as string,
      classifyIntent,
      logger: silentLogger,
    });

    expect(verdict.respond).toBe(false);
    expect(verdict.reason).toBe(AI_ELIGIBILITY_REASONS.NO_TEXT);
    // And it never reaches the model - there is nothing to ask about.
    expect(classifyIntent).not.toHaveBeenCalled();
  });
});

describe('generic messages that are not enquiries', () => {
  it.each(['Hi', 'Hello', 'hey', 'Good morning', 'Good evening', 'Thanks', 'Thank you', 'Okay', 'ok', 'Who is this?', "What's up"])(
    'stays silent on %p without asking the model',
    async (text) => {
      const classifyIntent = classifierSaying('sales_lead');

      const verdict = await canAiRespondToInbound({
        inboundText: text,
        classifyIntent,
        logger: silentLogger,
      });

      expect(verdict.respond).toBe(false);
      expect(verdict.reason).toBe(AI_ELIGIBILITY_REASONS.DETERMINISTIC_NON_LEAD);
      expect(classifyIntent).not.toHaveBeenCalled();
    },
  );
});

describe('marketing, notifications and bots', () => {
  // Every one of these is from the production screenshots. The deterministic list catches some
  // of them outright and the model is what settles the rest, which is the intended division of
  // labour - the list is a cheap first pass, not the guarantee. What is asserted here is the
  // guarantee: with the model answering as it should, nothing is sent.
  it.each([
    'Buy 2 Formal Pants & Save Extra 10%',
    'Join our webinar',
    '48-HOUR EXCLUSIVE OFFER | Buy 2 Formal Pants & Save Extra 10%',
    'Congrats Vistaar Event! Your Onsurity Membership has been successfully renewed',
    'A Powerful Angelic Session Awaits. Join at 11 AM IST',
    'Your invoice is ready',
    'Payment successful',
    'Your OTP is 123456',
    'Welcome to Dressy Daiquiri! Please let us know how can we help you? Choose one of the below options:',
    'Please select from the options below',
    'This number is used only for marketing updates',
  ])('stays silent on %p', async (text) => {
    const verdict = await ask(text, { intent: 'non_lead' });

    expect(verdict.respond).toBe(false);
  });

  it.each(['Your OTP is 123456', 'Please select from the options below'])(
    'catches %p without spending a model call',
    async (text) => {
      const classifyIntent = classifierSaying('sales_lead');

      const verdict = await canAiRespondToInbound({
        inboundText: text,
        classifyIntent,
        logger: silentLogger,
      });

      expect(verdict.respond).toBe(false);
      expect(verdict.reason).toBe(AI_ELIGIBILITY_REASONS.DETERMINISTIC_NON_LEAD);
      expect(classifyIntent).not.toHaveBeenCalled();
    },
  );
});

describe('genuine service enquiries', () => {
  it.each([
    'How much do you charge for wedding photography?',
    'I need a wedding photographer',
    'Do you cover pre wedding shoots?',
    'What are your wedding packages?',
    'Are you available on December 15?',
    'I need a videographer for my event',
    'How much for a corporate shoot?',
    'Do you provide real estate photography?',
    "I'm looking for a photographer in Bangalore",
    'kitna hoga bhai shoot ka',
  ])('answers %p', async (text) => {
    const verdict = await ask(text, { intent: 'sales_lead' });

    expect(verdict.respond).toBe(true);
    expect(verdict.reason).toBe(AI_ELIGIBILITY_REASONS.SERVICE_ENQUIRY);
  });

  it('answers a greeting that carries a real question with it', async () => {
    // The pleasantry list is whole-message only precisely so this still gets through.
    const verdict = await ask('Hi, I need a photographer for my wedding', { intent: 'sales_lead' });

    expect(verdict.respond).toBe(true);
  });
});

describe('ambiguity fails closed', () => {
  it('stays silent when the model says unclear', async () => {
    const verdict = await ask('How much?', { intent: 'unclear' });

    expect(verdict.respond).toBe(false);
    expect(verdict.intent).toBe('unclear');
    expect(verdict.reason).toBe(AI_ELIGIBILITY_REASONS.INTENT_NOT_SALES_LEAD);
  });

  it('stays silent when the model says non_lead', async () => {
    const verdict = await ask('Can you send me your bank details?', { intent: 'non_lead' });

    expect(verdict.respond).toBe(false);
    expect(verdict.intent).toBe('non_lead');
  });

  it('stays silent on a verdict the service invented', async () => {
    const verdict = await ask('Need details', { intent: 'probably_a_lead_honestly' });

    expect(verdict.respond).toBe(false);
    expect(verdict.intent).toBe('unclear');
    // Not recorded: an answer nobody can interpret is not a verdict.
    expect(verdict.decided).toBe(false);
  });

  it('stays silent when the classifier throws', async () => {
    const verdict = await ask('How much?', {
      classifyIntent: vi.fn(async () => {
        throw new Error('ETIMEDOUT');
      }),
    });

    expect(verdict.respond).toBe(false);
    expect(verdict.reason).toBe(AI_ELIGIBILITY_REASONS.CLASSIFIER_UNAVAILABLE);
    // Nothing is stored, so a transient outage cannot brand the conversation.
    expect(verdict.decided).toBe(false);
  });

  it('passes the transcript through, so "how much?" can be read in context', async () => {
    const classifyIntent = classifierSaying('sales_lead');
    const transcript = [{ role: 'lead', text: 'do you do pre wedding shoots' }];

    await canAiRespondToInbound({
      inboundText: 'How much?',
      transcript,
      classifyIntent,
      logger: silentLogger,
    });

    expect(classifyIntent).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'How much?', transcript }),
    );
  });
});

describe('the owner-directed bypass', () => {
  it('answers when a human or the greeting job supplied an instruction', async () => {
    const classifyIntent = classifierSaying('non_lead');

    const verdict = await canAiRespondToInbound({
      inboundText: '',
      ownerInstruction: 'Greet this imported lead from the wedding form.',
      classifyIntent,
      logger: silentLogger,
    });

    expect(verdict.respond).toBe(true);
    expect(verdict.reason).toBe(AI_ELIGIBILITY_REASONS.OWNER_DIRECTED);
    // It is an internal directive, so there is nothing for the classifier to judge.
    expect(classifyIntent).not.toHaveBeenCalled();
  });

  it('is not reachable from a blank instruction', async () => {
    const verdict = await ask('Buy 2 pants get 10% off', {
      ownerInstruction: '   ',
      intent: 'non_lead',
    });

    expect(verdict.respond).toBe(false);
  });
});

describe('a verdict is about this message, never the thread', () => {
  it('judges every message afresh rather than caching', async () => {
    const classifyIntent = vi
      .fn()
      .mockResolvedValueOnce({ intent: 'non_lead' })
      .mockResolvedValueOnce({ intent: 'sales_lead' });

    const first = await canAiRespondToInbound({
      inboundText: 'Your subscription has been renewed for October',
      classifyIntent,
      logger: silentLogger,
    });
    const second = await canAiRespondToInbound({
      inboundText: 'Actually I need a photographer for my wedding',
      classifyIntent,
      logger: silentLogger,
    });

    expect(first.respond).toBe(false);
    expect(second.respond).toBe(true);
    expect(classifyIntent).toHaveBeenCalledTimes(2);
  });
});

// --------------------------------------------------------------------------
// THE DETERMINISTIC LAYER IS NOT THE LEAD DETECTOR.
//
// Its only job is to drop messages with no readable customer text, plus bare greetings. It must
// never be the thing that decides a message IS an enquiry, and it must never swallow one. A
// customer can ask for the same thing a thousand ways - misspelt, in Hinglish, by implication,
// using none of the words this business would pick - and every one of those has to reach the
// model that can actually read it.
//
// So these assert REACHABILITY, not verdicts: the classifier is consulted. What the answer
// should be is the model's business, and is covered by the Python tests.
// --------------------------------------------------------------------------
describe('legitimate enquiries reach the classifier whatever their wording', () => {
  it.each([
    // Misspelt, no punctuation, as typed on a phone.
    'hi we are looking for photografer are you avaiable',
    'weddding shoot ke liye kitna lagega',
    'do u have packges for pre weddding',
    // Not one word a keyword list would hold.
    'we need someone for our wedding',
    'looking for someone to shoot our function',
    'can you tell me what you guys do',
    'how much would this cost',
    "need something for my sister's wedding",
    'do you guys cover events',
    'are you free on 15th',
    'can you send me the details',
    // Indirect, and polite openers that carry a real question with them.
    'Hi, we are looking for a photographer',
    'Hello, can you tell me about your wedding packages?',
    'Good morning, are you available in December?',
    'hey do you shoot corporate stuff',
    // Terse continuations that only make sense in context.
    'How much?',
    '15th December',
    'and the price?',
  ])('sends %p to the model rather than deciding locally', async (text) => {
    const classifyIntent = classifierSaying('sales_lead');

    await canAiRespondToInbound({
      inboundText: text,
      classifyIntent,
      logger: silentLogger,
    });

    // The ONLY assertion that matters here: the cheap layer did not get in the way.
    expect(classifyIntent).toHaveBeenCalledWith(expect.objectContaining({ message: text }));
  });

  it('answers a misspelt enquiry once the model recognises it', async () => {
    const verdict = await ask('hi we are looking for photografer are you avaiable', {
      intent: 'sales_lead',
    });

    expect(verdict.respond).toBe(true);
  });

  it('stays silent on the same wording when the model is unsure', async () => {
    // Proof that the decision is the model's, not the phrase list's - same text, both ways.
    const verdict = await ask('how much would this cost', { intent: 'unclear' });

    expect(verdict.respond).toBe(false);
  });
});

describe('the greeting filter is whole-message only', () => {
  it.each([
    ['Hi', false],
    ['Hi there', false],
    ['Good morning', false],
    ['👍', false],
    ['Hi, I need a photographer', true],
    ['Hello, what are your wedding packages?', true],
    ['thanks, can you send the packages', true],
    ['ok and how much for december', true],
  ])('%p reaches the model: %s', async (text, shouldReach) => {
    const classifyIntent = classifierSaying('sales_lead');

    await canAiRespondToInbound({
      inboundText: text as string,
      classifyIntent,
      logger: silentLogger,
    });

    expect(classifyIntent.mock.calls.length > 0).toBe(shouldReach);
  });
});

// --------------------------------------------------------------------------
// VISTAAR IS NOT A PHOTOGRAPHY BUSINESS. It is a multi-service agency - websites, SEO, social
// media, digital marketing, branding, content, video, podcasts, e-commerce, event marketing -
// and photography is one line of several.
//
// The risk this guards against is subtle: a deterministic layer tuned on photography wording
// would quietly swallow "we need SEO" or "can you manage our instagram?" long before any model
// saw them, and the symptom would be silence that looks exactly like correct behaviour. So
// these assert REACHABILITY - the cheap layer gets out of the way and the model is consulted.
// Whether the answer is right is the model's business, pinned in the Python prompt tests.
// --------------------------------------------------------------------------
describe('enquiries about any Vistaar service reach the classifier', () => {
  it.each([
    // Web and e-commerce
    'hi we need a website for our company',
    'do you guys build ecommerce websites?',
    'our website needs a complete redesign',
    'need ecommerce website',
    // Social media
    'can you manage our instagram?',
    'looking for someone to handle social media',
    'we need someone to handle our online presence',
    // Search and advertising
    'we need SEO for our website',
    'need SEO',
    'our Google ranking is bad, can you help?',
    'we want to run ads for our business',
    'how much does digital marketing cost?',
    // Content, video, podcast
    'we need a video for our brand',
    'do you guys do podcasts?',
    'we need content for our startup',
    'we need someone for social media and content',
    // Branding and strategy
    'we want help with branding',
    'we need branding for our startup',
    'can you help us launch our brand?',
    'need a marketing strategy for our new company',
    // Events
    'need marketing for an upcoming event',
    'we need marketing for our event',
    'are you available for a corporate event?',
    // Photography - still one of the services, not the only one
    'how much for a corporate photoshoot?',
    'we need photography for our real estate business',
    // Hinglish, across services
    'bhai website banwana hai',
    'insta manage karte ho?',
    'seo ka kya price hai?',
    'photografer chahiye corporate event ke liye',
    'hamko social media ke liye content chahiye',
    // Names no service at all - the case a keyword list can never catch
    'our online presence needs improvement',
    "our online presence isn't working and we need help",
    'can you send your packages?',
  ])('sends %p to the model rather than filtering it out', async (text) => {
    const classifyIntent = classifierSaying('sales_lead');

    await canAiRespondToInbound({
      inboundText: text,
      classifyIntent,
      logger: silentLogger,
    });

    expect(classifyIntent).toHaveBeenCalledWith(expect.objectContaining({ message: text }));
  });

  it.each([
    'we need a website',
    'can you manage our instagram?',
    'need SEO',
    'we need a video',
    'do you guys do podcasts?',
    'we need branding for our startup',
    'need ecommerce website',
    'we need marketing for our event',
    'bhai website banwana hai',
    'insta manage karte ho?',
  ])('answers %p once the model calls it a lead', async (text) => {
    const verdict = await ask(text, { intent: 'sales_lead' });

    expect(verdict.respond).toBe(true);
    expect(verdict.reason).toBe(AI_ELIGIBILITY_REASONS.SERVICE_ENQUIRY);
  });

  it('is the model, not the phrase list, that decides a web enquiry', async () => {
    // Same words, both verdicts: proof that nothing local is making this call.
    const asLead = await ask('we need a website for our company', { intent: 'sales_lead' });
    const asNoise = await ask('we need a website for our company', { intent: 'non_lead' });

    expect(asLead.respond).toBe(true);
    expect(asNoise.respond).toBe(false);
  });

  it('still ignores the non-leads, whichever service they mention', async () => {
    // A promo blast that happens to be about web design is still a promo blast.
    const verdict = await ask('50% OFF on website design this week only. Click to claim!', {
      intent: 'non_lead',
    });

    expect(verdict.respond).toBe(false);
  });
});

describe('an established lead is not re-interviewed', () => {
  it('answers without consulting the classifier at all', async () => {
    const classifyIntent = classifierSaying('unclear');

    const verdict = await ask('I will confirm the details tomorrow', {
      leadQualified: true,
      classifyIntent,
    });

    // THE WHOLE POINT. constants/ai-intents.ts has always said the classifier should run "ONCE
    // per conversation"; the read of that state was lost when this gate was rewritten, so every
    // message was re-judged and a mid-sale reply came back unclear.
    expect(verdict.respond).toBe(true);
    expect(verdict.reason).toBe(AI_ELIGIBILITY_REASONS.CONFIRMED_LEAD);
    expect(classifyIntent).not.toHaveBeenCalled();
  });

  it.each([
    'I will confirm the details tomorrow',
    'can you recommend me the best package',
    'photography only',
    'we are thinking about the 16th',
  ])('answers %j, which alone would not read as an enquiry', async (text) => {
    const classifyIntent = classifierSaying('non_lead');

    const verdict = await ask(text, { leadQualified: true, classifyIntent });

    expect(verdict.respond).toBe(true);
    expect(classifyIntent).not.toHaveBeenCalled();
  });

  it('writes nothing back, because nothing new was decided', async () => {
    const verdict = await ask('what about drone coverage', { leadQualified: true });

    // Re-stamping the conversation on every message would be churn with no information in it.
    expect(verdict.decided).toBe(false);
  });

  // ---- what being confirmed does NOT buy ---------------------------------
  //
  // These four are the incident guard. Qualification skips the CLASSIFIER and nothing else; if
  // it ever skipped the checks above it, an established thread would become the same hole that
  // put fifty cold intros on the wire.

  it('still says nothing when there is no readable text', async () => {
    const classifyIntent = classifierSaying('sales_lead');

    const verdict = await ask('', { leadQualified: true, classifyIntent });

    // A template or list message in a confirmed thread has no body either, and handing an empty
    // string to the brain is exactly what made it introduce the studio out of nowhere.
    expect(verdict.respond).toBe(false);
    expect(verdict.reason).toBe(AI_ELIGIBILITY_REASONS.NO_TEXT);
    expect(classifyIntent).not.toHaveBeenCalled();
  });

  it.each(['👍', '???', '   '])('still says nothing to %j', async (text) => {
    const verdict = await ask(text, { leadQualified: true });

    expect(verdict.respond).toBe(false);
    expect(verdict.reason).toBe(AI_ELIGIBILITY_REASONS.NO_TEXT);
  });

  it('still applies the deterministic non-lead filter', async () => {
    const verdict = await ask('Your OTP is 445566. Do not share it with anyone.', {
      leadQualified: true,
    });

    expect(verdict.respond).toBe(false);
    expect(verdict.reason).toBe(AI_ELIGIBILITY_REASONS.DETERMINISTIC_NON_LEAD);
  });

  it('leaves an unqualified conversation exactly as it was', async () => {
    const classifyIntent = classifierSaying('unclear');

    const verdict = await ask('I will confirm the details tomorrow', {
      leadQualified: false,
      classifyIntent,
    });

    // The gate must not have become more permissive for strangers.
    expect(verdict.respond).toBe(false);
    expect(classifyIntent).toHaveBeenCalledTimes(1);
  });
});

describe('a short answer from an established lead is an answer', () => {
  // The AI asks "photography, or videography as well?" and the customer types "yes". The
  // pleasantry list matches a whole message equal to "yes", so that reply - the most direct
  // answer possible to our own question - used to end the conversation. The list is right for a
  // stranger who typed "hi" and wrong for someone mid-sale, so the reason is waived once, and
  // only once, the thread is established.
  it.each(['yes', 'ok', 'okay', 'sure', 'please do', 'yes please', 'thanks'])(
    'lets %j through for a confirmed lead',
    async (text) => {
      const classifyIntent = classifierSaying('non_lead');

      const verdict = await ask(text, { leadQualified: true, classifyIntent });

      expect(verdict.respond).toBe(true);
      expect(verdict.reason).toBe(AI_ELIGIBILITY_REASONS.CONFIRMED_LEAD);
      // And still without an LLM call - waiving the filter must not reintroduce the
      // re-interviewing this change removed.
      expect(classifyIntent).not.toHaveBeenCalled();
    },
  );

  it('lets a short but contextual reply through', async () => {
    const verdict = await ask('both please', { leadQualified: true });

    expect(verdict.respond).toBe(true);
  });

  it.each(['yes', 'ok', 'okay', 'sure', 'thanks'])(
    'still filters %j for a conversation that was never qualified',
    async (text) => {
      const verdict = await ask(text, { leadQualified: false });

      // NOT A GLOBAL WHITELIST. A stranger typing "ok" into a cold thread is exactly what the
      // pleasantry filter is for, and nothing here may loosen that.
      expect(verdict.respond).toBe(false);
      expect(verdict.reason).toBe(AI_ELIGIBILITY_REASONS.DETERMINISTIC_NON_LEAD);
    },
  );

  it.each(['please do', 'yes please', 'both please'])(
    'sends %j to the classifier when the conversation is unqualified',
    async (text) => {
      // These are NOT on the pleasantry list - checked against classifyNonLead rather than
      // assumed - so an unqualified thread still pays for a verdict on them. Asserted so a
      // future edit to that list cannot quietly change which layer decides these.
      const classifyIntent = classifierSaying('non_lead');

      const verdict = await ask(text, { leadQualified: false, classifyIntent });

      expect(classifyIntent).toHaveBeenCalledTimes(1);
      expect(verdict.respond).toBe(false);
    },
  );

  // ---- what the waiver does NOT cover -----------------------------------
  //
  // Exactly one reason is waived. These are the other five, on a confirmed lead, and every one
  // of them must still be silence - a forwarded OTP is an OTP whoever sends it.

  it.each([
    ['a bank OTP', 'Your OTP is 445566. Do not share it with anyone.'],
    ['a bare link', 'https://example.com/offer'],
  ])('still filters %s from a confirmed lead', async (_label, text) => {
    const verdict = await ask(text, { leadQualified: true });

    expect(verdict.respond).toBe(false);
    expect(verdict.reason).toBe(AI_ELIGIBILITY_REASONS.DETERMINISTIC_NON_LEAD);
  });

  it('still says nothing to an empty body from a confirmed lead', async () => {
    const verdict = await ask('', { leadQualified: true });

    expect(verdict.respond).toBe(false);
    expect(verdict.reason).toBe(AI_ELIGIBILITY_REASONS.NO_TEXT);
  });
});
