import { useRef, useState } from 'react';

import { generateTemplates, sendMessage } from '../../api/endpoints';
import { useAuth } from '../../auth/AuthContext';
import { buildRawDetails } from '../../lib/template-context';
import { type AuthValue, errorMessage } from '../types';

type Props = {
  /** The thread these messages will be sent to. The ONLY routing input - never a name. */
  conversationId: string;
  /** Steers generation towards the right playbook without the owner retyping it. */
  aiCategory?: string | null;
  /** What the lead has already told us: date, city, guest count and so on. */
  aiFacts?: Record<string, unknown> | null;
};

interface Option {
  title: string;
  body: string;
}

/**
 * Write a few versions of an offer, edit one, send it.
 *
 * REUSES THE EXISTING TEMPLATE WRITER, the same `/templates/generate` the Templates page used,
 * and the existing `POST /conversations/:id/messages` to send. Nothing here talks to WhatsApp
 * directly, so manual takeover, opt-out, quiet hours, the allowlist, the outbound queue and the
 * retry ladder all apply exactly as they do to a message the owner types by hand.
 *
 * SWITCHING THREADS REMOUNTS THIS - LeadPanel keys it on the conversation id - so one lead's
 * drafts can never be left on screen looking ready to send to another. `generatedFor` below is
 * the second line of that defence, for any path where a remount does not happen.
 *
 * THE DANGEROUS PART IS WHICH THREAD IT GOES TO. The owner generates for one lead, clicks
 * another in the inbox while it is still writing, and sends - and a quote meant for a December
 * wedding lands on a stranger. So a generated batch is STAMPED with the conversation it was
 * written for, and sending is refused when that stamp does not match the thread currently open.
 * See `generatedFor`.
 */
