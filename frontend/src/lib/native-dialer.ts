import { Capacitor, registerPlugin } from '@capacitor/core';

/**
 * Handing a number to the phone's own dialler.
 *
 * WHAT THIS IS AND IS NOT. It opens the system dialler with the number filled in and stops
 * there. The agent presses the green button. There is no VoIP leg, no cloud telephony, no SIP,
 * no in-app call screen - the call is an ordinary cellular call on the agent's own SIM, and the
 * dialler stays the calling interface.
 *
 * ACTION_DIAL, NOT ACTION_CALL, and the difference is the whole permission story. `ACTION_CALL`
 * places the call immediately and needs the `CALL_PHONE` runtime permission, which Vistaar does
 * not request and does not hold. `ACTION_DIAL` needs NO permission at all, because the user is
 * still the one who decides to dial. That is also the behaviour the brief asks for: the agent
 * "places or confirms" the call.
 *
 * THE WEB FALLBACK IS A `tel:` LINK, which is what every browser and every desktop OS already
 * does with a phone number. The dashboard is used on laptops too, and a Call button that only
 * worked inside the APK would be a worse answer than one that hands off to whatever the machine
 * has.
 *
 * NOTHING HERE LOGS THE NUMBER. It arrives from the authorised reveal, lives in a local
 * variable for the length of one function call, and is handed to the platform. It is never put
 * into a console line, an error message, an analytics event or a URL we construct for our own
 * API.
 */

export interface NativeDialerPlugin {
  /** Opens the system dialler pre-filled. Resolves once the intent has been fired. */
  openDialler(options: { number: string }): Promise<void>;
}

const NativeDialer = registerPlugin<NativeDialerPlugin>('NativeDialer');

/** Digits, and the punctuation a dialler actually understands. Anything else is not a number. */
const DIALLABLE = /^[+0-9][0-9\s\-().]{4,24}$/;

export const isDiallable = (value: string | null | undefined): boolean =>
  typeof value === 'string' && DIALLABLE.test(value.trim());

export interface OpenDiallerOptions {
  isNative?: () => boolean;
  plugin?: NativeDialerPlugin;
  /** Seam for the web path, so a test never has to touch real navigation. */
  navigate?: (url: string) => void;
}

export class NotDiallableError extends Error {
  constructor() {
    super('NOT_DIALLABLE');
    this.name = 'NotDiallableError';
  }
}

/**
 * Opens the dialler, or throws if the number is not one.
 *
 * REFUSES RATHER THAN GUESSING. A contact with no number on file, or with something that is not
 * a phone number in the field, must not produce a dialler full of rubbish or a silently dead
 * button - the caller catches this and says plainly that there is no number to call.
 *
 * The error carries NO number, deliberately: an error message is the most likely thing to end
 * up in a log or a bug report.
 */
export const openDialler = async (
  phoneNumber: string,
  {
    isNative = () => Capacitor.isNativePlatform(),
    plugin = NativeDialer,
    navigate = (url: string) => {
      window.location.href = url;
    },
  }: OpenDiallerOptions = {},
): Promise<void> => {
  const trimmed = (phoneNumber ?? '').trim();

  if (!isDiallable(trimmed)) {
    throw new NotDiallableError();
  }

  if (isNative()) {
    await plugin.openDialler({ number: trimmed });
    return;
  }

  // `encodeURIComponent` so a `+` survives: unencoded it is read as a space in a URI, and the
  // country code silently vanishes from an international number.
  navigate(`tel:${encodeURIComponent(trimmed)}`);
};
