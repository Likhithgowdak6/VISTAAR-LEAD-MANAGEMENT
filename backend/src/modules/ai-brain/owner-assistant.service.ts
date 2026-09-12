/**
 * The owner's personal assistant, reachable by texting the agent's own WhatsApp number.
 *
 * He asks "how many people have booked for a birthday party" and gets a real number back. The
 * question goes to ai-brain-service, which decides WHAT to look up; this module runs that lookup
 * against the database it owns and sends the phrased answer back to him.
 *
 * THE ANSWERS ARE GROUNDED BY CONSTRUCTION. ai-brain-service is never given the data and asked to
 * summarise from memory - it picks a lookup from a fixed list and gets back exactly the rows that
 * lookup returned. There is no path from a message he typed to an arbitrary database read: the
 * model chooses which typed filter to apply, never how to query. An invented stage or category is
 * dropped on the way through rather than becoming a silent "0 results", which would read as an
 * answer instead of a mistake.
 *
 * WHAT IT DELIBERATELY WILL NOT SAY. No customer phone numbers. Revealing one is gated on
 * CLIENT_PII_REVEAL and written to an audit log (see RevealPhone), and an assistant that printed
 * one into a chat would route around both - so the projection in listConversationsMatching does
 * not even select the field.
 *
 * It only ever replies to the owner's own number, because that is the only sender
 * handleOwnerApprovalReply is reached for at all. Anyone else's message is a lead's message and
 * never gets here.
 */
import { CONVERSATION_STAGE_VALUES } from '../../constants/conversation-stages.js';
import { logger as defaultLogger } from '../../config/logger.js';
import { type ObjectIdLike } from '../../types/common.js';
import {
  countConversationsMatching as defaultCountConversationsMatching,
  groupConversationCounts as defaultGroupConversationCounts,
  listConversationsMatching as defaultListConversationsMatching,
} from '../conversations/conversation.repository.js';
import { LEAD_SCORE_BANDS } from '../conversations/lead-score.js';
import {
  answerAssistantQuestion as defaultAnswerAssistantQuestion,
  planAssistantAction as defaultPlanAssistantAction,
  type AiBrainAssistantPlan,
} from './ai-brain.client.js';
import { CATEGORY_PLAYBOOKS } from './category-playbooks.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Long enough for "show me the hot leads", short enough to stay one readable WhatsApp message. */
const LIST_LIMIT = 15;

const SCORE_BANDS = Object.values(LEAD_SCORE_BANDS);

/** Every category with a playbook, minus the fallback - `unknown` is a state, not an answer. */
const CATEGORY_KEYS = Object.keys(CATEGORY_PLAYBOOKS).filter((key) => key !== 'unknown');

const GROUP_BY_FIELDS: Record<string, 'stage' | 'aiCategory' | 'leadScoreBand'> = {
  stage: 'stage',
  category: 'aiCategory',
  score_band: 'leadScoreBand',
};

// Narrowed to what this module actually calls, as the other services here do, so a test can pass
// a couple of spies instead of standing up a whole pino instance.
type Logger = { info?: (...args: unknown[]) => void };

export interface OwnerAssistantDeps {
  planAssistantAction?: typeof defaultPlanAssistantAction;
  answerAssistantQuestion?: typeof defaultAnswerAssistantQuestion;
  countConversationsMatching?: typeof defaultCountConversationsMatching;
  listConversationsMatching?: typeof defaultListConversationsMatching;
  groupConversationCounts?: typeof defaultGroupConversationCounts;
  logger?: Logger;
  now?: () => Date;
}

export interface HandleOwnerQuestionParams extends OwnerAssistantDeps {
  organizationId: ObjectIdLike;
  question: string;
  /** The lead the AI has parked, if any. Its presence is what makes an instruction possible. */
  parkedLeadName?: string;
}

export interface OwnerAssistantOutcome {
  /**
   * `answered` - a reply was written. `instruction` - this was an order about the parked lead, so
   * the caller should hand it to the existing instruction path instead of answering it.
   */
  kind: 'answered' | 'instruction';
  message?: string;
}

/** Turns the plan's day counts into the dates the repository filters on. */
const resolveWindow = (plan: AiBrainAssistantPlan, now: Date) => {
  const sinceDays = plan.filters?.since_days;
  const eventWithinDays = plan.filters?.event_within_days;

  return {
    since: sinceDays ? new Date(now.getTime() - sinceDays * MS_PER_DAY) : undefined,
    // Upcoming events only: an event window that reached backwards would answer "who's booked
    // next week" with last month's shoots.
    eventFrom: eventWithinDays ? now : undefined,
    eventTo: eventWithinDays ? new Date(now.getTime() + eventWithinDays * MS_PER_DAY) : undefined,
  };
};

