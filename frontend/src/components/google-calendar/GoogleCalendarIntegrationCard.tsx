import React, { useCallback, useEffect, useState } from 'react';
import {
  disconnectGoogleCalendar,
  getGoogleCalendarAuthUrl,
  getGoogleCalendarStatus,
  listUncertainEvents,
  syncGoogleCalendarNow,
  updateGoogleCalendars,
  type GoogleCalendarItem,
  type GoogleCalendarStatusResponse,
  type UncertainEventItem,
} from '../../api/endpoints';
import { useAuth } from '../../auth/AuthContext';
import Spinner from '../Spinner';
import { UncertainEventsReviewModal } from './UncertainEventsReviewModal';

export const GoogleCalendarIntegrationCard: React.FC = () => {
  const { authedRequest } = useAuth();
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [status, setStatus] = useState<GoogleCalendarStatusResponse | null>(null);
  const [calendars, setCalendars] = useState<GoogleCalendarItem[]>([]);
  const [uncertainEvents, setUncertainEvents] = useState<UncertainEventItem[]>([]);
  const [reviewModalOpen, setReviewModalOpen] = useState(false);
  const [customMinutes, setCustomMinutes] = useState(120);
  const [savingSettings, setSavingSettings] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await authedRequest((token) => getGoogleCalendarStatus({ token }));
      setStatus(res.data);
      if (res.data?.calendars) {
        setCalendars(res.data.calendars);
      }
      if (res.data?.connection?.customReminderMinutes) {
        setCustomMinutes(res.data.connection.customReminderMinutes);
      }
      if (res.data?.uncertainCount && res.data.uncertainCount > 0) {
        const eventsRes = await authedRequest((token) => listUncertainEvents({ token }));
        setUncertainEvents(eventsRes.data.events || []);
      } else {
        setUncertainEvents([]);
      }
      setError(null);
    } catch (err: any) {
      setError(err?.message || 'Failed to load Google Calendar status.');
    } finally {
      setLoading(false);
    }
  }, [authedRequest]);

  useEffect(() => {
    fetchStatus();
    // Catch OAuth callback redirect parameters
    try {
      const params = new URLSearchParams(window.location.search);
      if (params.get('google_calendar_connected') === 'true') {
        setNotice('Google Calendar connected successfully!');
        window.history.replaceState({}, document.title, window.location.pathname);
      } else if (params.get('google_calendar_error')) {
        const errParam = params.get('google_calendar_error');
        setError(errParam === 'access_denied' ? 'Google authentication was cancelled.' : `Google connection error: ${errParam}`);
        window.history.replaceState({}, document.title, window.location.pathname);
      }
    } catch {
      // Ignore URL parsing errors in test environments
    }
  }, [fetchStatus]);

  const handleConnect = async () => {
    setConnecting(true);
    setError(null);
    try {
      const res = await authedRequest((token) => getGoogleCalendarAuthUrl({ token }));
      if (res.data?.authUrl) {
        window.location.href = res.data.authUrl;
      }
    } catch (err: any) {
      setError(err?.message || 'Failed to start Google authentication.');
      setConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    if (!window.confirm('Disconnect Google Calendar? Scheduled calendar reminders will be halted.')) {
      return;
    }
    setDisconnecting(true);
    setError(null);
    try {
      await authedRequest((token) => disconnectGoogleCalendar({ token }));
      setNotice('Google Calendar disconnected.');
      await fetchStatus();
    } catch (err: any) {
      setError(err?.message || 'Failed to disconnect.');
    } finally {
      setDisconnecting(false);
    }
  };

  const handleSyncNow = async () => {
    setSyncing(true);
    setError(null);
    setNotice(null);
    try {
      const res = await authedRequest((token) => syncGoogleCalendarNow({ token }));
      const s = res.data?.stats || {};
      setNotice(`Sync complete: ${s.created || 0} created, ${s.updated || 0} updated, ${s.cancelled || 0} cancelled.`);
      await fetchStatus();
    } catch (err: any) {
      setError(err?.message || 'Sync failed.');
    } finally {
      setSyncing(false);
    }
  };

  const handleToggleCalendar = async (calendarId: string, currentEnabled: boolean) => {
    const updated = calendars.map((c) =>
      c.calendarId === calendarId ? { ...c, syncEnabled: !currentEnabled } : c
    );
    setCalendars(updated);
    setSavingSettings(true);
    try {
      await authedRequest((token) =>
        updateGoogleCalendars({
          token,
          calendars: updated.map((c) => ({
            calendarId: c.calendarId,
            syncEnabled: c.syncEnabled,
          })),
          customReminderMinutes: customMinutes,
        })
      );
      setNotice('Calendar preferences saved.');
      await fetchStatus();
    } catch (err: any) {
      setError(err?.message || 'Failed to update calendar selection.');
    } finally {
      setSavingSettings(false);
    }
  };

  const handleSaveReminderSettings = async () => {
    setSavingSettings(true);
    setError(null);
    try {
      await authedRequest((token) =>
        updateGoogleCalendars({
          token,
          calendars: calendars.map((c) => ({
            calendarId: c.calendarId,
            syncEnabled: c.syncEnabled,
          })),
          customReminderMinutes: customMinutes,
        })
      );
      setNotice('Reminder timing updated.');
    } catch (err: any) {
      setError(err?.message || 'Failed to update reminder timings.');
    } finally {
      setSavingSettings(false);
    }
  };

  if (loading) {
    return (
      <div className="p-6 rounded-2xl border border-edge bg-surface-card flex items-center justify-center">
        <Spinner label="Loading Google Calendar..." />
      </div>
    );
  }

  const isConnected = Boolean(status?.connected && status?.connection && status.connection.status === 'connected');
  const isNeedsReauth = Boolean(status?.connection && status.connection.status === 'needs_reauth');

  return (
    <div className="p-6 rounded-2xl border border-edge bg-surface-card shadow-sm hover:border-edge/80 transition-all">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center text-blue-500 font-bold text-lg">
            📅
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-base font-bold text-text">Google Calendar Integration</h2>
              {isConnected ? (
                <span className="flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/10 text-emerald-500 border border-emerald-500/20">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                  Connected
                </span>
              ) : isNeedsReauth ? (
                <span className="flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[10px] font-semibold bg-amber-500/10 text-amber-500 border border-amber-500/20">
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
                  Re-auth Required
                </span>
              ) : (
                <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-surface-elevated text-text-subtle border border-edge">
                  Not Connected
                </span>
              )}
            </div>
            <p className="text-xs text-text-subtle mt-0.5">
              Two-way calendar sync, smart event classification, WhatsApp reminders & Android alarms.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 self-start sm:self-center">
          {isConnected ? (
            <>
              <button
                disabled={syncing}
                onClick={handleSyncNow}
                className="px-3.5 py-2 rounded-xl text-xs font-semibold bg-surface-elevated hover:bg-surface-elevated/80 text-text border border-edge flex items-center gap-1.5 transition-all disabled:opacity-50"
              >
                {syncing ? <Spinner label="Syncing..." /> : '↻ Sync Now'}
              </button>
              <button
                disabled={disconnecting}
                onClick={handleDisconnect}
                className="px-3.5 py-2 rounded-xl text-xs font-semibold text-red-500 hover:bg-red-500/10 border border-red-500/20 transition-all disabled:opacity-50"
              >
                {disconnecting ? <Spinner label="Disconnecting..." /> : 'Disconnect'}
              </button>
            </>
          ) : (
            <button
              disabled={connecting}
              onClick={handleConnect}
              className={`px-4 py-2 rounded-xl text-xs font-semibold ${isNeedsReauth ? 'bg-amber-600 hover:bg-amber-700' : 'bg-brand-primary hover:bg-brand-primary/90'} text-white shadow-md flex items-center gap-2 transition-all disabled:opacity-50`}
            >
              {connecting ? <Spinner label="Connecting..." /> : isNeedsReauth ? '⚠️ Reconnect Google Calendar' : '🔗 Connect Google Calendar'}
            </button>
          )}
        </div>
      </div>

      {/* Notices & Errors */}
      {isNeedsReauth && (
        <div className="mt-4 p-3 bg-amber-500/10 border border-amber-500/30 text-amber-600 dark:text-amber-400 rounded-xl text-xs">
          Google Calendar authorization was revoked or expired. Please click "Reconnect Google Calendar" to re-authorize.
        </div>
      )}

      {/* Notices & Errors */}
      {notice && (
        <div className="mt-4 p-3 bg-emerald-500/10 border border-emerald-500/30 text-emerald-500 rounded-xl text-xs">
          {notice}
        </div>
      )}
      {error && (
        <div className="mt-4 p-3 bg-red-500/10 border border-red-500/30 text-red-500 rounded-xl text-xs">
          {error}
        </div>
      )}

      {/* Connected Details */}
      {isConnected && status?.connection && (
        <div className="mt-6 pt-6 border-t border-edge/60 space-y-5">
          {/* Account info bar */}
          <div className="flex flex-wrap items-center justify-between gap-3 p-3.5 rounded-xl bg-surface-subtle border border-edge/60 text-xs">
            <div>
              <span className="text-text-subtle">Account: </span>
              <span className="font-semibold text-text">{status.connection.accountEmail}</span>
            </div>
            {status.connection.lastSyncAt && (
              <div className="text-text-subtle">
                Last synced:{' '}
                <span className="text-text">
                  {new Date(status.connection.lastSyncAt).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
              </div>
            )}
          </div>

          {/* Pending Reviews Pill */}
          {uncertainEvents.length > 0 && (
            <div className="flex items-center justify-between p-3.5 rounded-xl bg-amber-500/10 border border-amber-500/20 text-xs">
              <div className="flex items-center gap-2 text-amber-500 font-medium">
                <span>⚠️</span>
                <span>
                  <strong>{uncertainEvents.length} event(s)</strong> need customer confirmation before WhatsApp reminders can fire.
                </span>
              </div>
              <button
                onClick={() => setReviewModalOpen(true)}
                className="px-3 py-1 bg-amber-500 text-white rounded-lg font-semibold hover:bg-amber-600 transition-colors"
              >
                Review Events
              </button>
            </div>
          )}

          {/* Calendar Selection */}
          <div>
            <h3 className="text-xs font-bold uppercase tracking-wider text-text-subtle mb-3">
              Connected Calendars
            </h3>
            {calendars.length === 0 ? (
              <p className="text-xs text-text-subtle">No calendars found.</p>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                {calendars.map((cal) => (
                  <label
                    key={cal.calendarId}
                    className={`flex items-center justify-between p-3 rounded-xl border transition-all cursor-pointer ${
                      cal.syncEnabled
                        ? 'border-brand-primary/50 bg-brand-primary/5 text-text'
                        : 'border-edge bg-surface-card/60 text-text-subtle hover:border-edge/80'
                    }`}
                  >
                    <div className="pr-2 truncate">
                      <p className="text-xs font-semibold text-text truncate">
                        {cal.summary || 'Primary Calendar'}
                      </p>
                      <p className="text-[10px] text-text-subtle truncate">
                        {cal.isPrimary ? 'Primary Google Calendar' : cal.timeZone}
                      </p>
                    </div>
                    <input
                      type="checkbox"
                      checked={cal.syncEnabled}
                      disabled={savingSettings}
                      onChange={() => handleToggleCalendar(cal.calendarId, cal.syncEnabled)}
                      className="w-4 h-4 rounded text-brand-primary focus:ring-0 border-edge cursor-pointer"
                    />
                  </label>
                ))}
              </div>
            )}
          </div>

          {/* Reminder Timing Preferences */}
          <div className="pt-4 border-t border-edge/60">
            <h3 className="text-xs font-bold uppercase tracking-wider text-text-subtle mb-3">
              Automated Reminders & Handset Alarms
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {/* Default WhatsApp Reminder */}
              <div className="p-3.5 rounded-xl border border-edge bg-surface-subtle">
                <div className="flex items-center gap-2">
                  <span className="text-base">💬</span>
                  <div>
                    <h4 className="text-xs font-semibold text-text">Standard WhatsApp Reminder</h4>
                    <p className="text-[11px] text-text-subtle mt-0.5">
                      Fires automatically <strong>15 minutes</strong> before confirmed customer meetings.
                    </p>
                  </div>
                </div>
              </div>

              {/* Custom WhatsApp Reminder */}
              <div className="p-3.5 rounded-xl border border-edge bg-surface-subtle flex flex-col justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-base">⏱️</span>
                    <div>
                      <h4 className="text-xs font-semibold text-text">Custom Advance Reminder</h4>
                      <p className="text-[11px] text-text-subtle mt-0.5">
                        Owner-defined second WhatsApp reminder for meetings.
                      </p>
                    </div>
                  </div>
                </div>
                <div className="mt-3 flex items-center gap-2">
                  <select
                    value={customMinutes}
                    onChange={(e) => setCustomMinutes(Number(e.target.value))}
                    className="flex-1 px-2.5 py-1.5 rounded-lg bg-surface-card border border-edge text-xs text-text focus:outline-none focus:border-brand-primary"
                  >
                    <option value={30}>30 minutes before</option>
                    <option value={60}>1 hour before</option>
                    <option value={120}>2 hours before (Default)</option>
                    <option value={240}>4 hours before</option>
                    <option value={1440}>1 day before (24 hours)</option>
                    <option value={2880}>2 days before (48 hours)</option>
                  </select>
                  <button
                    disabled={savingSettings}
                    onClick={handleSaveReminderSettings}
                    className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-surface-elevated hover:bg-surface-elevated/80 border border-edge text-text transition-colors disabled:opacity-50"
                  >
                    Save
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Review Modal */}
      <UncertainEventsReviewModal
        isOpen={reviewModalOpen}
        events={uncertainEvents}
        onClose={() => setReviewModalOpen(false)}
        onUpdated={() => {
          setReviewModalOpen(false);
          fetchStatus();
        }}
      />
    </div>
  );
};
