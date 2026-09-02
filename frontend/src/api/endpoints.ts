import { apiFetch } from './client';
import {
  type AccountAccessMode,
  type AccountQrPayload,
  type AccountRemoval,
  type ActivityLog,
  type AiBrainApproval,
  type AiBrainApprovalResolution,
  type AiBrainOutcome,
  type AiBrainProposalContent,
  type AiBrainRenderedProposal,
  type AiDraft,
  type AiDraftOutcome,
  type AiKnowledge,
  type AiKnowledgeCategory,
  type ApiSuccessResponse,
  type AssignableRole,
  type AuthResponse,
  type Conversation,
  type ConversationAiSummary,
  type ConversationDetail,
  type ConversationTagsResult,
  type FollowUpPriority,
  type FollowUpTask,
  type FollowUpType,
  type LeadSource,
  type LeadSourceStatus,
  type LeadSubmission,
  type Message,
  type MetaConnectionTest,
  type MetaLeadFormSummary,
  type Note,
  type NoteVisibility,
  type OrganizationSettings,
  type QueryParams,
  type RevealPhoneResult,
  type Role,
  type SendableAccount,
  type Stage,
  type StageKey,
  type StageStatus,
  type Tag,
  type User,
  type UserStatus,
  type WhatsAppAccount,
} from '../types';

// --- Auth (cookie-based refresh; no token needed for these three) ---

export interface LoginParams {
  organizationSlug: string;
  email: string;
  password: string;
}

export const login = ({ organizationSlug, email, password }: LoginParams): Promise<AuthResponse> =>
  apiFetch('/auth/login', {
    method: 'POST',
    body: { organizationSlug, email, password },
  });

export const refresh = (): Promise<AuthResponse> => apiFetch('/auth/refresh', { method: 'POST' });

export const logout = (): Promise<ApiSuccessResponse<unknown>> =>
  apiFetch('/auth/logout', { method: 'POST' });

// --- CRM (Bearer token required) ---

const buildQuery = (params: QueryParams = {}): string => {
  const search = new URLSearchParams();

  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      search.set(key, String(value));
    }
  });

  const query = search.toString();

  return query ? `?${query}` : '';
};

export interface TokenParams {
  token?: string | null;
}

export interface ListConversationsParams extends TokenParams {
  stage?: StageKey | null;
  tagIds?: readonly string[] | null;
  status?: string | null;
  limit?: number;
  skip?: number;
}

export const listConversations = ({
  token,
  stage,
  tagIds,
  status,
  limit,
  skip,
}: ListConversationsParams = {}): Promise<ApiSuccessResponse<Conversation[]>> =>
  apiFetch(
    `/conversations${buildQuery({
      stage,
      // Match-ALL on the server; omitted entirely when nothing is selected.
      tagIds: tagIds?.length ? tagIds.join(',') : undefined,
      status,
      limit,
      skip,
    })}`,
    { token },
  );

export interface ConversationIdParams extends TokenParams {
  conversationId: string;
}

export const getConversation = ({
  token,
  conversationId,
}: ConversationIdParams): Promise<ApiSuccessResponse<ConversationDetail>> =>
  apiFetch(`/conversations/${conversationId}`, { token });

/**
 * The AI's catch-up read, as stored. A GET never generates one - opening a thread must not cost
 * an ai-brain-service call - so `data` is null until someone has asked for a summary.
 */
export const getConversationSummary = ({
  token,
  conversationId,
}: ConversationIdParams): Promise<ApiSuccessResponse<ConversationAiSummary | null>> =>
  apiFetch(`/conversations/${conversationId}/summary`, { token });

export interface RegenerateConversationSummaryParams extends ConversationIdParams {
  /** Re-read the same messages anyway. Without it, a summary that is still current is served
   *  back untouched rather than spending a call. */
  force?: boolean;
}

export const regenerateConversationSummary = ({
  token,
  conversationId,
  force,
}: RegenerateConversationSummaryParams): Promise<
  ApiSuccessResponse<ConversationAiSummary | null>
