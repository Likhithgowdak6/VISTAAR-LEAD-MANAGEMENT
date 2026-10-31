import { useCallback, useEffect, useState } from 'react';

import { getActivity } from '../../api/endpoints';
import { useAuth } from '../../auth/AuthContext';
import EmptyState from '../EmptyState';
import RelativeTime from '../RelativeTime';
import Spinner from '../Spinner';
import { type ActivityEntry, type AuthValue, errorMessage } from '../types';

type Props = {
  conversationId: string;
  refreshKey?: number;
  /**
   * Opens a call's detail. Optional, so the timeline still renders anywhere this is not wired -
   * the entry then reads as a plain line rather than offering a link to nothing.
   */
  onOpenCall?: (callId: string) => void;
};

const ActivitySection = ({ conversationId, refreshKey, onOpenCall }: Props) => {
  const { authedRequest } = useAuth() as AuthValue;
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const payload = await authedRequest((token) =>
        getActivity({ token, conversationId, limit: 30 }),
      );
      setActivity((payload?.data as ActivityEntry[] | undefined) ?? []);
      setError(null);
    } catch (loadError: unknown) {
      setError(errorMessage(loadError, 'Unable to load activity.'));
    } finally {
      setLoading(false);
    }
  }, [authedRequest, conversationId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load, refreshKey]);

  return (
    <section>
      <h3 className="mb-2 text-xs font-semibold uppercase text-slate-500">Activity</h3>

      {loading ? <Spinner label="Loading activity…" /> : null}
      {error ? (
        <p role="alert" className="text-xs text-red-600">
          {error}
        </p>
      ) : null}
      {!loading && activity.length === 0 ? (
        <EmptyState
          compact
          title="No activity yet"
          description="Actions on this lead will appear here."
        />
      ) : null}

      <ul className="space-y-2">
        {activity.map((entry) => {
          /*
           * Call entries carry their call id, so the timeline can offer a way into the detail.
           * Read defensively rather than cast: `metadata` is a free-form bag, older rows
           * predate these keys, and a missing id must degrade to a plain line rather than
           * render a button that leads nowhere.
           */
          const callId =
            typeof entry.metadata?.callId === 'string' ? entry.metadata.callId : null;
          const durationSeconds =
            typeof entry.metadata?.durationSeconds === 'number'
              ? entry.metadata.durationSeconds
              : null;

          return (
            <li key={entry.id} className="border-l-2 border-slate-200 pl-2 text-sm">
              <p className="text-slate-700">{entry.summary}</p>
              <p className="text-[11px] text-slate-400">
                <RelativeTime value={entry.createdAt} />
                {/* Only ever shown for a call somebody said connected - the server stores no
                    duration otherwise, so there is nothing here to invent. */}
                {durationSeconds ? <span> · {Math.round(durationSeconds / 60)} min</span> : null}
              </p>
              {callId && onOpenCall ? (
                <button
                  type="button"
                  onClick={() => onOpenCall(callId)}
                  className="min-h-11 text-[11px] font-medium text-blue-600 hover:text-blue-700 sm:min-h-0"
                >
                  View call
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
};

export default ActivitySection;
