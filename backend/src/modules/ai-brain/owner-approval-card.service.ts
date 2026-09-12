/**
 * The WhatsApp side of AI-draft approval: sends the owner a short "card" in their own
 * self-chat for each new (or freshly revised) pending draft, and parses their typed reply back
 * into the same approve/edit/skip decision the dashboard's Approve/Revise/Skip buttons make.
 *
 * A faithful, scoped-down port of the reference implementation's `services/approvals.py`:
 *  - `_new_code()`      -> approval-code.ts's generateApprovalCode / the repository's
 *                          generateUniqueApprovalCode.
 *  - `_resolve_target()` -> splitIntoCodeSegments + resolveApprovalTarget below.
 *  - `_classify()`       -> classifyApprovalReplyText below.
 */
import { type ObjectIdLike } from '../../types/common.js';
import { logger as defaultLogger } from '../../config/logger.js';
import { ACTIVITY_EVENTS } from '../../constants/activity-events.js';
import {
  AI_BRAIN_APPROVAL_KINDS,
  AI_BRAIN_APPROVAL_RESOLUTIONS,
  AI_BRAIN_OUTCOME_DECISIONS,
  type AiBrainApprovalResolution,
} from '../../constants/ai-brain-statuses.js';
import { CONVERSATION_STAGES } from '../../constants/conversation-stages.js';
import { createActivity as defaultCreateActivity } from '../activity/activity-log.repository.js';
import {
  bumpNurtureStep as defaultBumpNurtureStep,
  findConversationById as defaultFindConversationById,
  findMostRecentlyEscalatedConversation as defaultFindMostRecentlyEscalatedConversation,
  updateAutomationState as defaultUpdateAutomationState,
  updateStage as defaultUpdateStage,
} from '../conversations/conversation.repository.js';
import { REALTIME_REASONS } from '../realtime/realtime.events.js';
import { enqueueConversationChanged as defaultEnqueueConversationChanged } from '../realtime/realtime-outbox.repository.js';
import {
  createOwnerNotifyService,
  type NotifyOwnerParams,
  type NotifyOwnerResult,
  type OwnerNotifyServiceHandle,
} from '../whatsapp/automation/owner-notify.service.js';
import {
  listPendingApprovals as defaultListPendingApprovals,
  resolveApproval as defaultResolveApproval,
} from './ai-brain-approval.repository.js';
import {
  resolveApprovalForActor as defaultResolveApprovalForActor,
  resumeEscalatedConversationWithInstruction as defaultResumeEscalatedConversationWithInstruction,
} from './ai-brain.service.js';
import { getOwnerActorForOrganization as defaultGetOwnerActorForOrganization } from './owner-actor.service.js';
import { handleOwnerQuestion as defaultHandleOwnerQuestion } from './owner-assistant.service.js';

type Logger = { error?: (...args: unknown[]) => void };
type NotifyOwnerFn = (params?: NotifyOwnerParams) => Promise<NotifyOwnerResult>;
type ListPendingApprovalsFn = (options: {
  organizationId?: ObjectIdLike;
  limit?: number;
}) => Promise<PendingApprovalRecord[]>;

// Lazily constructed (not at module scope) so this never has to evaluate `getSessionManager()`
// / anything downstream of it before the whole module graph has finished loading. This module
// and ai-brain.service.ts import each other (a card fires from ai-brain.service.ts's own
// approval-creation code, and this module calls resolveApprovalForActor back on it); every
// cross-reference here is read lazily, inside a function body, for exactly that reason.
let ownerNotifyServiceSingleton: OwnerNotifyServiceHandle | null = null;
const getOwnerNotifyService = (): OwnerNotifyServiceHandle => {
  ownerNotifyServiceSingleton ??= createOwnerNotifyService();
  return ownerNotifyServiceSingleton;
};

// --------------------------------------------------------------------------
// Card text.
// --------------------------------------------------------------------------
const MAX_DRAFT_PREVIEW_LENGTH = 300;

const previewDraft = (draft: string): string => {
  const trimmed = (draft ?? '').trim();
  return trimmed.length > MAX_DRAFT_PREVIEW_LENGTH
    ? `${trimmed.slice(0, MAX_DRAFT_PREVIEW_LENGTH).trimEnd()}…`
    : trimmed;
};

export const buildApprovalCardText = ({
  leadDisplayName,
  draft,
  code,
}: {
  leadDisplayName: string;
  draft: string;
  code: string;
}): string =>
  `New draft for ${leadDisplayName}:\n"${previewDraft(draft)}"\n\nReply ${code} 1 to send, ${code} 2 to revise, ${code} 3 to skip.`;

