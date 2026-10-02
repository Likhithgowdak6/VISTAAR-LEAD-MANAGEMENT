import { useCallback, useEffect, useState } from 'react';

import {
  createMetaOauthLeadSource,
  disconnectMeta,
  getMetaConnection,
  listConnectedMetaFormFields,
  listConnectedMetaForms,
  listConnectedMetaPages,
  listMetaFieldKeys,
  listStages,
  listTags,
  listUsers,
  retryMetaWebhookSubscription,
  startMetaOauth,
} from '../../../api/endpoints';
import { useAuth } from '../../../auth/AuthContext';
import { type MetaConnectReturn } from '../../../lib/meta-connect';
import { errorMessage, type AuthValue } from '../../types';
import MetaConnectStep from './MetaConnectStep';
import MetaFormStep from './MetaFormStep';
import MetaMappingStep from './MetaMappingStep';
import MetaPageStep from './MetaPageStep';
import MetaReviewStep from './MetaReviewStep';
import MetaSettingsStep from './MetaSettingsStep';
import {
  type FieldChoice,
  type MetaActivationResult,
  type MetaConnectedPage,
  type MetaConnection,
  type MetaFieldKey,
  type MetaFieldMapping,
  type MetaFormField,
  type MetaLeadFormSummary,
  type MetaWizardSettings,
  type Stage,
  type Tag,
  type User,
  type WhatsAppAccount,
} from './meta-wizard-types';
import { primaryButtonClass, secondaryButtonClass } from './meta-wizard-ui';

type Props = {
  accounts: readonly WhatsAppAccount[];
  /** The outcome of the redirect we have just come back from, when there was one. */
  returned: MetaConnectReturn | null;
  /**
   * Hold on step one even when Facebook is already connected.
   *
   * Set when someone pressed "Reconnect" on an existing source: skipping ahead because a
   * connection exists would skip past the very button they came for.
   */
  startAtConnect?: boolean;
  onClose: () => void;
  /** Refreshes the lead-source list behind the wizard. */
  onCreated: () => void;
};

const STEPS = [
  { key: 'connect', label: 'Facebook' },
  { key: 'page', label: 'Page' },
  { key: 'form', label: 'Form' },
  { key: 'mapping', label: 'Fields' },
  { key: 'settings', label: 'Settings' },
  { key: 'review', label: 'Review' },
] as const;

type StepKey = (typeof STEPS)[number]['key'];

const stepIndex = (key: StepKey): number => STEPS.findIndex((step) => step.key === key);

const DEFAULT_SETTINGS: MetaWizardSettings = {
  name: '',
  whatsappAccountId: '',
  defaultCountryCode: '91',
  defaultStage: null,
  defaultTagIds: [],
  defaultAssigneeId: null,
  aiContextEnabled: false,
  // Cold outbound is never a default. See MetaSettingsStep.
  autoGreetEnabled: false,
  importExisting: false,
};

/**
 * Connecting a Facebook lead form, end to end, without anyone meeting a Meta concept.
 *
 * Six steps, one modal, and all of the state lives here rather than in the steps — so Back is
 * free, and so a failed activation can put the owner back on the review screen with the mapping
 * they spent time on still intact. The only thing that can lose work is the OAuth redirect, and
 * that is step one precisely because there is nothing to lose yet.
 *
 * The manual Page-access-token form next door is untouched and still works; this is a second way
 * in, not a replacement.
 */
