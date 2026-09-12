/**
 * HTTP client for ai-brain-service - the pulled-out vistaar-agent "brain" (see
 * ai-brain-service/README.md in the project root for the full contract). This is the ONLY file
 * in wam-crm-ai that knows ai-brain-service's URL shape; everything else calls the functions
 * below.
 */
import { env } from '../../config/env.js';

export class AiBrainNotConfiguredError extends Error {
  constructor() {
    super('AI_BRAIN_NOT_CONFIGURED');
    this.name = 'AiBrainNotConfiguredError';
  }
}

export class AiBrainRequestError extends Error {
  readonly statusCode: number;
  readonly body: unknown;

  constructor(message: string, statusCode: number, body: unknown) {
    super(message);
    this.name = 'AiBrainRequestError';
    this.statusCode = statusCode;
    this.body = body;
  }
}

const baseUrl = (): string => {
  if (!env.AI_BRAIN_ENABLED || !env.AI_BRAIN_SERVICE_URL) {
    throw new AiBrainNotConfiguredError();
  }

  return env.AI_BRAIN_SERVICE_URL.replace(/\/+$/, '');
};

const request = async <T>(path: string, body: unknown): Promise<T> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), env.AI_BRAIN_REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${baseUrl()}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(env.AI_BRAIN_SERVICE_KEY ? { 'X-Service-Key': env.AI_BRAIN_SERVICE_KEY } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const text = await response.text();
    const parsed: unknown = text ? JSON.parse(text) : null;

    if (!response.ok) {
      throw new AiBrainRequestError(
        `ai-brain-service returned ${response.status} for ${path}.`,
        response.status,
        parsed,
      );
    }

    return parsed as T;
  } finally {
    clearTimeout(timeout);
  }
};