> =>
  apiFetch(`/conversations/${conversationId}/summary`, {
    method: 'POST',
    token,
    body: { force: force ?? false },
  });

export interface GetMessagesParams extends ConversationIdParams {
  beforeSentAt?: string | null;
  beforeId?: string | null;
  limit?: number;
}

export const getMessages = ({
  token,
  conversationId,
  beforeSentAt,
  beforeId,
  limit,
}: GetMessagesParams): Promise<ApiSuccessResponse<Message[]>> =>
  apiFetch(
    `/conversations/${conversationId}/messages${buildQuery({ beforeSentAt, beforeId, limit })}`,
    { token },
  );

export interface SendMessageParams extends ConversationIdParams {
  body: string;
  idempotencyKey: string;
  /** Omit to send from the number the thread is already on. */
  whatsappAccountId?: string | null;
}

export const sendMessage = ({
  token,
  conversationId,
  body,
  idempotencyKey,
  whatsappAccountId,
}: SendMessageParams): Promise<ApiSuccessResponse<Message>> =>
  apiFetch(`/conversations/${conversationId}/messages`, {
    method: 'POST',
    token,
    body: whatsappAccountId
      ? { body, idempotencyKey, whatsappAccountId }
      : { body, idempotencyKey },
  });

export const listSendableAccounts = ({ token }: TokenParams = {}): Promise<
  ApiSuccessResponse<SendableAccount[]>
> => apiFetch('/whatsapp-accounts/sendable', { token });

export const getLeadSubmissions = ({
  token,
  conversationId,
}: ConversationIdParams): Promise<ApiSuccessResponse<LeadSubmission[]>> =>
  apiFetch(`/conversations/${conversationId}/lead-submissions`, { token });

// --- Lead CRM (Phase 9 surface) ---

export interface ChangeStageParams extends ConversationIdParams {
  stage: StageKey;
}

export const changeStage = ({
  token,
  conversationId,
  stage,
}: ChangeStageParams): Promise<ApiSuccessResponse<Conversation>> =>
  apiFetch(`/conversations/${conversationId}/stage`, {
    method: 'PATCH',
    token,
    body: { stage },
  });

export interface AssignConversationParams extends ConversationIdParams {
  assignedTo: string | null;
}

export const assignConversation = ({
  token,
  conversationId,
  assignedTo,
}: AssignConversationParams): Promise<ApiSuccessResponse<Conversation>> =>
  apiFetch(`/conversations/${conversationId}/assignment`, {
    method: 'PATCH',
    token,
    body: { assignedTo },
  });

export interface GetActivityParams extends ConversationIdParams {
  limit?: number;
}

export const getActivity = ({
  token,
  conversationId,
  limit,
}: GetActivityParams): Promise<ApiSuccessResponse<ActivityLog[]>> =>
  apiFetch(`/conversations/${conversationId}/activity${buildQuery({ limit })}`, { token });

export const listNotes = ({
  token,
  conversationId,
}: ConversationIdParams): Promise<ApiSuccessResponse<Note[]>> =>
  apiFetch(`/conversations/${conversationId}/notes`, { token });

export interface CreateNoteParams extends ConversationIdParams {
  body: string;
  visibility: NoteVisibility;
}

export const createNote = ({
  token,
  conversationId,
  body,
  visibility,
}: CreateNoteParams): Promise<ApiSuccessResponse<Note>> =>
  apiFetch(`/conversations/${conversationId}/notes`, {
    method: 'POST',
    token,
    body: { body, visibility },
  });

export interface DeleteNoteParams extends ConversationIdParams {
  noteId: string;
}

export const deleteNote = ({
  token,
  conversationId,
  noteId,
}: DeleteNoteParams): Promise<ApiSuccessResponse<Note>> =>
  apiFetch(`/conversations/${conversationId}/notes/${noteId}`, { method: 'DELETE', token });

export const listTags = ({ token }: TokenParams = {}): Promise<ApiSuccessResponse<Tag[]>> =>
  apiFetch('/tags', { token });

