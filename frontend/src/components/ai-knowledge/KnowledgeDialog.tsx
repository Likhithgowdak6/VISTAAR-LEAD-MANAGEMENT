import { type FormEvent, useEffect, useRef, useState } from 'react';

import { createAiKnowledge, optimizeAiKnowledge } from '../../api/endpoints';
import { useAuth } from '../../auth/AuthContext';
import { AI_KNOWLEDGE_CATEGORIES, AI_KNOWLEDGE_CATEGORY_HINTS } from '../../lib/ai-knowledge';
import { type AiKnowledgeCategory } from '../../types';
import { type AuthValue, errorMessage } from '../types';

/**
 * How the owner programs the agent.
 *
 * He types the way he speaks - "always greet the customer when u r chating with a new customer" -
 * and that is deliberately all this asks for. The old form wanted a label, a fact and a category
 * up front, which is three decisions about filing before he has said the one thing he wanted to
 * say, and it is why the knowledge base sat empty.
 *
 * So: one box, then an optional AI pass that turns the note into an instruction a model follows
 * consistently and proposes where to file it. The rewrite always comes back for approval and is
 * fully editable - whatever is saved here is read into every future conversation, so a rewrite
 * nobody looked at would be an unapproved change to how the agent behaves.
 *
 * Saving the raw note without optimizing stays a first-class path. It is what makes the AI pass
 * an offer rather than a toll, and it is the fallback when the brain service is off.
 */

type Phase = 'writing' | 'reviewing';

type Props = {
  onClose: () => void;
  onSaved: () => void;
};

const EXAMPLE = 'always greet the customer when u r chatting with a new customer';

