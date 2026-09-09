/** Thin re-exports and aliases over shared DTOs for component-local imports. */

import type { AuthContextValue, AuthUser } from '../auth/AuthContext';
import type { MergedStage } from '../lib/stages';
import type {
  AccountRemoval,
  ActivityLog,
  AiBrainApproval,
  AiBrainOutcome,
  AiBrainProposalContent,
  AiBrainRenderedProposal,
  AiKnowledge,
  Conversation,
  ConversationAiSummary,
  ConversationDetail,
  FollowUpTask,
  LeadSource,
  LeadSubmission,
  Message,
  MessageType,
  MetaConnectionTest,
  MetaLeadFormSummary,
  MetaPageSummary,
  Note,
  OrganizationSettings,
  SendableAccount,
  Stage,
  Tag,
  User,
  WhatsAppAccount,
} from '../types';

export type {
  AccountRemoval,
  ActivityLog,
  AiBrainApproval,
  AiBrainOutcome,
  AiBrainProposalContent,
  AiBrainRenderedProposal,
  AiKnowledge,
  Conversation,
  ConversationAiSummary,
  ConversationDetail,
  FollowUpTask,
  LeadSource,
  LeadSubmission,
  Message,
  MessageType,
  MetaConnectionTest,
  MetaLeadFormSummary,
  MetaPageSummary,
  Note,
  OrganizationSettings,
  SendableAccount,
  Stage,
  Tag,
  User,
  WhatsAppAccount,
};

export type { AuthUser };

export type ActivityEntry = ActivityLog;
export type TeamMember = User;
export type CustomStage = Stage;
/** Inbox / lead-panel view of a conversation — full DTO fields are optional for fixtures. */
export type ConversationSummary = Pick<
  Conversation,
  'id' | 'displayName' | 'leadId' | 'stage' | 'tags' | 'assignedTo'
> &
  Partial<
    Pick<
      Conversation,
      | 'lastMessageAt'
      | 'lastMessagePreview'
      | 'unreadCount'
      | 'status'
      | 'aiAutomationEnabled'
      | 'aiAutomationPausedReason'
      | 'optedOutAt'
      | 'eventDate'
      | 'aiCategory'
      | 'leadScore'
      | 'leadScoreBand'
      | 'leadScoreSignals'
    >
  >;
export type StageOption = MergedStage;

export type AuthValue = AuthContextValue;
export type AuthedRequest = AuthContextValue['authedRequest'];

export type RealtimeEvent = {
  conversationId?: string;
  type?: string;
};

export type RealtimeValue = {
  subscribe: (handler: (event: RealtimeEvent) => void) => () => void;
};

export const errorMessage = (error: unknown, fallback: string): string =>
  error instanceof Error ? error.message : fallback;
