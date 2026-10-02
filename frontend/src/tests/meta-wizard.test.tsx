import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as endpointsApi from '../api/endpoints';
import { PERMISSIONS } from '../lib/permissions';
import LeadSourcesPage from '../pages/LeadSourcesPage';
import { AUTH_PAYLOAD, renderAuthed } from './lead-helpers';

// Tests may use `any` for Vitest mocks of untyped endpoint modules.
const endpoints = endpointsApi as any;

vi.mock('../api/endpoints');

const ACCOUNTS = [{ id: 'acc-1', name: 'Studio Main', brandKey: 'studio-main', status: 'active' }];

const CONNECTION = {
  id: 'mc-1',
  metaUserId: '900',
  metaUserName: 'Asha Menon',
  status: 'active',
  grantedScopes: ['pages_show_list', 'leads_retrieval'],
  accessTokenLast4: 'wxyz',
  accessTokenSetAt: '2026-09-30T10:00:00.000Z',
  accessTokenExpiresAt: null,
  lastError: null,
  lastCheckedAt: '2026-09-30T10:00:00.000Z',
  createdAt: '2026-09-30T10:00:00.000Z',
  updatedAt: '2026-09-30T10:00:00.000Z',
};

const PAGES = [
  { id: '777', name: 'Wedding Genie', pictureUrl: null },
  { id: '888', name: 'Trikal Cafe', pictureUrl: null },
];

const FORMS = [
  { id: '4001', name: 'Wedding enquiry', status: 'ACTIVE' },
  { id: '4002', name: 'Old enquiry', status: 'ARCHIVED' },
];

/** Mirrors a real form: two mapped questions, one the rules do not recognise, plus identity. */
const FIELDS = [
  { key: 'event_dates_month', label: 'Event Dates/Month ?', type: 'custom', suggestedFactKey: 'event_date' },
  { key: 'approx_number_of_guest', label: 'Approx Number of Guest', type: 'custom', suggestedFactKey: 'guest_count' },
  { key: 'how_did_you_hear', label: 'How did you hear about us?', type: 'custom', suggestedFactKey: null },
  { key: 'full_name', label: 'Full name', type: 'full_name', suggestedFactKey: 'name' },
  { key: 'phone_number', label: 'Phone number', type: 'phone', suggestedFactKey: 'phone' },
];

const FIELD_KEYS = [
  { key: 'budget_range', isContact: false },
  { key: 'city', isContact: false },
  { key: 'email', isContact: true },
  { key: 'event_date', isContact: false },
  { key: 'guest_count', isContact: false },
  { key: 'name', isContact: true },
  { key: 'phone', isContact: true },
  { key: 'service_interest', isContact: false },
];

const CREATED_SOURCE = {
  id: 'ls-fb',
  name: 'Wedding enquiry',
  kind: 'meta_lead_ads',
  sheetUrl: null,
  gid: null,
  meta: {
    pageId: '777',
    pageName: 'Wedding Genie',
    formId: '4001',
    formName: 'Wedding enquiry',
    hasAccessToken: true,
    accessTokenLast4: 'abcd',
    accessTokenSetAt: '2026-09-30T11:00:00.000Z',
    lastLeadCreatedAt: null,
    webhookSubscribedAt: '2026-09-30T11:00:00.000Z',
    webhookError: null,
    usesFacebookLogin: true,
  },
  whatsappAccountId: 'acc-1',
  defaultCountryCode: '91',
  status: 'active',
  aiContextEnabled: false,
  autoGreetEnabled: false,
  lastSyncStatus: 'pending',
  lastError: null,
  lastSyncCounts: { imported: 0, duplicates: 0, skipped: 0, failed: 0 },
  totalImported: 0,
};

const assign = vi.fn();

const openWizard = async () => {
  fireEvent.click(await screen.findByRole('button', { name: 'Connect Facebook' }));

  return screen.findByRole('dialog', { name: 'Connect a Facebook lead form' });
};

