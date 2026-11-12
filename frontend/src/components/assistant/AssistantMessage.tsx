/**
 * One turn in the assistant conversation.
 *
 * THE TWO SIDES LOOK DELIBERATELY DIFFERENT. The owner's question is a compact right-aligned
 * chip; the assistant's answer is a full-width panel. That asymmetry is not decoration — the
 * answers contain lead names, scores and quoted customer messages, and a transcript where both
 * sides look alike is one where a glance cannot tell what the business said from what the
 * assistant inferred.
 */
import { type ReactNode } from 'react';

import { type AssistantStep } from '../../api/endpoints';
import AssistantSteps from './AssistantSteps';

export interface AssistantMessageProps {
  role: 'user' | 'assistant';
  content: string;
  steps?: AssistantStep[];
  stoppedEarly?: boolean;
  usedHistory?: boolean;
}

/**
 * A SAFE SUBSET OF MARKDOWN, built as React elements — never `dangerouslySetInnerHTML`.
 *
 * The model writes markdown whether or not it is asked to: `**bold**`, bullet lists, and pipe
 * tables for anything comparative. The first version of this component rendered the text
 * verbatim, which was safe but looked broken — real answers came out reading
 * `**Ananya Reddy is hot (score 92)**`. Browser testing found that; the component tests did
 * not, because they asserted on text content, which matched either way.
 *
 * The answer is derived from attacker-controllable WhatsApp messages, so the escaping rule is
 * absolute: every fragment below becomes a React child, which React escapes. An HTML-injecting
 * markdown library here would turn a customer's message into a script tag.
 */
const BOLD = /\*\*(.+?)\*\*/g;

/** `**bold**` → <strong>, everything else left as escaped text. */
const inline = (text: string, keyPrefix: string) => {
  const parts: ReactNode[] = [];
  let lastIndex = 0;

  for (const match of text.matchAll(BOLD)) {
    const start = match.index ?? 0;

    if (start > lastIndex) {
      parts.push(text.slice(lastIndex, start));
    }

    parts.push(
      <strong key={`${keyPrefix}-b-${start}`} className="font-semibold text-slate-900 dark:text-slate-50">
        {match[1]}
      </strong>,
    );
    lastIndex = start + match[0].length;
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return parts.length > 0 ? parts : [text];
};

const isTableRow = (line: string) => line.startsWith('|') && line.endsWith('|');
const isTableDivider = (line: string) => /^\|[\s:|-]+\|$/.test(line);

const cells = (line: string) =>
  line.slice(1, -1).split('|').map((cell) => cell.trim());

const renderTable = (lines: string[], blockIndex: number) => {
  const [header, ...rest] = lines;
  const body = rest.filter((line) => !isTableDivider(line));

  return (
    <div key={blockIndex} className="overflow-x-auto">
      <table className="w-full border-collapse text-left text-xs">
        <thead>
          <tr className="border-b border-slate-200 dark:border-slate-700">
            {cells(header).map((cell, index) => (
              <th key={index} className="px-2 py-1.5 font-semibold text-slate-700 dark:text-slate-200">
                {inline(cell, `h${index}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((line, rowIndex) => (
            <tr key={rowIndex} className="border-b border-slate-100 last:border-0 dark:border-slate-800">
              {cells(line).map((cell, cellIndex) => (
                <td key={cellIndex} className="px-2 py-1.5 align-top">
                  {inline(cell, `r${rowIndex}c${cellIndex}`)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

const renderBody = (content: string) =>
  content
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block, blockIndex) => {
      const lines = block.split('\n').map((line) => line.trim()).filter(Boolean);

      // A table needs a header and at least one more row, or a stray pipe in prose becomes a
      // one-column table.
      if (lines.length >= 2 && lines.every(isTableRow)) {
        return renderTable(lines, blockIndex);
      }

      const isList = lines.length > 0 && lines.every((line) => /^[-*•]\s+/.test(line));

      if (isList) {
        return (
          <ul key={blockIndex} className="ml-1 list-none space-y-1.5">
            {lines.map((line, lineIndex) => (
              <li key={lineIndex} className="flex gap-2.5">
                <span
                  aria-hidden="true"
                  className="mt-[0.55rem] h-1.5 w-1.5 shrink-0 rounded-full bg-blue-500/70 dark:bg-blue-400/70"
                />
                <span>{inline(line.replace(/^[-*•]\s+/, ''), `l${blockIndex}-${lineIndex}`)}</span>
              </li>
            ))}
          </ul>
        );
      }

      return (
        <p key={blockIndex} className="whitespace-pre-wrap">
          {inline(block, `p${blockIndex}`)}
        </p>
      );
    });

const AssistantMessage = ({
  role,
  content,
  steps,
  stoppedEarly,
  usedHistory,
}: AssistantMessageProps) => {
  if (role === 'user') {
    return (
      <div className="flex justify-end">
        <div
          data-testid="assistant-question"
          className="max-w-[85%] rounded-2xl rounded-br-md bg-slate-900 px-4 py-2.5 text-sm font-medium text-white shadow-sm dark:bg-slate-700"
        >
          {content}
        </div>
      </div>
    );
  }

  return (
    <div data-testid="assistant-answer" className="flex gap-3">
      <div
        aria-hidden="true"
        className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-blue-600 to-sky-500 text-white shadow-[0_2px_10px_-2px_rgba(37,99,235,0.5)]"
      >
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v2m0 14v2m9-9h-2M5 12H3m14.7-6.7-1.4 1.4M7.7 16.3l-1.4 1.4m0-11.4 1.4 1.4m8.6 8.6 1.4 1.4" />
          <circle cx="12" cy="12" r="3.5" />
        </svg>
      </div>

      <div className="min-w-0 flex-1 space-y-3">
        <div className="space-y-3 text-sm leading-relaxed text-slate-700 dark:text-slate-200">
          {renderBody(content)}
        </div>

        {stoppedEarly ? (
          <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
            This answer stopped at the step limit, so it may be incomplete.
          </p>
        ) : null}

        {steps && steps.length > 0 ? (
          <AssistantSteps steps={steps} usedHistory={usedHistory} />
        ) : null}
      </div>
    </div>
  );
};

export default AssistantMessage;
