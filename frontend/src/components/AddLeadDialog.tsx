import { useEffect, useState } from 'react';

import { createManualLead, listAiCategories, listSendableAccounts } from '../api/endpoints';
import { useAuth } from '../auth/AuthContext';
import ToggleSwitch from './ToggleSwitch';
import { type AuthValue, errorMessage, type SendableAccount } from './types';

type Props = {
  onClose: () => void;
  /** Called with the new (or already-existing) conversation id so the inbox can open it. */
  onCreated: (conversationId: string) => void;
};

/** `half_saree` -> `Half saree`. */
const labelFor = (key: string): string => {
  const spaced = key.replace(/_/g, ' ');

  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
};

/**
 * Adding a lead the owner met offline - a number, what they need, and whether to message them.
 *
 * TWO DECISIONS, NOT ONE. Saving the lead and messaging a stranger first are separated on purpose,
 * and the messaging switch starts OFF. Everywhere else in this app the AI is replying to someone
 * who wrote in; this is the one screen that can make it speak first, to a person who never asked
 * to hear from the studio. That deserves a deliberate second action rather than a default.
 *
 * The service picker matters more than it looks: it decides which of the AI's playbooks runs, so
 * choosing "Wedding" here means the very first message asks about functions and guest counts
 * instead of spending three turns working out what the job is.
 */
