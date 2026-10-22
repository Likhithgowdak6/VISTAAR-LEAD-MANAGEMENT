/**
 * The eight headline numbers, each one a door into the inbox.
 *
 * WHY SOME CARDS ARE NOT CLICKABLE. A drill-down is a promise that the inbox will show you the
 * conversations behind the number. Two of these cannot keep it: "unique contacts" counts
 * distinct contacts, not conversations, so the list it opened would be longer than the figure
 * clicked; and a rate is a ratio, not a set. Rather than wire them to an approximate filter and
 * let the owner discover the mismatch by counting rows, they are rendered as plain cards and
 * their tooltip says why. A drill-down that lies once is never trusted again.
 */
import type { AnalyticsOverview, DefinedCount, DefinedRate } from '../../types/analytics';

import { countValue, formatCount, formatRate, formatWorking } from './AnalyticsFormat';
import { DefinitionTip, StatValue } from './AnalyticsPrimitives';

export type DrillFilters = {
  enquiryClass?: string;
  aiStatus?: string;
  needsAttention?: boolean;
};

type Props = {
  overview: AnalyticsOverview | null;
  onDrillDown?: (filters: DrillFilters) => void;
};

const KpiCard = ({
  label,
  value,
  definition,
  working,
  onDrill,
}: {
  label: string;
  value: string;
  definition: string;
  /** The numerator/denominator behind a rate. Absent on plain counts. */
  working?: string;
  onDrill?: () => void;
}) => {
  const inner = (
    <>
      <span className="font-mono text-[0.6875rem] uppercase tracking-[0.06em] text-muted">
        {label}
      </span>
      <StatValue text={value} className="mt-1 block" />
      {working ? (
        <span className="mt-0.5 block font-mono text-[0.6875rem] text-bone-dim">{working}</span>
      ) : null}
    </>
  );

  return (
    <div
      data-metric={label}
      className="grid grid-cols-[1fr_auto] items-start gap-2 rounded-[var(--m-radius-card)] border border-hairline bg-panel p-3"
    >
      {onDrill ? (
        <button
          type="button"
          onClick={onDrill}
          className="min-h-11 text-left transition-colors hover:text-key"
        >
          {inner}
          <span className="mt-1 block font-mono text-[0.625rem] uppercase tracking-[0.06em] text-muted">
            Open in inbox →
          </span>
        </button>
      ) : (
        <div className="min-h-11 text-left">{inner}</div>
      )}

      <DefinitionTip text={definition} label={label} />
    </div>
  );
};

/** Reads a count card off the overview without ever inventing a value for a missing field. */
const countCard = (
  label: string,
  count: DefinedCount | undefined,
  fallbackDefinition: string,
  onDrill?: () => void,
) => ({
  label,
  value: formatCount(countValue(count)),
  definition: count?.definition ?? fallbackDefinition,
  onDrill,
});

const rateCard = (label: string, rate: DefinedRate | undefined, fallbackDefinition: string) => ({
  label,
  value: formatRate(rate),
  working: formatWorking(rate),
  definition: rate?.definition ?? fallbackDefinition,
});

const KpiGrid = ({ overview, onDrillDown }: Props) => {
  const cards = [
    countCard(
      'Conversations',
      overview?.totalConversations,
      'Conversations in the selected range. Definition not supplied by the server.',
      // No filter: the inbox's unfiltered list IS this set.
      onDrillDown ? () => onDrillDown({}) : undefined,
    ),
    countCard(
      'Unique contacts',
      overview?.uniqueContacts,
      'Distinct contacts behind those conversations. The same person on two numbers counts twice, because a contact is unique per phone number.',
    ),
    countCard(
      'Enquiries',
      overview?.enquiries,
      'Conversations classified as a genuine potential customer.',
      onDrillDown ? () => onDrillDown({ enquiryClass: 'enquiry' }) : undefined,
    ),
    countCard(
      'Not enquiries',
      overview?.notEnquiries,
      'Conversations confidently identified as not a customer.',
      onDrillDown ? () => onDrillDown({ enquiryClass: 'not_enquiry' }) : undefined,
    ),
    countCard(
      'Needs review',
      overview?.needsReview,
      'Conversations with too little evidence to classify either way.',
      onDrillDown ? () => onDrillDown({ enquiryClass: 'needs_review' }) : undefined,
    ),
    rateCard(
      'Enquiry rate',
      overview?.enquiryRate,
      'Enquiries as a share of conversations. Blank when nothing was counted.',
    ),
    countCard(
      'Awaiting AI reply',
      overview?.awaitingAiReply,
      'Enquiries whose newest inbound message is newer than the last successful AI reply.',
      onDrillDown ? () => onDrillDown({ aiStatus: 'awaiting_ai_reply' }) : undefined,
    ),
    countCard(
      'Needs attention',
      overview?.needsAttention,
      'Conversations the owner is expected to look at, as of now.',
      onDrillDown ? () => onDrillDown({ needsAttention: true }) : undefined,
    ),
  ];

  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
      {cards.map((card) => (
        <KpiCard key={card.label} {...card} />
      ))}
    </div>
  );
};

export default KpiGrid;