/** Drives the wizard from the page list through to the review screen. */
const advanceToReview = async () => {
  await openWizard();

  fireEvent.click(await screen.findByRole('button', { name: /Wedding Genie/ }));
  fireEvent.click(await screen.findByRole('button', { name: /Wedding enquiry/ }));
  await screen.findByLabelText('Event Dates/Month ?');

  fireEvent.click(screen.getByRole('button', { name: 'Next' })); // mapping -> settings
  await screen.findByLabelText('Lead source name');
  fireEvent.click(screen.getByRole('button', { name: 'Next' })); // settings -> review

  return screen.findByRole('button', { name: 'Activate' });
};

beforeEach(() => {
  assign.mockReset();
  // jsdom refuses a real navigation; the wizard only ever needs the URL it was handed.
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, assign, search: '', href: 'http://localhost/' },
  });

  endpoints.refresh.mockResolvedValue(
    AUTH_PAYLOAD({ role: 'admin', permissions: [PERMISSIONS.LEAD_SOURCES_MANAGE] }),
  );
  endpoints.listLeadSources.mockResolvedValue({ data: [] });
  endpoints.listAccounts.mockResolvedValue({ data: ACCOUNTS });
  endpoints.listStages.mockResolvedValue({ data: [] });
  endpoints.listTags.mockResolvedValue({ data: [] });
  endpoints.listUsers.mockResolvedValue({ data: [] });

  endpoints.getMetaConnection.mockResolvedValue({
    data: { connection: CONNECTION, configured: true },
  });
  endpoints.startMetaOauth.mockResolvedValue({
    data: { authorizeUrl: 'https://www.facebook.com/v25.0/dialog/oauth?x=1', scopes: [] },
  });
  endpoints.listConnectedMetaPages.mockResolvedValue({ data: PAGES });
  endpoints.listConnectedMetaForms.mockResolvedValue({ data: FORMS });
  endpoints.listConnectedMetaFormFields.mockResolvedValue({ data: FIELDS });
  endpoints.listMetaFieldKeys.mockResolvedValue({ data: FIELD_KEYS });
  endpoints.createMetaOauthLeadSource.mockResolvedValue({
    data: { leadSource: CREATED_SOURCE, webhookSubscribed: true, webhookError: null },
  });
  endpoints.retryMetaWebhookSubscription.mockResolvedValue({
    data: { leadSource: CREATED_SOURCE, webhookSubscribed: true, webhookError: null },
  });
  endpoints.runMetaDiagnostics.mockResolvedValue({
    data: { ok: true, checks: [{ key: 'webhook', ok: true, detail: 'Page is subscribed.' }] },
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('Step 1 — connecting Facebook', () => {
  it('offers the sign-in when no account is connected, and never asks for a token', async () => {
    endpoints.getMetaConnection.mockResolvedValue({ data: { connection: null, configured: true } });

    renderAuthed(<LeadSourcesPage />);
    const dialog = await openWizard();

    expect(
      await within(dialog).findByRole('button', { name: 'Connect Facebook' }),
    ).toBeInTheDocument();
    // The whole point of this route: no token field anywhere in the wizard.
    expect(within(dialog).queryByLabelText(/access token/i)).not.toBeInTheDocument();
  });

  it('sends the browser to the URL the server minted, rather than building one itself', async () => {
    endpoints.getMetaConnection.mockResolvedValue({ data: { connection: null, configured: true } });

    renderAuthed(<LeadSourcesPage />);
    const dialog = await openWizard();

    fireEvent.click(await within(dialog).findByRole('button', { name: 'Connect Facebook' }));

    await waitFor(() => expect(endpoints.startMetaOauth).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith('https://www.facebook.com/v25.0/dialog/oauth?x=1'),
    );
  });

  it('refuses to offer the button when the server has no Meta credentials', async () => {
    endpoints.getMetaConnection.mockResolvedValue({
      data: { connection: null, configured: false },
    });

    renderAuthed(<LeadSourcesPage />);
    const dialog = await openWizard();

    expect(await within(dialog).findByText(/isn.t set up on this server/i)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Connect Facebook' })).toBeDisabled();
  });

  it('skips straight to the pages when Facebook is already connected', async () => {
    renderAuthed(<LeadSourcesPage />);
    await openWizard();

    expect(await screen.findByRole('button', { name: /Wedding Genie/ })).toBeInTheDocument();
    await waitFor(() => expect(endpoints.listConnectedMetaPages).toHaveBeenCalledTimes(1));
  });

  it('shows only the last four characters of the stored credential', async () => {
    endpoints.getMetaConnection.mockResolvedValue({
      data: { connection: { ...CONNECTION, status: 'needs_attention' }, configured: true },
    });

    renderAuthed(<LeadSourcesPage />);
    const dialog = await openWizard();

    expect(await within(dialog).findByText(/····wxyz/)).toBeInTheDocument();
    expect(within(dialog).getByText('Needs attention')).toBeInTheDocument();
  });
});

describe('Steps 2 and 3 — page and form', () => {
  it('loads the chosen page’s forms, and nobody else’s', async () => {
    renderAuthed(<LeadSourcesPage />);
    await openWizard();

    fireEvent.click(await screen.findByRole('button', { name: /Trikal Cafe/ }));

    await waitFor(() => expect(endpoints.listConnectedMetaForms).toHaveBeenCalledTimes(1));
    expect(endpoints.listConnectedMetaForms.mock.calls[0][0]).toMatchObject({ pageId: '888' });
  });

  it('says what to do when the account manages no pages', async () => {
    endpoints.listConnectedMetaPages.mockResolvedValue({ data: [] });

    renderAuthed(<LeadSourcesPage />);
    await openWizard();

    expect(await screen.findByText(/No pages on this Facebook account/i)).toBeInTheDocument();
  });

  it('marks an archived form instead of hiding it', async () => {
    renderAuthed(<LeadSourcesPage />);
    await openWizard();

    fireEvent.click(await screen.findByRole('button', { name: /Wedding Genie/ }));

    expect(await screen.findByRole('button', { name: /Old enquiry/ })).toHaveTextContent(
      'archived',
    );
  });

  it('drops a stale form choice when the page is changed', async () => {
    renderAuthed(<LeadSourcesPage />);
    await openWizard();

    fireEvent.click(await screen.findByRole('button', { name: /Wedding Genie/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Wedding enquiry/ }));
    await screen.findByLabelText('Event Dates/Month ?');

    // Back twice, to the page list, and pick a different page.
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    fireEvent.click(await screen.findByRole('button', { name: /Trikal Cafe/ }));

    // A form from the previous page must not still be selected — Next has nothing to advance to.
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  });
});

describe('Step 4 — field mapping', () => {
  it('arrives pre-answered from the importer’s own rules', async () => {
    renderAuthed(<LeadSourcesPage />);
    await openWizard();

    fireEvent.click(await screen.findByRole('button', { name: /Wedding Genie/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Wedding enquiry/ }));

    expect(await screen.findByLabelText('Event Dates/Month ?')).toHaveValue('event_date');
    expect(screen.getByLabelText('Approx Number of Guest')).toHaveValue('guest_count');
  });

  it('keeps an unrecognised question as extra detail rather than silently dropping it', async () => {
    renderAuthed(<LeadSourcesPage />);
    await openWizard();

    fireEvent.click(await screen.findByRole('button', { name: /Wedding Genie/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Wedding enquiry/ }));

    // The dangerous default would be "ignore". It is not.
    expect(await screen.findByLabelText('How did you hear about us?')).toHaveValue('__extra__');
  });

  it('shows name and phone as contact fields, with no mapping control', async () => {
    renderAuthed(<LeadSourcesPage />);
    await openWizard();

    fireEvent.click(await screen.findByRole('button', { name: /Wedding Genie/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Wedding enquiry/ }));

    await screen.findByLabelText('Event Dates/Month ?');
    expect(screen.getByText('Saved to the contact record')).toBeInTheDocument();
    // Identity is read from Meta's standard columns, so offering a picker would be a lie.
    expect(screen.queryByLabelText('Full name')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Phone number')).not.toBeInTheDocument();
  });

  it('still renders when the override vocabulary cannot be loaded', async () => {
    // Caught in a real browser against a backend that predated /meta/field-keys: the questions
    // had arrived and every one carried a suggestion, but the optional call's 404 killed the
    // whole step. A frontend newer than its backend is an ordinary deploy race.
    endpoints.listMetaFieldKeys.mockRejectedValue(
      new Error('Route GET /api/v1/lead-sources/meta/field-keys not found.'),
    );

    renderAuthed(<LeadSourcesPage />);
    await openWizard();

    fireEvent.click(await screen.findByRole('button', { name: /Wedding Genie/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Wedding enquiry/ }));

    // The suggestions still drive the step...
    expect(await screen.findByLabelText('Event Dates/Month ?')).toHaveValue('event_date');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    // ...the fallback vocabulary is derived from this form's own suggestions...
    const options = Array.from(
      (screen.getByLabelText('Event Dates/Month ?') as HTMLSelectElement).options,
    ).map((option) => option.value);
    expect(options).toEqual(['event_date', 'guest_count', '__extra__', '__ignore__']);

    // ...and the identity triple is still recognised, so it stays locked rather than becoming
    // three editable dropdowns the owner cannot usefully change.
    expect(screen.getByText('Saved to the contact record')).toBeInTheDocument();
    expect(screen.queryByLabelText('Full name')).not.toBeInTheDocument();
  });

  it('warns when two questions are pointed at one key', async () => {
    renderAuthed(<LeadSourcesPage />);
    await openWizard();

    fireEvent.click(await screen.findByRole('button', { name: /Wedding Genie/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Wedding enquiry/ }));

    fireEvent.change(await screen.findByLabelText('How did you hear about us?'), {
      target: { value: 'event_date' },
    });

    expect(await screen.findAllByText(/Another question is already using this/i)).toHaveLength(2);
  });
});

describe('Step 6 — activating', () => {
  it('sends the mapping in the shape the importer reads, keyed by the Meta field key', async () => {
    renderAuthed(<LeadSourcesPage />);
    const activate = await advanceToReview();

    fireEvent.click(activate);

    await waitFor(() => expect(endpoints.createMetaOauthLeadSource).toHaveBeenCalledTimes(1));
    const body = endpoints.createMetaOauthLeadSource.mock.calls[0][0];

    expect(body).toMatchObject({
      pageId: '777',
      formId: '4001',
      formName: 'Wedding enquiry',
      whatsappAccountId: 'acc-1',
      defaultCountryCode: '91',
      subscribeWebhook: true,
    });
    expect(body.fieldMappings).toEqual([
      { metaKey: 'event_dates_month', metaLabel: 'Event Dates/Month ?', factKey: 'event_date' },
      {
        metaKey: 'approx_number_of_guest',
        metaLabel: 'Approx Number of Guest',
        factKey: 'guest_count',
      },
      { metaKey: 'full_name', metaLabel: 'Full name', factKey: 'name' },
      { metaKey: 'phone_number', metaLabel: 'Phone number', factKey: 'phone' },
    ]);
  });

  it('sends an explicit null only for a question that was deliberately ignored', async () => {
    renderAuthed(<LeadSourcesPage />);
    await openWizard();

    fireEvent.click(await screen.findByRole('button', { name: /Wedding Genie/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Wedding enquiry/ }));
    fireEvent.change(await screen.findByLabelText('How did you hear about us?'), {
      target: { value: '__ignore__' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByLabelText('Lead source name');
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Activate' }));

    await waitFor(() => expect(endpoints.createMetaOauthLeadSource).toHaveBeenCalledTimes(1));
    const { fieldMappings } = endpoints.createMetaOauthLeadSource.mock.calls[0][0];

    expect(fieldMappings).toContainEqual({
      metaKey: 'how_did_you_hear',
      metaLabel: 'How did you hear about us?',
      factKey: null,
    });
  });

  it('never turns on cold outbound by default', async () => {
    renderAuthed(<LeadSourcesPage />);
    const activate = await advanceToReview();

    fireEvent.click(activate);

    await waitFor(() => expect(endpoints.createMetaOauthLeadSource).toHaveBeenCalledTimes(1));
    expect(endpoints.createMetaOauthLeadSource.mock.calls[0][0]).toMatchObject({
      autoGreetEnabled: false,
      importExisting: false,
      aiContextEnabled: false,
    });
  });

  it('cannot be submitted twice', async () => {
    let release: (value: unknown) => void = () => {};
    endpoints.createMetaOauthLeadSource.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );

    renderAuthed(<LeadSourcesPage />);
    const activate = await advanceToReview();

    fireEvent.click(activate);
    await screen.findByRole('button', { name: 'Connecting…' });
    fireEvent.click(screen.getByRole('button', { name: 'Connecting…' }));

    expect(screen.getByRole('button', { name: 'Connecting…' })).toBeDisabled();
    expect(endpoints.createMetaOauthLeadSource).toHaveBeenCalledTimes(1);

    release({ data: { leadSource: CREATED_SOURCE, webhookSubscribed: true, webhookError: null } });
    await screen.findByText(/is live/i);
  });

  it('keeps the mapping when activation fails, so nothing has to be redone', async () => {
    endpoints.createMetaOauthLeadSource.mockRejectedValue(
      new Error('That WhatsApp number is not connected.'),
    );

    renderAuthed(<LeadSourcesPage />);
    const activate = await advanceToReview();

    fireEvent.click(activate);

    expect(await screen.findByRole('alert')).toHaveTextContent(/not connected/i);
    // Still on Review, still populated, and Activate is usable again.
    expect(screen.getByText('Wedding Genie')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Activate' })).toBeEnabled();
  });

  it('treats a refused subscription as a partial success, with a retry', async () => {
    endpoints.createMetaOauthLeadSource.mockResolvedValue({
      data: {
        leadSource: {
          ...CREATED_SOURCE,
          status: 'paused',
          meta: { ...CREATED_SOURCE.meta, webhookSubscribedAt: null },
        },
        webhookSubscribed: false,
        webhookError: 'Facebook refused: pages_manage_metadata was not granted.',
      },
    });

    renderAuthed(<LeadSourcesPage />);
    const activate = await advanceToReview();

    fireEvent.click(activate);

    expect(await screen.findByText(/isn.t live yet/i)).toBeInTheDocument();
    expect(screen.getByText(/pages_manage_metadata was not granted/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry connection' }));

    await waitFor(() => expect(endpoints.retryMetaWebhookSubscription).toHaveBeenCalledTimes(1));
    expect(endpoints.retryMetaWebhookSubscription.mock.calls[0][0]).toMatchObject({
      leadSourceId: 'ls-fb',
    });
    expect(await screen.findByText(/is live/i)).toBeInTheDocument();
  });

  it('refreshes the lead-source list once the source exists', async () => {
    renderAuthed(<LeadSourcesPage />);
    const activate = await advanceToReview();

    expect(endpoints.listLeadSources).toHaveBeenCalledTimes(1);
    fireEvent.click(activate);

    await waitFor(() => expect(endpoints.listLeadSources).toHaveBeenCalledTimes(2));
  });
});

describe('Step 7 — an existing connection', () => {
  const LIVE_SOURCE = { ...CREATED_SOURCE, name: 'FB wedding leads' };

  it('re-checks against Facebook rather than trusting the stored flag', async () => {
    endpoints.listLeadSources.mockResolvedValue({ data: [LIVE_SOURCE] });

    renderAuthed(<LeadSourcesPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Connection' }));

    await waitFor(() => expect(endpoints.runMetaDiagnostics).toHaveBeenCalledTimes(1));
    expect(endpoints.runMetaDiagnostics.mock.calls[0][0]).toMatchObject({
      pageId: '777',
      formId: '4001',
    });
    expect(await screen.findByText('Page is subscribed.')).toBeInTheDocument();
  });

  it('offers a retry only while instant delivery is off', async () => {
    endpoints.listLeadSources.mockResolvedValue({
      data: [
        {
          ...LIVE_SOURCE,
          status: 'paused',
          meta: {
            ...LIVE_SOURCE.meta,
            webhookSubscribedAt: null,
            webhookError: 'Facebook refused the webhook subscription.',
          },
        },
      ],
    });

    renderAuthed(<LeadSourcesPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Connection' }));

    fireEvent.click(await screen.findByRole('button', { name: 'Retry connection' }));

    await waitFor(() => expect(endpoints.retryMetaWebhookSubscription).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole('status')).toHaveTextContent(/arrive within seconds/i);
  });

  it('leaves a manually-tokened source alone — it has no connection to inspect', async () => {
    endpoints.listLeadSources.mockResolvedValue({
      data: [
        {
          ...LIVE_SOURCE,
          meta: {
            ...LIVE_SOURCE.meta,
            usesFacebookLogin: false,
            webhookSubscribedAt: null,
            webhookError: null,
          },
        },
      ],
    });

    renderAuthed(<LeadSourcesPage />);

    await screen.findByText('FB wedding leads');
    expect(screen.queryByRole('button', { name: 'Connection' })).not.toBeInTheDocument();
  });

  it('is still reachable when instant delivery was never switched on', async () => {
    // Created with "Deliver leads instantly" unchecked: no timestamp, no error, but there is
    // still a Facebook connection behind it and still a subscription to turn on later.
    endpoints.listLeadSources.mockResolvedValue({
      data: [
        {
          ...LIVE_SOURCE,
          meta: {
            ...LIVE_SOURCE.meta,
            usesFacebookLogin: true,
            webhookSubscribedAt: null,
            webhookError: null,
          },
        },
      ],
    });

    renderAuthed(<LeadSourcesPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'Connection' }));
    expect(await screen.findByRole('button', { name: 'Retry connection' })).toBeInTheDocument();
  });

  it('holds on the sign-in step when Reconnect is pressed, connection or not', async () => {
    endpoints.listLeadSources.mockResolvedValue({ data: [LIVE_SOURCE] });

    renderAuthed(<LeadSourcesPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Connection' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Reconnect Facebook' }));

    const dialog = await screen.findByRole('dialog', { name: 'Connect a Facebook lead form' });

    // Without the hold, an active connection would send the wizard straight to the page list and
    // past the button they just asked for.
    expect(await within(dialog).findByRole('button', { name: 'Reconnect' })).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: /Trikal Cafe/ })).not.toBeInTheDocument();
  });
});

describe('The manual Page-token form still works', () => {
  it('is still reachable, now behind the fallback disclosure', async () => {
    renderAuthed(<LeadSourcesPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'Use a Page access token instead' }));

    expect(screen.getByLabelText('Page access token')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Test connection' })).toBeInTheDocument();
  });

  it('does not offer Google Sheet creation any more', async () => {
    renderAuthed(<LeadSourcesPage />);

    await screen.findByRole('button', { name: 'Connect Facebook' });

    expect(screen.queryByLabelText('Google Sheet link')).not.toBeInTheDocument();
  });
});
