import Spinner from '../../Spinner';
import {
  type FieldChoice,
  type MetaFieldKey,
  type MetaFormField,
} from './meta-wizard-types';
import { inputClass, prettyFactKey, secondaryButtonClass } from './meta-wizard-ui';

type Props = {
  loading: boolean;
  fields: readonly MetaFormField[];
  fieldKeys: readonly MetaFieldKey[];
  choices: Readonly<Record<string, FieldChoice>>;
  error: string | null;
  onChange: (metaKey: string, choice: FieldChoice) => void;
  onRetry: () => void;
};

/** The two non-fact options. Prefixed so they can never collide with a real fact key. */
const EXTRA = '__extra__';
const IGNORE = '__ignore__';

const selectValueFor = (choice: FieldChoice | undefined): string => {
  if (!choice || choice.mode === 'extra') {
    return EXTRA;
  }

  return choice.mode === 'ignore' ? IGNORE : (choice.factKey ?? EXTRA);
};

const choiceFromValue = (value: string): FieldChoice => {
  if (value === IGNORE) {
    return { mode: 'ignore', factKey: null };
  }

  if (value === EXTRA) {
    return { mode: 'extra', factKey: null };
  }

  return { mode: 'fact', factKey: value };
};

/**
 * Step 4. Confirm what each question means.
 *
 * A REVIEW, NOT DATA ENTRY. The importer's own rules have already chosen for every question, and
 * on a typical form they get all of them right; the job here is to disagree where they are wrong.
 * So each row arrives pre-answered and the page is readable top to bottom without touching
 * anything.
 *
 * Name, email and phone are shown but locked. They are not facts — they are the lead's identity,
 * they are read from Meta's own standard columns rather than from the question list, and they
 * are deliberately never sent to the AI. Offering to remap them would imply a control that does
 * not exist.
 */
const MetaMappingStep = ({
  loading,
  fields,
  fieldKeys,
  choices,
  error,
  onChange,
  onRetry,
}: Props) => {
  if (loading) {
    return (
      <div className="p-6">
        <Spinner label="Reading the form’s questions…" />
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

  const contactKeys = new Set(fieldKeys.filter((entry) => entry.isContact).map((entry) => entry.key));
  const factOptions = fieldKeys.filter((entry) => !entry.isContact);

  const questionFields = fields.filter(
    (field) => !(field.suggestedFactKey && contactKeys.has(field.suggestedFactKey)),
  );
  const contactFields = fields.filter(
    (field) => field.suggestedFactKey && contactKeys.has(field.suggestedFactKey),
  );

  // Two questions pointed at one key is legal but lossy: the first answer wins and the second is
  // kept as free text instead. Worth saying here, where it can still be changed.
  const usedKeys = questionFields
    .map((field) => choices[field.key])
    .filter((choice): choice is FieldChoice => choice?.mode === 'fact')
    .map((choice) => choice.factKey);
  const duplicateKeys = new Set(
    usedKeys.filter((key, index) => key !== null && usedKeys.indexOf(key) !== index),
  );

  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-500">
        Vistaar has read the form and filled these in. Change anything it got wrong.
      </p>

      <ul className="max-h-[22rem] space-y-2 overflow-y-auto pr-1">
        {questionFields.map((field) => {
          const choice = choices[field.key];
          const value = selectValueFor(choice);
          const isDuplicate = choice?.mode === 'fact' && duplicateKeys.has(choice.factKey);
          const selectId = `meta-map-${field.key}`;

          return (
            <li key={field.key} className="rounded-xl border border-slate-200 bg-white p-3">
              <label htmlFor={selectId} className="block text-sm font-medium text-slate-800">
                {field.label}
              </label>
              <p className="mt-0.5 font-mono text-[11px] text-slate-400">{field.key}</p>

              <select
                id={selectId}
                value={value}
                onChange={(event) => onChange(field.key, choiceFromValue(event.target.value))}
                className={`${inputClass} mt-2`}
              >
                {factOptions.map((option) => (
                  <option key={option.key} value={option.key}>
                    {prettyFactKey(option.key)}
                  </option>
                ))}
                <option value={EXTRA}>Keep as extra detail</option>
                <option value={IGNORE}>Ignore this answer</option>
              </select>

              {field.suggestedFactKey && choice?.factKey !== field.suggestedFactKey ? (
                <p className="mt-1 text-[11px] text-slate-400">
                  Vistaar suggested {prettyFactKey(field.suggestedFactKey)}.
                </p>
              ) : null}

              {isDuplicate ? (
                <p className="mt-1 text-[11px] text-amber-700">
                  Another question is already using this. Only the first answer is stored under it
                  — the rest are kept as extra detail.
                </p>
              ) : null}

              {choice?.mode === 'ignore' ? (
                <p className="mt-1 text-[11px] text-slate-500">
                  This answer won&apos;t be saved at all.
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>

      {contactFields.length > 0 ? (
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
          <p className="text-xs font-medium text-slate-700">Saved to the contact record</p>
          <p className="mt-0.5 text-[11px] text-slate-500">
            Read from Meta&apos;s own fields, and never sent to the AI.
          </p>
          <ul className="mt-2 space-y-1">
            {contactFields.map((field) => (
              <li key={field.key} className="flex items-center justify-between gap-3 text-xs">
                <span className="truncate text-slate-700">{field.label}</span>
                <span className="shrink-0 font-mono text-[11px] text-slate-500">
                  {field.suggestedFactKey}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
};

export default MetaMappingStep;
