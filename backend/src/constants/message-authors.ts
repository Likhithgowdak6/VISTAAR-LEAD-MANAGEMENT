export const MESSAGE_AUTHORS = Object.freeze({
  AI: 'ai',
  HUMAN: 'human',
} as const);

export type MessageAuthor = (typeof MESSAGE_AUTHORS)[keyof typeof MESSAGE_AUTHORS];

export const MESSAGE_AUTHOR_VALUES = Object.freeze(
  Object.values(MESSAGE_AUTHORS),
) as readonly [MessageAuthor, ...MessageAuthor[]];