/**
 * The two lines of the AI's catch-up read that fit on a phone. The full summary lives in the
 * dashboard (see conversation-summary.service.ts); this is the part worth carrying into
 * WhatsApp, and nothing more.
 */
export interface HandoverCardSummary {
  headline: string;
  suggestedNextStep: string;
  /** Messages have arrived since it was read. Said out loud rather than quietly implied. */
  stale?: boolean;
}

const MAX_SUMMARY_LINE_LENGTH = 160;

const summaryLine = (text: string | undefined | null): string => {
  const trimmed = (text ?? '').replace(/\s+/g, ' ').trim();
  return trimmed.length > MAX_SUMMARY_LINE_LENGTH
    ? `${trimmed.slice(0, MAX_SUMMARY_LINE_LENGTH).trimEnd()}…`
    : trimmed;
};

/**
 * The summary block appended to a handover card. Empty string when there is nothing worth
 * saying - a card with a blank "Where it stands:" under it is worse than a card without one.
 */
export const buildHandoverSummaryBlock = (summary?: HandoverCardSummary | null): string => {
  if (!summary) {
    return '';
  }

  const headline = summaryLine(summary.headline);
  const nextStep = summaryLine(summary.suggestedNextStep);

  if (!headline && !nextStep) {
    return '';
  }

  const lines: string[] = [];

  if (headline) {
    lines.push(`Where it stands: ${headline}`);
  }
  if (nextStep) {
    lines.push(`Next: ${nextStep}`);
  }
  if (summary.stale) {
    lines.push('(Read before the latest messages.)');
  }

  return lines.join('\n');
};

/**
 * The morning handover read's card (Phase 5). Deliberately a question, not an action: the AI
 * never silently closes a deal off its own reading, because a mis-read on a closed deal is
 * expensive. `verdict` is the reading that raised the card and decides what 1/2/3 mean.
 *
 * This is the "owner is coming back to this thread" moment, so it carries the two-line catch-up
 * above the question when one has already been generated - the owner should be able to answer
 * 1/2/3 without opening the thread and scrolling it. Only a STORED summary ever reaches here;
 * the morning read never generates one (see handover-read.service.ts on why).
 */
export const buildHandoverCardText = ({
  leadDisplayName,
  verdict,
  code,
  summary,
}: {
  leadDisplayName: string;
  verdict: string;
  code: string;
  summary?: HandoverCardSummary | null;
}): string => {
  const question =
    verdict === AI_BRAIN_OUTCOME_DECISIONS.WON || verdict === AI_BRAIN_OUTCOME_DECISIONS.LOST
      ? (() => {
          const label = verdict === AI_BRAIN_OUTCOME_DECISIONS.WON ? 'Won' : 'Lost';

          return `${leadDisplayName} — looks like this one's ${label}. Reply ${code} 1 to mark it ${label}, ${code} 2 if it's still open, ${code} 3 to leave it with you.`;
        })()
      : `${leadDisplayName} — I can't tell where this stands. Reply ${code} 1 if you're on it, ${code} 2 if I should follow up, ${code} 3 if it's finished.`;

  const block = buildHandoverSummaryBlock(summary);

  return block ? `${block}\n\n${question}` : question;
};

// --------------------------------------------------------------------------
// (a) Sending a card.
// --------------------------------------------------------------------------
export interface SendApprovalCardParams {
  organizationId?: ObjectIdLike;
  accountId?: ObjectIdLike;
  conversationId?: ObjectIdLike;
  approvalId?: ObjectIdLike;
  draft: string;
  leadDisplayName: string;
  code: string;
  notifyOwner?: NotifyOwnerFn;
  logger?: Logger;
}

/**
 * Best-effort side effect: the dashboard's own pending-approval card is the source of truth, so
 * a failure here (most commonly: no running WhatsApp session yet) is logged and swallowed, never
 * thrown - the caller's approval flow must keep working either way.
 */
export const sendApprovalCard = async ({
  organizationId,
  accountId,
  conversationId,
  approvalId,
  draft,
  leadDisplayName,
  code,
  notifyOwner = getOwnerNotifyService().notifyOwner,
  logger = defaultLogger,
}: SendApprovalCardParams): Promise<void> => {
  try {
    await notifyOwner({
      accountId,
      organizationId,
      text: buildApprovalCardText({ leadDisplayName, draft, code }),
    });
  } catch (error: unknown) {
    const err = error as { code?: unknown; name?: unknown };
    logger?.error?.(
      {
        code: err?.code,
        name: err?.name,
        organizationId: organizationId?.toString?.(),
        conversationId: conversationId?.toString?.(),
        approvalId: approvalId?.toString?.(),
      },
      'Owner WhatsApp approval-card send failed safely; the dashboard approval flow continues.',
    );
  }
};

