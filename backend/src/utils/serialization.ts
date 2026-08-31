export type PlainObject = Record<string, unknown>;

/** Anything Mongoose-document-shaped, i.e. convertible to a plain object. */
interface ToObjectCapable {
  toObject(options?: { depopulate?: boolean }): PlainObject;
}

const isToObjectCapable = (value: object): value is ToObjectCapable =>
  typeof (value as Partial<ToObjectCapable>).toObject === 'function';

export const toPlainObject = (value: unknown): PlainObject | null => {
  if (!value) {
    return null;
  }

  if (typeof value === 'object' && isToObjectCapable(value)) {
    return value.toObject({
      depopulate: true,
    });
  }

  return value as PlainObject;
};

export const serializeId = (value: unknown): string | null => {
  if (!value) {
    return null;
  }

  return String(value);
};

export const serializeIdArray = (values: readonly unknown[] = []): (string | null)[] =>
  values.map((value) => serializeId(value));

export const serializeDate = (value: unknown): string | null => {
  if (!value) {
    return null;
  }

  return new Date(value as string | number | Date).toISOString();
};
