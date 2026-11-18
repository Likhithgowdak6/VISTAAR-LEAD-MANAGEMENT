import { serializeDate, serializeId, toPlainObject } from '../../utils/serialization.js';
import { type WhatsAppTemplateDocument } from './whatsapp-template.model.js';

export interface SerializedWhatsAppTemplate {
  id: string | null;
  whatsappAccountId: string | null;
  name: unknown;
  language: unknown;
  status: unknown;
  category: unknown;
  bodyText: unknown;
  headerText: unknown;
  footerText: unknown;
  bodyVariableCount: number;
  headerVariableCount: number;
  syncedAt: string | null;
}

/**
 * What the composer needs to render a template picker.
 *
 * `components` is deliberately NOT serialized. It is Meta's raw array, kept so a future component
 * type needs no migration, and nothing in the UI reads it - the text and the variable counts above
 * are everything the picker uses. Shipping it would put a large, shape-unstable blob into every
 * list response for no reader.
 */
export const serializeWhatsAppTemplate = (
  template: WhatsAppTemplateDocument | Record<string, unknown> | null | undefined,
): SerializedWhatsAppTemplate | null => {
  const value = toPlainObject(template);

  if (!value) {
    return null;
  }

  return {
    id: serializeId(value._id),
    whatsappAccountId: serializeId(value.whatsappAccountId),
    name: value.name,
    language: value.language,
    status: value.status,
    category: value.category,
    bodyText: value.bodyText,
    headerText: value.headerText,
    footerText: value.footerText,
    bodyVariableCount: Number(value.bodyVariableCount ?? 0),
    headerVariableCount: Number(value.headerVariableCount ?? 0),
    syncedAt: serializeDate(value.syncedAt),
  };
};