const AddLeadDialog = ({ onClose, onCreated }: Props) => {
  const { authedRequest } = useAuth() as AuthValue;
  const [accounts, setAccounts] = useState<SendableAccount[]>([]);
  const [categories, setCategories] = useState<string[]>([]);

  const [phone, setPhone] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [whatsappAccountId, setWhatsappAccountId] = useState('');
  const [aiCategory, setAiCategory] = useState('unknown');
  const [eventDate, setEventDate] = useState('');
  const [originNote, setOriginNote] = useState('');
  const [greetNow, setGreetNow] = useState(false);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    authedRequest((token) => listSendableAccounts({ token }))
      .then((payload) => {
        const list = payload.data ?? [];
        setAccounts(list);
        // Preselect when there is only one number, which is the normal case - an extra required
        // dropdown with one option is just a step to forget.
        if (list.length === 1) {
          setWhatsappAccountId(list[0]!.id);
        }
      })
      .catch(() => setError('Could not load your WhatsApp numbers.'));

    authedRequest((token) => listAiCategories({ token }))
      .then((payload) => setCategories(payload.data ?? []))
      .catch(() => {});
  }, [authedRequest]);

  const handleSubmit = async () => {
    if (!phone.trim()) {
      setError('A phone number is needed.');
      return;
    }

    if (!whatsappAccountId) {
      setError('Choose which of your numbers this lead belongs to.');
      return;
    }

    setBusy(true);
    setError(null);
    setNotice(null);

    try {
      const payload = await authedRequest((token) =>
        createManualLead({
          token,
          phone: phone.trim(),
          whatsappAccountId,
          displayName: displayName.trim() || undefined,
          aiCategory: aiCategory !== 'unknown' ? aiCategory : undefined,
          eventDate: eventDate.trim() || undefined,
          originNote: originNote.trim() || undefined,
          greetNow,
        }),
      );

      const conversationId = payload.data?.id;

      // `existing` is not a failure: the number was already in the inbox. Saying so and opening
      // that thread is the honest outcome - reporting success would imply the details just typed
      // were saved onto it, and they were not.
      if (payload.meta?.outcome === 'existing') {
        setNotice('That number is already in your inbox — opening it.');
      }

      if (conversationId) {
        onCreated(conversationId);
      }
    } catch (submitError: unknown) {
      setError(errorMessage(submitError, 'Could not add this lead.'));
    } finally {
      setBusy(false);
    }
  };

  const inputClass =
    'w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm text-slate-900 focus:border-blue-500 focus:outline-none disabled:opacity-60';
  const labelClass = 'mb-1 block text-xs font-semibold uppercase text-slate-500';

  return (
    <div
      role="dialog"
      aria-label="Add a lead"
      className="fixed inset-0 z-10 flex items-center justify-center bg-slate-900/40 p-4"
    >
      <div className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-2xl bg-white p-6 shadow-xl">
        <h3 className="text-base font-semibold text-slate-900">Add a lead</h3>
        <p className="mt-1 text-xs text-slate-500">
          For someone who reached you off WhatsApp — a call, an expo, a referral.
        </p>

        <div className="mt-4 space-y-3">
          <div>
            <label htmlFor="add-lead-phone" className={labelClass}>
              Phone number
            </label>
            <input
              id="add-lead-phone"
              type="tel"
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              placeholder="98765 43210"
              disabled={busy}
              className={inputClass}
            />
            <p className="mt-1 text-xs text-slate-400">
              Indian numbers don&apos;t need +91. Include the country code for anywhere else.
            </p>
          </div>

          <div>
            <label htmlFor="add-lead-name" className={labelClass}>
              Name <span className="normal-case text-slate-400">(optional)</span>
            </label>
            <input
              id="add-lead-name"
              type="text"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              placeholder="Priya"
              disabled={busy}
              className={inputClass}
            />
          </div>

          {accounts.length > 1 ? (
            <div>
              <label htmlFor="add-lead-account" className={labelClass}>
                Your number
              </label>
              <select
                id="add-lead-account"
                value={whatsappAccountId}
                onChange={(event) => setWhatsappAccountId(event.target.value)}
                disabled={busy}
                className={inputClass}
              >
                <option value="">Choose…</option>
                {accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.name}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          <div>
            <label htmlFor="add-lead-service" className={labelClass}>
              What do they need?
            </label>
            <select
              id="add-lead-service"
              value={aiCategory}
              onChange={(event) => setAiCategory(event.target.value)}
              disabled={busy}
              className={inputClass}
            >
              <option value="unknown">Not sure yet</option>
              {categories
                .filter((key) => key !== 'unknown')
                .map((key) => (
                  <option key={key} value={key}>
                    {labelFor(key)}
                  </option>
                ))}
            </select>
            <p className="mt-1 text-xs text-slate-400">
              Decides which questions the AI asks first. Leave it if you don&apos;t know — it will
              work it out.
            </p>
          </div>

          <div>
            <label htmlFor="add-lead-date" className={labelClass}>
              Event date <span className="normal-case text-slate-400">(optional)</span>
            </label>
            <input
              id="add-lead-date"
              type="text"
              value={eventDate}
              onChange={(event) => setEventDate(event.target.value)}
              placeholder="12 Dec 2026"
              disabled={busy}
              className={inputClass}
            />
            <p className="mt-1 text-xs text-slate-400">
              Turns on the countdown reminders and stops follow-ups after the day.
            </p>
          </div>

          <div>
            <label htmlFor="add-lead-note" className={labelClass}>
              How do you know them? <span className="normal-case text-slate-400">(optional)</span>
            </label>
            <input
              id="add-lead-note"
              type="text"
              value={originNote}
              onChange={(event) => setOriginNote(event.target.value)}
              placeholder="Met at the wedding expo on Sunday"
              disabled={busy}
              className={inputClass}
            />
            <p className="mt-1 text-xs text-slate-400">
              The AI opens with this so they can place you. Without it, it introduces the studio
              plainly rather than inventing a reason.
            </p>
          </div>

          <div className="rounded-lg border border-slate-200 p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-slate-800">Message them now</p>
                <p className="mt-0.5 text-xs text-slate-500">
                  The AI sends an opening message in about 5 minutes. Leave this off to just save
                  the lead and message them yourself.
                </p>
              </div>
              <ToggleSwitch
                checked={greetNow}
                onChange={setGreetNow}
                disabled={busy}
                label="Message them now"
              />
            </div>
          </div>
        </div>

        {notice ? <p className="mt-3 text-xs text-slate-500">{notice}</p> : null}
        {error ? (
          <p role="alert" className="mt-3 text-xs text-red-600">
            {error}
          </p>
        ) : null}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={busy}
            className="rounded-lg border border-blue-600 bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {busy ? 'Adding…' : greetNow ? 'Add and message' : 'Add lead'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default AddLeadDialog;
