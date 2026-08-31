import { useState } from 'react';

import { revealPhone } from '../../api/endpoints';
import { useAuth } from '../../auth/AuthContext';
import { hasPermission, PERMISSIONS } from '../../lib/permissions';
import { type AuthValue, errorMessage } from '../types';

type Props = {
  contactId: string;
};

const RevealPhone = ({ contactId }: Props) => {
  const { authedRequest, permissions } = useAuth() as AuthValue;
  const [phone, setPhone] = useState<string | null>(null);
  // `revealed` tracks that the audited call already happened, independently of whether it
  // returned a number. Without it a contact with no stored phone re-hits the API — and writes
  // a fresh audit entry — on every click.
  const [revealed, setRevealed] = useState(false);
  const [visible, setVisible] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!hasPermission(permissions, PERMISSIONS.CLIENT_PII_REVEAL)) {
    return null;
  }

  // The audited call happens once per mount. Hiding afterwards is a UI affordance only — the
  // number has already left the backend, so re-showing it is not a new access to audit.
  const handleToggle = async () => {
    if (revealed) {
      setVisible((current) => !current);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const payload = await authedRequest((token) => revealPhone({ token, contactId }));
      setPhone((payload?.data?.phone as string | null | undefined) ?? null);
      setRevealed(true);
      setVisible(true);
    } catch (revealError: unknown) {
      setError(errorMessage(revealError, 'Unable to reveal phone.'));
    } finally {
      setLoading(false);
    }
  };

  const showing = visible && revealed;
  const missing = revealed && !phone;

  const buttonLabel = () => {
    if (loading) {
      return 'Revealing…';
    }
    if (showing) {
      return missing ? 'Hide' : 'Hide phone';
    }
    return 'Reveal phone';
  };

  return (
    <div>
      <p className="mb-1 text-xs font-semibold uppercase text-slate-500">Phone</p>
      <div className="flex items-center gap-2">
        {showing ? (
          <p
            className={
              missing ? 'text-sm text-slate-400 italic' : 'text-sm font-medium text-slate-900'
            }
          >
            {missing ? 'No phone on file' : phone}
          </p>
        ) : null}
        <button
          type="button"
          onClick={handleToggle}
          disabled={loading}
          aria-pressed={showing}
          className="rounded-lg border border-slate-300 px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60"
        >
          {buttonLabel()}
        </button>
      </div>
      {showing && missing ? (
        <p className="mt-1 text-[11px] text-slate-400">
          This lead reached you from a WhatsApp ID that hides the number.
        </p>
      ) : null}
      {showing && !missing ? (
        <p className="mt-1 text-[11px] text-slate-400">Revealed — this access is audited.</p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-1 text-xs text-red-600">
          {error}
        </p>
      ) : null}
    </div>
  );
};

export default RevealPhone;