const MessageTemplatesSection = ({ conversationId, aiCategory, aiFacts }: Props) => {
  const { authedRequest } = useAuth() as AuthValue;

  const [offer, setOffer] = useState('');
  const [options, setOptions] = useState<Option[]>([]);
  /** Which conversation `options` were written for. Null whenever there are none. */
  const [generatedFor, setGeneratedFor] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<number | null>(0);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [generating, setGenerating] = useState(false);
  const [sendingIndex, setSendingIndex] = useState<number | null>(null);
  const [sentIndex, setSentIndex] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  /**
   * One key per generated batch. Two clicks on Send reuse it, so the backend's idempotency
   * check collapses them into a single outbound message rather than sending twice.
   */
  const sendKeys = useRef(new Map<number, string>());

  /**
   * In-flight guard, in a ref rather than in `sendingIndex`.
   *
   * STATE IS TOO SLOW FOR THIS. Three clicks landing in one task all read the same rendered
   * value of `sendingIndex` - React has not re-rendered between them - so a state check lets
   * the extras through. Observed in a browser: three clicks produced two POSTs. The backend's
   * idempotency key meant only one message was created, but the second request should never
   * have left. A ref updates synchronously, so the second click sees it immediately.
   */
  const sendInFlight = useRef(false);

  const handleGenerate = async () => {
    if (offer.trim() === '' || generating) {
      return;
    }

    // Captured now: by the time this resolves the owner may be looking at someone else, and
    // the result belongs to the lead it was written for, not to whoever is on screen.
    const target = conversationId;

    setGenerating(true);
    setError(null);
    setSentIndex(null);

    try {
      const payload = await authedRequest((token) =>
        generateTemplates({
          token,
          rawDetails: buildRawDetails(offer, aiCategory, aiFacts),
        }),
      );

      const generated = (payload?.data?.templates ?? []).filter(
        (template) => (template?.body ?? '').trim() !== '',
      );

      if (generated.length === 0) {
        setError('No usable versions came back. Try describing the offer differently.');

        return;
      }

      setOptions(generated.map((template) => ({ title: template.title, body: template.body })));
      setGeneratedFor(target);
      setExpanded(0);
      sendKeys.current.clear();
    } catch (generateError: unknown) {
      // The offer text is deliberately NOT cleared - retyping it after a failed call is the
      // most annoying thing this section could do.
      setError(errorMessage(generateError, 'Could not write the messages. Try again.'));
    } finally {
      setGenerating(false);
    }
  };

  const updateBody = (index: number, body: string) => {
    setOptions((current) =>
      current.map((option, position) => (position === index ? { ...option, body } : option)),
    );
    // The text changed, so a key issued for the old text must not suppress this as a duplicate.
    sendKeys.current.delete(index);
    setSentIndex(null);
  };

  const handleSend = async (index: number) => {
    const option = options[index];

    if (!option || sendInFlight.current) {
      return;
    }

    if (option.body.trim() === '') {
      setError('That message is empty.');

      return;
    }

    // THE GUARD. The batch was written for another lead and the owner has since switched.
    // Refused outright rather than silently retargeted - a quote sent to the wrong customer
    // cannot be taken back.
    if (generatedFor !== conversationId) {
      setError('These were written for a different lead. Generate again for this one.');

      return;
    }

    let key = sendKeys.current.get(index);

    if (!key) {
      key = `tpl-${conversationId}-${Date.now()}-${index}`;
      sendKeys.current.set(index, key);
    }

    sendInFlight.current = true;
    setSendingIndex(index);
    setError(null);

    try {
      await authedRequest((token) =>
        sendMessage({
          token,
          // The open thread, every time. Never a display name, never a stored number.
          conversationId,
          body: option.body.trim(),
          idempotencyKey: key,
        }),
      );

      setSentIndex(index);
    } catch (sendError: unknown) {
      // The key is kept, so a retry after a network wobble cannot produce a second message if
      // the first actually landed.
      setError(errorMessage(sendError, 'Could not send that message.'));
    } finally {
      sendInFlight.current = false;
      setSendingIndex(null);
    }
  };

  const stale = options.length > 0 && generatedFor !== conversationId;

  return (
    <div className="rounded-lg border border-slate-200 p-3">
      <span className="text-xs font-semibold uppercase text-slate-500">Message templates</span>

      <label htmlFor="offer-description" className="mt-2 block text-xs text-slate-600">
        What would you like to offer?
      </label>
      <textarea
        id="offer-description"
        value={offer}
        onChange={(event) => setOffer(event.target.value)}
        placeholder="Wedding photography package with candid photography, traditional photography, and an album."
        rows={3}
        className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
      />
      <p className="mt-1 text-[0.6875rem] leading-snug text-slate-500">
        Include the price if you want it quoted — the writer never invents one.
      </p>

      <button
        type="button"
        onClick={handleGenerate}
        disabled={generating || offer.trim() === ''}
        className="mt-2 rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
      >
        {generating ? 'Writing…' : 'Generate templates'}
      </button>

      {error ? (
        <p role="alert" className="mt-2 text-xs text-red-600">
          {error}
        </p>
      ) : null}

      {stale ? (
        <p className="mt-2 text-xs text-amber-700">
          These were written for a different lead. Generate again before sending.
        </p>
      ) : null}

      {options.length > 0 ? (
        <ul className="mt-3 space-y-2">
          {options.map((option, index) => {
            const isOpen = expanded === index;
            const isEditing = editingIndex === index;

            return (
              <li key={option.title + String(index)} className="rounded-md border border-slate-200">
                <button
                  type="button"
                  onClick={() => setExpanded(isOpen ? null : index)}
                  aria-expanded={isOpen}
                  className="flex w-full items-center justify-between px-2.5 py-1.5 text-left"
                >
                  <span className="text-xs font-semibold text-slate-800">
                    Option {index + 1} · {option.title}
                  </span>
                  <span aria-hidden="true" className="text-xs text-slate-400">
                    {isOpen ? '−' : '+'}
                  </span>
                </button>

                {isOpen ? (
                  <div className="border-t border-slate-200 p-2.5">
                    {isEditing ? (
                      <textarea
                        aria-label={`Option ${index + 1} message`}
                        value={option.body}
                        onChange={(event) => updateBody(index, event.target.value)}
                        rows={6}
                        className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
                      />
                    ) : (
                      <p className="whitespace-pre-wrap text-xs text-slate-700">{option.body}</p>
                    )}

                    <div className="mt-2 flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setEditingIndex(isEditing ? null : index)}
                        className="rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                      >
                        {isEditing ? 'Done' : 'Edit'}
                      </button>

                      <button
                        type="button"
                        onClick={() => void handleSend(index)}
                        disabled={sendingIndex !== null || stale || option.body.trim() === ''}
                        className="rounded-md bg-blue-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                      >
                        {sendingIndex === index ? 'Sending…' : 'Send'}
                      </button>

                      {sentIndex === index ? (
                        <span role="status" className="text-xs text-green-700">
                          {/* Queued, not delivered - the outbound runner decides that, and quiet
                              hours or a dead socket can still hold it. Saying "Sent" here would
                              claim something this component cannot know. */}
                          Queued for sending
                        </span>
                      ) : null}
                    </div>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
};

export default MessageTemplatesSection;
