import { useCallback, useEffect, useState } from 'react';

import { getLeadSubmissions } from '../../api/endpoints';
import { useAuth } from '../../auth/AuthContext';
import RelativeTime from '../RelativeTime';
import Spinner from '../Spinner';
import { type AuthValue, errorMessage, type LeadSubmission } from '../types';

type Props = {
  conversationId: string;
};

const PLATFORM_LABELS: Readonly<Record<string, string>> = {
  fb: 'Facebook',
  ig: 'Instagram',
  msg: 'Messenger',
};

/**
 * What the lead told us on the Meta enquiry form.
 *
 * Renders nothing at all for a lead that arrived over WhatsApp rather than a form, so the panel
 * does not grow an empty section for the majority of leads. Name, email and phone are absent by
 * design — the API withholds them, and the phone stays behind the audited reveal above.
 */
const LeadFormSection = ({ conversationId }: Props) => {
  const { authedRequest } = useAuth() as AuthValue;
  const [submissions, setSubmissions] = useState<LeadSubmission[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  const load = useCallback(async () => {
    try {
      const payload = await authedRequest((token) => getLeadSubmissions({ token, conversationId }));
      setSubmissions(payload.data ?? []);
      setError(null);
    } catch (loadError: unknown) {
      setError(errorMessage(loadError, 'Unable to load lead details.'));
    } finally {
      setLoading(false);
    }
  }, [authedRequest, conversationId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  if (loading) {
    return <Spinner label="Loading lead details…" />;
  }

  if (error) {
    return (
      <p role="alert" className="text-xs text-red-600">
        {error}
      </p>
    );
  }

  if (submissions.length === 0) {
    return null;
  }

  const visible = showAll ? submissions : submissions.slice(0, 1);

  return (
    <section>
      <h3 className="mb-2 text-xs font-semibold uppercase text-slate-500">Enquiry form</h3>

      <ul className="space-y-3">
        {visible.map((submission) => (
          <li key={submission.id} className="rounded-lg bg-slate-50 p-2">
            <div className="mb-1.5 flex flex-wrap items-center gap-x-1.5 text-[11px] text-slate-400">
              {submission.submittedAt ? <RelativeTime value={submission.submittedAt} /> : null}
              {submission.platform ? (
                <>
                  <span aria-hidden="true">·</span>
                  <span>{PLATFORM_LABELS[submission.platform] ?? submission.platform}</span>
                </>
              ) : null}
              {submission.campaignName ? (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="truncate">{submission.campaignName}</span>
                </>
              ) : null}
            </div>

            <dl className="space-y-1.5">
              {submission.fields.map((field) => (
                <div key={field.key}>
                  <dt className="text-[11px] text-slate-500">{field.label}</dt>
                  <dd className="break-words text-sm text-slate-800">{field.value}</dd>
                </div>
              ))}
            </dl>
          </li>
        ))}
      </ul>

      {submissions.length > 1 ? (
        <button
          type="button"
          onClick={() => setShowAll((open) => !open)}
          className="mt-2 text-xs font-medium text-blue-600 hover:text-blue-700"
        >
          {showAll
            ? 'Show latest only'
            : `Show ${submissions.length - 1} earlier submission${
                submissions.length > 2 ? 's' : ''
              }`}
        </button>
      ) : null}
    </section>
  );
};

export default LeadFormSection;
