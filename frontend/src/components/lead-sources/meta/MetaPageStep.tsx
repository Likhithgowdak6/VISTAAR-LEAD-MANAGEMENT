import EmptyState from '../../EmptyState';
import Spinner from '../../Spinner';
import { type MetaConnectedPage } from './meta-wizard-types';
import {
  choiceRowClass,
  choiceRowIdleClass,
  choiceRowSelectedClass,
  secondaryButtonClass,
} from './meta-wizard-ui';

type Props = {
  loading: boolean;
  pages: readonly MetaConnectedPage[];
  selectedPageId: string | null;
  error: string | null;
  onSelect: (page: MetaConnectedPage) => void;
  onRetry: () => void;
};

/** Step 2. Which page's leads should reach the CRM. Exactly one. */
const MetaPageStep = ({ loading, pages, selectedPageId, error, onSelect, onRetry }: Props) => {
  if (loading) {
    return (
      <div className="p-6">
        <Spinner label="Loading your Facebook pages…" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-3">
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
          {error}
        </p>
        <button type="button" onClick={onRetry} className={secondaryButtonClass}>
          Try again
        </button>
      </div>
    );
  }

  if (pages.length === 0) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white">
        {/* Almost never a bug in this app: the signed-in account has no page role, or the Meta
            app has not been granted access to it. Saying so beats "no results". */}
        <EmptyState
          title="No pages on this Facebook account"
          description="The account you signed in with doesn’t manage any pages Vistaar can see. Sign in with the account that admins your page, or ask for a page role on it."
        />
        <div className="px-4 pb-4">
          <button type="button" onClick={onRetry} className={secondaryButtonClass}>
            Check again
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-slate-500">
        {pages.length} page{pages.length === 1 ? '' : 's'} on this account.
      </p>

      <ul className="max-h-80 space-y-2 overflow-y-auto pr-1">
        {pages.map((page) => {
          const selected = page.id === selectedPageId;

          return (
            <li key={page.id}>
              <button
                type="button"
                aria-pressed={selected}
                onClick={() => onSelect(page)}
                className={`${choiceRowClass} ${selected ? choiceRowSelectedClass : choiceRowIdleClass}`}
              >
                {page.pictureUrl ? (
                  <img
                    src={page.pictureUrl}
                    alt=""
                    className="h-9 w-9 shrink-0 rounded-full object-cover"
                  />
                ) : (
                  <span className="h-9 w-9 shrink-0 rounded-full bg-slate-200" aria-hidden="true" />
                )}
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-slate-900">
                    {page.name ?? page.id}
                  </span>
                  <span className="block font-mono text-[11px] text-slate-400">{page.id}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
};

export default MetaPageStep;
