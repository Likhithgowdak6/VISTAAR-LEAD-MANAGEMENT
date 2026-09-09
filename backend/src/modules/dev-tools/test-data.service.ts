/**
 * TEST-PHASE ONLY. Lets an admin wipe this organization's lead/conversation data from the
 * dashboard with a click, instead of running a script or touching Mongo by hand, while a real
 * phone is being used to poke the AI agent over and over.
 *
 * Deliberately reuses `scripts/reset-conversation-data.ts` rather than re-deriving its delete
 * list: that script is the vetted definition of "lead/conversation data" vs. "configuration",
 * and importing it (instead of running it as a script - `isDirectRun()` guards `main()`) means
 * this tool can never drift from it.
 *
 * Not scoped to one phone number, on purpose. WhatsApp's `@lid` privacy identifiers mean a
 * contact is sometimes never resolvable back to the plain phone number that sent it, so a
 * phone-keyed lookup silently finds nothing. The safety net is `WHATSAPP_TEST_ALLOWED_NUMBERS`
 * itself: while it is non-empty, every inbound message that is not from an allowed number is
 * dropped before it is ever persisted (see allowlist.ts) - so every conversation that exists at
 * all while test mode is on is already guaranteed to be test data. This tool fails closed the
 * moment that env var is cleared, which is also what makes an install production-safe.
 *
 * Delete this module - the route, the controller, the frontend button - before going to
 * production. It exists so testing does not require shell access, not as a permanent feature.
 */
import { env, type Env } from '../../config/env.js';
import { createConversationDataReset } from '../../scripts/reset-conversation-data.js';
import { type ObjectIdLike } from '../../types/common.js';
import { getCall, placeOutboundCall } from '../calls/vapi.client.js';
import {
  findOrganizationById,
  normalizeOwnerWhatsappNumber,
} from '../organizations/organization.repository.js';

export interface ClearOrganizationTestDataResult {
  totalDeleted: number;
  deletedByCollection: Array<{ name: string; count: number }>;
}

export interface TestOwnerCallResult {
  callId: string;
  /** Vapi's status the instant it accepted the request - almost always `queued`. */
  status: string | null;
  /** The line it dialled, masked. Enough to tell the old owner number from the new one. */
  dialed: string;
}

export interface TestOwnerCallOutcomeResult {
  status: string | null;
  endedReason: string | null;
  durationSeconds: number | null;
  /** False until the call is over; poll again rather than recording a half-finished answer. */
  settled: boolean;
  /** True only if there was connected audio. A call can end "successfully" with 0 seconds. */
  connected: boolean;
}

export class TestDataToolError extends Error {}

/** True while this whole feature is reachable at all - mirrors the WhatsApp test allowlist. */
export const isTestModeActive = (config: Pick<Env, 'WHATSAPP_TEST_ALLOWED_NUMBERS'> = env): boolean =>
  config.WHATSAPP_TEST_ALLOWED_NUMBERS.trim() !== '';

export const clearOrganizationTestData = async (
  { organizationId }: { organizationId: ObjectIdLike },
  config: Env = env,
): Promise<ClearOrganizationTestDataResult> => {
  if (!isTestModeActive(config)) {
    // Fails closed on purpose: the moment WHATSAPP_TEST_ALLOWED_NUMBERS is cleared for
    // production, this tool must refuse to run rather than still being one click away.
    throw new TestDataToolError('TEST_MODE_NOT_ACTIVE');
  }

  const reset = createConversationDataReset({
    config,
    // The script's own console.log is useful here too: it lands right in the backend terminal
    // next to the WHATSAPP_TRACE_ENABLED lines, so a click on the dashboard is visible there.
    log: (line: string) => {
      console.log(`[dev-tools/clear-test-data] ${line}`);
    },
  });

  const { plan } = await reset.run({
    scope: { organizationId: organizationId.toString(), label: `organization ${organizationId}` },
    apply: true,
  });

  return {
    totalDeleted: plan.totalDeletable,
    deletedByCollection: plan.deletable.map(({ name, count }) => ({ name, count })),
  };
};

/** Masked for display and for logs - the full number belongs in the settings field, nowhere else. */
const maskNumber = (digitsOnly: string): string =>
  digitsOnly.length <= 7 ? '***' : `${digitsOnly.slice(0, 4)}***${digitsOnly.slice(-3)}`;

/**
 * Rings the owner's configured number on demand.
 *
 * The automatic escalation only fires when a new-lead alert has genuinely gone unanswered for the
 * configured delay, which makes it a slow instrument for testing telephony: every trunk change
 * meant inventing a fresh lead and waiting. This does the same thing the sweep does - same client,
 * same number, same dial format - with no lead and no waiting, so a trunk setting can be changed
 * and verified in one click.
 *
 * Deliberately NOT gated on OWNER_CALL_ESCALATION_ENABLED: being able to test the phone path while
 * the automatic caller stays switched off is the point.
 */
export const placeTestOwnerCall = async (
  { organizationId }: { organizationId: ObjectIdLike },
  config: Env = env,
): Promise<TestOwnerCallResult> => {
  if (!isTestModeActive(config)) {
    throw new TestDataToolError('TEST_MODE_NOT_ACTIVE');
  }

  const organization = await findOrganizationById(organizationId);
  const ownerNumber = normalizeOwnerWhatsappNumber(
    (organization as { ownerWhatsappNumber?: string | null } | null)?.ownerWhatsappNumber,
  );

  if (!ownerNumber) {
    throw new TestDataToolError('OWNER_NUMBER_NOT_SET');
  }

  const call = await placeOutboundCall({
    toNumber: config.VAPI_DIAL_FORMAT === 'plain' ? ownerNumber : `+${ownerNumber}`,
    variableValues: {
      callReason: 'a test call from the dashboard',
      leadName: 'a test lead',
      enquiryType: 'a test enquiry',
      knownDetails: 'nothing - this is a test',
    },
  });

  return { callId: call.callId, status: call.status, dialed: maskNumber(ownerNumber) };
};

/**
 * What became of a test call. Separate from placing it because a call takes tens of seconds to
 * resolve and an HTTP request that blocks for all of it is worse than a second click - and
 * because the answer that matters ("did it actually connect?") only exists once it has ended.
 */
export const readTestOwnerCallOutcome = async (
  { callId }: { callId: string },
  config: Env = env,
): Promise<TestOwnerCallOutcomeResult> => {
  if (!isTestModeActive(config)) {
    throw new TestDataToolError('TEST_MODE_NOT_ACTIVE');
  }

  const outcome = await getCall(callId);

  return {
    status: outcome.status,
    endedReason: outcome.endedReason,
    durationSeconds: outcome.durationSeconds,
    settled: outcome.settled,
    connected: (outcome.durationSeconds ?? 0) > 0,
  };
};
