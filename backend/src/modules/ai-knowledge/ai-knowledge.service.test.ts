/**
 * The knowledge CRUD surface, now that it carries four client-facing sections instead of one
 * undifferentiated pile. The repository is mocked - this is about what the module accepts,
 * stores and hands back, not about Mongo.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AI_KNOWLEDGE_CATEGORIES,
  AI_KNOWLEDGE_CATEGORY_VALUES,
  AI_KNOWLEDGE_SECTION_VALUES,
} from '../../constants/ai-knowledge-statuses.js';

vi.mock('../../config/env.js', () => ({
  env: { NODE_ENV: 'test', LOG_LEVEL: 'silent' },
}));

const mocks = vi.hoisted(() => ({
  createKnowledge: vi.fn(),
  findKnowledgeById: vi.fn(),
  findKnowledgeByOrganization: vi.fn(),
  archiveKnowledge: vi.fn(),
  updateKnowledge: vi.fn(),
  deleteKnowledge: vi.fn(),
}));

vi.mock('./ai-knowledge.repository.js', () => ({
  createKnowledge: mocks.createKnowledge,
  findKnowledgeById: mocks.findKnowledgeById,
  findKnowledgeByOrganization: mocks.findKnowledgeByOrganization,
  archiveKnowledge: mocks.archiveKnowledge,
  updateKnowledge: mocks.updateKnowledge,
  deleteKnowledge: mocks.deleteKnowledge,
}));

const {
  createKnowledgeForActor,
  deleteKnowledgeForActor,
  listKnowledgeForOrganization,
  updateKnowledgeForActor,
} = await import('./ai-knowledge.service.js');
const { createKnowledgeBodySchema, updateKnowledgeBodySchema } = await import(
  './ai-knowledge.validation.js'
);

const organizationId = 'org-1';
const actor = { _id: 'user-1' } as never;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('the four sections', () => {
  it('offers company, services, pricing and rules, in that order', () => {
    expect(AI_KNOWLEDGE_SECTION_VALUES).toEqual(['company', 'services', 'pricing', 'rules']);
  });

  it.each([...AI_KNOWLEDGE_SECTION_VALUES])('accepts a new entry under %s', async (section) => {
    mocks.createKnowledge.mockResolvedValue({
      _id: 'k1',
      organizationId,
      label: 'A label',
      content: 'Some content.',
      category: section,
      status: 'active',
    });

    const created = await createKnowledgeForActor({
      organizationId,
      actor,
      label: 'A label',
      content: 'Some content.',
      category: section,
    });

    expect(mocks.createKnowledge).toHaveBeenCalledWith(
      expect.objectContaining({ category: section }),
    );
    expect(created?.category).toBe(section);
  });

  it.each([...AI_KNOWLEDGE_SECTION_VALUES])('validates %s as a category the API accepts', (section) => {
    const parsed = createKnowledgeBodySchema.safeParse({
      label: 'A label',
      content: 'Some content.',
      category: section,
    });

    expect(parsed.success).toBe(true);
  });
});

describe('editing a fact in place', () => {
  const existing = {
    _id: 'k1',
    organizationId,
    label: 'Warranty policy',
    content: 'Warranty is two years.',
    category: AI_KNOWLEDGE_CATEGORIES.POLICY,
    status: 'active',
  };

  it('writes only the fields supplied, so a category change cannot blank the content', async () => {
    mocks.findKnowledgeById.mockResolvedValue(existing);
    mocks.updateKnowledge.mockResolvedValue({
      ...existing,
      category: AI_KNOWLEDGE_CATEGORIES.RULES,
    });

    const updated = await updateKnowledgeForActor({
      organizationId,
      knowledgeId: 'k1',
      actor,
      category: AI_KNOWLEDGE_CATEGORIES.RULES,
    });

    const [call] = mocks.updateKnowledge.mock.calls;
    expect(call?.[0]).toMatchObject({ category: 'rules', actorId: 'user-1' });
    expect(call?.[0]?.label).toBeUndefined();
    expect(call?.[0]?.content).toBeUndefined();
    expect(updated?.content).toBe('Warranty is two years.');
  });

  it('is a not-found rather than a silent no-op when the id belongs to another organization', async () => {
    mocks.findKnowledgeById.mockResolvedValue(null);

    await expect(
      updateKnowledgeForActor({
        organizationId,
        knowledgeId: 'k-elsewhere',
        actor,
        label: 'Renamed',
      }),
    ).rejects.toThrow('AI_KNOWLEDGE_NOT_FOUND');

    expect(mocks.updateKnowledge).not.toHaveBeenCalled();
  });

  it('rejects an edit that changes nothing, so the UI cannot report an empty save as done', () => {
    expect(updateKnowledgeBodySchema.safeParse({}).success).toBe(false);
    expect(updateKnowledgeBodySchema.safeParse({ category: 'rules' }).success).toBe(true);
  });

  it('rejects a category nothing has ever used on the edit path too', () => {
    expect(updateKnowledgeBodySchema.safeParse({ category: 'moon_landing' }).success).toBe(false);
  });
});

describe('deleting a fact for good', () => {
  const existing = {
    _id: 'k1',
    organizationId,
    label: 'Old warranty',
    content: 'Two years.',
    category: AI_KNOWLEDGE_CATEGORIES.POLICY,
    status: 'archived',
  };

  it('removes it scoped to the organization and returns what went', async () => {
    mocks.findKnowledgeById.mockResolvedValue(existing);
    mocks.deleteKnowledge.mockResolvedValue(existing);

    const removed = await deleteKnowledgeForActor({ organizationId, knowledgeId: 'k1' });

    expect(mocks.deleteKnowledge).toHaveBeenCalledWith(
      expect.objectContaining({ knowledgeId: 'k1', organizationId }),
    );
    expect(removed).toMatchObject({ id: 'k1', label: 'Old warranty' });
  });

  it('is a not-found for an id belonging to another organization, and deletes nothing', async () => {
    mocks.findKnowledgeById.mockResolvedValue(null);

    await expect(
      deleteKnowledgeForActor({ organizationId, knowledgeId: 'k-elsewhere' }),
    ).rejects.toThrow('AI_KNOWLEDGE_NOT_FOUND');

    expect(mocks.deleteKnowledge).not.toHaveBeenCalled();
  });
});

describe('rows written before the four sections existed', () => {
  it('still accepts the older category values, so nothing already saved becomes unwritable', () => {
    for (const legacy of ['policy', 'product', 'faq', 'other']) {
      expect(AI_KNOWLEDGE_CATEGORY_VALUES).toContain(legacy);
      expect(
        createKnowledgeBodySchema.safeParse({
          label: 'A label',
          content: 'Some content.',
          category: legacy,
        }).success,
      ).toBe(true);
    }
  });

  it('loads an archived entry under an older category alongside the new ones', async () => {
    mocks.findKnowledgeByOrganization.mockResolvedValue([
      {
        _id: 'k-old',
        organizationId,
        label: 'Old warranty policy',
        content: 'Two years.',
        category: AI_KNOWLEDGE_CATEGORIES.POLICY,
        status: 'archived',
      },
      {
        _id: 'k-new',
        organizationId,
        label: 'Never promise availability',
        content: 'Only a human confirms a date.',
        category: AI_KNOWLEDGE_CATEGORIES.RULES,
        status: 'active',
      },
    ]);

    const listed = await listKnowledgeForOrganization({ organizationId });

    expect(listed).toHaveLength(2);
    expect(listed[0]).toMatchObject({ category: 'policy', status: 'archived' });
    expect(listed[1]).toMatchObject({ category: 'rules', status: 'active' });
  });

  it('rejects a category nothing has ever used', () => {
    expect(
      createKnowledgeBodySchema.safeParse({
        label: 'A label',
        content: 'Some content.',
        category: 'moon_landing',
      }).success,
    ).toBe(false);
  });
});
