/**
 * Choosing an approved WhatsApp template and filling in its blanks.
 *
 * This is the only way to reach a customer outside the 24-hour service window, which makes it the
 * most consequential dialog in the Cloud API feature. Three decisions shape it:
 *
 *   1. THE WORDING IS NOT EDITABLE. Meta approved a specific sentence and performs the
 *      substitution on its side; what travels is the template's name and the values. Offering a
 *      text box here would imply an edit that cannot happen, and the customer would receive the
 *      approved text regardless.
 *
 *   2. THE PREVIEW IS LIVE. An agent should read the message as the customer will receive it
 *      before sending, because they cannot correct it afterwards and because a template with the
 *      wrong name in it is worse than no message.
 *
 *   3. ONLY APPROVED TEMPLATES ARE OFFERED. A pending one would be refused by WhatsApp. The
 *      Accounts page shows the full list including rejected ones, which is where somebody
 *      debugging "why is my template not here" should be looking.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

import { listAccountTemplates } from '../api/endpoints';
import { useAuth } from '../auth/AuthContext';
import { useMobileBackLayer } from '../hooks/useMobileBackLayer';
import { type AuthValue, errorMessage } from './types';
import { type WhatsAppTemplate } from '../types';
import Spinner from './Spinner';

/** Mirrors backend/src/modules/whatsapp-templates/whatsapp-template.parser.ts. */
const PLACEHOLDER_PATTERN = /\{\{\s*(\d+)\s*\}\}/g;

/**
 * Deliberately not exported: this file exports a component, and a second export would break Fast
 * Refresh for it. Nothing outside needs it - the preview exists only to be read here, and the
 * server renders the body that is actually stored on the message.
 */
const renderPreview = (text: string | null, values: readonly string[]): string => {
  if (!text) {
    return '';
  }

  return text.replace(PLACEHOLDER_PATTERN, (match, rawIndex: string) => {
    const value = values[Number(rawIndex) - 1];

    // An unfilled placeholder stays visible as itself rather than vanishing, so the agent can
    // see at a glance which blank is still empty.
    return value && value.trim() !== '' ? value : match;
  });
};

export type TemplateSelection = {
  name: string;
  language: string;
  bodyParameters: string[];
  headerParameters: string[];
};

type Props = {
  accountId: string;
  onClose: () => void;
  onSend: (selection: TemplateSelection) => Promise<void>;
};

