import { useEffect, useRef, useState } from 'react';

import { createTemplate, generateTemplates } from '../../api/endpoints';
import { useAuth } from '../../auth/AuthContext';
import { type GeneratedTemplate } from '../../types';
import { type AuthValue, errorMessage } from '../types';

/**
 * Four ways of saying the same prices, and the owner keeps one.
 *
 * He types what he charges the way he'd say it out loud. What comes back is four presentations of
 * that - one offer, four registers - because a quote that reads well is the difference between
 * being compared on price alone and being compared on the work.
 *
 * Regenerating sends back the four he rejected. Without that the model reliably returns the same
 * ideas with the sentences shuffled, which reads as the button being broken.
 */

type Props = {
  onClose: () => void;
  onSaved: () => void;
  /** Pre-fills the box, for "make more like this one" from a saved template. */
  initialDetails?: string;
};

const EXAMPLE =
  '300 edited photos one day 45k\nphoto + video one day 85k, includes a reel and full edit\nextra day 20k';

const TemplateGenerateDialog = ({ onClose, onSaved, initialDetails = '' }: Props) => {
  const { authedRequest } = useAuth() as AuthValue;
  const detailsRef = useRef<HTMLTextAreaElement>(null);

  const [details, setDetails] = useState(initialDetails);
  const [options, setOptions] = useState<GeneratedTemplate[]>([]);
  const [chosen, setChosen] = useState<number | null>(null);
  const [busy, setBusy] = useState<'generate' | 'save' | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Everything he has already turned down, across rounds, so round three does not circle back
  // to round one's wording.
  const [rejected, setRejected] = useState<string[]>([]);

  useEffect(() => {
    detailsRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const runGenerate = async (previous: GeneratedTemplate[]) => {
    if (busy || details.trim() === '') {
      return;
    }

    setBusy('generate');
    setError(null);
    setChosen(null);

    // Carried forward before the call so a failed regenerate does not lose what was rejected.
    const avoid = [...rejected, ...previous.map((option) => option.body)];

    try {
      const payload = await authedRequest((token) =>
        generateTemplates({
          token,
          rawDetails: details.trim(),
          rejected: avoid.slice(-8),
        }),
      );

      setOptions(payload.data?.templates ?? []);
      setRejected(avoid);
    } catch (generateError: unknown) {
      setError(errorMessage(generateError, 'Could not write the templates. Try again.'));
    } finally {
      setBusy(null);
    }
  };

  const handleSave = async () => {
    const option = chosen === null ? null : options[chosen];
    if (busy || !option) {
      return;
    }

    setBusy('save');
    setError(null);

    try {
      await authedRequest((token) =>
        createTemplate({
          token,
          title: option.title,
          body: option.body,
          kind: 'pricing',
          // Kept so he can come back and generate more from the same numbers.
          sourceDetails: details.trim(),
        }),
      );
      onSaved();
      onClose();
    } catch (saveError: unknown) {
      setError(errorMessage(saveError, 'Unable to save this template.'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink/80 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Write a price template"
        onClick={(event) => event.stopPropagation()}
        className="surface glow-key my-4 w-full max-w-2xl rounded-xl p-5"
      >
        <h2 className="eyebrow">Write a price template</h2>
        <p className="mt-2 text-sm text-bone-dim">
          Type what you charge, however you'd say it. You'll get four ways to send it.
        </p>

        <label
          htmlFor="template-details"
          className="mt-4 mb-1 block text-xs font-medium text-slate-600"
        >
          Your prices
        </label>
        <textarea
          id="template-details"
          ref={detailsRef}
          rows={4}
          placeholder={EXAMPLE}
          value={details}
          onChange={(event) => setDetails(event.target.value)}
          className="w-full resize-none rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none"
        />
        <p className="mt-1 text-xs text-slate-500">
          Your figures are used exactly as written — nothing is rounded, and no package, discount
          or offer is added.
        </p>

        {error ? (
          <p role="alert" className="mt-2 text-xs text-red-600">
            {error}
          </p>
        ) : null}

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => runGenerate(options)}
            disabled={busy !== null || details.trim() === ''}
            className="btn-key rounded-lg px-4 py-2 text-sm disabled:opacity-50"
          >
            {busy === 'generate'
              ? 'Writing…'
              : options.length > 0
                ? '✦ Show me four more'
                : '✦ Write four versions'}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto font-mono text-[0.6875rem] uppercase tracking-[0.1em] text-muted hover:text-bone"
          >
            Cancel
          </button>
        </div>

        {options.length > 0 ? (
          <div className="mt-5">
            <h3 className="eyebrow">Pick one</h3>
            <p className="mt-1 text-xs text-slate-500">
              Not happy with any of them? Ask for four more — these ones won't come back.
            </p>

            <ul className="mt-3 space-y-2">
              {options.map((option, index) => {
                const isChosen = chosen === index;

                return (
                  <li key={`${option.title}-${index}`}>
                    <button
                      type="button"
                      onClick={() => setChosen(index)}
                      aria-pressed={isChosen}
                      className={`w-full rounded-lg border p-3 text-left transition-colors ${
                        isChosen
                          ? 'border-key/60 bg-key/5'
                          : 'border-slate-300 hover:border-key/30'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-semibold text-slate-900">{option.title}</span>
                        {isChosen ? (
                          <span className="chip chip-fill text-[0.625rem]">Selected</span>
                        ) : null}
                      </div>
                      {/* Pre-wrap: the line breaks are the formatting, and they are what it will
                          look like in WhatsApp. */}
                      <p className="mt-2 whitespace-pre-wrap break-words text-sm text-slate-600">
                        {option.body}
                      </p>
                    </button>
                  </li>
                );
              })}
            </ul>

            <button
              type="button"
              onClick={handleSave}
              disabled={busy !== null || chosen === null}
              className="btn-key mt-4 rounded-lg px-4 py-2 text-sm disabled:opacity-50"
            >
              {busy === 'save' ? 'Saving…' : 'Save this one'}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
};

export default TemplateGenerateDialog;
