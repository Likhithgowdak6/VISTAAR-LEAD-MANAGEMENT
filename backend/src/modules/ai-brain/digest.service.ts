/**
 * The 9:10am owner digest (Phase 6). One WhatsApp message into the owner's own self-chat
 * summarizing everything that needs them: cards waiting on a reply, leads parked with a human,
 * and leads about to go cold. It never messages a lead and never changes any state - it only
 * reads and reports.
 *
 * It runs ten minutes after the morning handover read (see daily-jobs-runner.ts) on purpose, so
 * the cards that read raises show up in the same morning's digest.
 *
 * There is deliberately no "proposals out, no answer" section: this project has no persisted
 * proposal state to query. ai-brain-service's proposal endpoints are stateless
 * generate/revise/render calls and wam-crm-ai stores nothing from them (see
 * ai-brain.service.ts's generateProposalForActor - "there is no proposal history store yet"),
 * so there is nothing truthful to count. Nothing was invented to fill the gap.
 */
import { ACCOUNT_STATUSES } from '../../constants/account-statuses.js';
import { ORGANIZATION_STATUSES } from '../../constants/organization-statuses.js';
import { logger as defaultLogger } from '../../config/logger.js';
import { type ObjectIdLike } from '../../types/common.js';
import {
  countConversationsCreatedSince as defaultCountConversationsCreatedSince,
  findConversationById as defaultFindConversationById,
  findGoingColdConversations as defaultFindGoingColdConversations,
  findParkedConversations as defaultFindParkedConversations,
} from '../conversations/conversation.repository.js';
import { listOrganizations as defaultListOrganizations } from '../organizations/organization.repository.js';
import { findAccountsByOrganization as defaultFindAccountsByOrganization } from '../whatsapp-accounts/whatsapp-account.repository.js';
import {
  createOwnerNotifyService,
  type NotifyOwnerParams,
  type NotifyOwnerResult,
} from '../whatsapp/automation/owner-notify.service.js';
import { listPendingApprovals as defaultListPendingApprovals } from './ai-brain-approval.repository.js';

const MS_PER_HOUR = 60 * 60 * 1000;
const NEW_LEAD_WINDOW_MS = 24 * MS_PER_HOUR;

/** Enough for any realistic single morning; a digest is a nudge, not an export. */
const SECTION_LIMIT = 25;
const ORGANIZATION_LIMIT = 200;

export const ALL_CLEAR_TEXT = 'Nothing needs you. Pipeline is running itself. 🎉';

export const APPROVAL_USAGE_HINT = 'Reply e.g. A7 1 to send, A7 3 to skip.';

// --------------------------------------------------------------------------
// Composition (pure - everything below just gathers the numbers to feed it).
// --------------------------------------------------------------------------
export interface DigestWaitingItem {
  code: string | null;
  leadDisplayName: string;
  hoursOld: number;
}

export interface DigestParkedItem {
  leadDisplayName: string;
  reason: string;
}

export interface DigestGoingColdItem {
  leadDisplayName: string;
  nurtureStep: number;
}

export interface DigestContent {
  newLeadCount: number;
  waiting: DigestWaitingItem[];
  parked: DigestParkedItem[];
  goingCold: DigestGoingColdItem[];
}

const pluralize = (count: number, singular: string): string =>
  `${count} ${singular}${count === 1 ? '' : 's'}`;

/**
 * Renders the digest. Every section is omitted when it has nothing in it; when all of them are
 * empty the whole message becomes the all-clear line instead - a positive daily heartbeat is
 * worth sending, both because "nothing needs you" is real information and because it is the
 * owner's proof the system is still alive.
 */
export const composeDigestText = ({
  newLeadCount,
  waiting,
  parked,
  goingCold,
}: DigestContent): string => {
  if (waiting.length === 0 && parked.length === 0 && goingCold.length === 0) {
    return ALL_CLEAR_TEXT;
  }

  const sections: string[] = [
    `Good morning — ${pluralize(newLeadCount, 'new lead')} in the last 24h.`,
  ];

  if (waiting.length > 0) {
    sections.push(
      [
        '*Waiting on you*',
        ...waiting.map(
          (item) =>
            `• ${item.code ?? '—'} ${item.leadDisplayName} (${pluralize(item.hoursOld, 'hr')} old)`,
        ),
        APPROVAL_USAGE_HINT,
      ].join('\n'),
    );
  }

  if (parked.length > 0) {
    sections.push(
      ['*Parked for you*', ...parked.map((item) => `• ${item.leadDisplayName} — ${item.reason}`)].join(
        '\n',
      ),
    );
  }

  if (goingCold.length > 0) {
    sections.push(
      [
        '*About to go cold*',
        ...goingCold.map((item) => `• ${item.leadDisplayName} (nudge ${item.nurtureStep} sent, no reply)`),
      ].join('\n'),
    );
  }

  return sections.join('\n\n');
};

// --------------------------------------------------------------------------
// Gathering + sending.
// --------------------------------------------------------------------------
type NotifyOwnerFn = (params?: NotifyOwnerParams) => Promise<NotifyOwnerResult>;

let ownerNotifyServiceSingleton: { notifyOwner: NotifyOwnerFn } | null = null;
const getOwnerNotifyService = () => {
  ownerNotifyServiceSingleton ??= createOwnerNotifyService();
  return ownerNotifyServiceSingleton;
};

