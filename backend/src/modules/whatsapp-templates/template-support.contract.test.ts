import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { isSupportedTemplate } from './whatsapp-template.parser.js';
import { createWhatsAppTemplateService } from './whatsapp-template.service.js';

const cases: Array<{name: string; components: unknown; supported: boolean}> = JSON.parse(readFileSync(new URL('../../../../contract-fixtures/cloud-template-support.json', import.meta.url), 'utf8'));
describe('shared Node/Python template contract', () => {
  it.each(cases)('$name', ({ components, supported }) => expect(isSupportedTemplate(components)).toBe(supported));
});
describe('template account authorization', () => {
  const account = '111111111111111111111111';
  const other = '222222222222222222222222';
  const organizationId = '333333333333333333333333';
  const options = () => ({
    findAccount: vi.fn().mockResolvedValue({ _id: account }),
    findTemplates: vi.fn().mockResolvedValue([
      { name: 'supported', components: [{ type: 'BODY', text: 'Hi' }] },
      { name: 'unsupported', components: [{ type: 'HEADER', format: 'IMAGE' }, { type: 'BODY', text: 'Hi' }] },
    ]),
  });
  it('rejects a member restricted to another number before reading the cache', async () => {
    const deps = options();
    const service = createWhatsAppTemplateService(deps as never);
    await expect(service.listTemplatesForAccount({ organizationId, accountId: account, actor: { accountAccessMode: 'selected', accountAccess: [other] } })).rejects.toMatchObject({ statusCode: 403 });
    expect(deps.findTemplates).not.toHaveBeenCalled();
  });
  it('filters unsupported templates for senders while allowing admin inspection', async () => {
    const service = createWhatsAppTemplateService(options() as never);
    const params = { organizationId, accountId: account, actor: { accountAccessMode: 'all' as const } };
    expect(await service.listTemplatesForAccount({ ...params, approvedOnly: true })).toHaveLength(1);
    expect(await service.listTemplatesForAccount(params)).toHaveLength(2);
  });
  it('does not reveal cache entries for an account outside the tenant', async () => {
    const deps = options(); deps.findAccount.mockResolvedValue(null);
    await expect(createWhatsAppTemplateService(deps as never).listTemplatesForAccount({ organizationId, accountId: other, actor: {} })).rejects.toMatchObject({ statusCode: 404 });
    expect(deps.findTemplates).not.toHaveBeenCalled();
  });
});
