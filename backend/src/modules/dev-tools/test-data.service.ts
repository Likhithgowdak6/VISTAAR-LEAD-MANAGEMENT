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

export interface ClearOrganizationTestDataResult {
  totalDeleted: number;
  deletedByCollection: Array<{ name: string; count: number }>;
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
