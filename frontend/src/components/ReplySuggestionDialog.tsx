import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { generateAiDraft } from '../api/endpoints';
import { useAuth } from '../auth/AuthContext';
import { useMobileBackLayer } from '../hooks/useMobileBackLayer';
import { errorMessage } from './types';

type Props = {
  conversationId: string;
  onClose: () => void;
  onUse: (body: string) => void;
};

/** Generates only on request. Using a draft fills the composer; it never sends a message. */
const ReplySuggestionDialog = ({ conversationId, onClose, onUse }: Props) => {
  const { authedRequest } = useAuth();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  useMobileBackLayer({ active: true, onBack: onClose });

  useEffect(() => () => controller.current?.abort(), []);

  const generate = async () => {
    if (controller.current) return;
    const request = new AbortController();
    controller.current = request;
    setBusy(true);
    setError(null);
    try {
      const payload = await authedRequest((token) => generateAiDraft({ token, conversationId, signal: request.signal }));
      if (request.signal.aborted) return;
      const draft = payload.data?.draftText?.trim();
      if (!draft) throw new Error('No reply draft was returned. Please try again.');
      setText(draft);
    } catch (failure) {
      if (!request.signal.aborted) setError(errorMessage(failure, 'Unable to suggest a reply.'));
    } finally {
      controller.current = null;
      if (!request.signal.aborted) setBusy(false);
    }
  };

  return createPortal(
    <div data-mobile-sheet-backdrop className="fixed inset-0 z-20 flex items-center justify-center bg-slate-900/40 p-4" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label="Suggest reply" data-mobile-sheet onClick={(event) => event.stopPropagation()}
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl bg-white p-4 shadow-xl">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h3 className="text-base font-semibold text-slate-900">Suggest reply</h3>
          <button type="button" onClick={onClose} className="rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50">Close</button>
        </div>
        <p className="mb-3 text-sm text-slate-600">Draft a reply using this conversation and your business knowledge. Review it before using it.</p>
        {error ? <p role="alert" className="mb-3 text-sm text-red-600">{error}</p> : null}
        <label htmlFor="suggested-reply" className="mb-1 block text-xs font-medium text-slate-600">Reply draft</label>
        <textarea id="suggested-reply" value={text} onChange={(event) => setText(event.target.value)} disabled={busy} rows={6}
          className="w-full resize-y rounded-lg border border-slate-300 bg-white p-3 text-sm text-slate-900 focus:border-blue-500 focus:outline-none disabled:opacity-60" />
        <p className="mt-2 text-xs text-slate-500">Use draft places it in the message box. You still choose when to send.</p>
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <button type="button" onClick={generate} disabled={busy} className="rounded-lg border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50">
            {busy ? 'Generating...' : text ? 'Generate another draft' : 'Generate draft'}
          </button>
          <button type="button" onClick={() => onUse(text.trim())} disabled={busy || !text.trim()} className="rounded-lg bg-blue-600 px-3 py-2 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-50">Use draft</button>
        </div>
      </div>
    </div>, document.body,
  );
};

export default ReplySuggestionDialog;