export interface CreateTagParams extends TokenParams {
  name: string;
  slug?: string;
  color?: string | null;
  description?: string | null;
}

export const createTag = ({
  token,
  name,
  slug,
  color,
  description,
}: CreateTagParams): Promise<ApiSuccessResponse<Tag>> =>
  apiFetch('/tags', {
    method: 'POST',
    token,
    body: { name, slug, color, description },
  });

export interface TagIdParams extends TokenParams {
  tagId: string;
}

export const archiveTag = ({ token, tagId }: TagIdParams): Promise<ApiSuccessResponse<Tag>> =>
  apiFetch(`/tags/${tagId}/archive`, { method: 'PATCH', token });

export interface ConversationTagParams extends ConversationIdParams {
  tagId: string;
}

export const attachTag = ({
  token,
  conversationId,
  tagId,
}: ConversationTagParams): Promise<ApiSuccessResponse<ConversationTagsResult>> =>
  apiFetch(`/conversations/${conversationId}/tags`, {
    method: 'POST',
    token,
    body: { tagId },
  });

export const detachTag = ({
  token,
  conversationId,
  tagId,
}: ConversationTagParams): Promise<ApiSuccessResponse<ConversationTagsResult>> =>
  apiFetch(`/conversations/${conversationId}/tags/${tagId}`, { method: 'DELETE', token });

export interface ListStagesParams extends TokenParams {
  status?: StageStatus;
}

export const listStages = ({ token, status }: ListStagesParams = {}): Promise<
  ApiSuccessResponse<Stage[]>
> => apiFetch(`/stages${buildQuery({ status })}`, { token });

export interface CreateStageParams extends TokenParams {
  label: string;
  key?: string;
  color?: string | null;
}

export const createStage = ({
  token,
  label,
  key,
  color,
}: CreateStageParams): Promise<ApiSuccessResponse<Stage>> =>
  apiFetch('/stages', {
    method: 'POST',
    token,
    body: { label, key, color },
  });

export interface StageIdParams extends TokenParams {
  stageId: string;
}

export const archiveStage = ({
  token,
  stageId,
}: StageIdParams): Promise<ApiSuccessResponse<Stage>> =>
  apiFetch(`/stages/${stageId}/archive`, { method: 'PATCH', token });

export const deleteStage = ({
  token,
  stageId,
}: StageIdParams): Promise<ApiSuccessResponse<Stage>> =>
  apiFetch(`/stages/${stageId}`, { method: 'DELETE', token });

export const getSettings = ({
  token,
}: TokenParams = {}): Promise<ApiSuccessResponse<OrganizationSettings>> =>
  apiFetch('/settings', { token });

export interface UpdateSettingsParams extends TokenParams {
  ownerWhatsappNumber: string | null;
}

export const updateSettings = ({
  token,
  ownerWhatsappNumber,
}: UpdateSettingsParams): Promise<ApiSuccessResponse<OrganizationSettings>> =>
  apiFetch('/settings', {
    method: 'PATCH',
    token,
    body: { ownerWhatsappNumber },
  });

export const listConversationFollowUps = ({
  token,
  conversationId,
}: ConversationIdParams): Promise<ApiSuccessResponse<FollowUpTask[]>> =>
  apiFetch(`/conversations/${conversationId}/follow-ups`, { token });

export interface CreateFollowUpParams extends ConversationIdParams {
  type: FollowUpType;
  note?: string | null;
  dueAt: string;
  priority?: FollowUpPriority;
}

export const createFollowUp = ({
  token,
  conversationId,
  type,
  note,
  dueAt,
  priority,
}: CreateFollowUpParams): Promise<ApiSuccessResponse<FollowUpTask>> =>
  apiFetch(`/conversations/${conversationId}/follow-ups`, {
    method: 'POST',
    token,
    body: { type, note, dueAt, priority },
  });

export interface FollowUpIdParams extends TokenParams {
  taskId: string;
}

