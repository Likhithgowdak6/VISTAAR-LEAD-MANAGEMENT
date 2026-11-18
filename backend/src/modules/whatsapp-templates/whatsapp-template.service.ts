/**
 * Pulls an account's message templates from Meta and caches them.
 *
 * Run on demand from the dashboard rather than on a schedule. Templates change rarely - a new one
 * is submitted, waits hours for review, and then stays - and a poller would spend a Graph call
 * every few minutes to discover nothing. The one case that matters, "I just got my template
 * approved and it is not in the list", is exactly the case where somebody is sitting at the screen
 * able to press Sync.
 */
import { type ObjectIdLike } from '../../types/common.js';
import { canUserAccessAccount, type AccountAccessSubject } from '../auth/account-access.service.js';
import { findAccountById as defaultFindAccount } from '../whatsapp-accounts/whatsapp-account.repository.js';
import { createHttpError } from '../../utils/http-error.js';
import { isSupportedTemplate } from './whatsapp-template.parser.js';
import { getCloudRuntime, type CloudRuntime } from '../whatsapp/cloud/cloud-runtime.service.js';
import { fetchCloudTemplates as defaultFetchCloudTemplates } from '../whatsapp/cloud/whatsapp-cloud.client.js';
import { CLOUD_FAILURE_KINDS, WhatsAppCloudError } from '../whatsapp/cloud/cloud.errors.js';
import { markCloudTemplatesSynced as defaultMarkSynced } from '../whatsapp-accounts/whatsapp-account.repository.js';
import {
  deleteStaleWhatsAppTemplates as defaultDeleteStale,
  findWhatsAppTemplates as defaultFindTemplates,
  upsertWhatsAppTemplate as defaultUpsert,
} from './whatsapp-template.repository.js';
import {
  normalizeTemplateStatus,
  parseTemplateComponents,
} from './whatsapp-template.parser.js';

export interface SyncTemplatesResult {
  synced: number;
  removed: number;
  syncedAt: Date;
}

export interface CreateWhatsAppTemplateServiceOptions {
  findAccount?: typeof defaultFindAccount;
  runtime?: CloudRuntime;
  fetchTemplates?: typeof defaultFetchCloudTemplates;
  upsertTemplate?: typeof defaultUpsert;
  deleteStale?: typeof defaultDeleteStale;
  findTemplates?: typeof defaultFindTemplates;
  markSynced?: typeof defaultMarkSynced;
  now?: () => Date;
}

export const createWhatsAppTemplateService = ({
  findAccount = defaultFindAccount,
  runtime = getCloudRuntime(),
  fetchTemplates = defaultFetchCloudTemplates,
  upsertTemplate = defaultUpsert,
  deleteStale = defaultDeleteStale,
  findTemplates = defaultFindTemplates,
  markSynced = defaultMarkSynced,
  now = () => new Date(),
}: CreateWhatsAppTemplateServiceOptions = {}) => {
  const syncTemplatesForAccount = async ({
    organizationId,
    accountId,
  }: {
    organizationId: ObjectIdLike;
    accountId: ObjectIdLike;
  }): Promise<SyncTemplatesResult> => {
    // Resolves AND authorises: it refuses an account that is not a Cloud account, is not active,
    // or belongs to another organisation, with a message the dashboard can show as-is.
    const credentials = await runtime.resolveCredentials({ accountId, organizationId });

    if (!credentials.wabaId) {
      throw new WhatsAppCloudError(
        'This number has no WhatsApp Business Account id, so its templates cannot be listed.',
        {
          code: 'WHATSAPP_CLOUD_WABA_MISSING',
          failureKind: CLOUD_FAILURE_KINDS.NEEDS_ATTENTION,
        },
      );
    }

    const templates = await fetchTemplates({
      wabaId: credentials.wabaId,
      accessToken: credentials.accessToken,
    });

    // Taken ONCE, before the first write, and used as both the stamp on every row and the
    // cut-off for the cleanup below. Calling now() per row would leave the last row's timestamp
    // ahead of the cut-off and delete rows this very sync had just written.
    const syncedAt = now();

    let synced = 0;

    for (const template of templates) {
      const parsed = parseTemplateComponents(template.components);

      await upsertTemplate({
        organizationId,
        whatsappAccountId: accountId,
        name: template.name,
        language: template.language,
        status: normalizeTemplateStatus(template.status),
        category: template.category,
        components: template.components,
        syncedAt,
        ...parsed,
      });

      synced += 1;
    }

    // Anything not touched by this run no longer exists on Meta's side.
    //
    // GUARDED on a non-empty result: an empty response is far more likely to be a Graph hiccup
    // or a permission that was just removed than a business that deleted every template at once,
    // and wiping the cache in that case would leave agents unable to reopen any conversation.
    let removed = 0;

    if (templates.length > 0) {
      const deletion = await deleteStale({ whatsappAccountId: accountId, syncedBefore: syncedAt });
      removed = deletion?.deletedCount ?? 0;
    }

    await markSynced({ accountId, organizationId, now: syncedAt });

    return { synced, removed, syncedAt };
  };

  const listTemplatesForAccount = async ({
    organizationId,
    accountId,
    approvedOnly = false,
    actor,
  }: {
    organizationId: ObjectIdLike;
    accountId: ObjectIdLike;
    approvedOnly?: boolean;
    actor: AccountAccessSubject;
  }) => {
    const account = await findAccount({ organizationId, accountId });
    if (!account) throw createHttpError({ statusCode: 404, code: 'ACCOUNT_NOT_FOUND', message: 'WhatsApp account not found.' });
    if (!canUserAccessAccount({ user: actor, accountId })) {
      throw createHttpError({ statusCode: 403, code: 'ACCOUNT_ACCESS_DENIED', message: 'You cannot access this WhatsApp number.' });
    }
    const templates = await findTemplates({
      organizationId,
      whatsappAccountId: accountId,
      approvedOnly,
    });
    return approvedOnly ? templates.filter((template) => isSupportedTemplate(template.components)) : templates;
  };

  return { syncTemplatesForAccount, listTemplatesForAccount };
};

export type WhatsAppTemplateService = ReturnType<typeof createWhatsAppTemplateService>;
