/**
 * What the agent is allowed to say to a customer who has already booked.
 *
 * WHY THIS EXISTS AT ALL. "Resume AI messaging" on a confirmed booking used to mean resuming the
 * QUALIFYING agent - the one whose entire job is to find out what somebody wants and move them
 * towards buying it. Pointed at a customer who has already bought, that agent asks what their
 * budget is and offers them packages, which reads as either a mistake or a second sales pitch
 * from a studio they have already paid. So `aiMode` exists, and this is what `post_booking`
 * actually means in words.
 *
 * DELIVERED THROUGH `ownerInstruction`, AND THAT IS A DELIBERATE TEMPORARY CHOICE.
 *
 * The clean design is a real `aiMode` field on the ai-brain-service payload with a post-booking
 * playbook on the Python side. That costs a container rebuild and a second service to deploy in
 * step with the backend, which is a materially riskier production operation than shipping Node
 * alone - and this installation has local, uncommitted docker-compose edits that have to survive
 * every deploy. The owner-instruction channel already reaches the model on every call and the
 * prompt already treats it as "an ORDER, not one more opinion to weigh", which is exactly the
 * authority this needs.
 *
 * The honest cost: that channel is documented as being for one reply. This works because the
 * caller regenerates the directive on EVERY turn while the mode is set, rather than setting it
 * once and hoping it persists - see ai-brain.service.ts. When the Python service next needs
 * deploying for another reason, the migration is to move this text into a real playbook keyed
 * off an `aiMode` field and delete this file.
 *
 * NOTHING HERE INVENTS A BOOKING. Every concrete detail the agent may state - the date, the
 * venue, what was booked - has to come from what is already recorded on the conversation. A
 * confident "see you on the 3rd at your venue" to somebody whose date was never confirmed is
 * worse than saying nothing, because they will plan around it.
 */

export const buildPostBookingDirective = (): string =>
  [
    'THIS CUSTOMER HAS ALREADY BOOKED. The sale is done.',
    'You are no longer qualifying anybody and you are not selling anything.',
    'You may: thank them for booking, confirm details THAT ARE ALREADY RECORDED above',
    '(the date, the venue, what they booked), ask for a specific detail that is genuinely',
    'missing and that we need in order to turn up prepared, answer a question they ask, and',
    'remind them about the event as it approaches.',
    'You may NOT: ask qualifying questions, ask about their budget, mention packages, quote or',
    'repeat any price, offer add-ons, upsell, cross-sell, or do anything that reads as trying to',
    'make a second sale. If they ask about extra services, say we will have someone come back to',
    'them about it rather than pitching it yourself.',
    // The failure mode that matters most here. A booking confirmation is the message a customer
    // plans around - a wrong date or venue in it is not a tone problem, it is a ruined event.
    'INVENT NOTHING. Do not state a date, a venue, a time, a duration, a deliverable or who will',
    'be attending unless it is in the recorded facts above. If a detail is not there, either ask',
    'for it or leave it out - never guess it, and never imply a commitment nobody made.',
    'Warm, short and human, in the usual voice.',
  ].join(' ');
