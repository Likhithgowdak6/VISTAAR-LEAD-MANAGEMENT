import { type AccountRemoval, type AccountRemovalReferences } from '../types';

const plural = (count: number, noun: string): string =>
  `${count} ${noun}${count === 1 ? '' : 's'}`;

/** "47 conversations, 912 messages and 1 lead source" - only the parts that are actually there. */
export const describeAccountReferences = (references: AccountRemovalReferences): string => {
  const parts = [
    references.conversations > 0 ? plural(references.conversations, 'conversation') : null,
    references.messages > 0 ? plural(references.messages, 'message') : null,
    references.leadSources > 0 ? plural(references.leadSources, 'lead source') : null,
  ].filter((part): part is string => part !== null);

  if (parts.length === 0) {
    return 'history attached to it';
  }

  if (parts.length === 1) {
    return parts[0]!;
  }

  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]!}`;
};

/**
 * Says which of the two things Remove actually did. An admin should never have to guess whether
 * the number is gone for good or merely out of sight.
 */
export const describeAccountRemoval = (removal: AccountRemoval): string => {
  const name = removal.account?.name ?? 'That number';

  if (removal.outcome === 'deleted') {
    return `${name} was deleted permanently. It had no conversations, messages or lead sources, so its stored WhatsApp login was cleared with it.`;
  }

  return `${name} was disconnected and hidden from this list, because it still has ${describeAccountReferences(removal.references)}. That history stays in the inbox, so nothing is orphaned.`;
};
