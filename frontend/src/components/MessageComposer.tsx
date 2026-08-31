import { type ChangeEvent, type FormEvent, useState } from 'react';

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
  draftId: string | null;
  wasEdited: boolean;
  whatsappAccountId: string | null;
};

type SuggestResult = {
  draftId: string | null;
  draftText: string;
};

type Props = {
  onSend: (args: SendArgs) => Promise<void>;
  onSuggest?: () => Promise<SuggestResult>;
  canSuggest?: boolean;
  /** Numbers with a live session that this user may send from. */
  sendableAccounts?: readonly SendableAccount[];
  /** The number the thread is currently on, pre-selected in the dropdown. */
  currentAccountId?: string | null;
  currentAccountName?: string | null;
};

const MessageComposer = ({
  onSend,
  onSuggest,
  canSuggest = false,
  sendableAccounts = [],
  currentAccountId = null,
  currentAccountName = null,
}: Props) => {
  const [body, setBody] = useState('');
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Tracks whether the current text is an unedited AI draft, so the parent can record whether
  // it was sent as-is or edited first (ADR-005's feedback-metadata control).
  const [draftId, setDraftId] = useState<string | null>(null);
  const [draftText, setDraftText] = useState<string | null>(null);

  const handleBodyChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    setBody(event.target.value);
  };

  const handleSuggest = async () => {
    if (suggesting || sending || !onSuggest) {
      return;
    }

    setSuggesting(true);
    setError(null);

    try {
      const suggestion = await onSuggest();
      setBody(suggestion.draftText);
      setDraftId(suggestion.draftId);
      setDraftText(suggestion.draftText);
    } catch (suggestError: unknown) {
      setError(errorMessage(suggestError, 'Unable to suggest a reply.'));
    } finally {
      setSuggesting(false);
    }
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
        draftId,
        wasEdited: draftId ? trimmed !== draftText : false,
        whatsappAccountId: activeAccountId,
      });
      setBody('');
      setDraftId(null);
      setDraftText(null);
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
      className="border-t border-slate-200 bg-white p-3"
    >
      {error ? (
        <p role="alert" className="mb-2 text-sm text-red-600">
          {error}
        </p>
      ) : null}
      {canSuggest || showAccountPicker ? (
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            {canSuggest ? (
              <button
                type="button"
                onClick={handleSuggest}
                disabled={suggesting || sending}
                className="rounded-lg border border-blue-300 px-2.5 py-1 text-xs font-medium text-blue-700 hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {suggesting ? 'Suggesting…' : '✨ Suggest reply'}
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
            {draftId ? (
              <span className="text-xs text-slate-400">AI draft — review before sending</span>
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