export const completeFollowUp = ({
  token,
  taskId,
}: FollowUpIdParams): Promise<ApiSuccessResponse<FollowUpTask>> =>
  apiFetch(`/follow-ups/${taskId}/complete`, { method: 'PATCH', token });

export const cancelFollowUp = ({
  token,
  taskId,
}: FollowUpIdParams): Promise<ApiSuccessResponse<FollowUpTask>> =>
  apiFetch(`/follow-ups/${taskId}/cancel`, { method: 'PATCH', token });

export interface RevealPhoneParams extends TokenParams {
  contactId: string;
}

export const revealPhone = ({
  token,
  contactId,
}: RevealPhoneParams): Promise<ApiSuccessResponse<RevealPhoneResult>> =>
  apiFetch(`/contacts/${contactId}/reveal-phone`, { method: 'POST', token });

// --- WhatsApp accounts (Phase 13) ---

export const listAccounts = ({ token }: TokenParams = {}): Promise<
  ApiSuccessResponse<WhatsAppAccount[]>
> => apiFetch('/whatsapp-accounts', { token });

export interface AccountIdParams extends TokenParams {
  accountId: string;
}

export const getAccount = ({
  token,
  accountId,
}: AccountIdParams): Promise<ApiSuccessResponse<WhatsAppAccount>> =>
  apiFetch(`/whatsapp-accounts/${accountId}`, { token });

export interface CreateAccountParams extends TokenParams {
  name: string;
  brandKey?: string | null;
  description?: string | null;
}

export const createAccount = ({
  token,
  name,
  brandKey,
  description,
}: CreateAccountParams): Promise<ApiSuccessResponse<WhatsAppAccount>> =>
  apiFetch('/whatsapp-accounts', {
    method: 'POST',
    token,
    body: { name, brandKey, description },
  });

export interface ConnectAccountParams extends AccountIdParams {
  pairingPhoneNumber?: string | null;
}

export const connectAccount = ({
  token,
  accountId,
  pairingPhoneNumber,
}: ConnectAccountParams): Promise<ApiSuccessResponse<WhatsAppAccount>> =>
  apiFetch(`/whatsapp-accounts/${accountId}/connect`, {
    method: 'POST',
    token,
    body: pairingPhoneNumber ? { pairingPhoneNumber } : {},
  });

export const getAccountQr = ({
  token,
  accountId,
}: AccountIdParams): Promise<ApiSuccessResponse<AccountQrPayload>> =>
  apiFetch(`/whatsapp-accounts/${accountId}/qr`, { token });

export const pauseAccount = ({
  token,
  accountId,
}: AccountIdParams): Promise<ApiSuccessResponse<WhatsAppAccount>> =>
  apiFetch(`/whatsapp-accounts/${accountId}/pause`, { method: 'POST', token });

export const resumeAccount = ({
  token,
  accountId,
}: AccountIdParams): Promise<ApiSuccessResponse<WhatsAppAccount>> =>
  apiFetch(`/whatsapp-accounts/${accountId}/resume`, { method: 'POST', token });

export const resetAccount = ({
  token,
  accountId,
}: AccountIdParams): Promise<ApiSuccessResponse<WhatsAppAccount>> =>
  apiFetch(`/whatsapp-accounts/${accountId}/reset`, { method: 'POST', token });

export const disconnectAccount = ({
  token,
  accountId,
}: AccountIdParams): Promise<ApiSuccessResponse<WhatsAppAccount>> =>
  apiFetch(`/whatsapp-accounts/${accountId}/disconnect`, { method: 'POST', token });

/**
 * Remove is not always a delete: the API deletes a number that has no history and soft-removes
 * (and hides) one that still owns conversations, messages or a lead source, and says which.
 */
export const removeAccount = ({
  token,
  accountId,
}: AccountIdParams): Promise<ApiSuccessResponse<AccountRemoval>> =>
  apiFetch(`/whatsapp-accounts/${accountId}`, { method: 'DELETE', token });

// --- Team / users (Phase 15) ---