const describeFilters = (plan: AiBrainAssistantPlan): string => {
  const parts: string[] = [];
  const { stages, categories, score_bands: bands, since_days: since } = plan.filters ?? {};

  if (stages?.length) parts.push(`stage: ${stages.join(', ')}`);
  if (categories?.length) parts.push(`service: ${categories.join(', ')}`);
  if (bands?.length) parts.push(`temperature: ${bands.join(', ')}`);
  if (since) parts.push(`arrived in the last ${since} day(s)`);
  if (plan.filters?.event_within_days) {
    parts.push(`event within ${plan.filters.event_within_days} day(s)`);
  }

  return parts.length > 0 ? parts.join('; ') : 'all leads, no filter';
};

const formatDate = (value: unknown): string => {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    return '';
  }

  return value.toISOString().slice(0, 10);
};

/**
 * Renders the rows as the plain text the answering call is allowed to state.
 *
 * Deliberately not JSON: the model reads this as a fact sheet, and a shape it might try to
 * complete is exactly what invites it to fill a gap.
 */
const renderRows = (
  rows: { displayName?: string; stage?: string; aiCategory?: string; leadScore?: number; eventDate?: unknown }[],
  total: number,
): string => {
  if (rows.length === 0) {
    return 'No leads match.';
  }

  const lines = rows.map((row) => {
    const bits = [row.displayName || '(no name)', row.stage || 'no stage'];

    if (row.aiCategory && row.aiCategory !== 'unknown') {
      bits.push(row.aiCategory);
    }

    const eventDate = formatDate(row.eventDate);
    if (eventDate) {
      bits.push(`event ${eventDate}`);
    }

    if (typeof row.leadScore === 'number' && row.leadScore > 0) {
      bits.push(`score ${row.leadScore}`);
    }

    return `- ${bits.join(' · ')}`;
  });

  const truncated = total > rows.length ? `\n(showing ${rows.length} of ${total})` : '';

  return `${lines.join('\n')}${truncated}`;
};

export const handleOwnerQuestion = async ({
  organizationId,
  question,
  parkedLeadName = '',
  planAssistantAction = defaultPlanAssistantAction,
  answerAssistantQuestion = defaultAnswerAssistantQuestion,
  countConversationsMatching = defaultCountConversationsMatching,
  listConversationsMatching = defaultListConversationsMatching,
  groupConversationCounts = defaultGroupConversationCounts,
  logger = defaultLogger,
  now = () => new Date(),
}: HandleOwnerQuestionParams): Promise<OwnerAssistantOutcome> => {
  const plan = await planAssistantAction({
    question,
    stages: CONVERSATION_STAGE_VALUES,
    categories: CATEGORY_KEYS,
    scoreBands: SCORE_BANDS,
    parkedLeadName,
  });

  if (plan.action === 'lead_instruction') {
    // Not this module's job. The caller already has a path for this and it changes a
    // conversation, so it must not be reached by accident from a question.
    return { kind: 'instruction' };
  }

  const at = now();
  const window = resolveWindow(plan, at);
  const filters = {
    organizationId,
    stages: plan.filters?.stages,
    categories: plan.filters?.categories,
    scoreBands: plan.filters?.score_bands,
    ...window,
  };

  // No initial value: every branch below assigns, and a default would be a silent fallback that
  // reached the model as if it were fetched data.
  let data: string;

  if (plan.action === 'count') {
    const count = await countConversationsMatching(filters);
    data = `Matching leads: ${count}\nFilter used: ${describeFilters(plan)}`;
  } else if (plan.action === 'list') {
    const [rows, total] = await Promise.all([
      listConversationsMatching({ ...filters, limit: LIST_LIMIT }),
      countConversationsMatching(filters),
    ]);
    data = `Filter used: ${describeFilters(plan)}\n${renderRows(rows, total)}`;
  } else if (plan.action === 'breakdown') {
    const groupBy = GROUP_BY_FIELDS[plan.group_by] ?? 'stage';
    const groups = await groupConversationCounts({ ...filters, groupBy });
    data =
      groups.length > 0
        ? `Counts by ${plan.group_by || 'stage'}:\n${groups
            .map((group) => `- ${group.key}: ${group.count}`)
            .join('\n')}`
        : 'No leads to group.';
  } else {
    // `chat` - a greeting or something unrelated. Nothing is looked up, and the answering call is
    // told as much so it replies briefly rather than reaching for a number it was not given.
    data = 'No lookup was run for this message - it was not a question about the pipeline.';
  }

  logger?.info?.(
    { action: plan.action, groupBy: plan.group_by || undefined },
    'Owner assistant answered a question.',
  );

  const { message } = await answerAssistantQuestion({
    question,
    restated: plan.restated,
    data,
  });

  return { kind: 'answered', message };
};
