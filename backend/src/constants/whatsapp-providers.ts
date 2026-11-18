/**
 * How a WhatsApp number is actually connected.
 *
 * Lives in constants/ rather than beside the provider implementations because it is persisted on
 * every WhatsAppAccount: the account model must not import a module that pulls in Baileys, which
 * opens sockets and installs console patches the moment it loads.
 *
 * The two are not interchangeable at runtime, and the difference is not an implementation detail:
 *
 *   BAILEYS  - an unofficial socket against WhatsApp Web. A QR scan, a live connection that can
 *              drop, no message approval, and no per-message fee. Also no guarantee from Meta
 *              that the number will not be banned.
 *   CLOUD    - Meta's official Cloud API. No session at all: a phone number id and a token, and
 *              every send is an HTTPS call. Meta bills per conversation and REFUSES free-form
 *              messages outside the 24-hour customer service window, which is the single
 *              behavioural difference that leaks furthest up the stack.
 */
export const WHATSAPP_PROVIDER_KINDS = Object.freeze({
  BAILEYS: 'baileys',
  CLOUD: 'cloud',
} as const);

export type WhatsAppProviderKind =
  (typeof WHATSAPP_PROVIDER_KINDS)[keyof typeof WHATSAPP_PROVIDER_KINDS];

export const WHATSAPP_PROVIDER_KIND_VALUES = Object.freeze(
  Object.values(WHATSAPP_PROVIDER_KINDS),
) as readonly [WhatsAppProviderKind, ...WhatsAppProviderKind[]];

/**
 * Meta's customer service window, in milliseconds.
 *
 * Within 24 hours of the customer's last inbound message a business may send anything it likes.
 * Outside it, Meta accepts ONLY a pre-approved template and rejects everything else with error
 * 131047 - so this constant decides whether the composer offers a text box or a template picker.
 *
 * Twenty-four hours is fixed by Meta's policy, not configurable per account, which is why it is a
 * constant here rather than a setting somebody can quietly get wrong.
 */
export const CLOUD_SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * How close to the edge counts as "about to close".
 *
 * Purely a presentation threshold: the window is open until it is not. It exists so the UI can
 * warn an agent who is halfway through typing rather than letting them press send at 23:59:58
 * and read a rejection.
 */
export const CLOUD_SERVICE_WINDOW_WARNING_MS = 60 * 60 * 1000;

export const isCloudServiceWindowOpen = ({
  lastInboundAt,
  now = new Date(),
}: {
  lastInboundAt: Date | string | null | undefined;
  now?: Date;
}): boolean => {
  if (!lastInboundAt) {
    return false;
  }

  const last = lastInboundAt instanceof Date ? lastInboundAt : new Date(lastInboundAt);
  const lastMs = last.getTime();

  // An unparseable date is not evidence that the window is open. Treating it as closed costs a
  // template message; treating it as open costs a rejected send the agent believed had gone.
  if (Number.isNaN(lastMs)) {
    return false;
  }

  return now.getTime() - lastMs < CLOUD_SERVICE_WINDOW_MS;
};

/** Milliseconds until the window shuts, or 0 once it has. Null when it was never open. */
export const cloudServiceWindowRemainingMs = ({
  lastInboundAt,
  now = new Date(),
}: {
  lastInboundAt: Date | string | null | undefined;
  now?: Date;
}): number | null => {
  if (!lastInboundAt) {
    return null;
  }

  const last = lastInboundAt instanceof Date ? lastInboundAt : new Date(lastInboundAt);
  const lastMs = last.getTime();

  if (Number.isNaN(lastMs)) {
    return null;
  }

  return Math.max(0, lastMs + CLOUD_SERVICE_WINDOW_MS - now.getTime());
};