// --------------------------------------------------------------------------
// (a2) Escalation alert - the AI has stopped and needs a person.
// --------------------------------------------------------------------------
export interface SendEscalationAlertParams {
  organizationId?: ObjectIdLike;
  accountId?: ObjectIdLike;
  conversationId?: ObjectIdLike;
  leadDisplayName: string;
  /** Why the AI stopped, in its own words (a discount ask, a complaint, something unanswerable). */
  reason: string;
  /** The lead's most recent message, quoted so the owner can act without opening the dashboard. */
  lastLeadMessage?: string | null;
  notifyOwner?: NotifyOwnerFn;
  logger?: Logger;
}

const ESCALATION_QUOTE_MAX_LENGTH = 300;

export const buildEscalationAlertText = ({
  leadDisplayName,
  reason,
  lastLeadMessage,
}: Pick<
  SendEscalationAlertParams,
  'leadDisplayName' | 'reason' | 'lastLeadMessage'
>): string => {
  const quoted = (lastLeadMessage ?? '').trim();
  const lines = [
    `✋ Needs you — ${leadDisplayName}`,
    '',
    reason.trim() || 'The AI needs a person on this.',
  ];

  if (quoted !== '') {
    lines.push(
      '',
      'Last message:',
      quoted.length > ESCALATION_QUOTE_MAX_LENGTH
        ? `${quoted.slice(0, ESCALATION_QUOTE_MAX_LENGTH)}…`
        : quoted,
    );
  }

  lines.push('', "Automation is paused for this lead. Reply in their chat when you've handled it.");

  return lines.join('\n');
};

/**
 * Tells the owner, on their own WhatsApp, that the AI has stepped back from a lead.
 *
 * Without this an escalation is silent: automation switches off and a reason is recorded, but
 * nobody finds out until someone happens to open the dashboard - which, for a lead actively
 * waiting on an answer about money, is the worst possible moment to be slow. Same best-effort
 * contract as the other cards: a WhatsApp failure is logged, never thrown, because the pause has
 * already been committed and must stand regardless.
 */
export const sendEscalationAlert = async ({
  organizationId,
  accountId,
  conversationId,
  leadDisplayName,
  reason,
  lastLeadMessage,
  notifyOwner = getOwnerNotifyService().notifyOwner,
  logger = defaultLogger,
}: SendEscalationAlertParams): Promise<void> => {
  try {
    await notifyOwner({
      accountId,
      organizationId,
      text: buildEscalationAlertText({ leadDisplayName, reason, lastLeadMessage }),
    });
  } catch (error: unknown) {
    const err = error as { code?: unknown; name?: unknown };
    logger?.error?.(
      {
        code: err?.code,
        name: err?.name,
        organizationId: organizationId?.toString?.(),
        conversationId: conversationId?.toString?.(),
      },
      'Owner WhatsApp escalation alert failed safely; automation stays paused and the dashboard shows why.',
    );
  }
};

// --------------------------------------------------------------------------
// (a3) Opt-out alert - the lead asked to stop, so automation is off for good.
// --------------------------------------------------------------------------
export interface SendOptOutAlertParams {
  organizationId?: ObjectIdLike;
  accountId?: ObjectIdLike;
  conversationId?: ObjectIdLike;
  leadDisplayName: string;
  /** What the lead actually typed ("stop", "band karo"), quoted so the owner can judge it. */
  lastLeadMessage?: string | null;
  notifyOwner?: NotifyOwnerFn;
  logger?: Logger;
}

const OPT_OUT_QUOTE_MAX_LENGTH = 200;

export const buildOptOutAlertText = ({
  leadDisplayName,
  lastLeadMessage,
}: Pick<SendOptOutAlertParams, 'leadDisplayName' | 'lastLeadMessage'>): string => {
  const quoted = (lastLeadMessage ?? '').trim();
  const lines = [`🚫 Opted out — ${leadDisplayName}`, '', 'They asked to stop being messaged.'];

  if (quoted !== '') {
    lines.push(
      '',
      quoted.length > OPT_OUT_QUOTE_MAX_LENGTH
        ? `"${quoted.slice(0, OPT_OUT_QUOTE_MAX_LENGTH)}…"`
        : `"${quoted}"`,
    );
  }

  lines.push('', 'Automation is off for this lead and will not come back on.');

  return lines.join('\n');
};

/**
 * Tells the owner, on their own WhatsApp, that a lead has opted out.
 *
 * The owner needs to know for two reasons: the lead has effectively left the pipeline, and if
 * the owner still wants to reply personally they now have to do it themselves - nothing
 * automated will ever go to this number again. Same best-effort contract as the escalation alert
 * above: a WhatsApp failure is logged, never thrown, because the opt-out is already committed
 * and must stand whether or not the owner's phone was reachable.
 */
