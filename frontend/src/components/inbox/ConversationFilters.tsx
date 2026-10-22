import { type AiResponseStatus, type EnquiryClass } from '../../types/analytics';

/**
 * The two derived classifications, as inbox filters.
 *
 * THESE ARE NOT THE SEARCH BOX, and the difference is the whole point of the file. The search
 * input above narrows the fifty rows already in hand and says so on its own label. These run in
 * the database: every match in the org is reachable, including the ones that live past the end
 * of the loaded page. So changing one of these refetches from page one rather than hiding rows.
 *
 * ENQUIRY CLASS AND AI STATUS ARE INDEPENDENT QUESTIONS - "is this a potential customer?" and
 * "does it need a reply right now?" - and a conversation can be a confirmed enquiry that was
 * answered last week and is awaiting a reply today. They are therefore two controls that
 * combine (AND on the server), not one list of mutually exclusive buckets. Needs attention is a
 * third, broader question again and combines with both.
 *
 * The wording below mirrors backend/src/modules/analytics/conversation-classification.ts. Where
 * a label here drifts from the rule there, the label is wrong.
 */

interface FilterOption<Value extends string> {
  value: Value;
  label: string;
  /** The rule, in one sentence, as the tooltip. A bucket without its definition is decoration. */
  definition: string;
}

const ENQUIRY_CLASS_OPTIONS: ReadonlyArray<FilterOption<EnquiryClass>> = [
  {
    value: 'enquiry',
    label: 'Enquiries',
    definition: 'Established as a genuine potential customer.',
  },
  {
    value: 'not_enquiry',
    label: 'Not an enquiry',
    definition: 'Confidently identified as not a customer — a vendor, a bank, a wrong number.',
  },
  {
    value: 'needs_review',
    label: 'Needs review',
    definition:
      'Not enough evidence either way yet. Older threads sit here until a reply settles it.',
  },
];

const AI_STATUS_OPTIONS: ReadonlyArray<FilterOption<AiResponseStatus>> = [
  {
    value: 'ai_replied',
    label: 'AI replied',
    definition: 'A qualifying AI message was delivered, and nothing has come in since.',
  },
  {
    value: 'awaiting_ai_reply',
    label: 'Awaiting AI reply',
    definition: 'An enquiry whose newest inbound message is newer than the last reply sent.',
  },
  {
    value: 'ai_paused',
    label: 'AI paused / owner takeover',
    definition: 'Automation is off for this thread — paused, or a human took it over.',
  },
  {
    value: 'ai_reply_failed',
    label: 'AI reply failed',
    definition: 'The most recent AI send attempt failed and nothing has succeeded after it.',
  },
  {
    value: 'ai_not_needed',
    label: 'AI not needed',
    definition: 'Not a customer, or they asked us to stop. No reply is owed.',
  },
  {
    value: 'needs_review',
    label: 'AI status needs review',
    definition: 'Cannot be established from what is recorded. Older threads land here.',
  },
];

const NEEDS_ATTENTION_DEFINITION =
  'A human should look at this: waiting on us, a failed send, or a follow-up that has come due.';

/** Short forms for the row chip, where a sentence will not fit. */
const ENQUIRY_CHIP_LABELS: Readonly<Record<EnquiryClass, string>> = {
  enquiry: 'Enquiry',
  not_enquiry: 'Not an enquiry',
  needs_review: 'Needs review',
};

const AI_CHIP_LABELS: Readonly<Record<AiResponseStatus, string>> = {
  ai_replied: 'AI replied',
  awaiting_ai_reply: 'Awaiting AI',
  ai_paused: 'AI paused',
  ai_reply_failed: 'AI send failed',
  ai_not_needed: 'No reply owed',
  needs_review: 'AI status unknown',
};

const definitionOf = <Value extends string>(
  options: ReadonlyArray<FilterOption<Value>>,
  value: Value,
): string => options.find((option) => option.value === value)?.definition ?? '';

interface ChipProps {
  /** Undefined where the server did not send the field, which is NOT the same as needs_review. */
  enquiryClass?: EnquiryClass | null;
  aiResponseStatus?: AiResponseStatus | null;
  needsAttention?: boolean | null;
}

/**
 * One row's classification, in one chip.
 *
 * ONE chip, not two, and nothing at all when the fields are absent. A build talking to a server
 * that does not derive these yet must show an empty space rather than "Needs review" — that
 * label is a real answer meaning "we looked and could not tell", and printing it for "we were
 * never told" would invent a backlog of threads to review out of nothing.
 */
export const ConversationClassChip = ({
  enquiryClass,
  aiResponseStatus,
  needsAttention,
}: ChipProps) => {
  const parts: string[] = [];
  const definitions: string[] = [];

  if (enquiryClass && ENQUIRY_CHIP_LABELS[enquiryClass]) {
    parts.push(ENQUIRY_CHIP_LABELS[enquiryClass]);
    definitions.push(definitionOf(ENQUIRY_CLASS_OPTIONS, enquiryClass));
  }

  // "Needs review · Needs review" is the commonest pair on an older thread and says one thing
  // twice, so the second half is dropped when both questions have the same non-answer.
  const repeatsTheClass = aiResponseStatus === 'needs_review' && enquiryClass === 'needs_review';

  if (aiResponseStatus && AI_CHIP_LABELS[aiResponseStatus] && !repeatsTheClass) {
    parts.push(AI_CHIP_LABELS[aiResponseStatus]);
    definitions.push(definitionOf(AI_STATUS_OPTIONS, aiResponseStatus));
  }

  if (parts.length === 0) {
    return null;
  }

  if (needsAttention) {
    definitions.push(NEEDS_ATTENTION_DEFINITION);
  }

  // Key light (warm) for the rows a person has to deal with, fill light (cool) for the ones the
  // machine already handled. The same two-light vocabulary the rest of the app uses.
  let tone = 'chip';

  if (needsAttention) {
    tone = 'chip chip-key';
  } else if (aiResponseStatus === 'ai_replied') {
    tone = 'chip chip-fill';
  }

  return (
    <span className={tone} title={definitions.join(' ')}>
      {parts.join(' · ')}
    </span>
  );
};

