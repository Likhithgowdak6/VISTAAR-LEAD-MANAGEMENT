/**
 * Workspace settings for Instagram DMs: connect an account, configure replies, take over a thread.
 *
 * CONNECTING REUSES THE EXISTING `MetaConnection`. An admin who has already authorised Facebook
 * for Lead Ads does not log in again - the Page list comes from the user token already stored, and
 * the Page token it mints is what Instagram sends with. That is the whole reason to be on the
 * Facebook Login path rather than `graph.instagram.com`.
 *
 * NOTHING HERE RETURNS A TOKEN. The dashboard sees a handle, a Page name, a last-4 and a status.
 */
import { logger } from '../../config/logger.js';
import { asyncHandler } from '../../utils/async-handler.js';
import { decryptMetaAccessTokenFromStorage } from '../lead-sources/meta-credentials.service.js';
import { MetaConnection } from '../lead-sources/meta-connection.model.js';
import { InstagramAccount } from './instagram-account.model.js';
import { listInstagramCapablePages } from './instagram.client.js';
import { setInstagramThreadAutomation } from './instagram-automation.service.js';
import {
  encryptInstagramPageTokenForStorage,
  instagramPageTokenLast4,
} from './instagram-credentials.service.js';

/** What the dashboard may see of a connected account. */
const serialize = (account: Record<string, unknown> | null) =>
  account
    ? {
        id: String(account._id),
        instagramAccountId: account.instagramAccountId ?? null,
        username: account.username ?? null,
        pageId: account.pageId ?? null,
        pageName: account.pageName ?? null,
        accessTokenLast4: account.accessTokenLast4 ?? null,
        status: account.status ?? null,
        lastError: account.lastError ?? null,
        lastErrorAt: account.lastErrorAt ?? null,
        lastInboundAt: account.lastInboundAt ?? null,
        automationEnabled: account.automationEnabled === true,
        welcomeReply: account.welcomeReply ?? null,
        keywordReplies: Array.isArray(account.keywordReplies) ? account.keywordReplies : [],
      }
    : null;

/** GET /instagram/accounts - what this workspace has connected. */
export const listInstagramAccounts = asyncHandler(async (req, res) => {
  const accounts = await InstagramAccount.find({
    organizationId: req.auth?.organization?._id,
    status: { $ne: 'disconnected' },
  })
    .lean()
    .exec();

  res.json({ data: accounts.map((account) => serialize(account as never)) });
});

/**
 * GET /instagram/available - the Instagram accounts this workspace could connect.
 *
 * Reads the Pages from the EXISTING Meta connection and reports which carry an Instagram
 * professional account. A Page without one is listed with `instagram: null` rather than hidden,
 * because "my Page is not in the list" is a much harder question than "this Page has no Instagram
 * account attached".
 */
export const listAvailableInstagramAccounts = asyncHandler(async (req, res) => {
  const connection = await MetaConnection.findOne({ organizationId: req.auth?.organization?._id })
    .select('+encryptedUserAccessToken')
    .exec();

  if (!connection) {
    res.status(409).json({
      error: {
        code: 'META_NOT_CONNECTED',
        message:
          'Connect Facebook first under Lead Sources. Instagram uses the same authorisation, so there is no second login.',
      },
    });

    return;
  }

  const userToken = decryptMetaAccessTokenFromStorage(connection.encryptedUserAccessToken);

  if (!userToken) {
    res.status(409).json({
      error: {
        code: 'META_NOT_CONNECTED',
        message: 'The stored Facebook authorisation could not be read. Reconnect it under Lead Sources.',
      },
    });

    return;
  }

  try {
    const pages = await listInstagramCapablePages({ userAccessToken: userToken });

    res.json({
      data: pages.map((page) => ({
        pageId: page.pageId,
        pageName: page.pageName,
        instagram: page.instagram,
      })),
    });
  } catch (error) {
    logger.warn(
      { name: (error as { name?: string })?.name },
      'Could not list Pages for Instagram connection.',
    );

    res.status(502).json({
      error: {
        code: 'META_PAGES_UNAVAILABLE',
        message:
          'Meta would not list your Pages. The Facebook authorisation may have expired - reconnect it under Lead Sources.',
      },
    });
  }
});

/**
 * POST /instagram/accounts - connect one Instagram account.
 *
 * The Page token is minted from the stored user token rather than pasted, so there is no second
 * credential for an admin to handle or mislay.
 */
