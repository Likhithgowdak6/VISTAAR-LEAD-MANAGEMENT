import { useState } from 'react';

import { generateAiProposal, renderAiProposal, reviseAiProposal } from '../../api/endpoints';
import { useAuth } from '../../auth/AuthContext';
import { type AiBrainProposalContent, type AuthValue, errorMessage } from '../types';

type Props = {
  conversationId: string;
  displayName?: string;
};

const base64ToBlob = (base64: string, mimeType: string): Blob => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mimeType });
};

const downloadBlob = (blob: Blob, fileName: string): void => {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
};

const asText = (value: unknown): string => (typeof value === 'string' ? value : '');

/**
 * Draft -> revise by instruction -> render to a downloadable file. Sending the result to the
 * lead is still a manual step (attach the download from WhatsApp or email) - this only covers
 * getting from "facts we've learned" to "a document a human can send".
 */
const AiProposalSection = ({ conversationId, displayName }: Props) => {
  const { authedRequest } = useAuth() as AuthValue;
  const [content, setContent] = useState<AiBrainProposalContent | null>(null);
  const [instruction, setInstruction] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleGenerate = async () => {
    setBusy(true);
    setError(null);

    try {
      const payload = await authedRequest((token) =>
        generateAiProposal({ token, conversationId, clientName: displayName }),
      );
      setContent(payload?.data ?? null);
    } catch (generateError: unknown) {
      setError(errorMessage(generateError, 'Unable to draft a proposal right now.'));
    } finally {
      setBusy(false);
    }
  };

  const handleRevise = async () => {
    if (!content || instruction.trim() === '') {
      return;
    }

    setBusy(true);
    setError(null);

    try {
      const payload = await authedRequest((token) =>
        reviseAiProposal({ token, content, instruction }),
      );
      setContent(payload?.data ?? content);
      setInstruction('');
    } catch (reviseError: unknown) {
      setError(errorMessage(reviseError, 'Unable to revise the proposal.'));
    } finally {
      setBusy(false);
    }
  };

  const handleDownload = async () => {
    if (!content) {
      return;
    }

    setBusy(true);
    setError(null);

    try {
      const payload = await authedRequest((token) =>
        renderAiProposal({ token, conversationId, content }),
      );
      const rendered = payload?.data;

      if (rendered?.pdf_base64) {
        downloadBlob(base64ToBlob(rendered.pdf_base64, 'application/pdf'), 'proposal.pdf');
      }
      if (rendered?.docx_base64) {
        downloadBlob(
          base64ToBlob(
            rendered.docx_base64,
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          ),
          'proposal.docx',
        );
      }
    } catch (renderError: unknown) {
      setError(errorMessage(renderError, 'Unable to render the proposal document.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg border border-slate-200 p-3">
      <span className="text-xs font-semibold uppercase text-slate-500">Proposal</span>

      {!content ? (
        <div className="mt-2">
          <button
            type="button"
            onClick={handleGenerate}
            disabled={busy}
            className="rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            {busy ? 'Drafting…' : 'Draft proposal'}
          </button>
        </div>
      ) : (
        <div className="mt-2 space-y-2">
          <div className="rounded-md bg-slate-50 p-2.5">
            <p className="text-sm font-semibold text-slate-900">
              {asText(content.title) || 'Proposal'}
            </p>
            {content.total_amount !== undefined ? (
              <p className="mt-0.5 text-xs text-slate-500">
                Total: {String(content.total_amount)}
              </p>
            ) : null}
            {asText(content.intro) ? (
              <p className="mt-1 line-clamp-3 text-xs text-slate-600">{asText(content.intro)}</p>
            ) : null}
          </div>

          <textarea
            value={instruction}
            onChange={(event) => setInstruction(event.target.value)}
            placeholder="e.g. add a discovery-call line item"
            rows={2}
            className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
          />

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={handleRevise}
              disabled={busy || instruction.trim() === ''}
              className="rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              Revise
            </button>
            <button
              type="button"
              onClick={handleDownload}
              disabled={busy}
              className="rounded-md bg-blue-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              Download
            </button>
            <button
              type="button"
              onClick={handleGenerate}
              disabled={busy}
              className="rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              Start over
            </button>
          </div>
        </div>
      )}

      {error ? <p className="mt-2 text-xs text-red-600">{error}</p> : null}
    </div>
  );
};

export default AiProposalSection;
