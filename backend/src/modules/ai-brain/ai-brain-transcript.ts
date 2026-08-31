/**
 * The one way a stored WhatsApp thread becomes the `[{role, text}]` array ai-brain-service's
 * prompts interpolate.
 *
 * Extracted from ai-brain.service.ts so the outcome classifier, the proposal generator and the
 * conversation summariser all read a conversation the same way. They must: a summary that saw a
 * different transcript from the classifier that raised the card beside it would quietly
 * contradict it.
 */
import { MESSAGE_DIRECTIONS } from '../../constants/message-directions.js';

export interface TranscriptTurn {
  role: string;
  text: string;
}

/** Oldest-first, blank-bodied messages dropped, each turn labelled `lead` or `us`. */
export const buildTranscript = (
  recentMessages: readonly { body?: string | null; direction?: string }[],
): TranscriptTurn[] =>
  [...recentMessages]
    .reverse()
    .filter((message) => (message.body ?? '').trim() !== '')
    .map((message) => ({
      role: message.direction === MESSAGE_DIRECTIONS.IN ? 'lead' : 'us',
      text: message.body ?? '',
    }));
