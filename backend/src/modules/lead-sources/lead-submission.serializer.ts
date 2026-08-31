import { serializeDate, serializeId, toPlainObject } from '../../utils/serialization.js';
import { type LeadSubmissionWithPayload } from './lead-submission.repository.js';

export interface SerializedLeadSubmissionField {
  key: string;
  label: string;
  value: string;
}

export interface SerializedLeadSubmission {
  id: string | null;
  status: unknown;
  skipReason: unknown;
  submittedAt: string | null;
  platform: unknown;
  isOrganic: boolean;
  leadStatus: unknown;
  campaignName: unknown;
  adName: unknown;
  adsetName: unknown;
  formName: unknown;
  /** The lead's answers to the form's own questions, in sheet column order. */
  fields: SerializedLeadSubmissionField[];
  hasEmail: boolean;
  hasPhone: boolean;
}

const toFields = (value: unknown): SerializedLeadSubmissionField[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') {
      return [];
    }

    const field = entry as { key?: unknown; label?: unknown; value?: unknown };

    if (typeof field.label !== 'string' || typeof field.value !== 'string') {
      return [];
    }

    return [
      {
        key: typeof field.key === 'string' ? field.key : field.label,
        label: field.label,
        value: field.value,
      },
    ];
  });
};

/**
 * The privacy-safe view of a form submission.
 *
 * Form answers and campaign attribution are returned to anyone who can read the lead, because
 * that is what makes the lead workable. The name, email, phone, inbox URL and the raw row are
 * withheld — those stay behind the audited reveal endpoint, exactly like a contact's number.
 * `hasEmail` / `hasPhone` exist so the UI can offer the reveal without leaking the values.
 */
export const serializeLeadSubmission = ({
  submission,
  payload,
}: LeadSubmissionWithPayload): SerializedLeadSubmission | null => {
  const value = toPlainObject(submission);

  if (!value) {
    return null;
  }

  const payloadValue = (payload ?? {}) as Record<string, unknown>;

  return {
    id: serializeId(value._id),
    status: value.status,
    skipReason: value.skipReason,
    submittedAt: serializeDate(value.submittedAt),
    platform: value.platform,
    isOrganic: Boolean(value.isOrganic),
    leadStatus: value.leadStatus,
    campaignName: value.campaignName,
    adName: value.adName,
    adsetName: value.adsetName,
    formName: value.formName,
    fields: toFields(payloadValue.customFields),
    hasEmail: typeof payloadValue.email === 'string' && payloadValue.email !== '',
    hasPhone: typeof payloadValue.phone === 'string' && payloadValue.phone !== '',
  };
};