const requestGet = async <T>(path: string): Promise<T> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), env.AI_BRAIN_REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${baseUrl()}${path}`, {
      method: 'GET',
      headers: env.AI_BRAIN_SERVICE_KEY ? { 'X-Service-Key': env.AI_BRAIN_SERVICE_KEY } : {},
      signal: controller.signal,
    });

    const text = await response.text();
    const parsed: unknown = text ? JSON.parse(text) : null;

    if (!response.ok) {
      throw new AiBrainRequestError(
        `ai-brain-service returned ${response.status} for ${path}.`,
        response.status,
        parsed,
      );
    }

    return parsed as T;
  } finally {
    clearTimeout(timeout);
  }
};

export interface AiBrainConversationContext {
  category: string;
  /**
   * What to call the lead, as WhatsApp reports it. Sent because the brain otherwise has no idea
   * who it is talking to until the lead says so themselves - which made an owner rule like
   * "greet the customer by their name" impossible to follow rather than merely ignored.
   */
  leadName?: string;
  facts: Record<string, unknown>;
  requiredFields: readonly string[];
  catalogText: string;
  knowledgeText: string;
  /** The knowledge base's RULES section, sent apart from the facts so the prompt can frame it
   *  as a constraint rather than as one more thing the AI may mention. */
  rulesText: string;
  /** The one service brief this conversation's category earns. Never all sixteen. */
  serviceBrief: string;
  styleExamples: string;
  /**
   * A live, one-turn-only directive from the owner (e.g. "ask about their budget"), separate
   * from `facts` for the same reason `rulesText` is separate from `knowledgeText`: mixed into
   * facts it would read as trivia about the lead rather than an order to follow. Cleared by
   * ai-brain-service after this one call - see qualify() in nodes.py.
   */
  ownerInstruction?: string;
  /**
   * Every category this repo has a playbook for, so ai-brain-service can classify an organic
   * WhatsApp chat into one. Sent rather than hardcoded over there because category-playbooks.ts
   * is the single source of truth for the list, and a category the brain invented would resolve
   * to the `unknown` fallback anyway.
   */
  categoryOptions?: readonly string[];
}

export interface AiBrainResult {
  status: 'asked' | 'awaiting_approval' | 'escalated' | 'sent' | 'skipped';
  message: string;
  facts: Record<string, unknown>;
  escalation_reason: string;
  /** What the enquiry was classified as, '' while still unknown. Absent from older responses. */
  category?: string;
}

export const sendLeadMessage = (
  conversationId: string,
  params: AiBrainConversationContext & { text?: string | null },
): Promise<AiBrainResult> =>
  request(`/v1/conversations/${conversationId}/lead-message`, {
    text: params.text ?? null,
    category: params.category,
    lead_name: params.leadName ?? '',
    facts: params.facts,
    required_fields: params.requiredFields,
    catalog_text: params.catalogText,
    knowledge_text: params.knowledgeText,
    rules_text: params.rulesText,
    service_brief: params.serviceBrief,
    style_examples: params.styleExamples,
    owner_instruction: params.ownerInstruction ?? '',
    category_options: params.categoryOptions ?? [],
  });

export const sendOwnerDecision = (
  conversationId: string,
  verdict: 'approve' | 'edit' | 'skip',
  instruction = '',
): Promise<AiBrainResult> =>
  request(`/v1/conversations/${conversationId}/owner-decision`, { verdict, instruction });

export const getPending = (conversationId: string): Promise<{ pending: unknown }> =>
  requestGet(`/v1/conversations/${conversationId}/pending`);

export interface AiBrainOutcomeResult {
  decision: 'won' | 'lost' | 'answer' | 'reopen' | 'wait' | 'unclear';
  message: string;
  reasoning: string;
}

export const getOutcome = (
  conversationId: string,
  params: {
    facts: Record<string, unknown>;
    transcript: { role: string; text: string }[];
    knowledgeText?: string;
    styleExamples?: string;
    daysSilent?: number;
    whoSpokeLast?: string;
  },
): Promise<AiBrainOutcomeResult> =>
  request(`/v1/conversations/${conversationId}/outcome`, {
    facts: params.facts,
    transcript: params.transcript,
    knowledge_text: params.knowledgeText ?? '',
    style_examples: params.styleExamples ?? '',
    days_silent: params.daysSilent ?? 0,
    who_spoke_last: params.whoSpokeLast ?? 'unknown',
  });

export interface AiBrainFollowupResult {
  message: string;
}

export const getFollowup = (
  conversationId: string,
  params: {
    facts: Record<string, unknown>;
    transcript: { role: string; text: string }[];
    step: number;
    total: number;
    daysSilent: number;
    knowledgeText?: string;
    styleExamples?: string;
  },
): Promise<AiBrainFollowupResult> =>
  request(`/v1/conversations/${conversationId}/followup`, {
    facts: params.facts,
    transcript: params.transcript,
    step: params.step,
    total: params.total,
    days_silent: params.daysSilent,
    knowledge_text: params.knowledgeText ?? '',
    style_examples: params.styleExamples ?? '',
  });

export interface AiBrainSummaryResult {
  headline: string;
  what_they_asked_for: string;
  where_it_stands: string;
  open_questions: string[];
  suggested_next_step: string;
}

/**
 * The owner's catch-up read of a whole thread. Called on demand only - see
 * conversation-summary.service.ts for the "regenerate when new messages have arrived, serve the
 * stored one otherwise" policy that keeps this off the per-message path and inside the token
 * budget.
 */
export const getSummary = (
  conversationId: string,
  params: {
    facts: Record<string, unknown>;
    transcript: { role: string; text: string }[];
    category?: string;
    knowledgeText?: string;
  },
): Promise<AiBrainSummaryResult> =>
  request(`/v1/conversations/${conversationId}/summary`, {
    facts: params.facts,
    transcript: params.transcript,
    category: params.category ?? 'unknown',
    knowledge_text: params.knowledgeText ?? '',
  });

export interface AiBrainOptimizedKnowledge {
  label: string;
  content: string;
  category: string;
  notes: string;
}

/**
 * Rewrites the owner's rough note into an instruction the agent will follow.
 *
 * `categoryOptions` is sent for the same reason it is sent on every conversation call: this repo
 * owns the list of sections, so the brain classifies into ours rather than inventing one that
 * would fail the API's enum on save.
 *
 * Saves nothing. The result comes back for the owner to approve, because whatever is stored here
 * is read into every future conversation.
 */
export const optimizeKnowledge = (params: {
  rawText: string;
  categoryOptions: readonly string[];
}): Promise<AiBrainOptimizedKnowledge> =>
  request('/v1/knowledge/optimize', {
    raw_text: params.rawText,
    category_options: [...params.categoryOptions],
  });

export type AiBrainAssistantAction = 'count' | 'list' | 'breakdown' | 'lead_instruction' | 'chat';

export interface AiBrainAssistantPlan {
  action: AiBrainAssistantAction;
  restated: string;
  group_by: string;
  filters: {
    stages?: string[];
    categories?: string[];
    score_bands?: string[];
    since_days?: number;
    event_within_days?: number;
  };
}

/**
 * Decides what the owner's WhatsApp message means and what to look up. Answers nothing.
 *
 * The stage/category/band lists are sent for the same reason categoryOptions is on every
 * conversation call: this repo owns them, and a value the model invented would match nothing and
 * turn a real question into a silent zero.
 */
export const planAssistantAction = (params: {
  question: string;
  stages: readonly string[];
  categories: readonly string[];
  scoreBands: readonly string[];
  parkedLeadName?: string;
}): Promise<AiBrainAssistantPlan> =>
  request('/v1/assistant/plan', {
    question: params.question,
    stages: [...params.stages],
    categories: [...params.categories],
    score_bands: [...params.scoreBands],
    parked_lead_name: params.parkedLeadName ?? '',
  });

/** Writes the reply from data this repo has already fetched. That data is all it may state. */
export const answerAssistantQuestion = (params: {
  question: string;
  restated: string;
  data: string;
}): Promise<{ message: string }> =>
  request('/v1/assistant/answer', {
    question: params.question,
    restated: params.restated,
    data: params.data,
  });

export interface AiBrainPriceTemplate {
  title: string;
  body: string;
}

/**
 * Four ways of presenting the owner's prices. Saves nothing, sends nothing.
 *
 * `rejected` carries the bodies he already turned down so a regenerate returns something
 * genuinely different rather than the same four with the sentences moved around.
 */
export const generatePriceTemplates = (params: {
  rawDetails: string;
  rejected?: readonly string[];
}): Promise<{ templates: AiBrainPriceTemplate[] }> =>
  request('/v1/templates/price', {
    raw_details: params.rawDetails,
    rejected: [...(params.rejected ?? [])],
  });

export interface AiBrainProposalContent {
  [key: string]: unknown;
}

export const generateProposal = (params: {
  category: string;
  facts: Record<string, unknown>;
  transcript: { role: string; text: string }[];
  pricingJson: string;
  clientName?: string;
}): Promise<AiBrainProposalContent> =>
  request('/v1/proposals/generate', {
    category: params.category,
    facts: params.facts,
    transcript: params.transcript,
    pricing_json: params.pricingJson,
    client_name: params.clientName ?? '',
  });

export const reviseProposal = (
  content: AiBrainProposalContent,
  instruction: string,
): Promise<AiBrainProposalContent> =>
  request('/v1/proposals/revise', { content, instruction });

export const renderProposal = (params: {
  content: AiBrainProposalContent;
  templateBase64: string;
  version?: number;
}): Promise<{ docx_base64: string; pdf_base64: string | null }> =>
  request('/v1/proposals/render', {
    content: params.content,
    template_base64: params.templateBase64,
    version: params.version ?? 1,
  });