export const sendOptOutAlert = async ({
  organizationId,
  accountId,
  conversationId,
  leadDisplayName,
  lastLeadMessage,
  notifyOwner = getOwnerNotifyService().notifyOwner,
  logger = defaultLogger,
}: SendOptOutAlertParams): Promise<void> => {
  try {
    await notifyOwner({
      accountId,
      organizationId,
      text: buildOptOutAlertText({ leadDisplayName, lastLeadMessage }),
    });
  } catch (error: unknown) {
    const err = error as { code?: unknown; name?: unknown };
    logger?.error?.(
      {
        code: err?.code,
        name: err?.name,
        organizationId: organizationId?.toString?.(),
        conversationId: conversationId?.toString?.(),
      },
      'Owner WhatsApp opt-out alert failed safely; the opt-out itself is already recorded.',
    );
  }
};

export interface SendHandoverCardParams {
  organizationId?: ObjectIdLike;
  accountId?: ObjectIdLike;
  conversationId?: ObjectIdLike;
  approvalId?: ObjectIdLike;
  leadDisplayName: string;
  /** `won` / `lost` / `unclear` - the reading of the conversation that raised this card. */
  verdict: string;
  code: string;
  /** The stored catch-up read, when there is one. Omitted leaves the card exactly as it was. */
  summary?: HandoverCardSummary | null;
  notifyOwner?: NotifyOwnerFn;
  logger?: Logger;
}

/** Same best-effort contract as sendApprovalCard: a WhatsApp failure is logged, never thrown. */
export const sendHandoverCard = async ({
  organizationId,
  accountId,
  conversationId,
  approvalId,
  leadDisplayName,
  verdict,
  code,
  summary,
  notifyOwner = getOwnerNotifyService().notifyOwner,
  logger = defaultLogger,
}: SendHandoverCardParams): Promise<void> => {
  try {
    await notifyOwner({
      accountId,
      organizationId,
      text: buildHandoverCardText({ leadDisplayName, verdict, code, summary }),
    });
  } catch (error: unknown) {
    const err = error as { code?: unknown; name?: unknown };
    logger?.error?.(
      {
        code: err?.code,
        name: err?.name,
        organizationId: organizationId?.toString?.(),
        conversationId: conversationId?.toString?.(),
        approvalId: approvalId?.toString?.(),
      },
      'Owner WhatsApp handover-card send failed safely; the conversation stays owner-handled.',
    );
  }
};

// --------------------------------------------------------------------------
// (b) Parsing + acting on a reply.
// --------------------------------------------------------------------------

/** One `code`-targeted (or code-less) chunk of a possibly-bulk reply, e.g. "A7 1  B3 3". */
export interface ApprovalReplySegment {
  code: string | null;
  remainder: string;
}

// A leading/anywhere code token: one letter immediately followed by one digit, on word
// boundaries so it never matches mid-word (e.g. the "i5" inside "hi5").
const CODE_TOKEN_PATTERN = /\b([A-Za-z])(\d)\b/g;

/**
 * Splits a reply into `{ code, remainder }` segments. No code anywhere -> a single segment with
 * `code: null` and the whole (trimmed) text as `remainder`, left for implicit single-pending-card
 * targeting. One or more codes -> one segment per code, each `remainder` running from just after
 * that code to just before the next one (or the end of the message) - covers both the common
 * single-code case ("A7 1") and a bulk multi-code reply ("A7 1  B3 3"). Any text before the
 * first code is intentionally dropped; a code is always meant to lead its own segment.
 */
export const splitIntoCodeSegments = (text: string | undefined | null): ApprovalReplySegment[] => {
  const trimmed = (text ?? '').trim();

  if (!trimmed) {
    return [{ code: null, remainder: '' }];
  }

  const matches = [...trimmed.matchAll(CODE_TOKEN_PATTERN)];

  if (matches.length === 0) {
    return [{ code: null, remainder: trimmed }];
  }

  return matches.map((match, index) => {
    const code = `${match[1]?.toUpperCase()}${match[2]}`;
    const segmentStart = (match.index ?? 0) + match[0].length;
    const segmentEnd = matches[index + 1]?.index ?? trimmed.length;

    return { code, remainder: trimmed.slice(segmentStart, segmentEnd).trim() };
  });
};

const APPROVE_WORDS = new Set([
  '1',
  'yes',
  'y',
  'send',
  'ok',
  'okay',
  'sure',
  'go',
  'haan',
  'theek hai',
  'theek',
]);

const SKIP_WORDS = new Set(['3', 'skip', 'no', 'cancel', 'nah', 'nahi']);

export interface ClassifiedApprovalReply {
  verdict: AiBrainApprovalResolution;
  instruction: string;
}

