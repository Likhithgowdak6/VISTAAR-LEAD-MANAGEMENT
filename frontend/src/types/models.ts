/** Shared domain DTOs mirrored from backend serializers for UI consumption. */

export type Role = 'super_admin' | 'admin' | 'manager' | 'staff';
export type AssignableRole = 'admin' | 'manager' | 'staff';

export type AccountAccessMode = 'all' | 'selected';
export type UserStatus = 'active' | 'disabled';

export type ConversationStatus = 'open' | 'closed' | 'archived' | 'deleted';
export type BuiltinStageKey =
  'new' | 'contacted' | 'qualified' | 'proposal' | 'won' | 'lost' | 'closed';
/** Built-in stage keys plus org custom stage keys. */
export type StageKey = BuiltinStageKey | (string & {});

/** How warm a lead is, from the backend's conversations/lead-score.ts. */
export type LeadScoreBand = 'hot' | 'warm' | 'cold' | 'low_intent';

export type TagStatus = 'active' | 'archived' | 'deleted';
export type StageStatus = 'active' | 'archived';

export type NoteVisibility = 'shared' | 'manager' | 'admin';

export type MessageDirection = 'in' | 'out' | 'system';
export type MessageType =
  | 'text'
  | 'image'
  | 'document'
  | 'audio'
  | 'video'
  | 'contact'
  | 'sticker'
  | 'location'
  | 'unsupported';
export type MessageStatus =
  | 'received'
  | 'created'
  | 'queued'
  | 'sending'
  | 'sent'
  | 'delivered'
  | 'read'
  | 'failed'
  | 'failed_permanent';

export type FollowUpType = 'call' | 'message' | 'proposal' | 'custom';
export type FollowUpPriority = 'low' | 'normal' | 'high' | 'urgent';
export type FollowUpStatus = 'pending' | 'completed' | 'cancelled' | 'missed';

export type AccountStatus =
  | 'pending'
  | 'connecting'
  | 'active'
  | 'reconnecting'
  | 'disconnected'
  | 'paused'
  | 'removed'
  | 'blocked';

export type AiDraftOutcome = 'approved_unedited' | 'approved_edited' | 'discarded';
export type AiKnowledgeStatus = 'active' | 'archived';
export type AiKnowledgeCategory = 'pricing' | 'policy' | 'product' | 'faq' | 'other';

export type OrganizationStatus = 'active' | 'disabled';

