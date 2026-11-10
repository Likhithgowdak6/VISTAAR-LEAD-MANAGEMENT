import React, { useState } from 'react';
import { confirmUncertainEvent, type UncertainEventItem } from '../../api/endpoints';
import { useAuth } from '../../auth/AuthContext';
import Spinner from '../Spinner';

interface Props {
  events: UncertainEventItem[];
  isOpen: boolean;
  onClose: () => void;
  onUpdated: () => void;
}

export const UncertainEventsReviewModal: React.FC<Props> = ({
  events,
  isOpen,
  onClose,
  onUpdated,
}) => {
  const { authedRequest } = useAuth();
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleConfirm = async (
    eventSyncId: string,
    classification: string,
    conversationId?: string | null,
    contactId?: string | null
  ) => {
    setLoadingId(eventSyncId);
    setError(null);
    try {
      await authedRequest((token) =>
        confirmUncertainEvent({
          token,
          eventSyncId,
          classification,
          conversationId,
          contactId,
        })
      );
      onUpdated();
    } catch (err: any) {
      setError(err?.message || 'Failed to update event review.');
    } finally {
      setLoadingId(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs animate-fade-in">
      <div className="relative w-full max-w-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[85vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50">
          <div>
            <h2 className="text-base sm:text-lg font-bold text-slate-900 dark:text-slate-100 tracking-tight">
              Review Calendar Events
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              Confirm customer associations so WhatsApp reminders are only sent to the right people.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close modal"
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
          >
            ✕
          </button>
        </div>

        {/* Content list */}
        <div className="p-6 overflow-y-auto space-y-4 flex-1">
          {error && (
            <div className="p-3 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800/50 text-red-700 dark:text-red-300 rounded-xl text-xs">
              {error}
            </div>
          )}

          {events.length === 0 ? (
            <div className="text-center py-10">
              <span className="text-3xl">🎉</span>
              <p className="mt-2 text-sm font-semibold text-slate-800 dark:text-slate-200">No pending reviews</p>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                All imported Google Calendar events are confirmed and categorized.
              </p>
            </div>
          ) : (
            events.map((ev) => (
              <div
                key={ev.id}
                className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/40 hover:bg-white dark:hover:bg-slate-800/70 transition-all"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{ev.summary}</h3>
                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                      {new Date(ev.startTime).toLocaleString(undefined, {
                        dateStyle: 'medium',
                        timeStyle: 'short',
                      })}
                    </p>
                    {ev.description && (
                      <p className="text-xs text-slate-600 dark:text-slate-400 mt-1.5 line-clamp-2">
                        {ev.description}
                      </p>
                    )}
                  </div>
                  <span className="px-2 py-0.5 text-[10px] uppercase font-bold rounded-full bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-400 border border-amber-200 dark:border-amber-800/60 whitespace-nowrap">
                    Needs Review
                  </span>
                </div>

                <div className="mt-2.5 pt-2.5 border-t border-slate-200 dark:border-slate-800">
                  <div className="text-[11px] text-slate-500 dark:text-slate-400 mb-2">
                    <span className="font-semibold text-slate-700 dark:text-slate-300">AI Reason: </span>
                    {ev.classificationReason}
                  </div>

                  {/* Candidate Leads */}
                  {ev.candidateContacts && ev.candidateContacts.length > 0 && (
                    <div className="mb-3 space-y-1.5">
                      <p className="text-[11px] font-semibold text-slate-600 dark:text-slate-300">
                        Suggested Matching Leads:
                      </p>
                      {ev.candidateContacts.map((cand) => (
                        <div
                          key={cand.conversationId}
                          className="flex items-center justify-between p-2.5 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-xs"
                        >
                          <div>
                            <span className="font-semibold text-slate-800 dark:text-slate-200">{cand.displayName}</span>
                            <span className="ml-2 text-[10px] text-slate-500 dark:text-slate-400">
                              ({Math.round(cand.confidence * 100)}% match)
                            </span>
                            <p className="text-[10px] text-slate-500 dark:text-slate-400">{cand.reason}</p>
                          </div>
                          <button
                            type="button"
                            disabled={loadingId === ev.id}
                            onClick={() =>
                              handleConfirm(
                                ev.id,
                                'customer_meeting',
                                cand.conversationId,
                                cand.contactId
                              )
                            }
                            className="px-2.5 py-1 bg-blue-600 text-white rounded-lg text-xs font-semibold hover:bg-blue-700 transition-all disabled:opacity-50"
                          >
                            Link Lead
                          </button>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Action buttons */}
                  <div className="flex items-center justify-end gap-2 mt-2">
                    <button
                      type="button"
                      disabled={loadingId === ev.id}
                      onClick={() => handleConfirm(ev.id, 'personal')}
                      className="px-3 py-1.5 text-xs text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors disabled:opacity-50"
                    >
                      Mark as Personal
                    </button>
                    <button
                      type="button"
                      disabled={loadingId === ev.id}
                      onClick={() => handleConfirm(ev.id, 'customer_followup')}
                      className="px-3 py-1.5 text-xs text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/30 rounded-lg border border-blue-200 dark:border-blue-800/60 transition-colors disabled:opacity-50 font-semibold"
                    >
                      {loadingId === ev.id ? (
                        <Spinner label="Updating..." />
                      ) : (
                        'Confirm Follow-up'
                      )}
                    </button>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 bg-white dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 rounded-xl text-xs font-semibold border border-slate-200 dark:border-slate-700 transition-colors shadow-xs"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
