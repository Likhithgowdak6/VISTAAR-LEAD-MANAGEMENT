/**
 * The Call data retention settings panel.
 *
 * THE MOST IMPORTANT TESTS HERE ARE THE ONES THAT STOP A SAVE.
 *
 * This panel turns on an irreversible scheduled job that destroys recorded conversations with
 * real customers. There is no undo and no backup of the audio. So three things have to hold,
 * and each is pinned below:
 *
 *   NOTHING IS PRE-FILLED. Switching a setting on gives an EMPTY box, never a suggested "90".
 *   A number sitting in the field is one careless Save away from deleting years of recordings.
 *
 *   PREVIEW IS MANDATORY. Save is unreachable until the admin has seen how much would go.
 *
 *   AN INCOMPLETE FIELD BLOCKS BOTH BUTTONS. A field switched to "Delete after" with nothing
 *   typed holds NaN, and `JSON.stringify(NaN)` is `null` - which the server reads as "keep
 *   forever", the exact opposite of what was being configured, saved silently and looking fine.
 */
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import CallRetentionSection from '../components/settings/CallRetentionSection';
import * as endpointsApi from '../api/endpoints';
import { PERMISSIONS } from '../lib/permissions';
import { AUTH_PAYLOAD, renderAuthed } from './lead-helpers';

// Tests may use `any` for Vitest mocks of untyped endpoint modules.
const endpoints = endpointsApi as any;

vi.mock('../api/endpoints');

type Policy = { recordingDays: number | null; transcriptDays: number | null; summaryDays: number | null };

const KEEP_FOREVER: Policy = { recordingDays: null, transcriptDays: null, summaryDays: null };

const signedIn = () =>
  endpoints.refresh.mockResolvedValue(
    AUTH_PAYLOAD({ role: 'admin', permissions: [PERMISSIONS.SETTINGS_MANAGE] }),
  );

const withPolicy = (callRetention: Policy = KEEP_FOREVER) =>
  endpoints.getSettings.mockResolvedValue({
    data: { ownerWhatsappNumber: null, callRetention },
  });

const preview = (overrides: Record<string, unknown> = {}) => ({
  data: {
    policy: KEEP_FOREVER,
    unconfigured: false,
    recordings: { count: 12, cutoff: '2026-08-01T09:00:00.000Z' },
    transcripts: { count: 3, cutoff: '2026-08-01T09:00:00.000Z' },
    summaries: { count: 0, cutoff: null },
    ...overrides,
  },
});

const render = () => renderAuthed(<CallRetentionSection />);

/** Switches one setting to "Delete after" and types a period. */
const setDays = (label: string, days: string) => {
  fireEvent.click(screen.getByLabelText(`${label}: delete after a number of days`));
  fireEvent.change(screen.getByLabelText(`${label}: days to keep`), { target: { value: days } });
};

afterEach(() => {
  vi.clearAllMocks();
});

describe('the default state', () => {
  it('SHOWS KEEP FOREVER for every setting', async () => {
    // The state of every existing organisation, and the only safe default for a feature that
    // deletes irreversibly.
    signedIn();
    withPolicy();

    render();

    expect(await screen.findAllByText('Currently: Keep forever')).toHaveLength(3);
  });

  it('PRE-FILLS NO NUMBER ANYWHERE', async () => {
    signedIn();
    withPolicy();

    render();

    await screen.findAllByText('Currently: Keep forever');

    expect(screen.getByLabelText('Audio recordings: days to keep')).toHaveValue(null);
    expect(screen.getByLabelText('Transcripts: days to keep')).toHaveValue(null);
    expect(screen.getByLabelText('AI summaries: days to keep')).toHaveValue(null);
  });

  it('says deletion is permanent', async () => {
    signedIn();
    withPolicy();

    render();

    expect(
      await screen.findByText(/Deletion is permanent and cannot be undone/),
    ).toBeInTheDocument();
  });

  it('reads back a saved policy', async () => {
    signedIn();
    withPolicy({ recordingDays: 90, transcriptDays: 365, summaryDays: null });

    render();

    expect(await screen.findByText('Currently: Delete after 90 days')).toBeInTheDocument();
    expect(screen.getByText('Currently: Delete after 365 days')).toBeInTheDocument();
    expect(screen.getByText('Currently: Keep forever')).toBeInTheDocument();
  });
});

