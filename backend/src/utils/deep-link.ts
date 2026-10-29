import { env, type Env } from '../config/env.js';

/**
 * Links that take somebody from a WhatsApp notification to the exact record it is about.
 *
 * ONE BUILDER, NOT ONE PER NOTIFICATION. Two handlers composing their own URLs is how one of
 * them ends up pointing at a development host, or at a route that was renamed a month ago, and
 * nobody notices because the message still looks fine. Every notification link in this codebase
 * comes from here.
 *
 * ORDINARY HTTPS LINKS, DELIBERATELY. The provider is Baileys, which speaks the WhatsApp Web
 * protocol and sends `{ text }` and nothing else - see baileys.provider.ts. Native interactive
 * buttons are a WhatsApp Business Cloud API feature needing approved templates and a different
 * provider entirely. WhatsApp clients linkify a bare https URL in message text, which gets the
 * same tap with none of that, so that is what these produce. They are NOT buttons and this file
 * does not pretend otherwise.
 *
 * NOTHING SENSITIVE IN THE URL. A record id and nothing else: no token, no session, no phone
 * number, no name. The link opens the app, the app asks for a login if there is not one already,
 * and the server authorises the fetch exactly as it does for any other request. The id in the
 * URL grants nothing on its own - see the conversation routes, which scope every read by the
 * caller's organisation.
 */

/** Mongo ObjectId as it appears in a URL. Anything else is not an id we produced. */
const OBJECT_ID_PATTERN = /^[a-f\d]{24}$/i;

/**
 * Origins that are never the public web app, however they are ordered in config.
 *
 * `https://localhost` is in `FRONTEND_ORIGIN` because the Android build's WebView runs there -
 * see capacitor.config.ts. A notification linking somebody to `https://localhost/...` opens
 * nothing, so it is filtered out rather than relied on not being first.
 */
const NON_PUBLIC_HOSTS: readonly string[] = ['localhost', '127.0.0.1', '0.0.0.0', '[::1]'];

/**
 * The canonical public origin for links.
 *
 * DERIVED FROM `FRONTEND_ORIGIN` rather than from a new variable, because that list is already
 * the deployment's statement about where the app lives and adding a second source of truth
 * means one of them eventually goes stale. The first entry that is a real, reachable https
 * origin wins.
 *
 * Returns null when nothing qualifies. Callers omit the link rather than guessing - a link to
 * the wrong host is worse than no link, because it looks like it should work.
 */
export const resolvePublicAppOrigin = (config: Env = env): string | null => {
  const origins = Array.isArray(config.FRONTEND_ORIGIN) ? config.FRONTEND_ORIGIN : [];

  for (const candidate of origins) {
    let url: URL;

    try {
      url = new URL(candidate);
    } catch {
      continue;
    }

    // http is refused outright: these links travel through WhatsApp to a phone, and the app's
    // own refresh cookie is `Secure` - a plain-http link cannot work even if someone taps it.
    if (url.protocol !== 'https:') {
      continue;
    }

    if (NON_PUBLIC_HOSTS.includes(url.hostname)) {
      continue;
    }

    // Origin only: no trailing path, no trailing slash. The query is appended by the builders.
    return url.origin;
  }

  return null;
};

/** Narrow a possibly-ObjectId value to the string form, or null. */
const asRecordId = (value: unknown): string | null => {
  const text = typeof value === 'string' ? value.trim() : String(value ?? '').trim();

  return OBJECT_ID_PATTERN.test(text) ? text : null;
};

export interface DeepLinkOptions {
  config?: Env;
}

/**
 * Opens one lead's conversation in the inbox.
 *
 * `?conversation=<id>` on the root, because the frontend has NO ROUTER: navigation is
 * `view` + `selectedId` state in AppShell, and the only established way into it from outside is
 * a query parameter read once on load and then wiped from the address bar. That is exactly how
 * the Meta OAuth callback already returns - see frontend/src/lib/meta-connect.ts - so this
 * reuses a pattern the app already has rather than inventing a second one.
 *
 * Null when the id is not a well-formed ObjectId, or when there is no public origin configured.
 */
export const buildConversationDeepLink = (
  conversationId: unknown,
  { config = env }: DeepLinkOptions = {},
): string | null => {
  const id = asRecordId(conversationId);
  const origin = resolvePublicAppOrigin(config);

  if (!id || !origin) {
    return null;
  }

  return `${origin}/?conversation=${id}`;
};

export interface ReminderDeepLinkParams {
  /** The follow-up task. Carried so the app can highlight it once a reminder view exists. */
  taskId?: unknown;
  /** The lead the reminder is about. Absent for a personal reminder. */
  conversationId?: unknown;
}

/**
 * Opens the reminder itself, over the lead it is about.
 *
 * BOTH IDS, AND BOTH ARE USED. `conversation=<id>` opens the thread, which is the destination
 * and the floor: it is what the link did before a reminder view existed, and it is what still
 * happens if the reminder has since been completed or deleted. `reminder=<id>` opens
 * ReminderDetailDialog over it, so a notification that said "follow up with Vaishu at 5" lands
 * on that reminder rather than on a lead panel with five of them in a collapsed section.
 *
 * THE CONVERSATION ID IS NOT DECORATION in the second case either - it scopes the lookup. The
 * app reads the lead's own follow-up list and picks this id out of it, so a reminder belonging
 * to a different conversation than the link claims simply is not found.
 *
 * NULL FOR A PERSONAL REMINDER, deliberately. One with no `conversationId` has no lead and no
 * destination; linking it to the inbox root would be a tap that answers nothing.
 */
export const buildReminderDeepLink = (
  { taskId, conversationId }: ReminderDeepLinkParams,
  { config = env }: DeepLinkOptions = {},
): string | null => {
  const base = buildConversationDeepLink(conversationId, { config });

  if (!base) {
    return null;
  }

  const reminderId = asRecordId(taskId);

  return reminderId ? `${base}&reminder=${reminderId}` : base;
};