/**
 * Classifies a reply segment's remainder (the text after its code, if any, has already been
 * stripped by splitIntoCodeSegments). Everything that isn't a recognized approve/skip word -
 * including a bare "2", "revise", "change to mention the discount", or any other free text - is
 * an "edit", and that text itself becomes the revision instruction.
 */
export const classifyApprovalReplyText = (remainder: string | undefined | null): ClassifiedApprovalReply => {
  const normalized = (remainder ?? '').trim();
  const key = normalized.toLowerCase();

  if (APPROVE_WORDS.has(key)) {
    return { verdict: AI_BRAIN_APPROVAL_RESOLUTIONS.APPROVE, instruction: '' };
  }

  if (SKIP_WORDS.has(key)) {
    return { verdict: AI_BRAIN_APPROVAL_RESOLUTIONS.SKIP, instruction: '' };
  }

  return { verdict: AI_BRAIN_APPROVAL_RESOLUTIONS.EDIT, instruction: normalized };
};

export interface PendingApprovalRecord {
  _id: ObjectIdLike;
  conversationId: ObjectIdLike;
  code?: string | null;
  /** Absent/undefined on records written before handover cards existed - i.e. a reply card. */
  kind?: string | null;
  handoverVerdict?: string | null;
}

export interface ResolveApprovalTargetResult {
  approval?: PendingApprovalRecord;
  ambiguous?: boolean;
  notFound?: boolean;
  pendingCodes?: string[];
}

/**
 * Resolves one segment's `code` (or lack of one) to the pending approval it refers to, within
 * the org-wide list of currently pending approvals (`pendingApprovals`):
 *  - an explicit code matches (or doesn't - `notFound`) against that exact code;
 *  - no code, exactly one pending approval -> that one, implicitly;
 *  - no code, 2+ pending -> `ambiguous`, with the still-pending codes to show the owner.
 */
export const resolveApprovalTarget = ({
  code,
  pendingApprovals,
}: {
  code: string | null;
  pendingApprovals: PendingApprovalRecord[];
}): ResolveApprovalTargetResult => {
  if (code) {
    const match = pendingApprovals.find((approval) => approval.code === code);
    return match ? { approval: match } : { notFound: true };
  }

  if (pendingApprovals.length === 1) {
    return { approval: pendingApprovals[0] };
  }

  if (pendingApprovals.length === 0) {
    return { notFound: true };
  }

  return {
    ambiguous: true,
    pendingCodes: pendingApprovals
      .map((approval) => approval.code)
      .filter((value): value is string => Boolean(value)),
  };
};

// --------------------------------------------------------------------------
// (c) Handover cards: applying the answer.
//
// A handover card is NOT routed through resolveApprovalForActor. That path is reply-draft
// specific - it calls ai-brain-service's /owner-decision to resume a LangGraph interrupt, and a
// handover card has no interrupt behind it, nothing paused, nothing to resume. The three
// answers are applied directly against this repo's own state instead.
// --------------------------------------------------------------------------

/** Which of the card's three options the owner picked, or null if the reply wasn't one of them. */
export type HandoverChoice = 1 | 2 | 3;

/**
 * Maps the shared reply classifier's verdict onto the handover card's three options - the parser
 * itself is not forked, only the meaning of its result. approve-words -> 1, skip-words -> 3, and
 * a bare "2" -> 2. Any other free text is deliberately NOT taken as option 2: on a won/lost card
 * that would silently re-open a closed deal off an unrelated sentence, so the owner is asked to
 * answer with a number instead.
 */
export const resolveHandoverChoice = ({
  verdict,
  instruction,
}: ClassifiedApprovalReply): HandoverChoice | null => {
  if (verdict === AI_BRAIN_APPROVAL_RESOLUTIONS.APPROVE) {
    return 1;
  }

  if (verdict === AI_BRAIN_APPROVAL_RESOLUTIONS.SKIP) {
    return 3;
  }

  return instruction.trim() === '2' ? 2 : null;
};

interface HandoverAction {
  /** Pipeline stage to move to, if any. */
  stage?: string;
  /** True when the owner says the AI should carry on with this lead. */
  resumeAutomation?: boolean;
  /** True when the nurture cadence should restart from bump 1. */
  resetNurture?: boolean;
  /** Short confirmation sent back to the owner's self-chat. */
  confirmation: string;
  /** How the approval record itself is closed out (see the note in the map below). */
  resolution: AiBrainApprovalResolution;
}

/**
 * The whole Phase 5 verdict x answer table in one place.
 *
 * `resolution` records what the answer *did*: APPROVE when it changed something (a stage moved,
 * automation came back on), SKIP when the owner deliberately chose the no-op - "leave it with
 * you" / "I'm on it" - which is exactly a skipped card.
 */