export interface ListUsersParams extends TokenParams {
  role?: Role | null;
  status?: UserStatus | null;
  limit?: number;
  skip?: number;
}

export const listUsers = ({ token, role, status, limit, skip }: ListUsersParams = {}): Promise<
  ApiSuccessResponse<User[]>
> => apiFetch(`/users${buildQuery({ role, status, limit, skip })}`, { token });

export interface CreateUserParams extends TokenParams {
  name: string;
  email: string;
  password: string;
  role: AssignableRole;
  accountAccessMode?: AccountAccessMode;
  mustChangePassword?: boolean;
}

export const createUser = ({
  token,
  name,
  email,
  password,
  role,
  accountAccessMode = 'all',
  mustChangePassword = true,
}: CreateUserParams): Promise<ApiSuccessResponse<User>> =>
  apiFetch('/users', {
    method: 'POST',
    token,
    body: { name, email, password, role, accountAccessMode, mustChangePassword },
  });

export interface UpdateUserChanges {
  name?: string;
  email?: string;
  role?: AssignableRole;
  accountAccessMode?: AccountAccessMode;
  accountAccess?: string[];
  status?: UserStatus;
  mustChangePassword?: boolean;
}

export interface UpdateUserParams extends TokenParams, UpdateUserChanges {
  userId: string;
}

export const updateUser = ({
  token,
  userId,
  ...changes
}: UpdateUserParams): Promise<ApiSuccessResponse<User>> =>
  apiFetch(`/users/${userId}`, { method: 'PATCH', token, body: changes });

export interface UserIdParams extends TokenParams {
  userId: string;
}

export const disableUser = ({ token, userId }: UserIdParams): Promise<ApiSuccessResponse<User>> =>
  apiFetch(`/users/${userId}/disable`, { method: 'PATCH', token });

export const enableUser = ({ token, userId }: UserIdParams): Promise<ApiSuccessResponse<User>> =>
  apiFetch(`/users/${userId}/enable`, { method: 'PATCH', token });

export interface ResetUserPasswordParams extends UserIdParams {
  password: string;
  mustChangePassword?: boolean;
}

export const resetUserPassword = ({
  token,
  userId,
  password,
  mustChangePassword = true,
}: ResetUserPasswordParams): Promise<ApiSuccessResponse<User>> =>
  apiFetch(`/users/${userId}/reset-password`, {
    method: 'PATCH',
    token,
    body: { password, mustChangePassword },
  });

export interface ChangePasswordParams extends TokenParams {
  currentPassword: string;
  newPassword: string;
}

export const changePassword = ({
  token,
  currentPassword,
  newPassword,
}: ChangePasswordParams): Promise<ApiSuccessResponse<{ user: User }>> =>
  apiFetch('/auth/change-password', {
    method: 'POST',
    token,
    body: { currentPassword, newPassword },
  });

// --- AI reply assistant + knowledge base (Phase 17) ---

export const generateAiDraft = ({
  token,
  conversationId,
}: ConversationIdParams): Promise<ApiSuccessResponse<AiDraft>> =>
  apiFetch(`/conversations/${conversationId}/ai-draft`, { method: 'POST', token });

export interface RecordAiDraftOutcomeParams extends ConversationIdParams {
  draftId: string;
  outcome: AiDraftOutcome;
}

export const recordAiDraftOutcome = ({
  token,
  conversationId,
  draftId,
  outcome,
}: RecordAiDraftOutcomeParams): Promise<ApiSuccessResponse<AiDraft>> =>
  apiFetch(`/conversations/${conversationId}/ai-draft/${draftId}/outcome`, {
    method: 'PATCH',
    token,
    body: { outcome },
  });

export const listAiKnowledge = ({ token }: TokenParams = {}): Promise<
  ApiSuccessResponse<AiKnowledge[]>
> => apiFetch('/ai/knowledge', { token });

export interface CreateAiKnowledgeParams extends TokenParams {
  label: string;
  content: string;
  category: AiKnowledgeCategory;
}