export const connectInstagramAccount = asyncHandler(async (req, res) => {
  const { pageId, instagramAccountId, username, pageName } = req.body ?? {};

  if (!pageId || !instagramAccountId) {
    res.status(400).json({
      error: { code: 'INSTAGRAM_SELECTION_REQUIRED', message: 'Choose an Instagram account.' },
    });

    return;
  }

  const connection = await MetaConnection.findOne({ organizationId: req.auth?.organization?._id })
    .select('+encryptedUserAccessToken')
    .exec();

  const userToken = decryptMetaAccessTokenFromStorage(connection?.encryptedUserAccessToken);

  if (!userToken) {
    res.status(409).json({
      error: { code: 'META_NOT_CONNECTED', message: 'Connect Facebook first under Lead Sources.' },
    });

    return;
  }

  let pageToken: string | null = null;

  try {
    const pages = await listInstagramCapablePages({ userAccessToken: userToken });
    pageToken = pages.find((page) => page.pageId === String(pageId))?.pageAccessToken ?? null;
  } catch {
    pageToken = null;
  }

  if (!pageToken) {
    res.status(502).json({
      error: {
        code: 'INSTAGRAM_PAGE_TOKEN_UNAVAILABLE',
        message:
          'Meta would not issue a token for that Page. You need the Messages task on it, and "Allow Access to Messages" must be on in the Instagram app settings.',
      },
    });

    return;
  }

  try {
    const account = await InstagramAccount.findOneAndUpdate(
      // Keyed on the Instagram account id alone, matching the unique index - so reconnecting
      // overwrites rather than accumulating, and another workspace's account is refused below.
      { instagramAccountId: String(instagramAccountId) },
      {
        $set: {
          organizationId: req.auth?.organization?._id,
          pageId: String(pageId),
          pageName: pageName ?? null,
          username: username ?? null,
          encryptedPageAccessToken: encryptInstagramPageTokenForStorage(pageToken),
          accessTokenLast4: instagramPageTokenLast4(pageToken),
          accessTokenSetAt: new Date(),
          status: 'active',
          lastError: null,
          lastErrorAt: null,
          connectedBy: req.auth?.user?._id ?? null,
        },
        // Automation settings are NOT reset on reconnect: an expired token should not silently
        // wipe the replies somebody wrote, and should not silently re-enable them either.
        $setOnInsert: { automationEnabled: false, welcomeReply: null, keywordReplies: [] },
      },
      { new: true, upsert: true, runValidators: true },
    ).exec();

    res.status(201).json({ data: serialize(account as never) });
  } catch (error) {
    if ((error as { code?: number })?.code === 11000) {
      res.status(409).json({
        error: {
          code: 'INSTAGRAM_ACCOUNT_TAKEN',
          message:
            'That Instagram account is already connected to another workspace. A DM names only the account, so it can belong to one inbox.',
        },
      });

      return;
    }

    throw error;
  }
});

/** PATCH /instagram/accounts/:id/automation - welcome, keywords, and the master switch. */
export const updateInstagramAutomation = asyncHandler(async (req, res) => {
  const { automationEnabled, welcomeReply, keywordReplies } = req.body ?? {};

  const changes: Record<string, unknown> = {};

  if (typeof automationEnabled === 'boolean') {
    changes.automationEnabled = automationEnabled;
  }

  if (welcomeReply !== undefined) {
    changes.welcomeReply = String(welcomeReply ?? '').trim() || null;
  }

  if (keywordReplies !== undefined) {
    if (!Array.isArray(keywordReplies)) {
      res.status(400).json({
        error: { code: 'INSTAGRAM_KEYWORDS_INVALID', message: 'Keyword replies must be a list.' },
      });

      return;
    }

    // A blank keyword is a substring of every message, so one empty row would answer everything.
    // Dropped here rather than relied on downstream.
    changes.keywordReplies = keywordReplies
      .map((rule: { keyword?: unknown; reply?: unknown }) => ({
        keyword: String(rule?.keyword ?? '').trim(),
        reply: String(rule?.reply ?? '').trim(),
      }))
      .filter((rule) => rule.keyword !== '' && rule.reply !== '')
      .slice(0, 50);
  }

  const account = await InstagramAccount.findOneAndUpdate(
    { _id: req.params.id, organizationId: req.auth?.organization?._id },
    { $set: changes },
    { new: true, runValidators: true },
  ).exec();

  if (!account) {
    res.status(404).json({
      error: { code: 'INSTAGRAM_ACCOUNT_NOT_FOUND', message: 'That account is not connected here.' },
    });

    return;
  }

  res.json({ data: serialize(account as never) });
});

/** POST /instagram/accounts/:id/disconnect - stop receiving, keep the row for reconnecting. */
export const disconnectInstagramAccount = asyncHandler(async (req, res) => {
  const account = await InstagramAccount.findOneAndUpdate(
    { _id: req.params.id, organizationId: req.auth?.organization?._id },
    {
      $set: {
        status: 'disconnected',
        // The credential is destroyed, not just marked unused.
        encryptedPageAccessToken: null,
        accessTokenLast4: null,
        automationEnabled: false,
      },
    },
    { new: true },
  ).exec();

  if (!account) {
    res.status(404).json({
      error: { code: 'INSTAGRAM_ACCOUNT_NOT_FOUND', message: 'That account is not connected here.' },
    });

    return;
  }

  res.json({ data: serialize(account as never) });
});

/**
 * POST /instagram/threads/:conversationId/takeover - a human takes the thread, or hands it back.
 *
 * Writes the SAME flag WhatsApp uses, so a handover means one thing across the CRM.
 */
export const setInstagramTakeover = asyncHandler(async (req, res) => {
  const resume = req.body?.resume === true;

  const conversation = await setInstagramThreadAutomation({
    organizationId: req.auth?.organization?._id as never,
    conversationId: req.params.conversationId as never,
    enabled: resume,
    reason: resume ? null : 'human_takeover',
  });

  if (!conversation) {
    res.status(404).json({
      error: { code: 'CONVERSATION_NOT_FOUND', message: 'That conversation does not exist here.' },
    });

    return;
  }

  res.json({
    data: {
      id: String(conversation._id),
      aiAutomationEnabled: conversation.aiAutomationEnabled === true,
      aiAutomationPausedReason: conversation.aiAutomationPausedReason ?? null,
    },
  });
});
