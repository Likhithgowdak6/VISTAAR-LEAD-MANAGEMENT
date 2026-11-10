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
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fade-in">
      <div className="relative w-full max-w-2xl bg-surface-card border border-edge rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[85vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-edge bg-surface-subtle">
          <div>
            <h2 className="text-lg font-bold text-text tracking-tight">Review Calendar Events</h2>
            <p className="text-xs text-text-subtle mt-0.5">
              Confirm customer associations so WhatsApp reminders are only sent to the right people.
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-text-subtle hover:text-text hover:bg-surface-elevated transition-colors"
          >
            ✕
          </button>
        </div>

        {/* Content list */}
        <div className="p-6 overflow-y-auto space-y-4 flex-1">
          {error && (
            <div className="p-3 bg-red-500/10 border border-red-500/30 text-red-500 rounded-xl text-xs">
              {error}
            </div>
          )}

          {events.length === 0 ? (
            <div className="text-center py-10">
              <span className="text-3xl">🎉</span>
              <p className="mt-2 text-sm font-medium text-text">No pending reviews</p>
              <p className="text-xs text-text-subtle mt-1">
                All imported Google Calendar events are confirmed.
              </p>
            </div>
          ) : (
            events.map((ev) => (
              <div
                key={ev.id}
                className="p-4 rounded-xl border border-edge bg-surface-card/60 hover:bg-surface-card transition-all"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-semibold text-text">{ev.summary}</h3>
                    <p className="text-xs text-text-subtle mt-0.5">
                      {new Date(ev.startTime).toLocaleString(undefined, {
                        dateStyle: 'medium',
                        timeStyle: 'short',
                      })}
                    </p>
                    {ev.description && (
                      <p className="text-xs text-text-muted mt-1.5 line-clamp-2">
                        {ev.description}
                      </p>
                    )}
                  </div>
                  <span className="px-2 py-0.5 text-[10px] uppercase font-bold rounded-full bg-amber-500/10 text-amber-500 border border-amber-500/20 whitespace-nowrap">
                    Needs Review
                  </span>
                </div>

                <div className="mt-2.5 pt-2.5 border-t border-edge/60">
                  <div className="text-[11px] text-text-subtle mb-2">
                    <span className="font-semibold text-text">AI Reason: </span>
                    {ev.classificationReason}
                  </div>

                  {/* Candidate Leads */}
                  {ev.candidateContacts && ev.candidateContacts.length > 0 && (
                    <div className="mb-3 space-y-1.5">
                      <p className="text-[11px] font-semibold text-text-muted">
                        Suggested Matching Leads:
                      </p>
                      {ev.candidateContacts.map((cand) => (
                        <div
                          key={cand.conversationId}
                          className="flex items-center justify-between p-2 rounded-lg bg-surface-elevated/70 border border-edge/50 text-xs"
                        >
                          <div>
                            <span className="font-semibold text-text">{cand.displayName}</span>
                            <span className="ml-2 text-[10px] text-text-subtle">
                              ({Math.round(cand.confidence * 100)}% match)
                            </span>
                            <p className="text-[10px] text-text-muted">{cand.reason}</p>
                          </div>
                          <button
                            disabled={loadingId === ev.id}
                            onClick={() =>
                              handleConfirm(
                                ev.id,
                                'customer_meeting',
                                cand.conversationId,
                                cand.contactId
                              )
                            }
                            className="px-2.5 py-1 bg-brand-primary text-white rounded-lg text-xs font-medium hover:bg-brand-primary/90 transition-all disabled:opacity-50"
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
                      disabled={loadingId === ev.id}
                      onClick={() => handleConfirm(ev.id, 'personal')}
                      className="px-3 py-1.5 text-xs text-text-subtle hover:text-text rounded-lg border border-edge hover:bg-surface-elevated transition-colors disabled:opacity-50"
                    >
                      Mark as Personal
                    </button>
                    <button
                      disabled={loadingId === ev.id}
                      onClick={() => handleConfirm(ev.id, 'customer_followup')}
                      className="px-3 py-1.5 text-xs text-brand-primary hover:bg-brand-primary/10 rounded-lg border border-brand-primary/30 transition-colors disabled:opacity-50"
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
        <div className="px-6 py-3 border-t border-edge bg-surface-subtle flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-surface-elevated hover:bg-surface-elevated/80 text-text rounded-xl text-xs font-semibold border border-edge transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
