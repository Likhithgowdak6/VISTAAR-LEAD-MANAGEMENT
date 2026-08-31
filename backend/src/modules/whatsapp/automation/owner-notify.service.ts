/**
 * Sends a message to the owner - the WhatsApp-side half of the approval channel (see
 * ../../ai-brain/owner-approval-card.service.ts).
 *
 * Two shapes, chosen by whether an owner number is configured - in the organization's own
 * settings (../../organizations/organization-settings.service.ts) or, failing that, the
 * WHATSAPP_OWNER_NUMBER env default:
 *
 *  - set   -> the owner is a separate phone. The agent messages them like any other chat. This
 *             is the normal setup: the agent number talks to leads, the owner watches from their
 *             own phone and answers there.
 *  - empty -> the older single-phone fallback, where the agent writes into its own "message
 *             yourself" chat and the owner reads it on the agent's device.
 *
 * Either way this is a direct, immediate send to a person on the business's own side, never a
 * lead-facing message, so it deliberately skips the allowlist/quiet-hours/human-delay guard
 * stack in ../delivery/outbound-delivery.service.ts. Those guards exist to protect leads from
 * over-automated outreach; throttling the owner's own alerts would only make them late.
 */
import { env, type Env } from '../../../config/env.js';
import { getOrganizationSettingsService } from '../../organizations/organization-settings.service.js';
import { type ObjectIdLike } from '../../../types/common.js';
import { getSessionManager } from '../sessions/session-manager.instance.js';
import { WhatsAppProviderError } from '../whatsapp.errors.js';
import {
  createEchoGuardService as defaultCreateEchoGuardService,
  type EchoGuardService,
} from './echo-guard.service.js';

export interface NotifyOwnerParams {
  accountId?: ObjectIdLike;
  /**
   * Whose owner number to use. When absent (a caller with no organization in scope) this falls
   * back to the WHATSAPP_OWNER_NUMBER env default exactly as it did before settings existed.
   */
  organizationId?: ObjectIdLike;
  text?: string;
}

export interface NotifyOwnerResult {
  providerMessageId: string | null;
}

/**
 * The slice of the session manager this needs - deliberately NOT the real
 * `WhatsAppSessionManager` type from session-manager.service.ts. That type transitively depends
 * (through session-manager.service -> inbound-router.service -> owner-reply.service ->
 * owner-approval-card.service, which itself uses this module) on this module's own exported
 * types, which would make the two files' types circularly reference each other. A structurally
 * equivalent, standalone interface breaks that cycle; `getSessionManager()`'s real return value
 * satisfies it as-is.
 */
export interface OwnerNotifySessionManager {
  getOwnJid: (accountId: ObjectIdLike | undefined) => string | null;
  sendTextMessage: (options?: {
    accountId?: ObjectIdLike;
    to?: string;
    text?: string;
  }) => Promise<{ providerMessageId?: string | null } | null | undefined>;
}

/**
 * The slice of the organization-settings service this needs. A standalone structural interface
 * for the same reason `OwnerNotifySessionManager` above is one: it keeps this module's types
 * independent of anything that might import back into it.
 */
export interface OwnerNotifySettingsService {
  getOwnerNumber: (params?: { organizationId?: ObjectIdLike }) => Promise<string>;
}

export interface CreateOwnerNotifyServiceOptions {
  sessionManager?: OwnerNotifySessionManager;
  echoGuardService?: EchoGuardService;
  organizationSettingsService?: OwnerNotifySettingsService;
  config?: Env;
}

/**
 * The owner's phone as a WhatsApp JID, or null when no separate owner number is configured (in
 * which case the caller falls back to the account's own self-chat).
 */
export const ownerJidFromConfig = (rawNumber: unknown): string | null => {
  const digits = String(rawNumber ?? '').replace(/\D/g, '');

  return digits === '' ? null : `${digits}@s.whatsapp.net`;
};

/**
 * Explicit (not inferred) on purpose: `createOwnerNotifyService`'s own default `sessionManager`
 * value comes from `getSessionManager()`, whose real type transitively depends - through
 * session-manager.service -> inbound-router.service -> owner-reply.service ->
 * owner-approval-card.service - back on this file's own exported types. Without an explicit
 * annotation here TS cannot infer this function's return type without first resolving that
 * whole cycle, which needs this function's type to resolve it. Declaring the shape up front
 * breaks that regress; every other file in the cycle carries the same annotation for the same
 * reason (search "self-referential" in this codebase's Phase 2 files).
 */
export interface OwnerNotifyServiceHandle {
  notifyOwner: (params?: NotifyOwnerParams) => Promise<NotifyOwnerResult>;
}

export const createOwnerNotifyService = ({
  sessionManager = getSessionManager(),
  echoGuardService = defaultCreateEchoGuardService(),
  organizationSettingsService = getOrganizationSettingsService(),
  config = env,
}: CreateOwnerNotifyServiceOptions = {}): OwnerNotifyServiceHandle => {
  const notifyOwner = async ({
    accountId,
    organizationId,
    text,
  }: NotifyOwnerParams = {}): Promise<NotifyOwnerResult> => {
    // The organization's own setting wins, then the env default (both resolved by the settings
    // service, off a short-lived cache); without an organization there is only the env default.
    const ownerNumber = organizationId
      ? await organizationSettingsService.getOwnerNumber({ organizationId })
      : config?.WHATSAPP_OWNER_NUMBER;

    // A configured owner number wins; otherwise fall back to the account's own self-chat.
    const ownerJid = ownerJidFromConfig(ownerNumber);
    const destination = ownerJid ?? sessionManager.getOwnJid(accountId);

    if (!destination) {
      // No running session (or the socket hasn't authenticated yet, so its own JID isn't known)
      // - the caller needs to know the card never went out, not have this swallowed.
      throw new WhatsAppProviderError(
        "No running WhatsApp session for this account - can't reach the owner.",
        { code: 'WHATSAPP_SESSION_NOT_RUNNING' },
      );
    }

    const result = await sessionManager.sendTextMessage({ accountId, to: destination, text });

    // Remembered so the echo-guard doesn't mistake this send reflecting back (Baileys delivers
    // every message we send in a chat we're a participant of, including our own self-chat, as a
    // `fromMe` inbound event) for the owner manually typing a fresh approval reply.
    await echoGuardService.remember({
      accountId,
      providerMessageId: result?.providerMessageId ?? null,
    });

    return { providerMessageId: result?.providerMessageId ?? null };
  };

  return { notifyOwner };
};

export type OwnerNotifyService = OwnerNotifyServiceHandle;