const HANDOVER_ACTIONS: Record<string, Record<HandoverChoice, HandoverAction>> = {
  [AI_BRAIN_OUTCOME_DECISIONS.WON]: {
    1: {
      stage: CONVERSATION_STAGES.WON,
      confirmation: 'Marked Won.',
      resolution: AI_BRAIN_APPROVAL_RESOLUTIONS.APPROVE,
    },
    2: {
      resumeAutomation: true,
      confirmation: 'Back on it.',
      resolution: AI_BRAIN_APPROVAL_RESOLUTIONS.APPROVE,
    },
    3: {
      confirmation: 'Left with you.',
      resolution: AI_BRAIN_APPROVAL_RESOLUTIONS.SKIP,
    },
  },
  [AI_BRAIN_OUTCOME_DECISIONS.LOST]: {
    1: {
      stage: CONVERSATION_STAGES.LOST,
      confirmation: 'Marked Lost.',
      resolution: AI_BRAIN_APPROVAL_RESOLUTIONS.APPROVE,
    },
    2: {
      resumeAutomation: true,
      confirmation: 'Back on it.',
      resolution: AI_BRAIN_APPROVAL_RESOLUTIONS.APPROVE,
    },
    3: {
      confirmation: 'Left with you.',
      resolution: AI_BRAIN_APPROVAL_RESOLUTIONS.SKIP,
    },
  },
  [AI_BRAIN_OUTCOME_DECISIONS.UNCLEAR]: {
    // "I'm on it" - stays owner-handled and quiet, automation stays off.
    1: {
      confirmation: 'Left with you.',
      resolution: AI_BRAIN_APPROVAL_RESOLUTIONS.SKIP,
    },
    // "You follow up" - automation back on AND the nudge cadence restarts from bump 1.
    2: {
      resumeAutomation: true,
      resetNurture: true,
      confirmation: 'Back on it.',
      resolution: AI_BRAIN_APPROVAL_RESOLUTIONS.APPROVE,
    },
    // "It's finished" - not won, not lost, just done.
    3: {
      stage: CONVERSATION_STAGES.CLOSED,
      confirmation: 'Marked closed.',
      resolution: AI_BRAIN_APPROVAL_RESOLUTIONS.APPROVE,
    },
  },
};

export const handoverActionFor = (
  verdict: string | null | undefined,
  choice: HandoverChoice,
): HandoverAction | null => HANDOVER_ACTIONS[verdict ?? '']?.[choice] ?? null;

export interface HandoverRepositoryLike {
  findConversationById: typeof defaultFindConversationById;
  updateStage: typeof defaultUpdateStage;
  updateAutomationState: typeof defaultUpdateAutomationState;
  bumpNurtureStep: typeof defaultBumpNurtureStep;
}

export interface ApplyHandoverDecisionParams {
  organizationId: ObjectIdLike;
  approval: PendingApprovalRecord;
  choice: HandoverChoice;
  resolvedBy: ObjectIdLike;
  conversationRepository?: HandoverRepositoryLike;
  resolveApproval?: typeof defaultResolveApproval;
  createActivity?: typeof defaultCreateActivity;
  enqueueConversationChanged?: typeof defaultEnqueueConversationChanged;
}

/**
 * Applies one handover answer: moves the stage (or not), turns automation back on (or not),
 * resets the nurture cadence (or not), resolves the card, and logs what happened. Returns the
 * confirmation line to send back to the owner, or null when the verdict/choice pair has no
 * meaning (which should be impossible for a card this service itself raised).
 */
