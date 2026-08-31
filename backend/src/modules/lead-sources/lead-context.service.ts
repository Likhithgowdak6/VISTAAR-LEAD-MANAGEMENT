import { type ObjectIdLike } from '../../types/common.js';
import { findLeadSourceById } from './lead-source.repository.js';
import { findLeadSubmissionsForConversation } from './lead-submission.repository.js';

export interface LeadContextField {
  label: string;
  value: string;
}

export interface LeadFormContext {
  formName: string | null;
  fields: LeadContextField[];
}

export interface GetLeadFormContextParams {
  organizationId: ObjectIdLike;
  conversationId: ObjectIdLike;
}

/**
 * The lead's own form answers, for grounding an AI draft — but only when the admin who
 * connected the sheet turned that on.
 *
 * The gate is per lead source and defaults to off. Widening what leaves the estate for the AI
 * provider is an explicit choice, not a side effect of importing leads, and free-text answers
 * can contain whatever the lead decided to type. Name, email, phone and the inbox URL are never
 * included even when the toggle is on.
 */
export const getLeadFormContext = async ({
  organizationId,
  conversationId,
}: GetLeadFormContextParams): Promise<LeadFormContext | null> => {
  const submissions = await findLeadSubmissionsForConversation({
    organizationId,
    conversationId,
    limit: 1,
  });

  const latest = submissions[0];

  if (!latest?.payload) {
    return null;
  }

  const leadSource = await findLeadSourceById({
    leadSourceId: latest.submission.leadSourceId,
    organizationId,
  });

  if (!leadSource?.aiContextEnabled) {
    return null;
  }

  const fields = (latest.payload.customFields ?? [])
    .filter((field) => field.label !== '' && field.value !== '')
    .map((field) => ({ label: field.label, value: field.value }));

  if (fields.length === 0) {
    return null;
  }

  return {
    formName: latest.submission.formName,
    fields,
  };
};
