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
}

export interface AiBrainResult {
  status: 'asked' | 'awaiting_approval' | 'escalated' | 'sent' | 'skipped';
  message: string;
  facts: Record<string, unknown>;
  escalation_reason: string;
}

export const sendLeadMessage = (
  conversationId: string,
  params: AiBrainConversationContext & { text?: string | null },
): Promise<AiBrainResult> =>
  request(`/v1/conversations/${conversationId}/lead-message`, {
    text: params.text ?? null,
    category: params.category,
    facts: params.facts,
    required_fields: params.requiredFields,
    catalog_text: params.catalogText,
    knowledge_text: params.knowledgeText,
    rules_text: params.rulesText,
    service_brief: params.serviceBrief,
    style_examples: params.styleExamples,
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