export const createAiKnowledge = ({
  token,
  label,
  content,
  category,
}: CreateAiKnowledgeParams): Promise<ApiSuccessResponse<AiKnowledge>> =>
  apiFetch('/ai/knowledge', {
    method: 'POST',
    token,
    body: { label, content, category },
  });

export interface ArchiveAiKnowledgeParams extends TokenParams {
  knowledgeId: string;
}

export const archiveAiKnowledge = ({
  token,
  knowledgeId,
}: ArchiveAiKnowledgeParams): Promise<ApiSuccessResponse<AiKnowledge>> =>
  apiFetch(`/ai/knowledge/${knowledgeId}/archive`, { method: 'PATCH', token });

// --- Lead sources (Meta lead-ads sheet import) ---

export const listLeadSources = ({ token }: TokenParams = {}): Promise<
  ApiSuccessResponse<LeadSource[]>
> => apiFetch('/lead-sources', { token });

export interface CreateLeadSourceParams extends TokenParams {
  name: string;
  sheetUrl: string;
  whatsappAccountId: string;
  defaultCountryCode?: string;
  aiContextEnabled?: boolean;
  importExisting?: boolean;
}

/** Connects a Google Sheet. `kind` is omitted; the API defaults it, as it does for older clients. */
export const createLeadSource = ({
  token,
  name,
  sheetUrl,
  whatsappAccountId,
  defaultCountryCode,
  aiContextEnabled,
  importExisting,
}: CreateLeadSourceParams): Promise<ApiSuccessResponse<LeadSource>> =>
  apiFetch('/lead-sources', {
    method: 'POST',
    token,
    body: { name, sheetUrl, whatsappAccountId, defaultCountryCode, aiContextEnabled, importExisting },
  });

export interface CreateMetaLeadSourceParams extends TokenParams {
  name: string;
  /** The Page access token. Sent once, stored encrypted, never returned by any endpoint. */
  accessToken: string;
  pageId: string;
  pageName?: string | null;
  /** Omit or pass null for every lead form on the page. */
  formId?: string | null;
  formName?: string | null;
  whatsappAccountId: string;
  defaultCountryCode?: string;
  aiContextEnabled?: boolean;
  importExisting?: boolean;
}

export const createMetaLeadSource = ({
  token,
  ...body
}: CreateMetaLeadSourceParams): Promise<ApiSuccessResponse<LeadSource>> =>
  apiFetch('/lead-sources', {
    method: 'POST',
    token,
    body: { kind: 'meta_lead_ads', ...body },
  });

export interface TestMetaConnectionParams extends TokenParams {
  accessToken: string;
}

/**
 * Checks a pasted token before anything is saved, and reports the pages it can reach.
 * POST, not GET: a token in a query string would be written to every access log on the way.
 */
export const testMetaLeadSourceConnection = ({
  token,
  accessToken,
}: TestMetaConnectionParams): Promise<ApiSuccessResponse<MetaConnectionTest>> =>
  apiFetch('/lead-sources/meta/test-connection', {
    method: 'POST',
    token,
    body: { accessToken },
  });

export interface ListMetaLeadFormsParams extends TokenParams {
  accessToken: string;
  pageId: string;
}

export const listMetaLeadForms = ({
  token,
  accessToken,
  pageId,
}: ListMetaLeadFormsParams): Promise<ApiSuccessResponse<MetaLeadFormSummary[]>> =>
  apiFetch('/lead-sources/meta/forms', {
    method: 'POST',
    token,
    body: { accessToken, pageId },
  });

export interface UpdateLeadSourceParams extends TokenParams {
  leadSourceId: string;
  name?: string;
  whatsappAccountId?: string;
  defaultCountryCode?: string;
  aiContextEnabled?: boolean;
  status?: LeadSourceStatus;
  /** Meta sources only: rotate the token, or repoint at a different form. */
  accessToken?: string;
  formId?: string | null;
  formName?: string | null;
}