export interface Organization {
  id: string;
  name: string;
  slug: string;
  status: OrganizationStatus;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface User {
  id: string;
  organizationId: string | null;
  name: string;
  email: string;
  role: Role;
  permissionOverrides: {
    allow: string[];
    deny: string[];
  };
  accountAccessMode: AccountAccessMode;
  accountAccess: string[];
  status: UserStatus;
  mustChangePassword: boolean;
  passwordChangedAt: string | null;
  lastLoginAt: string | null;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface Contact {
  id: string;
  organizationId: string | null;
  leadId: string;
  displayName: string | null;
  profileName: string | null;
  source: string | null;
  status: string;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface Conversation {
  id: string;
  organizationId: string | null;
  whatsappAccountId: string | null;
  contactId: string | null;
  leadId: string;
  displayName: string;
  assignedTo: string | null;
  assignedTeam: string | null;
  lastHandledBy: string | null;
  lastHandledAt: string | null;
  stage: StageKey;
  /** Tag ids attached to the conversation. */
  tags: string[];
  summary: string | null;
  unreadCount: number;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  nextFollowUpAt: string | null;
  status: ConversationStatus;
  /** Whether ai-brain-service may auto-run the qualifying chat for this conversation. */
  aiAutomationEnabled: boolean;
  /** Set when the AI escalated and stopped automating; cleared when a human re-enables it. */
  aiAutomationPausedReason: string | null;
  /** When this lead asked to stop being contacted. Non-null means no automation may ever message
   *  them again - unlike a paused conversation, this is not a state a human can simply toggle off. */
  optedOutAt: string | null;
  /** The day the lead's event happens, read off their answers by the backend's event-date parser.
   *  Null until they give a date we can read - the normal state of a fresh enquiry. Day-only,
   *  anchored at UTC midnight, so it must be read back in UTC. */
  eventDate: string | null;
  aiCategory: string;
  aiFacts: Record<string, unknown>;
  /** 0-100, built from what this lead has told us and done. 0 until they tell us something. */
  leadScore: number;
  /** Which band that score falls in - 80+ HOT, 50+ WARM, 20+ COLD, else LOW INTENT. */
  leadScoreBand: LeadScoreBand;
  /** The signal keys that fired (see lib/lead-score.ts). The six minus these are what is still
   *  worth asking about. */
  leadScoreSignals: string[];
  createdAt: string | null;
  updatedAt: string | null;
}

export interface ConversationAccountSummary {
  id: string;
  name: string;
  brandKey: string | null;
  status: AccountStatus;
}

export interface ConversationDetail {
  conversation: Conversation;
  contact: Contact | null;
  whatsappAccount: ConversationAccountSummary | null;
}

export interface MessageMedia {
  mimeType: string | null;
  fileName: string | null;
  sizeBytes: number | null;
  storageStatus: string;
}

export interface Message {
  id: string;
  organizationId: string | null;
  whatsappAccountId: string | null;
  conversationId: string | null;
  contactId: string | null;
  providerMessageId: string | null;
  direction: MessageDirection;
  type: MessageType;
  body: string | null;
  mediaObjectKey: string | null;
  media: MessageMedia;
  sentByUserId: string | null;
  status: MessageStatus;
  sentAt: string | null;
  receivedAt: string | null;
  providerTimestamp: string | null;
  statusUpdatedAt: string | null;
  deliveryAttempts: number;
  lastDeliveryError: string | null;
  nextAttemptAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface Tag {
  id: string;
  organizationId: string | null;
  whatsappAccountId: string | null;
  name: string;
  slug: string;
  color: string | null;
  description: string | null;
  status: TagStatus;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface Stage {
  id: string;
  organizationId: string | null;
  key: string;
  label: string;
  color: string | null;
  status: StageStatus;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface Note {
  id: string;
  organizationId: string | null;
  whatsappAccountId: string | null;
  conversationId: string | null;
  body: string;
  visibility: NoteVisibility;
  createdBy: string | null;
  updatedBy: string | null;
  deletedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface FollowUpTask {
  id: string;
  organizationId: string | null;
  whatsappAccountId: string | null;
  conversationId: string | null;
  assignedTo: string | null;
  createdBy: string | null;
  type: FollowUpType;
  note: string | null;
  dueAt: string | null;
  priority: FollowUpPriority;
  status: FollowUpStatus;
  completedAt: string | null;
  cancelledAt: string | null;
  missedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface ActivityLog {
  id: string;
  organizationId: string | null;
  whatsappAccountId: string | null;
  conversationId: string | null;
  actorId: string | null;
  eventType: string;
  summary: string;
  metadata: Record<string, unknown>;
  createdAt: string | null;
}

export interface WhatsAppAccount {
  id: string;
  organizationId: string | null;
  name: string;
  description: string | null;
  brandKey: string | null;
  status: AccountStatus;
  ownerUserId: string | null;
  settings: {
    outboundIntervalMs: number | null;
    aiEnabled: boolean;
  };
  lastConnectedAt: string | null;
  lastDisconnectedAt: string | null;
  disconnectCode: string | number | null;
  disconnectReason: string | null;
  removedAt: string | null;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface AccountQrPayload {
  qrDataUrl: string | null;
  pairingCode: string | null;
}

export type AiBrainApprovalResolution = 'approve' | 'edit' | 'skip';
export type AiBrainOutcomeDecision = 'won' | 'lost' | 'answer' | 'reopen' | 'wait' | 'unclear';

/** A reply ai-brain-service drafted and is waiting on a human to approve, revise, or skip. */
export interface AiBrainApproval {
  id: string;
  conversationId: string | null;
  draft: string;
  facts: Record<string, unknown>;
  status: 'pending' | 'resolved';
  resolution: AiBrainApprovalResolution | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface AiBrainOutcome {
  decision: AiBrainOutcomeDecision;
  message: string;
  reasoning: string;
}

/**
 * A proposal's content is decided by ai-brain-service's own prompt schema (title, sections,
 * pricing, etc.) - the frontend round-trips it (generate -> revise -> render) without needing
 * to know every field, the same way the backend does.
 */
export type AiBrainProposalContent = Record<string, unknown>;

export interface AiBrainRenderedProposal {
  docx_base64: string;
  pdf_base64: string | null;
}

export interface AiDraft {
  id: string;
  conversationId: string | null;
  draftText: string;
  contextMessageCount: number;
  outcome: AiDraftOutcome | null;
  createdAt: string | null;
}

export interface AiKnowledge {
  id: string;
  organizationId: string | null;
  label: string;
  content: string;
  category: AiKnowledgeCategory;
  status: AiKnowledgeStatus;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export type LeadSourceStatus = 'active' | 'paused';
export type LeadSourceSyncStatus = 'pending' | 'ok' | 'failed';

export interface LeadSource {
  id: string;
  organizationId: string | null;
  name: string;
  sheetUrl: string;
  gid: string;
  whatsappAccountId: string | null;
  defaultCountryCode: string;
  status: LeadSourceStatus;
  aiContextEnabled: boolean;
  columnMapping: {
    externalId: string | null;
    createdTime: string | null;
    fullName: string | null;
    phone: string | null;
    email: string | null;
  };
  importFromTime: string | null;
  lastSyncedAt: string | null;
  lastSyncStatus: LeadSourceSyncStatus;
  lastError: string | null;
  lastSyncCounts: {
    imported: number;
    duplicates: number;
    skipped: number;
    failed: number;
  };
  totalImported: number;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface LeadSubmissionField {
  key: string;
  label: string;
  value: string;
}

/** Privacy-safe view of a lead-form submission: answers only, never name/email/phone. */
export interface LeadSubmission {
  id: string;
  status: 'imported' | 'skipped' | 'failed';
  skipReason: string | null;
  submittedAt: string | null;
  platform: string | null;
  isOrganic: boolean;
  leadStatus: string | null;
  campaignName: string | null;
  adName: string | null;
  adsetName: string | null;
  formName: string | null;
  fields: LeadSubmissionField[];
  hasEmail: boolean;
  hasPhone: boolean;
}

/** A number the current user may send from right now. */
export interface SendableAccount {
  id: string;
  name: string;
  brandKey: string | null;
}

export interface RevealPhoneResult {
  contactId: string;
  leadId: string;
  phone: string | null;
}

export interface ConversationTagsResult {
  conversationId: string;
  tags: string[];
}

/** Organization-level settings an admin edits on the Settings page. */
export interface OrganizationSettings {
  /** The owner's own phone, digits only, or null when the server default is in charge. */
  ownerWhatsappNumber: string | null;
}

export interface AuthSessionData {
  accessToken: string;
  tokenType?: 'Bearer';
  user: User;
  organization: Organization;
  permissions: string[];
  session?: unknown;
}
