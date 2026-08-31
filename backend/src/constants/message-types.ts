export const MESSAGE_TYPES = Object.freeze({
  TEXT: 'text',
  IMAGE: 'image',
  DOCUMENT: 'document',
  AUDIO: 'audio',
  VIDEO: 'video',
  CONTACT: 'contact',
  STICKER: 'sticker',
  LOCATION: 'location',
  UNSUPPORTED: 'unsupported',
} as const);

export type MessageType = (typeof MESSAGE_TYPES)[keyof typeof MESSAGE_TYPES];

export const MESSAGE_TYPE_VALUES = Object.freeze(Object.values(MESSAGE_TYPES)) as readonly [
  MessageType,
  ...MessageType[],
];
