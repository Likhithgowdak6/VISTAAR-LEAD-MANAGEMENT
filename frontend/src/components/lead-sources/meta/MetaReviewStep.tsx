import { type ReactNode } from 'react';

import {
  type FieldChoice,
  type MetaActivationResult,
  type MetaConnection,
  type MetaConnectedPage,
  type MetaFormField,
  type MetaLeadFormSummary,
  type MetaWizardSettings,
  type Stage,
  type Tag,
  type User,
  type WhatsAppAccount,
} from './meta-wizard-types';
import { prettyFactKey, secondaryButtonClass } from './meta-wizard-ui';

type Props = {
  connection: MetaConnection | null;
  page: MetaConnectedPage | null;
  form: MetaLeadFormSummary | null;
  fields: readonly MetaFormField[];
  choices: Readonly<Record<string, FieldChoice>>;
  settings: MetaWizardSettings;
  accounts: readonly WhatsAppAccount[];
  stages: readonly Stage[];
  tags: readonly Tag[];
  users: readonly User[];
  subscribeWebhook: boolean;
  onSubscribeWebhookChange: (next: boolean) => void;
  /** Set once activation has returned, success or partial. */
  result: MetaActivationResult | null;
  error: string | null;
  retrying: boolean;
  onRetrySubscription: () => void;
};

const Row = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="flex items-start justify-between gap-4 border-b border-slate-100 py-2 last:border-b-0">
    <span className="shrink-0 text-xs text-slate-500">{label}</span>
    <span className="min-w-0 text-right text-xs font-medium text-slate-800">{children}</span>
  </div>
);

/**
 * Step 6. Everything that is about to happen, on one screen, before it happens.
 *
 * After activation this same screen becomes the result, rather than closing on success: a
 * subscription that failed leaves a working source with slower delivery, and that is a state the
 * owner needs to see and be able to retry — not one to hide behind a closing modal.
 */