export interface DigestConversationRepositoryLike {
  findConversationById: typeof defaultFindConversationById;
  findParkedConversations: typeof defaultFindParkedConversations;
  findGoingColdConversations: typeof defaultFindGoingColdConversations;
  countConversationsCreatedSince: typeof defaultCountConversationsCreatedSince;
}

export interface CreateDigestServiceOptions {
  conversationRepository?: DigestConversationRepositoryLike;
  listPendingApprovals?: typeof defaultListPendingApprovals;
  listOrganizations?: typeof defaultListOrganizations;
  findAccountsByOrganization?: typeof defaultFindAccountsByOrganization;
  notifyOwner?: NotifyOwnerFn;
  logger?: { error?: (...args: unknown[]) => void };
  now?: () => Date;
}

export interface SendDigestParams {
  organizationId?: ObjectIdLike;
}

export interface SendDigestResult {
  organizations: number;
  sent: number;
  failed: number;
}

export const createDigestService = ({
  conversationRepository = {
    findConversationById: defaultFindConversationById,
    findParkedConversations: defaultFindParkedConversations,
    findGoingColdConversations: defaultFindGoingColdConversations,
    countConversationsCreatedSince: defaultCountConversationsCreatedSince,
  },
  listPendingApprovals = defaultListPendingApprovals,
  listOrganizations = defaultListOrganizations,
  findAccountsByOrganization = defaultFindAccountsByOrganization,
  notifyOwner,
  logger = defaultLogger,
  now = () => new Date(),
}: CreateDigestServiceOptions = {}) => {
  // Resolved lazily for the same module-cycle reason owner-approval-card.service.ts does it:
  // the session manager must not be constructed at import time.
  const notify: NotifyOwnerFn = notifyOwner ?? ((params) => getOwnerNotifyService().notifyOwner(params));

  const buildContentForOrganization = async (
    organizationId: ObjectIdLike,
    reference: Date,
  ): Promise<DigestContent> => {
    const [approvals, parkedConversations, goingColdConversations, newLeadCount] = await Promise.all([
      listPendingApprovals({ organizationId, limit: SECTION_LIMIT }),
      conversationRepository.findParkedConversations({ organizationId, limit: SECTION_LIMIT }),
      conversationRepository.findGoingColdConversations({ organizationId, limit: SECTION_LIMIT }),
      conversationRepository.countConversationsCreatedSince({
        organizationId,
        since: new Date(reference.getTime() - NEW_LEAD_WINDOW_MS),
      }),
    ]);

    const waiting: DigestWaitingItem[] = [];

    for (const approval of approvals) {
      const conversation = await conversationRepository.findConversationById({
        conversationId: approval.conversationId,
        organizationId,
      });

      const createdAt = approval.createdAt ? new Date(approval.createdAt).getTime() : reference.getTime();

      waiting.push({
        code: approval.code ?? null,
        leadDisplayName: conversation?.displayName ?? 'Unknown lead',
        hoursOld: Math.max(0, Math.floor((reference.getTime() - createdAt) / MS_PER_HOUR)),
      });
    }

    return {
      newLeadCount: Number(newLeadCount ?? 0),
      waiting,
      parked: parkedConversations.map((conversation) => ({
        leadDisplayName: conversation.displayName,
        reason: conversation.aiAutomationPausedReason ?? 'Paused.',
      })),
      goingCold: goingColdConversations.map((conversation) => ({
        leadDisplayName: conversation.displayName,
        nurtureStep: conversation.nurtureStep ?? 0,
      })),
    };
  };

  /** The account whose self-chat the digest goes to: the organization's live connection. */
  const resolveAccountId = async (organizationId: ObjectIdLike): Promise<ObjectIdLike | undefined> => {
    const accounts = await findAccountsByOrganization({
      organizationId,
      status: ACCOUNT_STATUSES.ACTIVE,
      limit: 1,
    });

    return accounts[0]?._id;
  };

  const sendForOrganization = async (organizationId: ObjectIdLike, reference: Date): Promise<void> => {
    const content = await buildContentForOrganization(organizationId, reference);
    const accountId = await resolveAccountId(organizationId);

    await notify({ accountId, organizationId, text: composeDigestText(content) });
  };

  const sendDigest = async ({ organizationId }: SendDigestParams = {}): Promise<SendDigestResult> => {
    const reference = now();
    const result: SendDigestResult = { organizations: 0, sent: 0, failed: 0 };

    const organizationIds: ObjectIdLike[] = organizationId
      ? [organizationId]
      : (
          await listOrganizations({
            status: ORGANIZATION_STATUSES.ACTIVE,
            limit: ORGANIZATION_LIMIT,
          })
        ).map((organization) => organization._id);

    for (const id of organizationIds) {
      result.organizations += 1;

      try {
        await sendForOrganization(id, reference);
        result.sent += 1;
      } catch (error: unknown) {
        // One organization without a live WhatsApp session (or with a read that failed) must not
        // stop the others getting their digest.
        result.failed += 1;
        const err = error as { code?: unknown; name?: unknown };
        logger.error?.(
          { code: err?.code, name: err?.name, organizationId: id?.toString?.() },
          'Owner digest failed safely for one organization.',
        );
      }
    }

    return result;
  };

  return { sendDigest, buildContentForOrganization };
};

export type DigestService = ReturnType<typeof createDigestService>;