type Props = {
  enquiryClass: EnquiryClass | null;
  aiStatus: AiResponseStatus | null;
  needsAttention: boolean;
  onEnquiryClassChange: (value: EnquiryClass | null) => void;
  onAiStatusChange: (value: AiResponseStatus | null) => void;
  onNeedsAttentionChange: (value: boolean) => void;
};

const ConversationFilters = ({
  enquiryClass,
  aiStatus,
  needsAttention,
  onEnquiryClassChange,
  onAiStatusChange,
  onNeedsAttentionChange,
}: Props) => {
  const active = Boolean(enquiryClass) || Boolean(aiStatus) || needsAttention;

  const clearAll = () => {
    onEnquiryClassChange(null);
    onAiStatusChange(null);
    onNeedsAttentionChange(false);
  };

  return (
    // Lives inside whatever the parent decided is visible - on a narrow screen that is the
    // collapsible Filters area, so these two selects cost nothing until they are asked for.
    <div className="space-y-2 border-b border-hairline px-4 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="Filter by enquiry type"
          value={enquiryClass ?? ''}
          onChange={(event) =>
            onEnquiryClassChange((event.target.value || null) as EnquiryClass | null)
          }
          className="min-w-0 flex-1 rounded-lg border border-hairline bg-panel px-2 py-1 text-xs text-bone focus:border-key/50 focus:outline-none"
        >
          <option value="">All enquiry types</option>
          {ENQUIRY_CLASS_OPTIONS.map((option) => (
            <option key={option.value} value={option.value} title={option.definition}>
              {option.label}
            </option>
          ))}
        </select>

        <select
          aria-label="Filter by AI response"
          value={aiStatus ?? ''}
          onChange={(event) =>
            onAiStatusChange((event.target.value || null) as AiResponseStatus | null)
          }
          className="min-w-0 flex-1 rounded-lg border border-hairline bg-panel px-2 py-1 text-xs text-bone focus:border-key/50 focus:outline-none"
        >
          <option value="">Any AI response</option>
          {AI_STATUS_OPTIONS.map((option) => (
            <option key={option.value} value={option.value} title={option.definition}>
              {option.label}
            </option>
          ))}
        </select>

        {/* A third question, not a third value of either select, so it is a toggle beside them. */}
        <button
          type="button"
          aria-pressed={needsAttention}
          title={NEEDS_ATTENTION_DEFINITION}
          onClick={() => onNeedsAttentionChange(!needsAttention)}
          className={`shrink-0 rounded-full border px-3 py-1 font-mono text-[0.625rem] uppercase tracking-[0.08em] transition-colors ${
            needsAttention
              ? 'border-key/40 bg-key/10 text-key'
              : 'border-hairline text-bone-dim hover:border-key/40 hover:text-key'
          }`}
        >
          Needs attention
        </button>
      </div>

      {active ? (
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-1.5">
            {enquiryClass ? (
              <ActiveFilterChip
                label={ENQUIRY_CHIP_LABELS[enquiryClass]}
                removeLabel={`Remove the ${ENQUIRY_CHIP_LABELS[enquiryClass]} filter`}
                onRemove={() => onEnquiryClassChange(null)}
              />
            ) : null}
            {aiStatus ? (
              <ActiveFilterChip
                label={AI_CHIP_LABELS[aiStatus]}
                removeLabel={`Remove the ${AI_CHIP_LABELS[aiStatus]} filter`}
                onRemove={() => onAiStatusChange(null)}
              />
            ) : null}
            {needsAttention ? (
              <ActiveFilterChip
                label="Needs attention"
                removeLabel="Remove the Needs attention filter"
                onRemove={() => onNeedsAttentionChange(false)}
              />
            ) : null}
            <button
              type="button"
              onClick={clearAll}
              className="text-xs font-medium text-key hover:text-key-soft"
            >
              Clear classification filters
            </button>
          </div>
          {/* Said out loud because the search box two rows up does the opposite, and someone who
              has just used it will reasonably assume these behave the same way. */}
          <p className="text-[0.6875rem] leading-snug text-muted">
            Searches the whole inbox on the server, not only the loaded rows.
          </p>
        </div>
      ) : null}
    </div>
  );
};

const ActiveFilterChip = ({
  label,
  removeLabel,
  onRemove,
}: {
  label: string;
  removeLabel: string;
  onRemove: () => void;
}) => (
  <span className="chip chip-key">
    {label}
    <button type="button" aria-label={removeLabel} onClick={onRemove} className="hover:text-bone">
      ×
    </button>
  </span>
);

export default ConversationFilters;
