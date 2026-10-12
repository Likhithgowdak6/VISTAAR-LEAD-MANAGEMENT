/**
 * The permission notice and the reschedule dialog.
 *
 * WHY THE PERMISSION STATES ARE TESTED SEPARATELY. `prompt` and `denied` look alike and need
 * opposite treatment: on Android, asking again after a refusal resolves straight back to denied
 * without showing a dialog, so a button there is a control that visibly does nothing. One state
 * gets the button, the other gets directions. Getting that backwards is invisible in review and
 * obvious to an annoyed owner.
 *
 * The dialog tests cover what `window.prompt` could not do: validate before closing, show an
 * API error, and refuse a double submit.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import NotificationPermissionNotice from '../components/reminders/NotificationPermissionNotice';
import RescheduleReminderDialog, {
  toLocalInputValue,
} from '../components/reminders/RescheduleReminderDialog';

const notice = (overrides: Record<string, unknown> = {}) => {
  const onRequest = vi.fn(async () => 'granted' as const);

  render(
    <NotificationPermissionNotice
      permission="prompt"
      lastSkip={null}
      lastSyncFailed={false}
      armedCount={0}
      onRequest={onRequest}
      {...overrides}
    />,
  );

  return { onRequest };
};

describe('permission notice', () => {
  it('offers a button while permission can still be asked for', () => {
    notice({ permission: 'prompt' });

    expect(screen.getByRole('button', { name: 'Enable notifications' })).toBeInTheDocument();
  });

  it('asks the plugin when the button is pressed', async () => {
    const { onRequest } = notice({ permission: 'prompt' });

    fireEvent.click(screen.getByRole('button', { name: 'Enable notifications' }));

    await waitFor(() => expect(onRequest).toHaveBeenCalledTimes(1));
  });

  it('explains what happened when the owner declines', async () => {
    const onRequest = vi.fn(async () => 'denied' as const);
    render(
      <NotificationPermissionNotice
        permission="prompt"
        lastSkip={null}
        lastSyncFailed={false}
        armedCount={0}
        onRequest={onRequest}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Enable notifications' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('declined');
  });

  it('does NOT offer a button once permission is denied', () => {
    notice({ permission: 'denied' });

    // Android will not show a dialog again from inside the app, so a button would do nothing.
    expect(screen.queryByRole('button', { name: 'Enable notifications' })).not.toBeInTheDocument();
  });

  it('tells the owner where to turn it back on instead', () => {
    notice({ permission: 'denied' });

    // No settings deep link is claimed: the installed plugin exposes only
    // changeExactNotificationSetting(), which is the exact-alarm screen this feature avoids.
    expect(screen.getByRole('alert')).toHaveTextContent('Settings');
  });

  it('says WhatsApp still works when the phone will not ring', () => {
    notice({ permission: 'denied' });

    // The two channels are independent, and a denied permission must not read as "no reminder".
    expect(screen.getByRole('alert')).toHaveTextContent('WhatsApp');
  });

  it('confirms when alarms are on, and how many are armed', () => {
    notice({ permission: 'granted', armedCount: 3 });

    expect(screen.getByRole('status')).toHaveTextContent('3 armed');
  });

  it('mentions a failed sync without hiding that alarms are on', () => {
    notice({ permission: 'granted', armedCount: 2, lastSyncFailed: true });

    expect(screen.getByRole('status')).toHaveTextContent('Could not reach the server');
  });

  it.each([
    ['the plugin is unavailable', { permission: 'unsupported' as const, lastSkip: null }],
    [
      'the platform cannot schedule',
      { permission: 'prompt' as const, lastSkip: 'unsupported-platform' as const },
    ],
  ])('explains the web build when %s', (_label, overrides) => {
    notice(overrides);

    // Not a fault to fix - it is the nature of a web page, so no permission button appears.
    expect(screen.getByText(/Android app/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Enable notifications' })).not.toBeInTheDocument();
  });
});

describe('toLocalInputValue', () => {
  it('produces the YYYY-MM-DDTHH:mm a datetime-local input wants', () => {
    const iso = '2026-10-12T11:30:00.000Z';
    const value = toLocalInputValue(iso);

    expect(value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    // Round-trips back to the same instant through the browser's own zone.
    expect(new Date(value).toISOString()).toBe(iso);
  });

  it('returns empty for an unparseable date rather than NaN', () => {
    expect(toLocalInputValue('not-a-date')).toBe('');
  });
});

const dialog = (overrides: Record<string, unknown> = {}) => {
  const onSave = vi.fn();
  const onCancel = vi.fn();
  const future = new Date(Date.now() + 86_400_000).toISOString();

  render(
    <RescheduleReminderDialog
      title="Call Rahul"
      dueAt={future}
      busy={false}
      error={null}
      onCancel={onCancel}
      onSave={onSave}
      {...overrides}
    />,
  );

  return { onSave, onCancel };
};

describe('reschedule dialog', () => {
  it('pre-fills with the current time so a small change is a small edit', () => {
    dialog();

    expect((screen.getByLabelText('New reminder time') as HTMLInputElement).value).not.toBe('');
  });

  it('saves an absolute instant', () => {
    const { onSave } = dialog();
    const future = new Date(Date.now() + 172_800_000);
    const local = new Date(future.getTime() - future.getTimezoneOffset() * 60_000)
      .toISOString()
      .slice(0, 16);

    fireEvent.change(screen.getByLabelText('New reminder time'), { target: { value: local } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0]![0]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('refuses a time in the past', () => {
    const { onSave } = dialog();

    fireEvent.change(screen.getByLabelText('New reminder time'), {
      target: { value: '2020-01-01T09:00' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('already passed');
  });

  it('refuses an empty time', () => {
    const { onSave } = dialog();

    fireEvent.change(screen.getByLabelText('New reminder time'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('Pick a date and time');
  });

  it('cancels without saving', () => {
    const { onSave, onCancel } = dialog();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('shows an API error the prompt could never have shown', () => {
    dialog({ error: 'Follow-up task not found.' });

    expect(screen.getByRole('alert')).toHaveTextContent('Follow-up task not found.');
  });

  it('cannot be submitted twice while saving', () => {
    const { onSave } = dialog({ busy: true });

    // The button is disabled, but a form can still be submitted from the keyboard.
    fireEvent.submit(screen.getByRole('dialog').querySelector('form')!);

    expect(onSave).not.toHaveBeenCalled();
  });

  it('is announced as a dialog for screen readers', () => {
    dialog();

    expect(screen.getByRole('dialog', { name: 'Reschedule Call Rahul' })).toBeInTheDocument();
  });
});

describe('the late-reminder warning', () => {
  const noticeWith = (overrides: Record<string, unknown> = {}) => {
    const onRequestExactAlarm = vi.fn(async () => 'granted' as const);

    render(
      <NotificationPermissionNotice
        permission="granted"
        exactAlarm="denied"
        lastSkip={null}
        lastSyncFailed={false}
        armedCount={2}
        onRequest={vi.fn(async () => 'granted' as const)}
        onRequestExactAlarm={onRequestExactAlarm}
        {...overrides}
      />,
    );

    return { onRequestExactAlarm };
  };

  it('warns when alarms are on but may fire late', () => {
    noticeWith();

    // THE STATE THIS EXISTS FOR. Before this, the screen said "Phone alarms are on" and the
    // reminders arrived minutes late with nothing anywhere admitting why.
    expect(screen.getByText('Reminders may ring late.')).toBeInTheDocument();
    expect(screen.queryByText(/Phone alarms are on/)).not.toBeInTheDocument();
  });

  it('offers the settings screen, because this one CAN be deep-linked', async () => {
    const { onRequestExactAlarm } = noticeWith();

    fireEvent.click(screen.getByRole('button', { name: 'Allow exact alarms' }));

    await waitFor(() => expect(onRequestExactAlarm).toHaveBeenCalledTimes(1));
  });

  it('says the WhatsApp reminder is unaffected', () => {
    noticeWith();

    // The two channels are independent and the owner should not think reminders are broken.
    expect(screen.getByText(/WhatsApp reminder is unaffected/)).toBeInTheDocument();
  });

  it('is silent about exactness once it is granted', () => {
    noticeWith({ exactAlarm: 'granted' });

    expect(screen.getByText(/will ring on the minute/)).toBeInTheDocument();
    expect(screen.queryByText('Reminders may ring late.')).not.toBeInTheDocument();
  });

  it('says nothing about exact alarms where the setting does not exist', () => {
    // Android < 12, iOS, and the browser. Warning here would be about a screen with no such
    // option on it.
    noticeWith({ exactAlarm: 'unsupported' });

    expect(screen.queryByText('Reminders may ring late.')).not.toBeInTheDocument();
    expect(screen.getByText(/Phone alarms are on/)).toBeInTheDocument();
  });

  it('does not claim exactness when the notice has no handler wired', () => {
    render(
      <NotificationPermissionNotice
        permission="granted"
        lastSkip={null}
        lastSyncFailed={false}
        armedCount={0}
        onRequest={vi.fn(async () => 'granted' as const)}
      />,
    );

    expect(screen.getByText(/Phone alarms are on/)).toBeInTheDocument();
    expect(screen.queryByText(/will ring on the minute/)).not.toBeInTheDocument();
  });
});
