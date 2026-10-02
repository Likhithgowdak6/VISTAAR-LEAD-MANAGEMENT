import ToggleSwitch from '../../ToggleSwitch';
import { mergeStages } from '../../../lib/stages';
import {
  type MetaWizardSettings,
  type Stage,
  type Tag,
  type User,
  type WhatsAppAccount,
} from './meta-wizard-types';
import { inputClass, labelClass } from './meta-wizard-ui';

type Props = {
  settings: MetaWizardSettings;
  accounts: readonly WhatsAppAccount[];
  stages: readonly Stage[];
  tags: readonly Tag[];
  users: readonly User[];
  onChange: (patch: Partial<MetaWizardSettings>) => void;
};

/**
 * Step 5. What happens to a lead the moment it lands.
 *
 * Auto-greeting starts OFF and is separated from everything else on the screen. Every other
 * setting here decides how a lead is filed; that one decides whether the studio sends a WhatsApp
 * to a stranger, which is a different kind of decision and should not be reachable by tabbing
 * past a stage picker.
 */
const MetaSettingsStep = ({ settings, accounts, stages, tags, users, onChange }: Props) => {
  // `new` is what a lead gets with no default set, so it is the empty option rather than a
  // second entry that means the same thing.
  const stageOptions = mergeStages(stages.filter((stage) => stage.status === 'active')).filter(
    (stage) => stage.key !== 'new',
  );
  const assignableUsers = users.filter((user) => user.status === 'active');

  const toggleTag = (tagId: string) => {
    const has = settings.defaultTagIds.includes(tagId);

    onChange({
      defaultTagIds: has
        ? settings.defaultTagIds.filter((id) => id !== tagId)
        : [...settings.defaultTagIds, tagId],
    });
  };

  return (
    <div className="space-y-3">
      <div>
        <label htmlFor="meta-wizard-name" className={labelClass}>
          Lead source name
        </label>
        <input
          id="meta-wizard-name"
          value={settings.name}
          onChange={(event) => onChange({ name: event.target.value })}
          placeholder="Facebook wedding leads"
          className={inputClass}
        />
        <p className="mt-1 text-[11px] text-slate-400">
          Only you see this. It labels the leads in your inbox.
        </p>
      </div>

      <div className="flex gap-3">
        <div className="flex-1">
          <label htmlFor="meta-wizard-account" className={labelClass}>
            WhatsApp number for new leads
          </label>
          <select
            id="meta-wizard-account"
            value={settings.whatsappAccountId}
            onChange={(event) => onChange({ whatsappAccountId: event.target.value })}
            className={inputClass}
          >
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name}
              </option>
            ))}
          </select>
        </div>

        <div className="w-32">
          <label htmlFor="meta-wizard-country" className={labelClass}>
            Country code
          </label>
          <input
            id="meta-wizard-country"
            value={settings.defaultCountryCode}
            onChange={(event) => onChange({ defaultCountryCode: event.target.value })}
            className={inputClass}
          />
        </div>
      </div>

      <div className="flex gap-3">
        <div className="flex-1">
          <label htmlFor="meta-wizard-stage" className={labelClass}>
            Starting stage
          </label>
          <select
            id="meta-wizard-stage"
            value={settings.defaultStage ?? ''}
            onChange={(event) => onChange({ defaultStage: event.target.value || null })}
            className={inputClass}
          >
            <option value="">New (default)</option>
            {stageOptions.map((stage) => (
              <option key={stage.key} value={stage.key}>
                {stage.label}
              </option>
            ))}
          </select>
        </div>

        <div className="flex-1">
          <label htmlFor="meta-wizard-assignee" className={labelClass}>
            Assign to
          </label>
          <select
            id="meta-wizard-assignee"
            value={settings.defaultAssigneeId ?? ''}
            onChange={(event) => onChange({ defaultAssigneeId: event.target.value || null })}
            className={inputClass}
          >
            {/* Unassigned is the default on purpose: an unassigned lead is visible to the whole
                team, where one assigned to someone on leave is not. */}
            <option value="">Nobody — leave it for the team</option>
            {assignableUsers.map((user) => (
              <option key={user.id} value={user.id}>
                {user.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <span className={labelClass}>Tags on every lead from this form</span>
        {tags.length === 0 ? (
          <p className="text-xs text-slate-400">No tags yet — you can add some on the Tags page.</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {tags.map((tag) => {
              const selected = settings.defaultTagIds.includes(tag.id);

              return (
                <button
                  key={tag.id}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => toggleTag(tag.id)}
                  className={`rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${
                    selected
                      ? 'border-blue-500 bg-blue-50 text-blue-700'
                      : 'border-slate-300 text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  {tag.name}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <label className="flex items-start gap-2 text-xs text-slate-600">
        <input
          type="checkbox"
          checked={settings.importExisting}
          onChange={(event) => onChange({ importExisting: event.target.checked })}
          className="mt-0.5"
        />
        <span>
          Import every lead this form has ever collected.
          <span className="block text-slate-400">
            Off by default — otherwise only leads submitted from now on are imported.
          </span>
        </span>
      </label>

      <label className="flex items-start gap-2 text-xs text-slate-600">
        <input
          type="checkbox"
          checked={settings.aiContextEnabled}
          onChange={(event) => onChange({ aiContextEnabled: event.target.checked })}
          className="mt-0.5"
        />
        <span>
          Let AI drafts use the form answers.
          <span className="block text-slate-400">
            Sends answers like event type and date to the AI provider. Name, email and phone are
            never included.
          </span>
        </span>
      </label>

      <div className="rounded-lg border border-slate-200 p-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-slate-800">AI messages new leads first</p>
            <p className="mt-0.5 text-xs text-slate-500">
              Sends a WhatsApp about 5 minutes after someone fills this form, before anyone on
              your team has looked at it. Leave this off until you have read a few leads and are
              happy with what the AI would say.
            </p>
          </div>
          <ToggleSwitch
            checked={settings.autoGreetEnabled}
            onChange={(next) => onChange({ autoGreetEnabled: next })}
            label="AI messages new leads first"
          />
        </div>
      </div>
    </div>
  );
};

export default MetaSettingsStep;
