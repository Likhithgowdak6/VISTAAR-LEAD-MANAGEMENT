import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

import { getCall } from '../../api/endpoints';
import { useAuth } from '../../auth/AuthContext';
import { useMobileBackLayer } from '../../hooks/useMobileBackLayer';
import RelativeTime from '../RelativeTime';
import Spinner from '../Spinner';
import { type AuthValue, type CallRecord, errorMessage } from '../types';

/**
 * One call, in full: when the dialler was opened and what the agent said happened afterwards.
 *
 * THAT IS THE WHOLE OF IT, AND THE SCREEN DOES NOT PRETEND OTHERWISE. Vistaar hands the number
 * to the phone's own dialler and Android tells an ordinary app nothing more - not whether the
 * green button was pressed, not whether anyone answered, not how long they spoke. There is no
 * recording, no transcript and no AI summary here because the app captures none of those
 * things. Every field on this dialog is either observed (the moment the dialler opened) or
 * supplied by a human, and `Length` says which.
 */

type Props = {
  callId: string;
  onClose: () => void;
};

const STATUS_LABELS: Record<string, string> = {
  initiated: 'Dialler opened',
  completed: 'Spoke to the lead',
  failed: 'No answer',
  cancelled: 'Not called',
  unknown: 'Outcome not recorded',
};

const formatDuration = (seconds: number | null): string => {
  if (!seconds || seconds <= 0) {
    return '—';
  }

  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;

  return minutes > 0 ? `${minutes} min ${rest}s` : `${rest}s`;
};

const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div>
    <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{label}</p>
    <p className="text-sm text-slate-700">{children}</p>
  </div>
);

const CallDetailDialog = ({ callId, onClose }: Props) => {
  const { authedRequest } = useAuth() as AuthValue;
  useMobileBackLayer({ active: true, onBack: onClose });

  const [call, setCall] = useState<CallRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const callPayload = await authedRequest((token) => getCall({ token, callId }));

      setCall(callPayload?.data ?? null);
      setError(null);
    } catch (loadError: unknown) {
      setError(errorMessage(loadError, 'Unable to load this call.'));
    } finally {
      setLoading(false);
    }
  }, [authedRequest, callId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  return createPortal(
    <div
      data-mobile-sheet-backdrop
      className="fixed inset-0 z-20 flex items-center justify-center bg-slate-900/40 p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Call details"
        data-mobile-sheet
        onClick={(event) => event.stopPropagation()}
        className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-2xl bg-white p-4 shadow-xl"
      >
        <div className="mb-3 flex items-start justify-between gap-3">
          <h3 className="text-base font-semibold text-slate-900">Call</h3>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            Close
          </button>
        </div>

        {loading ? <Spinner label="Loading call…" /> : null}

        {error ? (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        ) : null}

        {!loading && !call && !error ? (
          <p className="text-sm text-slate-600">
            This call is no longer here. It may have been deleted, or it belongs to a different
            lead.
          </p>
        ) : null}

        {call ? (
          <div className="space-y-3">
            <Row label="Outcome">{STATUS_LABELS[call.status] ?? call.status}</Row>

            <Row label="When">
              {call.startedAt ? (
                <>
                  {new Date(call.startedAt).toLocaleString()} (
                  <RelativeTime value={call.startedAt} />)
                </>
              ) : (
                '—'
              )}
            </Row>

            <Row label="Direction">{call.direction === 'inbound' ? 'Incoming' : 'Outgoing'}</Row>

            <Row label="Length">
              {call.status === 'completed' ? (
                <>
                  {formatDuration(call.durationSeconds)}
                  <span className="text-slate-400"> · as reported by the agent</span>
                </>
              ) : (
                '—'
              )}
            </Row>
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
};

export default CallDetailDialog;