export const updateLeadSource = ({
  token,
  leadSourceId,
  ...changes
}: UpdateLeadSourceParams): Promise<ApiSuccessResponse<LeadSource>> =>
  apiFetch(`/lead-sources/${leadSourceId}`, { method: 'PATCH', token, body: changes });

export interface LeadSourceIdParams extends TokenParams {
  leadSourceId: string;
}

export const syncLeadSource = ({
  token,
  leadSourceId,
}: LeadSourceIdParams): Promise<ApiSuccessResponse<LeadSource>> =>
  apiFetch(`/lead-sources/${leadSourceId}/sync`, { method: 'POST', token });

export const deleteLeadSource = ({
  token,
  leadSourceId,
}: LeadSourceIdParams): Promise<ApiSuccessResponse<unknown>> =>
  apiFetch(`/lead-sources/${leadSourceId}`, { method: 'DELETE', token });

// --- AI brain automation (qualifying chat, human-review approvals, won/lost, proposals) ---

export const listPendingAiApprovals = ({
  token,
  limit,
  skip,
}: TokenParams & { limit?: number; skip?: number } = {}): Promise<
  ApiSuccessResponse<AiBrainApproval[]>
> => apiFetch(`/ai-brain/approvals${buildQuery({ limit, skip })}`, { token });

export const getAiApproval = ({
  token,
  conversationId,
}: ConversationIdParams): Promise<ApiSuccessResponse<AiBrainApproval | null>> =>
  apiFetch(`/ai-brain/conversations/${conversationId}/approval`, { token });

export interface ResolveAiApprovalParams extends ConversationIdParams {
  verdict: AiBrainApprovalResolution;
  instruction?: string;
}

export const resolveAiApproval = ({
  token,
  conversationId,
  verdict,
  instruction,
}: ResolveAiApprovalParams): Promise<
  ApiSuccessResponse<{ approval: AiBrainApproval | null; sent: boolean }>
> =>
  apiFetch(`/ai-brain/conversations/${conversationId}/approval/resolve`, {
    method: 'POST',
    token,
    body: { verdict, instruction },
  });

export interface SetAiAutomationParams extends ConversationIdParams {
  enabled: boolean;
}

export const setAiAutomation = ({
  token,
  conversationId,
  enabled,
}: SetAiAutomationParams): Promise<ApiSuccessResponse<Conversation>> =>
  apiFetch(`/ai-brain/conversations/${conversationId}/automation`, {
    method: 'POST',
    token,
    body: { enabled },
  });

export const checkAiOutcome = ({
  token,
  conversationId,
}: ConversationIdParams): Promise<ApiSuccessResponse<AiBrainOutcome>> =>
  apiFetch(`/ai-brain/conversations/${conversationId}/outcome/check`, {
    method: 'POST',
    token,
  });

export interface GenerateAiProposalParams extends ConversationIdParams {
  clientName?: string;
}

export const generateAiProposal = ({
  token,
  conversationId,
  clientName,
}: GenerateAiProposalParams): Promise<ApiSuccessResponse<AiBrainProposalContent>> =>
  apiFetch(`/ai-brain/conversations/${conversationId}/proposal/generate`, {
    method: 'POST',
    token,
    body: { clientName },
  });

export interface ReviseAiProposalParams extends TokenParams {
  content: AiBrainProposalContent;
  instruction: string;
}

export const reviseAiProposal = ({
  token,
  content,
  instruction,
}: ReviseAiProposalParams): Promise<ApiSuccessResponse<AiBrainProposalContent>> =>
  apiFetch('/ai-brain/proposal/revise', {
    method: 'POST',
    token,
    body: { content, instruction },
  });

export interface RenderAiProposalParams extends ConversationIdParams {
  content: AiBrainProposalContent;
  version?: number;
}

export const renderAiProposal = ({
  token,
  conversationId,
  content,
  version,
}: RenderAiProposalParams): Promise<ApiSuccessResponse<AiBrainRenderedProposal>> =>
  apiFetch(`/ai-brain/conversations/${conversationId}/proposal/render`, {
    method: 'POST',
    token,
    body: { content, version },
  });
