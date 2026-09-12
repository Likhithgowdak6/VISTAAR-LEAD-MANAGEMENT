import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as endpointsApi from '../api/endpoints';
import { PERMISSIONS } from '../lib/permissions';
import TemplatesPage from '../pages/TemplatesPage';
import { AUTH_PAYLOAD, renderAuthed } from './lead-helpers';

// Tests may use `any` for Vitest mocks of untyped endpoint modules.
const endpoints = endpointsApi as any;

vi.mock('../api/endpoints');

const SAVED = [
  {
    id: 't1',
    title: 'Clean list',
    body: '*Wedding* — ₹45,000\n300 edited photos',
    kind: 'pricing',
    sourceDetails: '300 photos 45k',
  },
];

const FOUR = [
  { title: 'Clean list', body: '*Wedding* — ₹45,000' },
  { title: 'Value-led', body: 'You get 300 edited photos, and ₹45,000 covers the day.' },
  { title: 'Short', body: '₹45,000 for the day.' },
  { title: 'Warm', body: 'Hey! For your date it works out at ₹45,000.' },
];

beforeEach(() => {
  endpoints.listTemplates.mockResolvedValue({ data: SAVED });
});

afterEach(() => {
  vi.clearAllMocks();
});

const asAdmin = () =>
  endpoints.refresh.mockResolvedValue(
    AUTH_PAYLOAD({ role: 'admin', permissions: [PERMISSIONS.TEMPLATES_MANAGE] }),
  );

describe('TemplatesPage', () => {
  it('lists saved templates with their body as it will be sent', async () => {
    asAdmin();
    renderAuthed(<TemplatesPage />);

    expect(await screen.findByText('Clean list')).toBeInTheDocument();
    expect(screen.getByText(/300 edited photos/)).toBeInTheDocument();
  });

  it('generates four options and saves only the one picked', async () => {
    asAdmin();
    endpoints.generateTemplates.mockResolvedValue({ data: { templates: FOUR } });
    endpoints.createTemplate.mockResolvedValue({ data: { id: 't2' } });
    renderAuthed(<TemplatesPage />);

    await screen.findByText('Clean list');
    fireEvent.click(screen.getByRole('button', { name: 'New price template' }));

    const dialog = screen.getByRole('dialog', { name: 'Write a price template' });
    fireEvent.change(within(dialog).getByLabelText('Your prices'), {
      target: { value: '300 photos 45k' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: '✦ Write four versions' }));

    await waitFor(() => expect(endpoints.generateTemplates).toHaveBeenCalled());

    // All four are offered; nothing is stored until one is chosen.
    expect(await within(dialog).findByText('Value-led')).toBeInTheDocument();
    expect(within(dialog).getByText('Short')).toBeInTheDocument();
    expect(endpoints.createTemplate).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByText('₹45,000 for the day.'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save this one' }));

    await waitFor(() =>
      expect(endpoints.createTemplate).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Short',
          body: '₹45,000 for the day.',
          kind: 'pricing',
          sourceDetails: '300 photos 45k',
        }),
      ),
    );
  });

  it('sends the rejected bodies back when asked for four more', async () => {
    asAdmin();
    endpoints.generateTemplates.mockResolvedValue({ data: { templates: FOUR } });
    renderAuthed(<TemplatesPage />);

    await screen.findByText('Clean list');
    fireEvent.click(screen.getByRole('button', { name: 'New price template' }));

    const dialog = screen.getByRole('dialog', { name: 'Write a price template' });
    fireEvent.change(within(dialog).getByLabelText('Your prices'), {
      target: { value: '300 photos 45k' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: '✦ Write four versions' }));

    // The label changes once there is something to reject.
    const again = await within(dialog).findByRole('button', { name: '✦ Show me four more' });
    fireEvent.click(again);

    // Without this the model returns the same ideas reworded, which reads as a broken button.
    await waitFor(() =>
      expect(endpoints.generateTemplates).toHaveBeenLastCalledWith(
        expect.objectContaining({
          rejected: FOUR.map((option) => option.body),
        }),
      ),
    );
  });

  it('cannot save until one of the four is selected', async () => {
    asAdmin();
    endpoints.generateTemplates.mockResolvedValue({ data: { templates: FOUR } });
    renderAuthed(<TemplatesPage />);

    await screen.findByText('Clean list');
    fireEvent.click(screen.getByRole('button', { name: 'New price template' }));

    const dialog = screen.getByRole('dialog', { name: 'Write a price template' });
    fireEvent.change(within(dialog).getByLabelText('Your prices'), {
      target: { value: '300 photos 45k' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: '✦ Write four versions' }));

    expect(await within(dialog).findByRole('button', { name: 'Save this one' })).toBeDisabled();
  });

  it('hides the controls without templates.manage', async () => {
    endpoints.refresh.mockResolvedValue(AUTH_PAYLOAD({ role: 'staff', permissions: [] }));
    renderAuthed(<TemplatesPage />);

    await screen.findByText('Clean list');
    expect(screen.queryByRole('button', { name: 'New price template' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
  });
});
