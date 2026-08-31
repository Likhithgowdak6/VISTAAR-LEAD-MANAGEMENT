/**
 * Builds the "business context" ai-brain-service needs on every call. ai-brain-service has no
 * database of its own to look this up in - it's a thinking service, not a data owner - so
 * wam-crm-ai (the one real source of truth) assembles it fresh each time from AI Knowledge.
 *
 * The knowledge base has four client-facing sections and this is where three of them stop being
 * interchangeable text and start meaning different things to the model:
 *
 *   COMPANY, SERVICES  ->  knowledgeText - "what you KNOW about this business", stated freely.
 *   PRICING            ->  catalogText   - the authoritative money, quoted verbatim or not at all.
 *   RULES              ->  rulesText     - CONSTRAINTS, and this is why they are separate.
 *
 * A prohibition dropped into a list of facts reads as trivia. "Never promise availability" next
 * to "we have been shooting in Bangalore since 2016" is one more thing the model may mention,
 * not a line it may not cross - so the rules get their own interpolation point in
 * ai-brain-service's QUALIFY_SYSTEM and DRAFT_SYSTEM, placed with the objection handling and
 * framed as inviolable. Empty is not an option either: DEFAULT_AI_RULES is what a fresh install
 * is bound by before anyone has typed anything.
 *
 * The older POLICY / PRODUCT / FAQ / OTHER categories still read as general knowledge, exactly
 * as they always did - rows written under them keep working untouched.
 *
 * ONLY ACTIVE ROWS REACH THE MODEL. Archiving is how a business retires a fact, and a retired
 * price or a rescinded rule must stop binding the AI the moment it is archived.
 */
import {
  AI_KNOWLEDGE_CATEGORIES,
  type AiKnowledgeCategory,
} from '../../constants/ai-knowledge-statuses.js';
import { DEFAULT_AI_RULES } from '../../constants/ai-knowledge-defaults.js';
import { type ObjectIdLike } from '../../types/common.js';
import { findActiveKnowledgeForOrganization } from '../ai-knowledge/ai-knowledge.repository.js';
import { requiredFieldsForCategory, serviceBriefForCategory } from './category-playbooks.js';

const NO_CATALOG = '(no plans configured - do not quote any price)';
const NO_KNOWLEDGE = '(no knowledge base yet - do not state facts you were not given)';
const NO_STYLE = '(none saved - use your own judgement)';

const joinKnowledge = (items: { label: string; content: string }[]): string =>
  items.map((item) => `- ${item.label}: ${item.content}`).join('\n');

/** The seven defaults, rendered exactly like saved rows so the prompt cannot tell them apart. */
const DEFAULT_RULES_TEXT = joinKnowledge(
  DEFAULT_AI_RULES.map((rule) => ({ label: rule.label, content: rule.content })),
);

export interface AiBrainBusinessContext {
  requiredFields: readonly string[];
  catalogText: string;
  knowledgeText: string;
  /** The hard constraints, kept out of `knowledgeText` on purpose. Never empty. */
  rulesText: string;
  /** How THIS service differs, and only this one - see category-playbooks.ts on why not all 16. */
  serviceBrief: string;
  styleExamples: string;
}

export const buildAiBrainContext = async ({
  organizationId,
  category,
}: {
  organizationId: ObjectIdLike;
  category: string;
}): Promise<AiBrainBusinessContext> => {
  const knowledge = await findActiveKnowledgeForOrganization({ organizationId });

  const inSection = (section: AiKnowledgeCategory) =>
    knowledge.filter((item) => item.category === section);

  const pricing = inSection(AI_KNOWLEDGE_CATEGORIES.PRICING);
  const rules = inSection(AI_KNOWLEDGE_CATEGORIES.RULES);
  const general = knowledge.filter(
    (item) =>
      item.category !== AI_KNOWLEDGE_CATEGORIES.PRICING &&
      item.category !== AI_KNOWLEDGE_CATEGORIES.RULES,
  );

  return {
    requiredFields: requiredFieldsForCategory(category),
    serviceBrief: serviceBriefForCategory(category),
    catalogText: pricing.length > 0 ? joinKnowledge(pricing) : NO_CATALOG,
    knowledgeText: general.length > 0 ? joinKnowledge(general) : NO_KNOWLEDGE,
    // A business that has written its own rules is bound by exactly those; one that has not is
    // bound by the seven defaults rather than by nothing at all.
    rulesText: rules.length > 0 ? joinKnowledge(rules) : DEFAULT_RULES_TEXT,
    // wam-crm-ai has no "saved reply examples" store yet (vistaar-agent's Template model had
    // no equivalent here) - a fixed placeholder until that's built, same as vistaar-agent used
    // when a category had none saved.
    styleExamples: NO_STYLE,
  };
};
