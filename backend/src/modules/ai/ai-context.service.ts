import { MESSAGE_DIRECTIONS } from '../../constants/message-directions.js';
import { type ObjectIdLike } from '../../types/common.js';
import { findActiveKnowledgeForOrganization } from '../ai-knowledge/ai-knowledge.repository.js';
import { findContactById } from '../contacts/contact.repository.js';
import { type ConversationDocument } from '../conversations/conversation.model.js';
import { getLeadFormContext } from '../lead-sources/lead-context.service.js';
import { findMessagesByConversationCursor } from '../messages/message.repository.js';

const BASE_SYSTEM_PROMPT = `You are drafting a WhatsApp reply on behalf of a business team member.
This is a DRAFT ONLY — a human will review, may edit, and must explicitly send it. Never claim the
message has already been sent. Write in a professional, concise tone matching the conversation.
Only state facts given to you below (in "Business knowledge"); if a detail (price, availability,
timeline, policy) is not provided there, ask a clarifying question or say a team member will
confirm it — never invent or guess it.`;

interface KnowledgeFactLike {
  label: string;
  content: string;
}

const formatKnowledgeSection = (facts: readonly KnowledgeFactLike[]): string => {
  if (facts.length === 0) {
    return '';
  }

  const lines = facts.map((fact) => `- ${fact.label}: ${fact.content}`);
  return `\n\nBusiness knowledge (only use these facts):\n${lines.join('\n')}`;
};

interface LeadFormContextLike {
  formName: string | null;
  fields: readonly { label: string; value: string }[];
}

const formatLeadFormSection = (leadFormContext: LeadFormContextLike | null): string => {
  if (!leadFormContext || leadFormContext.fields.length === 0) {
    return '';
  }

  const heading = leadFormContext.formName
    ? `What the customer told us on the "${leadFormContext.formName}" enquiry form`
    : 'What the customer told us on the enquiry form';
  const lines = leadFormContext.fields.map((field) => `- ${field.label}: ${field.value}`);

  return `\n\n${heading}:\n${lines.join('\n')}`;
};

interface ThreadMessageLike {
  direction: string;
  body: string | null;
}

const formatThreadLine = (message: ThreadMessageLike): string => {
  const speaker = message.direction === MESSAGE_DIRECTIONS.IN ? 'Customer' : 'You';
  return `${speaker}: ${message.body}`;
};

export interface BuildReplyDraftContextParams {
  organizationId: ObjectIdLike;
  conversation: Pick<ConversationDocument, '_id' | 'contactId'>;
  contextMessageCount: number;
}

export interface ReplyDraftContext {
  systemPrompt: string;
  threadText: string;
  contextMessageCount: number;
}

/**
 * Builds the prompt context for a reply draft. Deliberately never touches decrypted contact
 * PII (phone) — only the message bodies already in the thread and the contact's non-sensitive
 * displayName go into the prompt. This is ADR-005's "privacy controls must sanitize inputs"
 * control: do not add a phone/PII lookup here.
 *
 * Lead-form answers are the one addition, and they are opt-in per lead source
 * (`aiContextEnabled`, default off) and never include the name, email, phone or inbox URL —
 * `getLeadFormContext` returns null unless an admin turned the toggle on.
 */
export const buildReplyDraftContext = async ({
  organizationId,
  conversation,
  contextMessageCount,
}: BuildReplyDraftContextParams): Promise<ReplyDraftContext> => {
  const [messages, contact, knowledgeFacts, leadFormContext] = await Promise.all([
    findMessagesByConversationCursor({
      organizationId,
      conversationId: conversation._id,
      limit: contextMessageCount,
    }),
    findContactById({
      contactId: conversation.contactId,
      organizationId,
    }),
    findActiveKnowledgeForOrganization({ organizationId }),
    getLeadFormContext({
      organizationId,
      conversationId: conversation._id,
    }),
  ]);

  // Newest-first from the repository; the model reads more naturally in chronological order.
  const orderedMessages = [...messages].reverse();
  const threadText = orderedMessages.map(formatThreadLine).join('\n');

  const contactName = contact?.displayName ? ` (${contact.displayName})` : '';
  const systemPrompt = `${BASE_SYSTEM_PROMPT}${formatKnowledgeSection(knowledgeFacts)}${formatLeadFormSection(leadFormContext)}`;

  return {
    systemPrompt,
    threadText: `Conversation with the customer${contactName}:\n${threadText}`,
    contextMessageCount: orderedMessages.length,
  };
};
