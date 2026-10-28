import { useCallback, useEffect, useState } from 'react';

import { listConnectedMetaFormFields, updateLeadSource } from '../../../api/endpoints';
import { useAuth } from '../../../auth/AuthContext';
import Spinner from '../../Spinner';
import { errorMessage, type AuthValue } from '../../types';
import { type LeadSource } from './meta-wizard-types';
import { primaryButtonClass } from './meta-wizard-ui';

interface Props {
  leadSource: LeadSource;
  onChanged: () => void;
}

/** Shown when the automatic rules found nothing, which is the only case worth a control. */
const AUTOMATIC = '';

/**
 * Which form question holds the lead's phone number.
 *
 * WHY THIS EXISTS. The importer reads Meta's own standard `phone_number` question, then a short
 * list of common aliases. A business that asks for a number in its own words - "Best number to
 * reach you on?" - produces a machine name matching neither, every lead is skipped `no_phone`,
 * and on a WhatsApp-first CRM that is the whole lead lost while the sync still reports `ok`.
 * This is the escape hatch for that case.
 *
 * DELIBERATELY NOT IN THE CONNECT WIZARD. The wizard's activation endpoint does not accept a
 * `columnMapping`, and widening it would mean changing the activation schema, the activation
 * service and the source-creation path for a control most forms never need. The existing
 * `PATCH /lead-sources/:id` already accepts exactly this, so the setting lives where a source is
 * inspected rather than where one is created - which is also when the problem is noticed.
 *
 * READING THE QUESTION LIST CALLS META. Deferred until the panel is opened, never on a timer.
 */
const MetaPhoneMapping = ({ leadSource, onChanged }: Props) => {
  const { authedRequest } = useAuth() as AuthValue;

  const pageId = leadSource.meta?.pageId ?? null;
  const formId = leadSource.meta?.formId ?? null;
  // An all-forms source has no single question list to offer, so there is nothing to wait for.
  // Deriving the initial value avoids a setState in the effect purely to turn the spinner off.
  const askable = Boolean(pageId && formId);

  const [fields, setFields] = useState<{ key: string; label: string }[]>([]);
  const [loading, setLoading] = useState(askable);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [selected, setSelected] = useState<string>(leadSource.columnMapping?.phone ?? AUTOMATIC);

  const load = useCallback(() => {
    if (!pageId || !formId) {
      return;
    }

    setLoading(true);

    authedRequest((token) => listConnectedMetaFormFields({ token, pageId, formId }))
      .then((payload) => {
        setFields(
          (payload.data ?? []).map((field: { key: string; label: string }) => ({
            key: field.key,
            label: field.label,
          })),
        );
        setError(null);
      })
      .catch((cause: unknown) =>
        setError(errorMessage(cause, 'Could not read the form’s questions from Facebook.')),
      )
      .finally(() => setLoading(false));
  }, [authedRequest, pageId, formId]);

  useEffect(() => {
    // Fetch on open. The only synchronous write is the spinner; everything else happens after
    // the request resolves. Same shape as ConversationList and the other loaders here.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);

    try {
      await authedRequest((token) =>
        updateLeadSource({
          token,
          leadSourceId: leadSource.id,
          // Empty string means "go back to the automatic rules"; null is how the API spells that.
          columnMapping: { phone: selected === AUTOMATIC ? null : selected },
        }),
      );

      setSaved(true);
      onChanged();
    } catch (cause: unknown) {
      setError(errorMessage(cause, 'Could not save the phone mapping.'));
    } finally {
      setSaving(false);
    }
  };

  if (!pageId || !formId) {
    return null;
  }

  return (
    <section className="rounded-xl border border-slate-200 p-3">
      <h4 className="text-sm font-semibold text-slate-900">Phone number question</h4>
      <p className="mt-1 text-xs text-slate-500">
        Leads with no phone number cannot be messaged on WhatsApp, so they are skipped. If this
        form asks for a number in its own words, point this at that question.
      </p>

      {loading ? (
        <div className="mt-2">
          <Spinner label="Reading the form’s questions…" />
        </div>
      ) : (
        <>
          <select
            aria-label="Phone number question"
            value={selected}
            onChange={(event) => {
              setSelected(event.target.value);
              setSaved(false);
            }}
            className="mt-2 w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm text-slate-800 focus:border-blue-500 focus:outline-none"
          >
            <option value={AUTOMATIC}>Detect automatically (recommended)</option>
            {fields.map((field) => (
              <option key={field.key} value={field.key}>
                {field.label}
              </option>
            ))}
          </select>

          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={saving}
            className={`${primaryButtonClass} mt-2`}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </>
      )}

      {saved ? (
        <p role="status" className="mt-2 text-xs text-green-700">
          Saved. It applies to leads imported from now on — leads already skipped are not re-read.
        </p>
      ) : null}

      {error ? (
        <p role="alert" className="mt-2 text-xs text-red-600">
          {error}
        </p>
      ) : null}
    </section>
  );
};

export default MetaPhoneMapping;
