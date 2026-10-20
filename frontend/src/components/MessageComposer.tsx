import { type ChangeEvent, type FormEvent, useState } from 'react';

import { type MessageTemplate } from '../types';
import { errorMessage, type SendableAccount } from './types';

const generateIdempotencyKey = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return `msg-${Date.now()}-${Math.random().toString(16).slice(2)}`;
};

type SendArgs = {
  body: string;
  idempotencyKey: string;
  whatsappAccountId: string | null;
};

type Props = {
  onSend: (args: SendArgs) => Promise<void>;
  /**
   * Opens the template writer for the open thread. Replaced "Suggest reply", which filled this
   * box with a single AI draft; the writer offers several versions, each editable and sendable
   * on its own, and lives in a dialog so it does not crowd the composer on a phone.
   */
  onOpenTemplates?: () => void;
  canUseTemplates?: boolean;
  /** Numbers with a live session that this user may send from. */
  sendableAccounts?: readonly SendableAccount[];
  /** The number the thread is currently on, pre-selected in the dropdown. */
  currentAccountId?: string | null;
  currentAccountName?: string | null;
  /**
   * Saved price messages, loaded by the parent. Picking one fills the box rather than sending it:
   * a quote goes out under the studio's name, so it gets the same human look as an AI draft.
   */
  templates?: readonly MessageTemplate[];
};

const MessageComposer = ({
  onSend,
  onOpenTemplates,
  canUseTemplates = false,
  sendableAccounts = [],
  currentAccountId = null,
  currentAccountName = null,
  templates = [],
}: Props) => {
  const [body, setBody] = useState('');
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleBodyChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    setBody(event.target.value);
  };

  /**
   * Loads a saved quote into the box for editing, never straight out to the customer.
   *
   * Confirms before overwriting: a half-typed reply is work, and there is no undo on a textarea.
   */
  const handleTemplate = (templateId: string) => {
    const template = templates.find((candidate) => candidate.id === templateId);
    if (!template) {
      return;
    }

    if (body.trim() !== '' && !window.confirm('Replace what you have typed with this template?')) {
      return;
    }

    setBody(template.body);
  };

  // Falls back to the thread's own number until the agent picks something else, so a stale
  // selection can never survive switching to a different lead.
  const activeAccountId = selectedAccountId ?? currentAccountId ?? null;

  // The thread's own number may not be sendable — disconnected, or outside this user's access.
  // It still gets an entry, disabled, so the dropdown never silently displays a different
  // number than the one the message would actually go out on.
  const currentIsSendable = sendableAccounts.some((account) => account.id === currentAccountId);
  const accountOptions = [
    ...(currentAccountId && !currentIsSendable
      ? [{ id: currentAccountId, name: currentAccountName ?? 'Current number', disabled: true }]
      : []),
    ...sendableAccounts.map((account) => ({ ...account, disabled: false })),
  ];

  const showAccountPicker = accountOptions.length > 1;
  const isSwitchingAccount =
    activeAccountId !== null && currentAccountId !== null && activeAccountId !== currentAccountId;

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const trimmed = body.trim();
    if (!trimmed || sending) {
      return;
    }

    setSending(true);
    setError(null);

    try {
      await onSend({
        body: trimmed,
        idempotencyKey: generateIdempotencyKey(),
        whatsappAccountId: activeAccountId,
      });
      setBody('');
    } catch (sendError: unknown) {
      setError(errorMessage(sendError, 'Unable to send message.'));
    } finally {
      setSending(false);
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      aria-label="Send a message"
      // The bottom inset ADDS to p-3 so the send button clears the gesture bar; shrink-0 stops
      // the composer being squeezed to nothing when the thread above it is long.
      className="shrink-0 border-t border-slate-200 bg-white p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]"
    >
      {error ? (
        <p role="alert" className="mb-2 text-sm text-red-600">
          {error}
        </p>
      ) : null}
      {canUseTemplates || showAccountPicker || templates.length > 0 ? (
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            {templates.length > 0 ? (
              /* Resets to the placeholder after each pick, so choosing the same template twice in
                 a row still fires a change event. */
              <select
                aria-label="Insert a template"
                value=""
                onChange={(event) => handleTemplate(event.target.value)}
                disabled={sending}
                className="rounded-lg border border-slate-300 px-2 py-1 text-xs text-slate-700 focus:border-blue-500 focus:outline-none disabled:opacity-50"
              >
                <option value="">Template…</option>
                {templates.map((template) => (
                  <option key={template.id} value={template.id}>
                    {template.title}
                  </option>
                ))}
              </select>
            ) : null}
            {canUseTemplates && onOpenTemplates ? (
              <button
                type="button"
                onClick={onOpenTemplates}
                disabled={sending}
                className="rounded-lg border border-blue-300 px-2.5 py-1 text-xs font-medium text-blue-700 hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                ✨ Message templates
              </button>
            ) : null}
            {showAccountPicker ? (
              <label className="flex items-center gap-1.5 text-xs text-slate-500">
                <span>From</span>
                <select
                  aria-label="Send from"
                  value={activeAccountId ?? ''}
                  onChange={(event) => setSelectedAccountId(event.target.value || null)}
                  disabled={sending}
                  className="rounded-lg border border-slate-300 px-2 py-1 text-xs text-slate-700 focus:border-blue-500 focus:outline-none disabled:opacity-50"
                >
                  {accountOptions.map((account) => (
                    <option key={account.id} value={account.id} disabled={account.disabled}>
                      {account.disabled ? `${account.name} (not connected)` : account.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            {isSwitchingAccount ? (
              <span className="text-xs text-amber-600">
                This lead will move to the selected number.
              </span>
            ) : null}
          </div>
        </div>
      ) : null}
      <div className="flex items-end gap-2">
        <textarea
          aria-label="Message"
          rows={1}
          value={body}
          onChange={handleBodyChange}
          placeholder="Type a reply…"
          className="max-h-32 flex-1 resize-none rounded-lg border border-slate-300 px-3 py-2 text-slate-900 focus:border-blue-500 focus:outline-none"
        />
        <button
          type="submit"
          disabled={sending || body.trim() === ''}
          className="rounded-lg bg-blue-600 px-4 py-2 font-semibold text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-blue-300"
        >
          {sending ? 'Sending…' : 'Send'}
        </button>
      </div>
    </form>
  );
};

export default MessageComposer;
