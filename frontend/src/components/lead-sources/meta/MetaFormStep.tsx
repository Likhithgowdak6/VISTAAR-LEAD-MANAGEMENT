import EmptyState from '../../EmptyState';
import Spinner from '../../Spinner';
import { type MetaLeadFormSummary } from './meta-wizard-types';
import {
  choiceRowClass,
  choiceRowIdleClass,
  choiceRowSelectedClass,
  secondaryButtonClass,
} from './meta-wizard-ui';

type Props = {
  loading: boolean;
  pageName: string;
  forms: readonly MetaLeadFormSummary[];
  selectedFormId: string | null;
  error: string | null;
  onSelect: (form: MetaLeadFormSummary) => void;
  onRetry: () => void;
};

/** Step 3. One lead form. Archived ones are shown but called out, not hidden. */
const MetaFormStep = ({
  loading,
  pageName,
  forms,
  selectedFormId,
  error,
  onSelect,
  onRetry,
}: Props) => {
  if (loading) {
    return (
      <div className="p-6">
        <Spinner label="Loading lead forms…" />
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

  if (forms.length === 0) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white">
        <EmptyState
          title={`No lead forms on ${pageName}`}
          description="Create an instant form for this page in Meta Business Suite, then come back and check again."
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
        {forms.length} form{forms.length === 1 ? '' : 's'} on{' '}
        <span className="font-medium text-slate-700">{pageName}</span>.
      </p>

      <ul className="max-h-80 space-y-2 overflow-y-auto pr-1">
        {forms.map((form) => {
          const selected = form.id === selectedFormId;
          const archived = Boolean(form.status) && form.status !== 'ACTIVE';

          return (
            <li key={form.id}>
              <button
                type="button"
                aria-pressed={selected}
                onClick={() => onSelect(form)}
                className={`${choiceRowClass} ${selected ? choiceRowSelectedClass : choiceRowIdleClass}`}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-slate-900">
                    {form.name ?? form.id}
                  </span>
                  <span className="block font-mono text-[11px] text-slate-400">{form.id}</span>
                </span>
                {/* An archived form collects nothing new. Selectable anyway — it is a legitimate
                    choice when backfilling old leads — but never silently. */}
                {archived ? (
                  <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600">
                    {form.status?.toLowerCase()}
                  </span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
};

export default MetaFormStep;
