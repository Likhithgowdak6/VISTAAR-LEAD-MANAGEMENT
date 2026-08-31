export const MESSAGE_DIRECTIONS = Object.freeze({
  IN: 'in',
  OUT: 'out',
  SYSTEM: 'system',
} as const);

export type MessageDirection = (typeof MESSAGE_DIRECTIONS)[keyof typeof MESSAGE_DIRECTIONS];

export const MESSAGE_DIRECTION_VALUES = Object.freeze(
  Object.values(MESSAGE_DIRECTIONS),
) as readonly [MessageDirection, ...MessageDirection[]];
