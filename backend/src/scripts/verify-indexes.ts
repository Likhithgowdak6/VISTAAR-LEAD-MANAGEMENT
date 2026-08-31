import { type IndexDefinition, type IndexDirection, type Model } from 'mongoose';

import { connectDatabase, disconnectDatabase } from '../config/database.js';
import { ActivityLog } from '../modules/activity/activity-log.model.js';
import { Contact } from '../modules/contacts/contact.model.js';
import { Conversation } from '../modules/conversations/conversation.model.js';
import { FollowUpTask } from '../modules/followups/followup-task.model.js';
import { IdempotencyRecord } from '../modules/idempotency/idempotency-record.model.js';
import { Message } from '../modules/messages/message.model.js';
import { Note } from '../modules/notes/note.model.js';
import { Tag } from '../modules/tags/tag.model.js';
import { WhatsAppAccount } from '../modules/whatsapp-accounts/whatsapp-account.model.js';
import { WhatsAppAuthState } from '../modules/whatsapp-auth-states/whatsapp-auth-state.model.js';

type IndexKeys = Record<string, IndexDirection | string | number>;

interface ExpectedIndex {
  keys: IndexKeys;
  options?: Record<string, unknown>;
}

interface ModelIndexRequirement {
  model: Model<unknown>;
  name: string;
  indexes: ExpectedIndex[];
}

const requiredIndexes: ModelIndexRequirement[] = [
  {
    model: WhatsAppAccount as Model<unknown>,
    name: 'WhatsAppAccount',
    indexes: [
      { keys: { organizationId: 1, status: 1 } },
      { keys: { organizationId: 1, name: 1 } },
      { keys: { organizationId: 1, brandKey: 1 } },
    ],
  },
  {
    model: Contact as Model<unknown>,
    name: 'Contact',
    indexes: [
      { keys: { organizationId: 1, leadId: 1 }, options: { unique: true } },
      { keys: { organizationId: 1, displayName: 1 } },
      { keys: { organizationId: 1, providerContactKey: 1 }, options: { unique: true } },
    ],
  },
  {
    model: Conversation as Model<unknown>,
    name: 'Conversation',
    indexes: [
      {
        keys: { organizationId: 1, whatsappAccountId: 1, contactId: 1 },
        options: { unique: true },
      },
      { keys: { organizationId: 1, whatsappAccountId: 1, updatedAt: -1 } },
      { keys: { organizationId: 1, assignedTo: 1, updatedAt: -1 } },
      { keys: { organizationId: 1, stage: 1, updatedAt: -1 } },
      { keys: { organizationId: 1, tags: 1, updatedAt: -1 } },
      { keys: { organizationId: 1, nextFollowUpAt: 1 } },
    ],
  },
  {
    model: Message as Model<unknown>,
    name: 'Message',
    indexes: [
      {
        keys: { organizationId: 1, whatsappAccountId: 1, providerMessageId: 1 },
        options: { unique: true },
      },
      { keys: { organizationId: 1, conversationId: 1, sentAt: -1, _id: -1 } },
      {
        keys: { organizationId: 1, whatsappAccountId: 1, idempotencyKey: 1 },
        options: { unique: true },
      },
      { keys: { organizationId: 1, status: 1, createdAt: -1 } },
    ],
  },
  {
    model: Tag as Model<unknown>,
    name: 'Tag',
    indexes: [
      { keys: { organizationId: 1, whatsappAccountId: 1, slug: 1 }, options: { unique: true } },
      { keys: { organizationId: 1, status: 1, name: 1 } },
    ],
  },
  {
    model: Note as Model<unknown>,
    name: 'Note',
    indexes: [
      { keys: { organizationId: 1, conversationId: 1, createdAt: -1 } },
      { keys: { organizationId: 1, visibility: 1, createdAt: -1 } },
    ],
  },
  {
    model: FollowUpTask as Model<unknown>,
    name: 'FollowUpTask',
    indexes: [
      { keys: { organizationId: 1, assignedTo: 1, status: 1, dueAt: 1 } },
      { keys: { organizationId: 1, conversationId: 1, status: 1, dueAt: 1 } },
      { keys: { organizationId: 1, whatsappAccountId: 1, status: 1, dueAt: 1 } },
    ],
  },
  {
    model: ActivityLog as Model<unknown>,
    name: 'ActivityLog',
    indexes: [
      { keys: { organizationId: 1, conversationId: 1, createdAt: -1 } },
      { keys: { organizationId: 1, whatsappAccountId: 1, createdAt: -1 } },
      { keys: { organizationId: 1, actorId: 1, createdAt: -1 } },
    ],
  },
  {
    model: IdempotencyRecord as Model<unknown>,
    name: 'IdempotencyRecord',
    indexes: [
      { keys: { organizationId: 1, scope: 1, key: 1 }, options: { unique: true } },
      { keys: { expiresAt: 1 }, options: { expireAfterSeconds: 0 } },
    ],
  },
  {
    model: WhatsAppAuthState as Model<unknown>,
    name: 'WhatsAppAuthState',
    indexes: [
      {
        keys: { organizationId: 1, whatsappAccountId: 1, namespace: 1, keyId: 1 },
        options: { unique: true },
      },
      { keys: { organizationId: 1, whatsappAccountId: 1, status: 1 } },
    ],
  },
];

const hasSchemaIndex = (
  model: Model<unknown>,
  expectedKeys: IndexKeys,
  expectedOptions: Record<string, unknown> = {},
): boolean =>
  model.schema.indexes().some(([keys, options]: [IndexDefinition, Record<string, unknown>]) => {
    const keysMatch = JSON.stringify(keys) === JSON.stringify(expectedKeys);

    if (!keysMatch) {
      return false;
    }

    return Object.entries(expectedOptions).every(
      ([optionName, optionValue]) => options[optionName] === optionValue,
    );
  });

interface IndexFailure {
  model: string;
  keys: IndexKeys;
  options: Record<string, unknown>;
}

const verifySchemaIndexes = (): IndexFailure[] => {
  const failures: IndexFailure[] = [];

  for (const modelRequirement of requiredIndexes) {
    for (const indexRequirement of modelRequirement.indexes) {
      const found = hasSchemaIndex(
        modelRequirement.model,
        indexRequirement.keys,
        indexRequirement.options ?? {},
      );

      if (!found) {
        failures.push({
          model: modelRequirement.name,
          keys: indexRequirement.keys,
          options: indexRequirement.options ?? {},
        });
      }
    }
  }

  return failures;
};

const run = async (): Promise<void> => {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Index verification must not run in production.');
  }

  const failures = verifySchemaIndexes();

  if (failures.length > 0) {
    console.error('Phase 4 index verification failed.');
    console.error(JSON.stringify(failures, null, 2));
    process.exitCode = 1;
    return;
  }

  await connectDatabase();

  try {
    await Promise.all(requiredIndexes.map(({ model }) => model.init()));

    console.log('Phase 4 index verification passed.');
    console.log(`Verified models: ${requiredIndexes.map(({ name }) => name).join(', ')}`);
  } finally {
    await disconnectDatabase();
  }
};

run().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