const MetaReviewStep = ({
  connection,
  page,
  form,
  fields,
  choices,
  settings,
  accounts,
  stages,
  tags,
  users,
  subscribeWebhook,
  onSubscribeWebhookChange,
  result,
  error,
  retrying,
  onRetrySubscription,
}: Props) => {
  const accountName = accounts.find((account) => account.id === settings.whatsappAccountId)?.name;
  const stageLabel =
    settings.defaultStage === null
      ? 'New'
      : (stages.find((stage) => stage.key === settings.defaultStage)?.label ??
        prettyFactKey(settings.defaultStage));
  const assigneeName = settings.defaultAssigneeId
    ? (users.find((user) => user.id === settings.defaultAssigneeId)?.name ?? 'Someone')
    : 'Nobody';
  const tagNames = tags
    .filter((tag) => settings.defaultTagIds.includes(tag.id))
    .map((tag) => tag.name);

  const mapped = fields.filter((field) => choices[field.key]?.mode === 'fact');
  const ignored = fields.filter((field) => choices[field.key]?.mode === 'ignore');
  const extra = fields.filter((field) => choices[field.key]?.mode === 'extra');

  if (result) {
    const { leadSource, webhookSubscribed, webhookError } = result;

    return (
      <div className="space-y-3">
        <div
          className={`rounded-xl border p-4 ${
            webhookSubscribed ? 'border-emerald-200 bg-emerald-50' : 'border-amber-200 bg-amber-50'
          }`}
        >
          <p
            className={`text-sm font-semibold ${
              webhookSubscribed ? 'text-emerald-800' : 'text-amber-900'
            }`}
          >
            {webhookSubscribed
              ? `${leadSource.name} is live.`
              : `${leadSource.name} was created, but isn’t live yet.`}
          </p>
          <p
            className={`mt-1 text-xs ${webhookSubscribed ? 'text-emerald-700' : 'text-amber-800'}`}
          >
            {webhookSubscribed
              ? 'New leads from this form arrive in your inbox within seconds.'
              : 'Your settings and mapping are saved. Facebook refused the instant-delivery subscription, so the source is paused. Retry below.'}
          </p>

          {webhookError ? (
            <p className="mt-2 rounded-lg bg-white/70 px-2 py-1.5 text-xs text-amber-900">
              {webhookError}
            </p>
          ) : null}

          {!webhookSubscribed ? (
            <button
              type="button"
              onClick={onRetrySubscription}
              disabled={retrying}
              className={`${secondaryButtonClass} mt-3`}
            >
              {retrying ? 'Retrying…' : 'Retry connection'}
            </button>
          ) : null}
        </div>

        <div className="rounded-xl border border-slate-200 bg-white px-3">
          <Row label="Status">{leadSource.status === 'active' ? 'Active' : 'Paused'}</Row>
          <Row label="Page">{leadSource.meta.pageName ?? leadSource.meta.pageId ?? '—'}</Row>
          <Row label="Form">{leadSource.meta.formName ?? leadSource.meta.formId ?? '—'}</Row>
          <Row label="Instant delivery">{webhookSubscribed ? 'On' : 'Off'}</Row>
        </div>

        {error ? (
          <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-slate-200 bg-white px-3">
        <Row label="Facebook account">{connection?.metaUserName ?? '—'}</Row>
        <Row label="Page">{page?.name ?? page?.id ?? '—'}</Row>
        <Row label="Lead form">{form?.name ?? form?.id ?? '—'}</Row>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white px-3">
        <Row label="Name">{settings.name.trim() || '—'}</Row>
        <Row label="Replies from">{accountName ?? '—'}</Row>
        <Row label="Country code">+{settings.defaultCountryCode}</Row>
        <Row label="Starting stage">{stageLabel}</Row>
        <Row label="Assign to">{assigneeName}</Row>
        <Row label="Tags">{tagNames.length > 0 ? tagNames.join(', ') : 'None'}</Row>
        <Row label="Backfill old leads">{settings.importExisting ? 'Yes' : 'No'}</Row>
        <Row label="AI reads answers">{settings.aiContextEnabled ? 'On' : 'Off'}</Row>
        <Row label="AI messages first">
          <span className={settings.autoGreetEnabled ? 'text-amber-700' : undefined}>
            {settings.autoGreetEnabled ? 'On' : 'Off'}
          </span>
        </Row>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-3">
        <p className="text-xs font-medium text-slate-700">
          Field mapping — {mapped.length} mapped
          {extra.length > 0 ? `, ${extra.length} kept as extra detail` : ''}
          {ignored.length > 0 ? `, ${ignored.length} ignored` : ''}
        </p>
        <ul className="mt-2 space-y-1">
          {mapped.map((field) => (
            <li key={field.key} className="flex items-center justify-between gap-3 text-xs">
              <span className="truncate text-slate-600">{field.label}</span>
              <span className="shrink-0 font-medium text-slate-800">
                {prettyFactKey(choices[field.key]?.factKey ?? '')}
              </span>
            </li>
          ))}
          {ignored.map((field) => (
            <li key={field.key} className="flex items-center justify-between gap-3 text-xs">
              <span className="truncate text-slate-400 line-through">{field.label}</span>
              <span className="shrink-0 text-slate-400">Ignored</span>
            </li>
          ))}
        </ul>
      </div>

      <label className="flex items-start gap-2 text-xs text-slate-600">
        <input
          type="checkbox"
          checked={subscribeWebhook}
          onChange={(event) => onSubscribeWebhookChange(event.target.checked)}
          className="mt-0.5"
        />
        <span>
          Deliver leads instantly.
          <span className="block text-slate-400">
            On by default. Turned off, leads still arrive — on the ten-minute check instead of in
            seconds.
          </span>
        </span>
      </label>

      {error ? (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
          {error}
        </p>
      ) : null}
    </div>
  );
};

export default MetaReviewStep;