describe('preview before saving', () => {
  it('DISABLES SAVE UNTIL A PREVIEW HAS BEEN RUN', async () => {
    signedIn();
    withPolicy();

    render();
    await screen.findAllByText('Currently: Keep forever');

    setDays('Audio recordings', '90');

    expect(screen.getByRole('button', { name: /Confirm and save/ })).toBeDisabled();
    expect(screen.getByText('Preview before saving.')).toBeInTheDocument();
  });

  it('PREVIEWING DOES NOT SAVE', async () => {
    signedIn();
    withPolicy();
    endpoints.getRetentionPreview.mockResolvedValue(preview());

    render();
    await screen.findAllByText('Currently: Keep forever');

    setDays('Audio recordings', '90');
    fireEvent.click(screen.getByRole('button', { name: /Preview what would be deleted/ }));

    await waitFor(() => expect(endpoints.getRetentionPreview).toHaveBeenCalled());
    expect(endpoints.updateCallRetention).not.toHaveBeenCalled();
  });

  it('shows the counts and the cutoff', async () => {
    signedIn();
    withPolicy();
    endpoints.getRetentionPreview.mockResolvedValue(preview());

    render();
    await screen.findAllByText('Currently: Keep forever');

    setDays('Audio recordings', '90');
    fireEvent.click(screen.getByRole('button', { name: /Preview what would be deleted/ }));

    expect(await screen.findByText(/12 recordings older than/)).toBeInTheDocument();
    expect(screen.getByText(/3 transcripts older than/)).toBeInTheDocument();
  });

  it('says plainly when nothing would be deleted', async () => {
    signedIn();
    withPolicy();
    endpoints.getRetentionPreview.mockResolvedValue(preview({ unconfigured: true }));

    render();
    await screen.findAllByText('Currently: Keep forever');

    setDays('Audio recordings', '90');
    fireEvent.click(screen.getByRole('button', { name: /Preview what would be deleted/ }));

    expect(await screen.findByText(/no retention period is currently saved/)).toBeInTheDocument();
  });

  it('INVALIDATES THE PREVIEW when the numbers change again', async () => {
    // Confirming against a stale preview would mean approving a deletion count that does not
    // describe what is about to be saved.
    signedIn();
    withPolicy();
    endpoints.getRetentionPreview.mockResolvedValue(preview());

    render();
    await screen.findAllByText('Currently: Keep forever');

    setDays('Audio recordings', '90');
    fireEvent.click(screen.getByRole('button', { name: /Preview what would be deleted/ }));
    await screen.findByText(/12 recordings older than/);

    fireEvent.change(screen.getByLabelText('Audio recordings: days to keep'), {
      target: { value: '30' },
    });

    expect(screen.queryByText(/12 recordings older than/)).toBeNull();
    expect(screen.getByRole('button', { name: /Confirm and save/ })).toBeDisabled();
  });
});

describe('saving', () => {
  const previewThen = async () => {
    endpoints.getRetentionPreview.mockResolvedValue(preview());
    fireEvent.click(screen.getByRole('button', { name: /Preview what would be deleted/ }));
    await screen.findByText(/12 recordings older than/);
  };

  it('sends all three fields, with nulls for keep-forever', async () => {
    // Null has to be writable: an owner who sets 90 days and changes their mind must be able
    // to turn it back off.
    signedIn();
    withPolicy();
    endpoints.updateCallRetention.mockResolvedValue({
      data: { ownerWhatsappNumber: null, callRetention: { ...KEEP_FOREVER, recordingDays: 90 } },
    });

    render();
    await screen.findAllByText('Currently: Keep forever');

    setDays('Audio recordings', '90');
    await previewThen();
    fireEvent.click(screen.getByRole('button', { name: /Confirm and save/ }));

    await waitFor(() =>
      expect(endpoints.updateCallRetention).toHaveBeenCalledWith(
        expect.objectContaining({ recordingDays: 90, transcriptDays: null, summaryDays: null }),
      ),
    );
  });

  it('confirms the save and shows the new current value', async () => {
    signedIn();
    withPolicy();
    endpoints.updateCallRetention.mockResolvedValue({
      data: { ownerWhatsappNumber: null, callRetention: { ...KEEP_FOREVER, recordingDays: 90 } },
    });

    render();
    await screen.findAllByText('Currently: Keep forever');

    setDays('Audio recordings', '90');
    await previewThen();
    fireEvent.click(screen.getByRole('button', { name: /Confirm and save/ }));

    expect(await screen.findByText('Retention policy saved.')).toBeInTheDocument();
    expect(screen.getByText('Currently: Delete after 90 days')).toBeInTheDocument();
  });

  it('reports a rejected save without claiming success', async () => {
    signedIn();
    withPolicy();
    endpoints.updateCallRetention.mockRejectedValue(new Error('Use at least 1 day.'));

    render();
    await screen.findAllByText('Currently: Keep forever');

    setDays('Audio recordings', '90');
    await previewThen();
    fireEvent.click(screen.getByRole('button', { name: /Confirm and save/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Use at least 1 day.');
    expect(screen.queryByText('Retention policy saved.')).toBeNull();
    // Still showing the old value, because nothing changed.
    expect(screen.getAllByText('Currently: Keep forever').length).toBe(3);
  });
});

describe('an incomplete field', () => {
  it('BLOCKS BOTH BUTTONS rather than sending NaN', async () => {
    // JSON.stringify(NaN) is null, which the server reads as "keep forever" - the opposite of
    // what the admin was configuring, saved silently and looking successful.
    signedIn();
    withPolicy();

    render();
    await screen.findAllByText('Currently: Keep forever');

    fireEvent.click(screen.getByLabelText('Audio recordings: delete after a number of days'));

    expect(screen.getByRole('button', { name: /Preview what would be deleted/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Confirm and save/ })).toBeDisabled();
    expect(screen.getByText(/Enter a number of days, or choose Keep forever/)).toBeInTheDocument();
  });

  it('clears once a number is typed', async () => {
    signedIn();
    withPolicy();

    render();
    await screen.findAllByText('Currently: Keep forever');

    fireEvent.click(screen.getByLabelText('Audio recordings: delete after a number of days'));
    fireEvent.change(screen.getByLabelText('Audio recordings: days to keep'), {
      target: { value: '30' },
    });

    expect(screen.getByRole('button', { name: /Preview what would be deleted/ })).not.toBeDisabled();
  });
});

describe('failures', () => {
  it('reports a policy that could not be loaded', async () => {
    signedIn();
    endpoints.getSettings.mockRejectedValue(new Error('Network down'));

    render();

    expect(await screen.findByRole('alert')).toHaveTextContent('Network down');
  });
});
