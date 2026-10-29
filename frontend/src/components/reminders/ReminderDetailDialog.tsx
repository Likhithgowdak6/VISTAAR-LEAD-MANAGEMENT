import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

import {
  cancelFollowUp,
  completeFollowUp,
  getConversation,
  listConversationFollowUps,
  rescheduleFollowUp,
} from '../../api/endpoints';
import { useAuth } from '../../auth/AuthContext';
import { useMobileBackLayer } from '../../hooks/useMobileBackLayer';
import { hasPermission, PERMISSIONS } from '../../lib/permissions';
import RelativeTime from '../RelativeTime';
import Spinner from '../Spinner';
import {
  type AuthValue,
  type AuthedRequest,
  errorMessage,
  type FollowUpTask,
} from '../types';
import RescheduleReminderDialog from './RescheduleReminderDialog';

/**
 * The reminder a WhatsApp notification was actually about.
 *
 * WHY THIS EXISTS. `View reminder:` links carry `?conversation=<id>&reminder=<id>`, and until
 * now the second id was decoration: the app opened the lead and left the owner to find which of
 * five reminders had just rung, in a section that is collapsed behind a disclosure on a phone.
 * This answers the question the notification asked.
 *
 * OVER THE LEAD, NOT INSTEAD OF IT. The conversation opens behind this dialog exactly as it did
 * before, so closing this lands on the thread rather than on nothing - the old behaviour is the
 * floor, and this is added on top of it.
 *
 * NO NEW ENDPOINT, DELIBERATELY. There is no `GET /follow-ups/:id`, and adding one would be a
 * new authorisation surface to get right for a view that already has a correct, org-scoped way
 * in: `GET /conversations/:id/follow-ups`, which the lead panel has always used. Reading the
 * lead's own list and picking one out of it has a property a by-id lookup would have to be
 * written to enforce - a reminder that belongs to a DIFFERENT conversation than the link claims
 * simply is not in the list, so it cannot be opened by pairing somebody else's reminder id with
 * a conversation you can see.
 *
 * NOT FOUND IS A REAL ANSWER. Completed-and-purged, cancelled, belonging to another
 * organisation, or an id that was never ours: all of them land on the same short message rather
 * than an error screen, because from the owner's side they are the same event - that reminder
 * is not here any more.
 */

const STATUS_LABELS: Record<string, string> = {
  pending: 'Still open',
  completed: 'Completed',
  cancelled: 'Cancelled',
  missed: 'Missed',
};

/** Where a reminder came from, in the same words the lead panel uses. */
const SOURCE_LABELS: Record<string, string> = {
  manual: 'Added by hand',
  lead_commitment: 'From what the lead said',
  owner_command: 'Asked for on WhatsApp',
};

type Props = {
  reminderId: string;
  /** The lead the link named. Scopes the lookup, and names the thread this reminder is about. */
  conversationId: string;
  onClose: () => void;
  /** Re-arms device alarms and refreshes the lead panel's list after a change made here. */
  onChanged?: () => void;
};

