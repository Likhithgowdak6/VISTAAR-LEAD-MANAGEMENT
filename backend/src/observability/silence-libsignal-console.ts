/**
 * Stops `libsignal` printing whole Signal session records to the terminal.
 *
 * The Baileys stack takes an injectable logger and this project gives it a filtered one (see
 * whatsapp/providers/baileys.provider.ts's createSafeBaileysLogger). `libsignal`, sitting
 * underneath it, does not: `libsignal/src/session_record.js` calls `console.info` and
 * `console.warn` DIRECTLY, passing the entire session object. There is no logger to configure
 * and no option to turn it off, so filtering its console calls is the only seam available.
 *
 * Two reasons this is worth doing, in order of importance:
 *
 *  1. IT PRINTS KEY MATERIAL. Each dump includes the ratchet's `privKey` and `rootKey` as raw
 *     buffers. They are ephemeral per-conversation ratchet keys rather than the account
 *     credentials in WhatsAppAuthState, and they rotate on their own - but they have no business
 *     in a terminal, in a scrollback buffer, or in a log file somebody later pastes into a chat
 *     or an issue tracker to ask for help.
 *  2. IT IS UNREADABLE. One session close is roughly thirty lines of hex. A reconnect closes
 *     many, which buries the pipeline trace the operator is actually reading.
 *
 * Deliberately narrow: it matches only the exact message prefixes that file emits, and anything
 * else - including a real libsignal error - passes through to the original console untouched. A
 * blanket console silencer would hide the next genuine problem.
 */

/** The message prefixes libsignal's session_record.js logs, all of them session-state chatter. */
const LIBSIGNAL_NOISE_PREFIXES: readonly string[] = [
  'Closing session:',
  'Opening session:',
  'Removing old closed session:',
  'Session already closed',
  'Session already open',
  'Migrating session to:',
];

const isLibsignalNoise = (args: readonly unknown[]): boolean => {
  const [first] = args;

  return (
    typeof first === 'string' && LIBSIGNAL_NOISE_PREFIXES.some((prefix) => first.startsWith(prefix))
  );
};

type ConsoleMethod = 'info' | 'warn';

let restore: (() => void) | null = null;

/**
 * Installs the filter. Idempotent: calling it twice does not stack two layers of wrapper, which
 * matters because a test that imports the server module more than once would otherwise leave the
 * console wrapped several deep.
 */
export const silenceLibsignalConsole = (): void => {
  if (restore) {
    return;
  }

  const originals = {
    info: console.info.bind(console),
    warn: console.warn.bind(console),
  };

  const wrap = (method: ConsoleMethod) => {
    console[method] = (...args: unknown[]): void => {
      if (isLibsignalNoise(args)) {
        return;
      }

      originals[method](...args);
    };
  };

  wrap('info');
  wrap('warn');

  restore = () => {
    console.info = originals.info;
    console.warn = originals.warn;
    restore = null;
  };
};

/** Test-only: puts the real console back. */
export const restoreLibsignalConsole = (): void => {
  restore?.();
};