const WhatsAppTemplateDialog = ({ accountId, onClose, onSend }: Props) => {
  useMobileBackLayer({ active: true, onBack: onClose });
  const { authedRequest } = useAuth() as AuthValue;

  const [templates, setTemplates] = useState<WhatsAppTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [bodyValues, setBodyValues] = useState<string[]>([]);
  const [headerValues, setHeaderValues] = useState<string[]>([]);
  const [sending, setSending] = useState(false);

  const load = useCallback(async () => {
    try {
      const payload = await authedRequest((token) =>
        listAccountTemplates({ token, accountId, approvedOnly: true }),
      );

      setTemplates(payload.data ?? []);
      setError(null);
    } catch (loadError: unknown) {
      setError(errorMessage(loadError, 'Unable to load templates.'));
    } finally {
      setLoading(false);
    }
  }, [authedRequest, accountId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  const selected = useMemo(
    () => templates.find((template) => template.id === selectedId) ?? null,
    [templates, selectedId],
  );

  const choose = (template: WhatsAppTemplate) => {
    setSelectedId(template.id);
    // Sized to the template, so the send carries exactly as many values as it declares - the
    // server refuses a mismatch and so does Meta.
    setBodyValues(Array.from({ length: template.bodyVariableCount }, () => ''));
    setHeaderValues(Array.from({ length: template.headerVariableCount }, () => ''));
    setError(null);
  };

  const allFilled =
    selected !== null &&
    bodyValues.every((value) => value.trim() !== '') &&
    headerValues.every((value) => value.trim() !== '');

  const handleSend = async () => {
    if (!selected || !allFilled || sending) {
      return;
    }

    setSending(true);
    setError(null);

    try {
      await onSend({
        name: selected.name,
        language: selected.language,
        bodyParameters: bodyValues.map((value) => value.trim()),
        headerParameters: headerValues.map((value) => value.trim()),
      });

      onClose();
    } catch (sendError: unknown) {
      setError(errorMessage(sendError, 'Unable to send this template.'));
      setSending(false);
    }
  };

  const renderVariableInputs = (
    label: string,
    values: string[],
    setValues: (values: string[]) => void,
  ) =>
    values.map((value, index) => (
      <div key={`${label}-${index}`}>
        <label
          htmlFor={`tpl-${label}-${index}`}
          className="mb-1 block text-xs font-medium text-slate-600"
        >
          {label} value {index + 1}
        </label>
        <input
          id={`tpl-${label}-${index}`}
          value={value}
          onChange={(event) => {
            const next = [...values];
            next[index] = event.target.value;
            setValues(next);
          }}
          className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none"
        />
      </div>
    ));

  const renderBody = () => {
    if (loading) {
      return (
        <div className="py-8">
          <Spinner label="Loading templates…" />
        </div>
      );
    }

    if (templates.length === 0) {
      return (
        <div className="py-6 text-center">
          <p className="text-sm text-slate-600">No supported approved text templates on this number yet.</p>
          <p className="mt-2 text-xs text-slate-500">
            Create one in the Meta dashboard, wait for it to be approved, then press{' '}
            <strong>Sync templates</strong> on the Accounts page.
            {' '}Use text templates with numbered placeholders. Media, button and named-parameter templates are not supported yet.
          </p>
        </div>
      );
    }

    if (!selected) {
      return (
        <ul className="max-h-80 space-y-2 overflow-y-auto">
          {templates.map((template) => (
            <li key={template.id}>
              <button
                type="button"
                onClick={() => choose(template)}
                className="w-full rounded-lg border border-slate-200 p-3 text-left hover:border-blue-400 hover:bg-blue-50"
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="truncate font-mono text-xs font-semibold text-slate-900">
                    {template.name}
                  </span>
                  <span className="shrink-0 text-[10px] uppercase tracking-wide text-slate-400">
                    {template.language}
                  </span>
                </span>
                {template.bodyText ? (
                  <span className="mt-1 block line-clamp-2 text-xs text-slate-600">
                    {template.bodyText}
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      );
    }

    return (
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate font-mono text-xs font-semibold text-slate-900">
            {selected.name}
          </span>
          <button
            type="button"
            onClick={() => setSelectedId(null)}
            className="shrink-0 text-xs font-medium text-blue-600 hover:text-blue-700"
          >
            Change
          </button>
        </div>

        {renderVariableInputs('Header', headerValues, setHeaderValues)}
        {renderVariableInputs('Message', bodyValues, setBodyValues)}

        {/* What the customer will actually receive. The whole reason the wording is not editable
            is that this preview is the only chance to catch a wrong value. */}
        <div className="rounded-lg bg-slate-50 p-3">
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
            Preview
          </p>
          {selected.headerText ? (
            <p className="text-sm font-semibold text-slate-900">
              {renderPreview(selected.headerText, headerValues)}
            </p>
          ) : null}
          <p className="whitespace-pre-wrap text-sm text-slate-800">
            {renderPreview(selected.bodyText, bodyValues)}
          </p>
          {selected.footerText ? (
            <p className="mt-1 text-xs text-slate-500">{selected.footerText}</p>
          ) : null}
        </div>

        <p className="text-xs text-slate-500">
          The wording was approved by WhatsApp and cannot be edited here.
        </p>
      </div>
    );
  };

  return (
    <div
      role="dialog"
      aria-label="Send an approved WhatsApp template"
      data-mobile-sheet-backdrop
      className="fixed inset-0 z-10 flex items-center justify-center bg-slate-900/40 p-4"
    >
      <div data-mobile-sheet className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-base font-semibold text-slate-900">Send a template</h3>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-600">
            ×
          </button>
        </div>

        {renderBody()}

        {error ? (
          <p role="alert" className="mt-2 text-xs text-red-600">
            {error}
          </p>
        ) : null}

        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Cancel
          </button>
          {selected ? (
            <button
              type="button"
              onClick={handleSend}
              disabled={!allFilled || sending}
              className="flex-1 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:bg-blue-300"
            >
              {sending ? 'Sending…' : 'Send'}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
};

export default WhatsAppTemplateDialog;
