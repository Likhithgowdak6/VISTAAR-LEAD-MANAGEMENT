export const NOTE_VISIBILITY = Object.freeze({
  SHARED: 'shared',
  MANAGER: 'manager',
  ADMIN: 'admin',
} as const);

export type NoteVisibility = (typeof NOTE_VISIBILITY)[keyof typeof NOTE_VISIBILITY];

export const NOTE_VISIBILITY_VALUES = Object.freeze(Object.values(NOTE_VISIBILITY)) as readonly [
  NoteVisibility,
  ...NoteVisibility[],
];
