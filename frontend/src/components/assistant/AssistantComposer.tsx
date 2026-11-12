/**
 * The question box.
 *
 * ENTER SENDS, SHIFT+ENTER ADDS A LINE. The same contract as every messaging surface the owner
 * already uses, including this CRM's own inbox composer — a feature that looks like a chat and
 * does not behave like one is worse than one that looks like a form.
 *
 * The textarea grows with its content up to a cap, so a long question is visible while being
 * typed without the composer swallowing the conversation above it.
 */
import { useEffect, useRef, type FormEvent, type KeyboardEvent } from 'react';

const MAX_HEIGHT_PX = 160;

/** Mirrors the backend's `question` field cap, so the limit is visible before the 400 is. */
export const MAX_QUESTION_LENGTH = 2000;

export interface AssistantComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  busy: boolean;
  placeholder?: string;
}

const AssistantComposer = ({
  value,
  onChange,
  onSubmit,
  busy,
  placeholder = 'Ask about your leads…',
}: AssistantComposerProps) => {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const element = textareaRef.current;

    if (!element) {
      return;
    }

    // Reset before measuring: `scrollHeight` only ever grows while a height is already set, so
    // deleting text would otherwise leave the box permanently tall.
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, MAX_HEIGHT_PX)}px`;
  }, [value]);

  const canSend = value.trim().length > 0 && !busy;

  const submit = (event?: FormEvent) => {
    event?.preventDefault();

    if (canSend) {
      onSubmit();
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <form onSubmit={submit} className="relative">
      <div className="surface flex items-end gap-2 p-2 focus-within:border-blue-400 focus-within:ring-2 focus-within:ring-blue-500/15 dark:focus-within:border-blue-500">
        <textarea
          ref={textareaRef}
          rows={1}
          value={value}
          onChange={(event) => onChange(event.target.value.slice(0, MAX_QUESTION_LENGTH))}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          aria-label="Ask the assistant"
          disabled={busy}
          className="max-h-40 flex-1 resize-none bg-transparent px-2 py-1.5 text-sm text-slate-900 outline-none placeholder:text-slate-400 disabled:opacity-60 dark:text-slate-100 dark:placeholder:text-slate-500"
        />

        <button
          type="submit"
          disabled={!canSend}
          aria-label="Send question"
          className="btn-key flex h-9 w-9 shrink-0 items-center justify-center rounded-xl disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? (
            <svg viewBox="0 0 24 24" aria-hidden="true" className="h-4 w-4 animate-spin" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path strokeLinecap="round" d="M12 3a9 9 0 1 0 9 9" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" aria-hidden="true" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 12h14m0 0-5.5-5.5M19 12l-5.5 5.5" />
            </svg>
          )}
        </button>
      </div>

      <p className="mt-1.5 px-1 text-[0.6875rem] text-slate-400 dark:text-slate-500">
        Enter to send · Shift + Enter for a new line · read-only, it cannot message anyone
      </p>
    </form>
  );
};

export default AssistantComposer;