export const applyHandoverDecision = async ({
  organizationId,
  approval,
  choice,
  resolvedBy,
  conversationRepository = {
    findConversationById: defaultFindConversationById,
    updateStage: defaultUpdateStage,
    updateAutomationState: defaultUpdateAutomationState,
    bumpNurtureStep: defaultBumpNurtureStep,
  },
  resolveApproval = defaultResolveApproval,
  createActivity = defaultCreateActivity,
  enqueueConversationChanged = defaultEnqueueConversationChanged,
}: ApplyHandoverDecisionParams): Promise<string | null> => {
  const action = handoverActionFor(approval.handoverVerdict, choice);

  if (!action) {
    return null;
  }

  const conversationId = approval.conversationId;

  if (action.stage) {
    await conversationRepository.updateStage({
      conversationId,
      organizationId,
      stage: action.stage,
      lastHandledBy: resolvedBy,
    });
  }

  if (action.resumeAutomation) {
    await conversationRepository.updateAutomationState({
      conversationId,
      organizationId,
      aiAutomationEnabled: true,
      aiAutomationPausedReason: null,
    });
  }

  if (action.resetNurture) {
    await conversationRepository.bumpNurtureStep({
      conversationId,
      organizationId,
      step: 0,
    });
  }

  await resolveApproval({
    approvalId: approval._id,
    organizationId,
    resolution: action.resolution,
    resolvedBy,
  });

  // The activity log is keyed on the WhatsApp account, which only the conversation knows. A
  // conversation that vanished under an open card is not a reason to fail the owner's answer -
  // the state changes above already landed - so the log entry is simply skipped.
  const conversation = await conversationRepository.findConversationById({
    conversationId,
    organizationId,
  });

  if (conversation) {
    // Anyone with this lead open in the dashboard sees the answer land, exactly like every other
    // stage/automation change in this module family.
    await enqueueConversationChanged({
      organizationId,
      conversationId,
      assignedTo: conversation.assignedTo,
      reason: action.stage ? REALTIME_REASONS.STAGE : REALTIME_REASONS.AI_PENDING,
    });

    await createActivity({
      organizationId,
      whatsappAccountId: conversation.whatsappAccountId,
      conversationId,
      actorId: resolvedBy,
      eventType: ACTIVITY_EVENTS.AI_BRAIN_HANDOVER_RESOLVED,
      summary: `Owner answered the "${approval.handoverVerdict}" handover card with ${choice}: ${action.confirmation}`,
      metadata: {
        handoverVerdict: approval.handoverVerdict,
        choice,
        stage: action.stage ?? null,
        resumedAutomation: Boolean(action.resumeAutomation),
        resetNurture: Boolean(action.resetNurture),
      },
    });
  }

  return action.confirmation;
};

export interface HandleOwnerApprovalReplyParams {
  organizationId?: ObjectIdLike;
  whatsappAccountId?: ObjectIdLike;
  text?: string;
  messageId?: string | null;
  listPendingApprovals?: ListPendingApprovalsFn;
  resolveApprovalForActor?: typeof defaultResolveApprovalForActor;
  applyHandoverDecision?: typeof applyHandoverDecision;
  getOwnerActorForOrganization?: typeof defaultGetOwnerActorForOrganization;
  findMostRecentlyEscalatedConversation?: typeof defaultFindMostRecentlyEscalatedConversation;
  resumeEscalatedConversationWithInstruction?: typeof defaultResumeEscalatedConversationWithInstruction;
  handleOwnerQuestion?: typeof defaultHandleOwnerQuestion;
  notifyOwner?: NotifyOwnerFn;
  logger?: Logger;
}

// Generous enough for any realistic number of simultaneously open owner drafts; this is a
// per-organization, per-moment count, not a growing history.
const PENDING_APPROVALS_LOOKUP_LIMIT = 200;

/**
 * Parses and acts on one inbound owner self-chat message. Never throws - every failure path
 * (an ambiguous reply, an unknown code, a resolution error) is reported back to the owner in
 * their self-chat, or logged, rather than raised, since this always runs on the inbound WhatsApp
 * message path where a throw would abort message ingestion for an unrelated reason.
 */
