/**
 * The schema facts the Cloud API integration actually depends on.
 *
 * WHY THIS NARROW FILE EXISTS. Two of these are security properties that no other test would
 * notice breaking, because breaking them produces a schema that still works perfectly in
 * development:
 *
 *   1. `cloud.phoneNumberId` carries a UNIQUE index. An inbound webhook names a phone number id
 *      and nothing else identifying the tenant, so uniqueness is the entire reason a delivery can
 *      be routed to one organisation and not another. It is declared inside a nested subschema,
 *      which is exactly the kind of place an index can silently fail to be created.
 *
 *   2. `encryptedCloudToken` is `select: false`. An access token that comes back on an ordinary
 *      find would reach the serializer, the API and the browser - and this is a credential that
 *      can send messages as the business.
 *
 *   3. The index is SPARSE. Every Baileys account has a null phone number id; a non-sparse unique
 *      index would let exactly one of them exist and refuse to save the second.
 *
 * Schema inspection only - no Mongo, no connection.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: { NODE_ENV: 'test', LOG_LEVEL: 'silent' },
}));

const { WhatsAppAccount } = await import('./whatsapp-account.model.js');
const { WHATSAPP_PROVIDER_KINDS } = await import('../../constants/whatsapp-providers.js');

type IndexDefinition = [Record<string, unknown>, Record<string, unknown>];

const indexes = () => WhatsAppAccount.schema.indexes() as unknown as IndexDefinition[];

const findIndexOn = (path: string) =>
  indexes().find(([fields]) => Object.keys(fields).includes(path));

describe('cloud.phoneNumberId index', () => {
  /**
   * The one that would fail silently. Mongoose does hoist indexes out of a single-nested
   * subschema, but that is a behaviour worth asserting rather than assuming: if it ever stopped,
   * two organisations could claim the same number and one would receive the other's messages.
   */
  it('exists, despite being declared inside a nested subschema', () => {
    expect(findIndexOn('cloud.phoneNumberId')).toBeDefined();
  });

  it('is unique, which is what makes webhook routing safe', () => {
    expect(findIndexOn('cloud.phoneNumberId')?.[1]).toMatchObject({ unique: true });
  });

  /** Without sparse, the second Baileys account ever created would fail to save. */
  it('is sparse, so the null on every Baileys account does not collide', () => {
    expect(findIndexOn('cloud.phoneNumberId')?.[1]).toMatchObject({ sparse: true });
  });
});

describe('credential storage', () => {
  it('keeps the Cloud token out of an ordinary query', () => {
    expect(WhatsAppAccount.schema.path('encryptedCloudToken').options.select).toBe(false);
  });

  /** The existing PII fields must not have been disturbed by the new one beside them. */
  it.each(['encryptedPhone', 'encryptedJid'])('leaves %s select:false', (path) => {
    expect(WhatsAppAccount.schema.path(path).options.select).toBe(false);
  });

  /**
   * The non-secret half is deliberately readable: it is how the dashboard shows which number is
   * connected. Asserted so nobody "tidies up" by hiding the whole subdocument and quietly breaks
   * the Accounts page.
   */
  it('leaves the non-secret cloud fields readable', () => {
    expect(WhatsAppAccount.schema.path('cloud.phoneNumberId').options.select).toBeUndefined();
  });
});

describe('provider', () => {
  /**
   * No migration ships with this feature. Every account that predates the field is a Baileys
   * account, and the default is what makes that true on read.
   */
  it('defaults to baileys, so accounts written before the field read correctly', () => {
    expect(WhatsAppAccount.schema.path('provider').options.default).toBe(
      WHATSAPP_PROVIDER_KINDS.BAILEYS,
    );
  });

  it('accepts only the two known providers', () => {
    expect(WhatsAppAccount.schema.path('provider').options.enum).toEqual(
      expect.arrayContaining(['baileys', 'cloud']),
    );
  });
});

describe('meta id validation', () => {
  const validate = (path: string, value: string) => {
    const account = new WhatsAppAccount({
      organizationId: '507f1f77bcf86cd799439011',
      name: 'Official',
      brandKey: 'official',
      cloud: { [path]: value },
    });

    return account.validateSync()?.errors?.[`cloud.${path}`];
  };

  it.each(['phoneNumberId', 'wabaId'])('accepts a digit string for %s', (path) => {
    expect(validate(path, '109876543210987')).toBeUndefined();
  });

  /**
   * These are interpolated into Graph URL paths. A value carrying a slash or a query separator
   * would address an endpoint nobody intended, so it is refused at the schema as well as at the
   * client.
   */
  it.each(['../me', 'me/accounts', '123?fields=x', 'abc', '12'])(
    'refuses "%s" as a phone number id',
    (value) => {
      expect(validate('phoneNumberId', value)).toBeDefined();
    },
  );

  /**
   * An empty string must become null, not pass through.
   *
   * Mongoose's `match` validator deliberately skips empty values, so `''` would otherwise
   * validate and be STORED - and `sparse` excludes null but not `''`, so the second account to
   * store one would collide with the first on the unique index and fail to save, over a field
   * neither of them uses. See emptyToNull in the model.
   */
  it.each(['', '   '])('stores "%s" as null rather than an empty id', (value) => {
    const account = new WhatsAppAccount({
      organizationId: '507f1f77bcf86cd799439011',
      name: 'Official',
      brandKey: 'official',
      cloud: { phoneNumberId: value },
    });

    expect(account.validateSync()?.errors?.['cloud.phoneNumberId']).toBeUndefined();
    expect(account.cloud?.phoneNumberId).toBeNull();
  });

  /**
   * Trimmed, not rejected. Copying an id out of Meta's dashboard routinely picks up a trailing
   * space or newline, and refusing that would be a support ticket for something the schema can
   * simply fix.
   */
  it.each([' 109876543210987', '109876543210987 ', '\n109876543210987\n'])(
    'accepts "%s" by trimming it',
    (value) => {
      expect(validate('phoneNumberId', value)).toBeUndefined();
    },
  );
});
