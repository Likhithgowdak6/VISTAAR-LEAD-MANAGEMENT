/** Local re-exports, so the wizard's step files import from one place rather than four. */

export type { MetaConnectReturn } from '../../../lib/meta-connect';
export type {
  LeadSource,
  MetaActivationResult,
  MetaConnectedPage,
  MetaConnection,
  MetaDiagnostics,
  MetaFieldKey,
  MetaFieldMapping,
  MetaFormField,
  MetaLeadFormSummary,
  Stage,
  Tag,
  User,
  WhatsAppAccount,
} from '../../../types';

/**
 * What the owner decided about one form question.
 *
 * Three states, not two, because "no canonical key" is genuinely two different intentions:
 *
 *  - `fact`   — store the answer under a canonical key the AI and the lead card understand.
 *  - `extra`  — no canonical key, but keep the answer as free text on the lead. This is what the
 *               importer already does unaided for a question no rule matches, so it is sent as
 *               NO mapping at all rather than as an explicit null.
 *  - `ignore` — throw the answer away. Sent as an explicit `factKey: null`, which the importer
 *               distinguishes from absent.
 *
 * Collapsing `extra` and `ignore` into one "unmapped" choice would quietly start discarding
 * answers people expected to keep.
 */
export type FieldChoiceMode = 'fact' | 'extra' | 'ignore';

export interface FieldChoice {
  mode: FieldChoiceMode;
  /** Meaningful only when `mode` is `fact`. */
  factKey: string | null;
}

/** The lead settings the wizard collects, kept together so Back never loses them. */
export interface MetaWizardSettings {
  name: string;
  whatsappAccountId: string;
  defaultCountryCode: string;
  defaultStage: string | null;
  defaultTagIds: string[];
  defaultAssigneeId: string | null;
  aiContextEnabled: boolean;
  autoGreetEnabled: boolean;
  importExisting: boolean;
}