export const handleOwnerApprovalReply = async ({
  organizationId,
  whatsappAccountId,
  text,
  messageId,
  listPendingApprovals = defaultListPendingApprovals as ListPendingApprovalsFn,
  resolveApprovalForActor = defaultResolveApprovalForActor,
  applyHandoverDecision: applyHandover = applyHandoverDecision,
  getOwnerActorForOrganization = defaultGetOwnerActorForOrganization,
  findMostRecentlyEscalatedConversation = defaultFindMostRecentlyEscalatedConversation,
  resumeEscalatedConversationWithInstruction = defaultResumeEscalatedConversationWithInstruction,
  handleOwnerQuestion = defaultHandleOwnerQuestion,
  notifyOwner = getOwnerNotifyService().notifyOwner,
  logger = defaultLogger,
}: HandleOwnerApprovalReplyParams = {}): Promise<void> => {
  if (!organizationId || !text?.trim()) {
    return;
  }

  const pendingApprovals = await listPendingApprovals({
    organizationId,
    limit: PENDING_APPROVALS_LOOKUP_LIMIT,
  });

  if (pendingApprovals.length === 0) {
    // Nothing waiting on a code. Two things this could still be, and they are not distinguishable
    // by shape: an instruction about a lead the AI stepped back from (an escalation completes the
    // graph run rather than pausing it, so there's no card to reply to - see
    // resumeEscalatedConversationWithInstruction), or a question about the business.
    //
    // "ask them for their budget" and "how many bookings this month" arrive on the same channel,
    // and no keyword rule was going to separate them, so the assistant's own dispatcher decides -
    // it is told which lead is parked, and answers `instruction` when that is the better reading.
    // Before the assistant existed, a message with no escalation open fell through here and did
    // nothing at all.
    try {
      const escalated = await findMostRecentlyEscalatedConversation({ organizationId });
      const outcome = await handleOwnerQuestion({
        organizationId,
        question: text.trim(),
        parkedLeadName: escalated?.displayName ?? '',
      });

      if (outcome.kind === 'answered') {
        await notifyOwner({
          accountId: whatsappAccountId,
          organizationId,
          text: outcome.message ?? "I couldn't work that one out.",
        });

        return;
      }

      // Read as an order about the parked lead. `instruction` is only ever returned when one is
      // parked, so this is reachable with `escalated` set.
      if (!escalated) {
        return;
      }

      await resumeEscalatedConversationWithInstruction({
        organizationId,
        conversation: escalated,
        instruction: text.trim(),
        ownerMessageId: messageId ?? `owner-instruction:${Date.now()}`,
      });

      await notifyOwner({
        accountId: whatsappAccountId,
        organizationId,
        text: `Got it — back on it for ${escalated.displayName}.`,
      });
    } catch (error: unknown) {
      const err = error as { code?: unknown; name?: unknown; message?: unknown };
      logger?.error?.(
        { code: err?.code, name: err?.name, message: err?.message },
        'Owner instruction on an escalated conversation failed safely.',
      );
      await notifyOwner({
        accountId: whatsappAccountId,
        organizationId,
        text: 'Sorry, something went wrong acting on that.',
      }).catch(() => {});
    }

    return;
  }

  const segments = splitIntoCodeSegments(text);
  let ownerActor: Awaited<ReturnType<typeof defaultGetOwnerActorForOrganization>> | null = null;

  for (const segment of segments) {
    const target = resolveApprovalTarget({ code: segment.code, pendingApprovals });

    if (target.ambiguous) {
      await notifyOwner({
        accountId: whatsappAccountId,
        organizationId,
        text: `More than one open — reply with a code: ${(target.pendingCodes ?? []).join(', ')}`,
      });
      continue;
    }

    if (target.notFound || !target.approval) {
      await notifyOwner({
        accountId: whatsappAccountId,
        organizationId,
        text: segment.code
          ? `I don't have an open draft for code ${segment.code}.`
          : 'No open drafts to act on right now.',
      });
      continue;
    }

    const classified = classifyApprovalReplyText(segment.remainder);
    const { verdict, instruction } = classified;

    try {
      ownerActor ??= await getOwnerActorForOrganization({ organizationId });

      // A handover card asks a different question, so 1/2/3 mean different things and there is
      // no paused LangGraph interrupt to resume - it never goes through resolveApprovalForActor.
      if (target.approval.kind === AI_BRAIN_APPROVAL_KINDS.HANDOVER) {
        const choice = resolveHandoverChoice(classified);

        if (choice === null) {
          await notifyOwner({
            accountId: whatsappAccountId,
            organizationId,
            text: `Reply ${target.approval.code ?? 'that card'} with 1, 2 or 3.`,
          });
          continue;
        }

        const confirmation = await applyHandover({
          organizationId,
          approval: target.approval,
          choice,
          resolvedBy: ownerActor.actor._id,
        });

        await notifyOwner({
          accountId: whatsappAccountId,
          organizationId,
          text: confirmation ?? `Reply ${target.approval.code ?? 'that card'} with 1, 2 or 3.`,
        });
        continue;
      }

      const result = await resolveApprovalForActor({
        organizationId,
        conversationId: target.approval.conversationId,
        permissions: ownerActor.permissions,
        actor: ownerActor.actor,
        verdict,
        instruction,
      });

      if (verdict === AI_BRAIN_APPROVAL_RESOLUTIONS.APPROVE) {
        await notifyOwner({
          accountId: whatsappAccountId,
          organizationId,
          text: result.sent ? 'Sent ✅' : 'Approved.',
        });
      } else if (verdict === AI_BRAIN_APPROVAL_RESOLUTIONS.SKIP) {
        await notifyOwner({ accountId: whatsappAccountId, organizationId, text: 'Skipped.' });
      }
      // "edit": resolveApprovalForActor raises a fresh pending approval, and
      // ai-brain.service.ts's own edit-path hook fires sendApprovalCard for it - the owner sees
      // the revised draft as a new card, so no separate confirmation is sent here.
    } catch (error: unknown) {
      const err = error as { code?: unknown; name?: unknown; message?: unknown };
      logger?.error?.(
        { code: err?.code, name: err?.name, message: err?.message },
        'Owner approval-reply resolution failed safely.',
      );
      await notifyOwner({
        accountId: whatsappAccountId,
        organizationId,
        text: `Sorry, something went wrong acting on ${segment.code ?? 'that'}.`,
      }).catch(() => {});
    }
  }
};