const KnowledgeDialog = ({ onClose, onSaved }: Props) => {
  const { authedRequest } = useAuth() as AuthValue;
  const noteRef = useRef<HTMLTextAreaElement>(null);

  const [phase, setPhase] = useState<Phase>('writing');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<'optimize' | 'save' | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The reviewed entry. Seeded by the optimize pass, then owned by the owner.
  const [label, setLabel] = useState('');
  const [content, setContent] = useState('');
  const [category, setCategory] = useState<AiKnowledgeCategory>('rules');
  const [notes, setNotes] = useState('');

  /**
   * Filing is the AI's job, not the owner's - he should be saying what he wants, not learning
   * what the sections mean. So the category arrives decided and is shown as a fact; the picker
   * only appears if he asks for it. It stays reachable because the AI can be wrong and he is
   * the one who knows which of these is a hard limit.
   */
  const [categoryOpen, setCategoryOpen] = useState(false);

  useEffect(() => {
    noteRef.current?.focus();
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

  const handleOptimize = async () => {
    if (busy || note.trim() === '') {
      return;
    }

    setBusy('optimize');
    setError(null);

    try {
      const payload = await authedRequest((token) =>
        optimizeAiKnowledge({ token, rawText: note.trim() }),
      );
      const draft = payload.data;

      // Falls back to his own words rather than to empty fields: a thin response should cost him
      // nothing he has already typed.
      setLabel(draft?.label ?? note.trim().slice(0, 60));
      setContent(draft?.content ?? note.trim());
      setCategory(draft?.category ?? 'rules');
      setNotes(draft?.notes ?? '');
      // A fresh classification is presented as decided again, even if he opened the picker last time.
      setCategoryOpen(false);
      setPhase('reviewing');
    } catch (optimizeError: unknown) {
      setError(
        errorMessage(
          optimizeError,
          'Could not rewrite that note. You can still save it as you wrote it.',
        ),
      );
    } finally {
      setBusy(null);
    }
  };

  /**
   * Skips the rewrite entirely. Nothing classifies the note on this path, so it is filed as a
   * rule: most of what an owner types here is behavioural, and `rules` is the safe wrong answer -
   * treated as more binding than it needed to be, rather than as ignorable trivia.
   */
  const handleSaveRaw = () => {
    const trimmed = note.trim();
    if (trimmed === '') {
      return;
    }

    setLabel(trimmed.slice(0, 60));
    setContent(trimmed);
    setCategory('rules');
    setNotes('');
    setCategoryOpen(false);
    setError(null);
    setPhase('reviewing');
  };

  const handleSave = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || label.trim() === '' || content.trim() === '') {
      return;
    }

    setBusy('save');
    setError(null);

    try {
      await authedRequest((token) =>
        createAiKnowledge({
          token,
          label: label.trim(),
          content: content.trim(),
          category,
        }),
      );
      onSaved();
      onClose();
    } catch (saveError: unknown) {
      setError(errorMessage(saveError, 'Unable to save this.'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink/80 p-4 backdrop-blur-sm sm:items-center"
      // Clicking the backdrop dismisses; clicks inside the panel must not, hence the stopPropagation.
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Tell the AI what to do"
        onClick={(event) => event.stopPropagation()}
        className="surface glow-key w-full max-w-xl rounded-xl p-5"
      >
        {phase === 'writing' ? (
          <>
            <h2 className="eyebrow">Tell the AI what to do</h2>
            <p className="mt-2 text-sm text-bone-dim">
              Write it however you would say it. The agent reads everything saved here before every
              reply.
            </p>

            <label htmlFor="knowledge-note" className="mt-4 mb-1 block text-xs font-medium text-slate-600">
              Your instruction
            </label>
            <textarea
              id="knowledge-note"
              ref={noteRef}
              rows={4}
              placeholder={EXAMPLE}
              value={note}
              onChange={(event) => setNote(event.target.value)}
              className="w-full resize-none rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none"
            />

            {error ? (
              <p role="alert" className="mt-2 text-xs text-red-600">
                {error}
              </p>
            ) : null}

            <div className="mt-4 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={handleOptimize}
                disabled={busy !== null || note.trim() === ''}
                className="btn-key rounded-lg px-4 py-2 text-sm disabled:opacity-50"
              >
                {busy === 'optimize' ? 'Optimizing…' : '✦ Optimize the prompt'}
              </button>
              <button
                type="button"
                onClick={handleSaveRaw}
                disabled={busy !== null || note.trim() === ''}
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                Use my words
              </button>
              <button
                type="button"
                onClick={onClose}
                className="ml-auto font-mono text-[0.6875rem] uppercase tracking-[0.1em] text-muted hover:text-bone"
              >
                Cancel
              </button>
            </div>
          </>
        ) : (
          <form onSubmit={handleSave} aria-label="Review this instruction">
            <h2 className="eyebrow">Review before saving</h2>
            <p className="mt-2 text-sm text-bone-dim">
              Edit anything here. This is what the agent will read.
            </p>

            {/* What the model changed and what it could not resolve. Shown because the owner is
                approving a rewrite of his own words and deserves to know what moved. */}
            {notes ? (
              <p className="chip chip-fill mt-3 inline-block text-xs">{notes}</p>
            ) : null}

            <div className="mt-4 space-y-3">
              <div>
                <label
                  htmlFor="knowledge-review-label"
                  className="mb-1 block text-xs font-medium text-slate-600"
                >
                  Label
                </label>
                <input
                  id="knowledge-review-label"
                  required
                  value={label}
                  onChange={(event) => setLabel(event.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none"
                />
              </div>

              <div>
                <label
                  htmlFor="knowledge-review-content"
                  className="mb-1 block text-xs font-medium text-slate-600"
                >
                  Fact or instruction
                </label>
                <textarea
                  id="knowledge-review-content"
                  required
                  rows={4}
                  value={content}
                  onChange={(event) => setContent(event.target.value)}
                  className="w-full resize-none rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none"
                />
              </div>

              <div>
                {categoryOpen ? (
                  <>
                    <label
                      htmlFor="knowledge-review-category"
                      className="mb-1 block text-xs font-medium text-slate-600"
                    >
                      Category
                    </label>
                    <select
                      id="knowledge-review-category"
                      value={category}
                      onChange={(event) => setCategory(event.target.value as AiKnowledgeCategory)}
                      className="w-full max-w-xs rounded-lg border border-slate-300 px-3 py-2 text-sm capitalize text-slate-900 focus:border-blue-500 focus:outline-none"
                    >
                      {AI_KNOWLEDGE_CATEGORIES.map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </select>
                  </>
                ) : (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-medium text-slate-600">Filed under</span>
                    <span className="chip chip-fill text-xs capitalize">{category}</span>
                    <button
                      type="button"
                      onClick={() => setCategoryOpen(true)}
                      className="font-mono text-[0.6875rem] uppercase tracking-[0.1em] text-muted transition-colors hover:text-key"
                    >
                      Change
                    </button>
                  </div>
                )}
                <p className="mt-1 text-xs text-slate-500">
                  {AI_KNOWLEDGE_CATEGORY_HINTS[category]}
                </p>
              </div>
            </div>

            {error ? (
              <p role="alert" className="mt-2 text-xs text-red-600">
                {error}
              </p>
            ) : null}

            <div className="mt-4 flex flex-wrap items-center gap-2">
              <button
                type="submit"
                disabled={busy !== null || label.trim() === '' || content.trim() === ''}
                className="btn-key rounded-lg px-4 py-2 text-sm disabled:opacity-50"
              >
                {busy === 'save' ? 'Saving…' : 'Save'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setPhase('writing');
                  setError(null);
                }}
                disabled={busy !== null}
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                Back to my note
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
};

export default KnowledgeDialog;
