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
};

const ActivitySection = ({ conversationId, refreshKey }: Props) => {
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
        {activity.map((entry) => (
          <li key={entry.id} className="border-l-2 border-slate-200 pl-2 text-sm">
            <p className="text-slate-700">{entry.summary}</p>
            <p className="text-[11px] text-slate-400">
              <RelativeTime value={entry.createdAt} />
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
};

export default ActivitySection;