const MetaConnectWizard = ({
  accounts,
  returned,
  startAtConnect = false,
  onClose,
  onCreated,
}: Props) => {
  const { authedRequest } = useAuth() as AuthValue;

  const [step, setStep] = useState<StepKey>('connect');

  const [connection, setConnection] = useState<MetaConnection | null>(null);
  const [configured, setConfigured] = useState(false);
  const [loadingConnection, setLoadingConnection] = useState(true);
  const [startingOauth, setStartingOauth] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);

  const [pages, setPages] = useState<MetaConnectedPage[]>([]);
  const [loadingPages, setLoadingPages] = useState(false);
  const [pagesError, setPagesError] = useState<string | null>(null);
  const [page, setPage] = useState<MetaConnectedPage | null>(null);

  const [forms, setForms] = useState<MetaLeadFormSummary[]>([]);
  const [loadingForms, setLoadingForms] = useState(false);
  const [formsError, setFormsError] = useState<string | null>(null);
  const [form, setForm] = useState<MetaLeadFormSummary | null>(null);

  const [fields, setFields] = useState<MetaFormField[]>([]);
  const [fieldKeys, setFieldKeys] = useState<MetaFieldKey[]>([]);
  const [choices, setChoices] = useState<Record<string, FieldChoice>>({});
  const [loadingFields, setLoadingFields] = useState(false);
  const [fieldsError, setFieldsError] = useState<string | null>(null);

  const [stages, setStages] = useState<Stage[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [settings, setSettings] = useState<MetaWizardSettings>(DEFAULT_SETTINGS);

  const [subscribeWebhook, setSubscribeWebhook] = useState(true);
  const [activating, setActivating] = useState(false);
  const [activationError, setActivationError] = useState<string | null>(null);
  const [result, setResult] = useState<MetaActivationResult | null>(null);
  const [retrying, setRetrying] = useState(false);

  const loadPages = useCallback(async () => {
    setLoadingPages(true);
    setPagesError(null);

    try {
      const payload = await authedRequest((token) => listConnectedMetaPages({ token }));
      setPages(payload.data ?? []);
    } catch (error: unknown) {
      setPagesError(errorMessage(error, 'Could not load your Facebook pages.'));
    } finally {
      setLoadingPages(false);
    }
  }, [authedRequest]);

  // The connection decides where the wizard opens: coming back from Facebook, step one has
  // already been satisfied and stopping there to admire it would just be an extra click.
  useEffect(() => {
    let active = true;

    authedRequest((token) => getMetaConnection({ token }))
      .then((payload) => {
        if (!active) {
          return;
        }

        const state = payload.data;
        setConnection(state?.connection ?? null);
        setConfigured(Boolean(state?.configured));

        if (!startAtConnect && state?.connection && state.connection.status === 'active') {
          setStep('page');
          void loadPages();
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setConnectError(errorMessage(error, 'Could not check your Facebook connection.'));
        }
      })
      .finally(() => {
        if (active) {
          setLoadingConnection(false);
        }
      });

    return () => {
      active = false;
    };
  }, [authedRequest, loadPages, startAtConnect]);

  // The settings step needs these and they never change mid-wizard, so they are fetched once
  // rather than on every visit to step five.
  useEffect(() => {
    authedRequest((token) => listStages({ token, status: 'active' }))
      .then((payload) => setStages(payload.data ?? []))
      .catch(() => {});
    authedRequest((token) => listTags({ token }))
      .then((payload) => setTags(payload.data ?? []))
      .catch(() => {});
    authedRequest((token) => listUsers({ token, status: 'active' }))
      .then((payload) => setUsers(payload.data ?? []))
      .catch(() => {});
  }, [authedRequest]);

  // One number is the normal case, so the first is preselected. DERIVED rather than written into
  // state on mount: state would have to be corrected in an effect every time `accounts` arrived,
  // and this reads the same without the extra render.
  const selectedAccountId = settings.whatsappAccountId || (accounts[0]?.id ?? '');
  const effectiveSettings: MetaWizardSettings = {
    ...settings,
    whatsappAccountId: selectedAccountId,
  };

  const handleConnect = async () => {
    if (startingOauth) {
      return;
    }

    setStartingOauth(true);
    setConnectError(null);

    try {
      const payload = await authedRequest((token) => startMetaOauth({ token }));
      const url = payload.data?.authorizeUrl;

      if (!url) {
        throw new Error('The server did not return a Facebook sign-in link.');
      }

      // Leaves the app. The signed `state` in this URL is short-lived, so it is followed
      // immediately rather than stored and offered as a link.
      window.location.assign(url);
    } catch (error: unknown) {
      setStartingOauth(false);
      setConnectError(errorMessage(error, 'Could not start Facebook sign-in.'));
    }
  };

  const handleDisconnect = async () => {
    setConnectError(null);

    try {
      await authedRequest((token) => disconnectMeta({ token }));
      setConnection(null);
      setPages([]);
      setPage(null);
      setStep('connect');
    } catch (error: unknown) {
      setConnectError(errorMessage(error, 'Could not disconnect.'));
    }
  };

  const loadForms = useCallback(
    async (pageId: string) => {
      setLoadingForms(true);
      setFormsError(null);

      try {
        const payload = await authedRequest((token) => listConnectedMetaForms({ token, pageId }));
        setForms(payload.data ?? []);
      } catch (error: unknown) {
        setFormsError(errorMessage(error, 'Could not load this page’s lead forms.'));
      } finally {
        setLoadingForms(false);
      }
    },
    [authedRequest],
  );

  const handleSelectPage = (nextPage: MetaConnectedPage) => {
    // Everything downstream belonged to the old page. Keeping a form or a mapping across a page
    // change would submit a form id the new page does not own.
    setPage(nextPage);
    setForm(null);
    setForms([]);
    setFields([]);
    setChoices({});
    setStep('form');
    void loadForms(nextPage.id);
  };

  const loadFields = useCallback(
    async (pageId: string, formId: string) => {
      setLoadingFields(true);
      setFieldsError(null);

      try {
        // The questions are required; the override vocabulary is NOT.
        //
        // These were one Promise.all until a browser test against a backend that predated
        // /meta/field-keys turned a 404 on the optional call into a dead step — the questions had
        // arrived and every one of them carried a suggestion, but the whole screen showed an
        // error. A frontend newer than its backend is an ordinary deploy race, and so is a
        // transient 5xx; neither should cost the owner the work.
        const fieldsPayload = await authedRequest((token) =>
          listConnectedMetaFormFields({ token, pageId, formId }),
        );

        const nextFields = fieldsPayload.data ?? [];
        setFields(nextFields);

        const keysPayload = await authedRequest((token) => listMetaFieldKeys({ token })).catch(
          () => null,
        );

        // Degraded, not broken: offer the keys this form's own suggestions already use, so the
        // owner can still re-point one question at another question's key, drop an answer, or
        // keep it as free text. Deriving from the data in hand beats a hardcoded copy of the
        // backend's table, which would be a second vocabulary to keep in step.
        setFieldKeys(
          keysPayload?.data ??
            [...new Set(nextFields.map((field) => field.suggestedFactKey).filter(Boolean))]
              .sort()
              .map((key) => ({
                key: key as string,
                // The identity triple is fixed and tiny; it is the one thing the fallback has to
                // assert so name/email/phone still render as locked contact fields.
                isContact: ['name', 'email', 'phone'].includes(key as string),
              })),
        );

        // Pre-answered from the importer's own rules. A question with no rule defaults to
        // `extra` (kept as free text), never to `ignore` — defaulting to discarding an answer
        // nobody has looked at would lose data silently.
        setChoices(
          Object.fromEntries(
            nextFields.map((field) => [
              field.key,
              field.suggestedFactKey
                ? ({ mode: 'fact', factKey: field.suggestedFactKey } satisfies FieldChoice)
                : ({ mode: 'extra', factKey: null } satisfies FieldChoice),
            ]),
          ),
        );
      } catch (error: unknown) {
        setFieldsError(errorMessage(error, 'Could not read this form’s questions.'));
      } finally {
        setLoadingFields(false);
      }
    },
    [authedRequest],
  );

  const handleSelectForm = (nextForm: MetaLeadFormSummary) => {
    setForm(nextForm);
    setStep('mapping');

    // A sensible name saves a step; the owner can still change it.
    setSettings((current) =>
      current.name.trim() === ''
        ? { ...current, name: (nextForm.name ?? 'Facebook leads').slice(0, 120) }
        : current,
    );

    if (page) {
      void loadFields(page.id, nextForm.id);
    }
  };

  /**
   * The mappings to persist.
   *
   * `extra` is deliberately absent rather than sent as null: absent means "the rules decide",
   * which is what keeping an answer as free text already is, while an explicit null means
   * "drop it". Sending null for both would start discarding answers.
   */
  const buildFieldMappings = (): MetaFieldMapping[] =>
    fields
      .map((field) => ({ field, choice: choices[field.key] }))
      .filter(({ choice }) => choice?.mode === 'fact' || choice?.mode === 'ignore')
      .map(({ field, choice }) => ({
        metaKey: field.key,
        metaLabel: field.label,
        factKey: choice?.mode === 'fact' ? choice.factKey : null,
      }));

  const handleActivate = async () => {
    if (activating || !page || !form) {
      return;
    }

    setActivating(true);
    setActivationError(null);

    try {
      const payload = await authedRequest((token) =>
        createMetaOauthLeadSource({
          token,
          name: settings.name.trim(),
          pageId: page.id,
          pageName: page.name,
          formId: form.id,
          formName: form.name,
          whatsappAccountId: selectedAccountId,
          defaultCountryCode: settings.defaultCountryCode.trim(),
          aiContextEnabled: settings.aiContextEnabled,
          autoGreetEnabled: settings.autoGreetEnabled,
          importExisting: settings.importExisting,
          fieldMappings: buildFieldMappings(),
          defaultStage: settings.defaultStage,
          defaultTagIds: settings.defaultTagIds,
          defaultAssigneeId: settings.defaultAssigneeId,
          subscribeWebhook,
        }),
      );

      if (payload.data) {
        setResult(payload.data);
        // The list behind the modal is refreshed now, not on close: the source exists either
        // way, including when the subscription failed.
        onCreated();
      }
    } catch (error: unknown) {
      // Stays on Review with every selection intact.
      setActivationError(errorMessage(error, 'Could not connect this form.'));
    } finally {
      setActivating(false);
    }
  };

  const handleRetrySubscription = async () => {
    const leadSourceId = result?.leadSource.id;

    if (retrying || !leadSourceId) {
      return;
    }

    setRetrying(true);
    setActivationError(null);

    try {
      const payload = await authedRequest((token) =>
        retryMetaWebhookSubscription({ token, leadSourceId }),
      );

      const retried = payload.data;

      if (retried?.leadSource) {
        setResult({
          leadSource: retried.leadSource,
          webhookSubscribed: retried.webhookSubscribed,
          webhookError: retried.webhookError,
        });
        onCreated();
      }
    } catch (error: unknown) {
      setActivationError(errorMessage(error, 'Could not retry the connection.'));
    } finally {
      setRetrying(false);
    }
  };

  const currentIndex = stepIndex(step);
  const settingsComplete =
    settings.name.trim() !== '' &&
    selectedAccountId !== '' &&
    /^\d{1,4}$/.test(settings.defaultCountryCode.trim());

  const canAdvance = (): boolean => {
    switch (step) {
      case 'connect':
        return connection !== null && connection.status === 'active';
      case 'page':
        return page !== null;
      case 'form':
        return form !== null;
      case 'mapping':
        return fields.length > 0;
      case 'settings':
        return settingsComplete;
      default:
        return false;
    }
  };

  const goBack = () => {
    const previous = STEPS[currentIndex - 1];

    if (previous) {
      setStep(previous.key);
    }
  };

  const goNext = () => {
    const next = STEPS[currentIndex + 1];

    if (next && canAdvance()) {
      setStep(next.key);
    }
  };

  return (
    <div
      role="dialog"
      aria-label="Connect a Facebook lead form"
      className="fixed inset-0 z-10 flex items-center justify-center bg-slate-900/40 p-4"
    >
      <div className="flex max-h-[92vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-white shadow-xl">
        <div className="border-b border-slate-200 px-6 pb-3 pt-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="text-base font-semibold text-slate-900">Connect Facebook leads</h3>
              <p className="mt-0.5 text-xs text-slate-500">
                Your lead form, straight into the inbox. No tokens to copy.
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg px-2 py-1 text-sm text-slate-400 hover:bg-slate-100 hover:text-slate-600"
              aria-label="Close"
            >
              ✕
            </button>
          </div>

          <ol className="mt-3 flex flex-wrap items-center gap-x-1.5 gap-y-1">
            {STEPS.map((entry, index) => {
              const done = index < currentIndex;
              const active = index === currentIndex;

              return (
                <li key={entry.key} className="flex items-center gap-1.5">
                  <span
                    aria-current={active ? 'step' : undefined}
                    className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                      active
                        ? 'bg-blue-600 text-white'
                        : done
                          ? 'bg-blue-50 text-blue-700'
                          : 'bg-slate-100 text-slate-500'
                    }`}
                  >
                    {index + 1}. {entry.label}
                  </span>
                  {index < STEPS.length - 1 ? (
                    <span aria-hidden="true" className="text-slate-300">
                      ›
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ol>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
          {step === 'connect' ? (
            <MetaConnectStep
              loading={loadingConnection}
              configured={configured}
              connection={connection}
              returned={returned}
              starting={startingOauth}
              error={connectError}
              onConnect={handleConnect}
              onDisconnect={handleDisconnect}
            />
          ) : null}

          {step === 'page' ? (
            <MetaPageStep
              loading={loadingPages}
              pages={pages}
              selectedPageId={page?.id ?? null}
              error={pagesError}
              onSelect={handleSelectPage}
              onRetry={() => void loadPages()}
            />
          ) : null}

          {step === 'form' ? (
            <MetaFormStep
              loading={loadingForms}
              pageName={page?.name ?? page?.id ?? 'this page'}
              forms={forms}
              selectedFormId={form?.id ?? null}
              error={formsError}
              onSelect={handleSelectForm}
              onRetry={() => page && void loadForms(page.id)}
            />
          ) : null}

          {step === 'mapping' ? (
            <MetaMappingStep
              loading={loadingFields}
              fields={fields}
              fieldKeys={fieldKeys}
              choices={choices}
              error={fieldsError}
              onChange={(metaKey, choice) =>
                setChoices((current) => ({ ...current, [metaKey]: choice }))
              }
              onRetry={() => page && form && void loadFields(page.id, form.id)}
            />
          ) : null}

          {step === 'settings' ? (
            <MetaSettingsStep
              settings={effectiveSettings}
              accounts={accounts}
              stages={stages}
              tags={tags}
              users={users}
              onChange={(patch) => setSettings((current) => ({ ...current, ...patch }))}
            />
          ) : null}

          {step === 'review' ? (
            <MetaReviewStep
              connection={connection}
              page={page}
              form={form}
              fields={fields}
              choices={choices}
              settings={effectiveSettings}
              accounts={accounts}
              stages={stages}
              tags={tags}
              users={users}
              subscribeWebhook={subscribeWebhook}
              onSubscribeWebhookChange={setSubscribeWebhook}
              result={result}
              error={activationError}
              retrying={retrying}
              onRetrySubscription={handleRetrySubscription}
            />
          ) : null}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-slate-200 px-6 py-3">
          <button
            type="button"
            onClick={goBack}
            // Once the source exists, Back would offer to create a second one.
            disabled={currentIndex === 0 || activating || result !== null}
            className={secondaryButtonClass}
          >
            Back
          </button>

          {result ? (
            <button type="button" onClick={onClose} className={primaryButtonClass}>
              Done
            </button>
          ) : step === 'review' ? (
            <button
              type="button"
              onClick={handleActivate}
              disabled={activating || !page || !form || !settingsComplete}
              className={primaryButtonClass}
            >
              {activating ? 'Connecting…' : 'Activate'}
            </button>
          ) : (
            <button
              type="button"
              onClick={goNext}
              disabled={!canAdvance()}
              className={primaryButtonClass}
            >
              Next
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default MetaConnectWizard;
