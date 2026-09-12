/**
 * The template surface. The repository and the brain client are both mocked - what is checked
 * here is that generating never writes, that only what the owner picked is stored, and that the
 * four options survive a thin answer from the model without reaching the UI as `undefined`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: { NODE_ENV: 'test', LOG_LEVEL: 'silent' },
}));

const mocks = vi.hoisted(() => ({
  createMessageTemplate: vi.fn(),
  findMessageTemplates: vi.fn(),
  findMessageTemplateById: vi.fn(),
  deleteMessageTemplate: vi.fn(),
  generatePriceTemplates: vi.fn(),
}));

vi.mock('./message-template.repository.js', () => ({
  createMessageTemplate: mocks.createMessageTemplate,
  findMessageTemplates: mocks.findMessageTemplates,
  findMessageTemplateById: mocks.findMessageTemplateById,
  deleteMessageTemplate: mocks.deleteMessageTemplate,
}));

vi.mock('../ai-brain/ai-brain.client.js', () => ({
  generatePriceTemplates: mocks.generatePriceTemplates,
}));

const {
  deleteTemplateForActor,
  generateTemplateOptions,
  listTemplatesForOrganization,
  saveTemplateForActor,
} = await import('./message-template.service.js');

const organizationId = 'org-1';
const actor = { _id: 'user-1' } as never;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('writing the four options', () => {
  it('returns them without storing anything - three are about to be thrown away', async () => {
    mocks.generatePriceTemplates.mockResolvedValue({
      templates: [
        { title: 'Clean list', body: '*Wedding* — ₹45,000' },
        { title: 'Value-led', body: 'You get 300 edited photos...' },
        { title: 'Short', body: '₹45,000 for the day.' },
        { title: 'Warm', body: 'Hey! For your date...' },
      ],
    });

    const options = await generateTemplateOptions({ rawDetails: '300 photos 45k' });

    expect(options).toHaveLength(4);
    expect(mocks.createMessageTemplate).not.toHaveBeenCalled();
  });

  it('passes the rejected bodies through so a regenerate is genuinely different', async () => {
    mocks.generatePriceTemplates.mockResolvedValue({ templates: [{ title: 'A', body: 'B' }] });

    await generateTemplateOptions({
      rawDetails: '300 photos 45k',
      rejected: ['an earlier version'],
    });

    expect(mocks.generatePriceTemplates).toHaveBeenCalledWith(
      expect.objectContaining({ rejected: ['an earlier version'] }),
    );
  });

  it('labels an untitled option rather than rendering undefined in the picker', async () => {
    mocks.generatePriceTemplates.mockResolvedValue({
      templates: [{ body: 'A price message with no title.' }],
    });

    const options = await generateTemplateOptions({ rawDetails: '45k' });

    expect(options[0]?.title).toBe('Version 1');
  });

  it('drops an option with no body, which would be an empty card to click', async () => {
    mocks.generatePriceTemplates.mockResolvedValue({
      templates: [{ title: 'Clean list', body: '' }, { title: 'Short', body: '₹45,000.' }],
    });

    const options = await generateTemplateOptions({ rawDetails: '45k' });

    expect(options).toHaveLength(1);
    expect(options[0]?.title).toBe('Short');
  });
});

describe('keeping the one he picked', () => {
  it('stores it against the actor, with what he typed to get it', async () => {
    mocks.createMessageTemplate.mockResolvedValue({
      _id: 't1',
      title: 'Clean list',
      body: '*Wedding* — ₹45,000',
      kind: 'pricing',
      sourceDetails: '300 photos 45k',
    });

    const saved = await saveTemplateForActor({
      organizationId,
      actor,
      title: 'Clean list',
      body: '*Wedding* — ₹45,000',
      kind: 'pricing',
      sourceDetails: '300 photos 45k',
    });

    expect(mocks.createMessageTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ createdBy: 'user-1', sourceDetails: '300 photos 45k' }),
    );
    expect(saved).toMatchObject({ id: 't1', title: 'Clean list' });
  });

  it('lists what the organization has saved', async () => {
    mocks.findMessageTemplates.mockResolvedValue([
      { _id: 't1', title: 'Clean list', body: 'x', kind: 'pricing' },
    ]);

    const listed = await listTemplatesForOrganization({ organizationId });

    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: 't1', kind: 'pricing' });
  });
});

describe('deleting one', () => {
  it('removes it scoped to the organization', async () => {
    mocks.findMessageTemplateById.mockResolvedValue({ _id: 't1', title: 'Clean list' });
    mocks.deleteMessageTemplate.mockResolvedValue({ _id: 't1', title: 'Clean list' });

    const removed = await deleteTemplateForActor({ organizationId, templateId: 't1' });

    expect(mocks.deleteMessageTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ templateId: 't1', organizationId }),
    );
    expect(removed).toMatchObject({ id: 't1' });
  });

  it('is a not-found for another organization id, and deletes nothing', async () => {
    mocks.findMessageTemplateById.mockResolvedValue(null);

    await expect(
      deleteTemplateForActor({ organizationId, templateId: 't-elsewhere' }),
    ).rejects.toThrow('MESSAGE_TEMPLATE_NOT_FOUND');

    expect(mocks.deleteMessageTemplate).not.toHaveBeenCalled();
  });
});