const ReminderDetailDialog = ({ reminderId, conversationId, onClose, onChanged }: Props) => {
  const { authedRequest, permissions } = useAuth() as AuthValue;
  const canManage = hasPermission(permissions, PERMISSIONS.CRM_TASKS_MANAGE);
  useMobileBackLayer({ active: true, onBack: onClose });

  const [task, setTask] = useState<FollowUpTask | null>(null);
  const [leadName, setLeadName] = useState<string | null>(null);
  const [leadId, setLeadId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [rescheduling, setRescheduling] = useState(false);

  const load = useCallback(async () => {
    try {
      const payload = await authedRequest((token) =>
        listConversationFollowUps({ token, conversationId }),
      );
      // `?? null` rather than `undefined`: "we looked and it is not here" is the not-found
      // branch below, and it has to be distinguishable from "we have not looked yet".
      setTask((payload?.data ?? []).find((entry) => entry.id === reminderId) ?? null);
      setError(null);
    } catch (loadError: unknown) {
      setError(errorMessage(loadError, 'Unable to load this reminder.'));
    } finally {
      setLoading(false);
    }
  }, [authedRequest, conversationId, reminderId]);

  useEffect(() => {
    if (!canManage) {
      return;
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load, canManage]);

  useEffect(() => {
    if (!canManage) {
      return;
    }

    // Who the reminder is about. Fetched separately and allowed to fail quietly: a missing name
    // costs one line of context, and must not stop the reminder itself from being shown or
    // acted on.
    authedRequest((token) => getConversation({ token, conversationId }))
      .then((payload) => {
        setLeadName(payload.data?.conversation?.displayName ?? null);
        setLeadId(payload.data?.conversation?.leadId ?? null);
      })
      .catch(() => {});
  }, [authedRequest, conversationId, canManage]);

  /**
   * Runs one of the three state changes and closes.
   *
   * CLOSES ON SUCCESS rather than re-rendering this dialog around a completed reminder: the
   * owner came here from a notification to deal with one thing, and once it is dealt with the
   * useful place to be is the conversation underneath.
   */
  const transition = async (makeRequest: Parameters<AuthedRequest>[0]) => {
    if (busy) {
      return;
    }

    setBusy(true);
    setError(null);

    try {
      await authedRequest(makeRequest);
      onChanged?.();
      onClose();
    } catch (transitionError: unknown) {
      setError(errorMessage(transitionError, 'Unable to update this reminder.'));
      setBusy(false);
    }
  };

  const handleCancel = () => {
    // Same confirmation the lead panel asks for, because it is the same irreversible action.
    if (!window.confirm('Cancel this reminder? It will not ring.')) {
      return;
    }

    void transition((token) => cancelFollowUp({ token, taskId: reminderId }));
  };

  // Reminders are a permissioned section, and the list endpoint behind this would refuse
  // anyway. Rendering nothing leaves the link doing what it did before: opening the lead.
  if (!canManage) {
    return null;
  }

  const title = task?.title?.trim() || (task ? `${task.type} reminder` : 'Reminder');
  const status = task ? (STATUS_LABELS[task.status] ?? task.status) : null;
  const source = task?.source ? SOURCE_LABELS[task.source] : null;

  return createPortal(
    <>
      <div
        data-mobile-sheet-backdrop
        className="fixed inset-0 z-20 flex items-center justify-center bg-slate-900/40 p-4"
        onClick={onClose}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Reminder"
          data-mobile-sheet
          onClick={(event) => event.stopPropagation()}
          className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-2xl bg-white p-4 shadow-xl"
        >
          <div className="mb-3 flex items-start justify-between gap-3">
            <h3 className="min-w-0 text-base font-semibold text-slate-900">Reminder</h3>
            <button
              type="button"
              onClick={onClose}
              className="shrink-0 rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
            >
              Close
            </button>
          </div>

          {loading ? <Spinner label="Loading reminder…" /> : null}

          {error ? (
            <p role="alert" className="text-sm text-red-600">
              {error}
            </p>
          ) : null}

          {!loading && !task && !error ? (
            <p className="text-sm text-slate-600">
              This reminder is no longer here. It may have been deleted, or it belongs to a
              different lead. The conversation it pointed at is open behind this.
            </p>
          ) : null}

          {task ? (
            <div className="space-y-3">
              <div>
                <p className="text-sm font-medium capitalize text-slate-900">{title}</p>
                <p className="mt-0.5 text-xs text-slate-500">
                  {status}
                  {source ? <span> · {source}</span> : null}
                </p>
              </div>

              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                  Due
                </p>
                {/* A reminder with no due time is a real row in this schema, so it says so
                    rather than rendering "Invalid Date". */}
                <p className="text-sm text-slate-700">
                  {task.dueAt ? (
                    <>
                      {new Date(task.dueAt).toLocaleString()} (<RelativeTime value={task.dueAt} />)
                    </>
                  ) : (
                    'No due time recorded'
                  )}
                </p>
              </div>

              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                  Lead
                </p>
                <p className="text-sm text-slate-700">
                  {leadName ?? 'This conversation'}
                  {leadId ? <span className="text-slate-400"> · {leadId}</span> : null}
                </p>
              </div>

              {task.note ? (
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                    Notes
                  </p>
                  <p className="whitespace-pre-wrap text-sm text-slate-700">{task.note}</p>
                </div>
              ) : null}

              {/* What the customer actually said, when that is what produced this reminder.
                  This is the reason the notification quoted, and the answer to "why am I
                  looking at this?" a day later. */}
              {task.sourceQuote ? (
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                    Reason
                  </p>
                  <p className="border-l-2 border-slate-300 pl-2 text-sm italic text-slate-600">
                    “{task.sourceQuote}”
                  </p>
                </div>
              ) : null}

              {task.status === 'pending' ? (
                <div className="flex flex-wrap gap-3 pt-1 text-xs font-medium">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void transition((token) => completeFollowUp({ token, taskId: reminderId }))
                    }
                    className="min-h-11 text-green-600 hover:text-green-700 disabled:opacity-50 sm:min-h-0"
                  >
                    Complete
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setRescheduling(true)}
                    className="min-h-11 text-blue-600 hover:text-blue-700 disabled:opacity-50 sm:min-h-0"
                  >
                    Reschedule
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={handleCancel}
                    className="min-h-11 text-slate-500 hover:text-slate-700 disabled:opacity-50 sm:min-h-0"
                  >
                    Cancel
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      {/* The same dialog the lead panel opens, so rescheduling behaves identically wherever it
          is reached from - including its past-time validation. */}
      {rescheduling && task ? (
        <RescheduleReminderDialog
          title={title}
          dueAt={task.dueAt ?? ''}
          busy={busy}
          error={error}
          onCancel={() => setRescheduling(false)}
          onSave={(dueAtIso: string) => {
            setRescheduling(false);
            void transition((token) =>
              rescheduleFollowUp({ token, taskId: reminderId, dueAt: dueAtIso }),
            );
          }}
        />
      ) : null}
    </>,
    document.body,
  );
};

export default ReminderDetailDialog;
