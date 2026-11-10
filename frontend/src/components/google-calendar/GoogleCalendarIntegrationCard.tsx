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

const GoogleLogo = ({ className = 'w-5 h-5' }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
    <path
      fill="#4285F4"
      d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
    />
    <path
      fill="#34A853"
      d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
    />
    <path
      fill="#FBBC05"
      d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"
    />
    <path
      fill="#EA4335"
      d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"
    />
  </svg>
);

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
      const payload = res?.data || (res as any);
      setStatus(payload);
      if (payload?.calendars) {
        setCalendars(payload.calendars);
      }
      if (payload?.connection?.customReminderMinutes) {
        setCustomMinutes(payload.connection.customReminderMinutes);
      }
      if (payload?.uncertainCount && payload.uncertainCount > 0) {
        const eventsRes = await authedRequest((token) => listUncertainEvents({ token }));
        const eventsData = eventsRes?.data?.events || (eventsRes as any)?.events || [];
        setUncertainEvents(eventsData);
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
      const authUrl = res?.data?.authUrl || (res as any)?.authUrl;
      if (authUrl) {
        window.location.href = authUrl;
      } else {
        setError('No authorization URL received from server.');
        setConnecting(false);
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
      const s = res?.data?.stats || (res as any)?.stats || {};
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
      <div className="p-8 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-sm flex items-center justify-center">
        <Spinner label="Loading Google Calendar..." />
      </div>
    );
  }

  const isConnected = Boolean(status?.connected && status?.connection && status.connection.status === 'connected');
  const isNeedsReauth = Boolean(status?.connection && status.connection.status === 'needs_reauth');

  return (
    <div className="p-6 sm:p-7 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-sm transition-all duration-200">
      {/* Top Header Row */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-5">
        <div className="flex items-start sm:items-center gap-3.5">
          <div className="w-12 h-12 shrink-0 rounded-2xl bg-blue-50 dark:bg-blue-950/50 border border-blue-200/80 dark:border-blue-800/60 flex items-center justify-center text-2xl shadow-xs">
            📅
          </div>
          <div>
            <div className="flex flex-wrap items-center gap-2.5">
              <h2 className="text-base sm:text-lg font-bold text-slate-900 dark:text-slate-100 tracking-tight">
                Google Calendar Integration
              </h2>
              {isConnected ? (
                <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800/60">
                  <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                  Connected
                </span>
              ) : isNeedsReauth ? (
                <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-400 border border-amber-200 dark:border-amber-800/60">
                  <span className="w-2 h-2 rounded-full bg-amber-500" />
                  Re-auth Required
                </span>
              ) : (
                <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700">
                  Not Connected
                </span>
              )}
            </div>
            <p className="text-xs sm:text-sm text-slate-500 dark:text-slate-400 mt-1 leading-relaxed">
              Two-way calendar sync, smart event classification, WhatsApp reminders &amp; Android alarms.
            </p>
          </div>
        </div>

        {/* Primary Action Button (Connect / Sync / Disconnect) */}
        <div className="flex items-center gap-2.5 shrink-0 self-start sm:self-center">
          {isConnected ? (
            <>
              <button
                type="button"
                disabled={syncing}
                onClick={handleSyncNow}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold bg-slate-100 hover:bg-slate-200/80 dark:bg-slate-800 dark:hover:bg-slate-700/80 text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-700 transition-all active:scale-95 disabled:opacity-50"
              >
                {syncing ? <Spinner label="Syncing..." /> : '↻ Sync Now'}
              </button>
              <button
                type="button"
                disabled={disconnecting}
                onClick={handleDisconnect}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold bg-red-50 hover:bg-red-100/80 dark:bg-red-950/30 dark:hover:bg-red-900/40 text-red-600 dark:text-red-400 border border-red-200 dark:border-red-900/60 transition-all active:scale-95 disabled:opacity-50"
              >
                {disconnecting ? <Spinner label="Disconnecting..." /> : 'Disconnect'}
              </button>
            </>
          ) : (
            <button
              type="button"
              disabled={connecting}
              onClick={handleConnect}
              className={`group relative inline-flex items-center justify-center gap-2.5 px-5 py-2.5 rounded-xl text-xs sm:text-sm font-semibold transition-all duration-200 shadow-md active:scale-95 disabled:opacity-70 disabled:cursor-not-allowed ${
                isNeedsReauth
                  ? 'bg-amber-600 hover:bg-amber-500 text-white shadow-amber-600/30 ring-2 ring-amber-500/40'
                  : 'bg-blue-600 hover:bg-blue-700 text-white shadow-blue-600/30 ring-2 ring-blue-500/50 dark:bg-blue-600 dark:hover:bg-blue-500 dark:shadow-blue-500/30 dark:ring-blue-400/40'
              }`}
            >
              {connecting ? (
                <>
                  <Spinner label="Connecting..." />
                  <span className="font-semibold tracking-wide">Connecting to Google...</span>
                </>
              ) : (
                <>
                  <div className="flex h-5 w-5 items-center justify-center rounded-full bg-white shadow-xs">
                    <GoogleLogo className="w-3.5 h-3.5" />
                  </div>
                  <span className="font-semibold tracking-wide">
                    {isNeedsReauth ? 'Reconnect Google Calendar' : 'Connect Google Calendar'}
                  </span>
                </>
              )}
            </button>
          )}
        </div>
      </div>

      {/* Notices & Alerts */}
      {isNeedsReauth && (
        <div className="mt-5 p-4 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800/50 text-amber-800 dark:text-amber-300 rounded-xl text-xs sm:text-sm flex items-start gap-2.5">
          <span className="text-base leading-none">⚠️</span>
          <div>
            <p className="font-semibold">Google Calendar authorization was revoked or expired.</p>
            <p className="text-xs text-amber-700 dark:text-amber-400 mt-0.5">
              Please click &ldquo;Reconnect Google Calendar&rdquo; above to re-authorize sync.
            </p>
          </div>
        </div>
      )}

      {notice && (
        <div className="mt-5 p-3.5 bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800/50 text-emerald-800 dark:text-emerald-300 rounded-xl text-xs sm:text-sm flex items-center justify-between">
          <span>{notice}</span>
          <button
            type="button"
            onClick={() => setNotice(null)}
            className="text-emerald-600 hover:text-emerald-800 dark:text-emerald-400 text-xs font-bold px-2 py-0.5"
          >
            ✕
          </button>
        </div>
      )}

      {error && (
        <div className="mt-5 p-3.5 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800/50 text-red-800 dark:text-red-300 rounded-xl text-xs sm:text-sm flex items-center justify-between">
          <span>{error}</span>
          <button
            type="button"
            onClick={() => setError(null)}
            className="text-red-600 hover:text-red-800 dark:text-red-400 text-xs font-bold px-2 py-0.5"
          >
            ✕
          </button>
        </div>
      )}

      {/* Connected Details Section */}
      {isConnected && status?.connection && (
        <div className="mt-6 pt-6 border-t border-slate-200 dark:border-slate-800 space-y-5">
          {/* Account info bar */}
          <div className="flex flex-wrap items-center justify-between gap-3 p-3.5 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200/80 dark:border-slate-700/80 text-xs">
            <div className="flex items-center gap-2">
              <span className="text-slate-500 dark:text-slate-400">Account:</span>
              <span className="font-semibold text-slate-800 dark:text-slate-100">{status.connection.accountEmail}</span>
            </div>
            {status.connection.lastSyncAt && (
              <div className="text-slate-500 dark:text-slate-400">
                Last synced:{' '}
                <span className="font-medium text-slate-700 dark:text-slate-200">
                  {new Date(status.connection.lastSyncAt).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
              </div>
            )}
          </div>

          {/* Pending Reviews Banner */}
          {uncertainEvents.length > 0 && (
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3.5 rounded-xl bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800/60 text-xs">
              <div className="flex items-center gap-2 text-amber-800 dark:text-amber-300 font-medium">
                <span className="text-base">⚠️</span>
                <span>
                  <strong>{uncertainEvents.length} event(s)</strong> require customer confirmation before automated WhatsApp reminders will fire.
                </span>
              </div>
              <button
                type="button"
                onClick={() => setReviewModalOpen(true)}
                className="shrink-0 px-3.5 py-1.5 bg-amber-600 hover:bg-amber-700 text-white rounded-lg font-semibold shadow-xs transition-colors"
              >
                Review Events
              </button>
            </div>
          )}

          {/* Calendar Selection */}
          <div>
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-3">
              Connected Calendars
            </h3>
            {calendars.length === 0 ? (
              <p className="text-xs text-slate-500 dark:text-slate-400">No calendars found.</p>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {calendars.map((cal) => (
                  <label
                    key={cal.calendarId}
                    className={`flex items-center justify-between p-3.5 rounded-xl border transition-all cursor-pointer ${
                      cal.syncEnabled
                        ? 'border-blue-500/50 bg-blue-50/50 dark:bg-blue-950/20 text-slate-900 dark:text-slate-100 ring-1 ring-blue-500/20'
                        : 'border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/40 text-slate-500 dark:text-slate-400 hover:border-slate-300 dark:hover:border-slate-700'
                    }`}
                  >
                    <div className="pr-3 truncate">
                      <p className="text-xs font-semibold text-slate-900 dark:text-slate-100 truncate">
                        {cal.summary || 'Primary Calendar'}
                      </p>
                      <p className="text-[11px] text-slate-500 dark:text-slate-400 truncate mt-0.5">
                        {cal.isPrimary ? 'Primary Google Calendar' : cal.timeZone}
                      </p>
                    </div>
                    <input
                      type="checkbox"
                      checked={cal.syncEnabled}
                      disabled={savingSettings}
                      onChange={() => handleToggleCalendar(cal.calendarId, cal.syncEnabled)}
                      className="w-4 h-4 rounded text-blue-600 focus:ring-0 border-slate-300 dark:border-slate-700 cursor-pointer"
                    />
                  </label>
                ))}
              </div>
            )}
          </div>

          {/* Automated Reminders & Alarms */}
          <div className="pt-5 border-t border-slate-200 dark:border-slate-800">
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-3">
              Automated Reminders &amp; Handset Alarms
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {/* Default WhatsApp Reminder */}
              <div className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-800/40">
                <div className="flex items-start gap-2.5">
                  <span className="text-xl">💬</span>
                  <div>
                    <h4 className="text-xs font-semibold text-slate-900 dark:text-slate-100">Standard WhatsApp Reminder</h4>
                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 leading-relaxed">
                      Fires automatically <strong>15 minutes</strong> before confirmed customer meetings via WhatsApp.
                    </p>
                  </div>
                </div>
              </div>

              {/* Custom WhatsApp Reminder */}
              <div className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-800/40 flex flex-col justify-between">
                <div className="flex items-start gap-2.5">
                  <span className="text-xl">⏱️</span>
                  <div>
                    <h4 className="text-xs font-semibold text-slate-900 dark:text-slate-100">Custom Advance Reminder</h4>
                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 leading-relaxed">
                      Owner-defined second advance WhatsApp reminder.
                    </p>
                  </div>
                </div>
                <div className="mt-3.5 flex items-center gap-2">
                  <select
                    value={customMinutes}
                    onChange={(e) => setCustomMinutes(Number(e.target.value))}
                    className="flex-1 px-3 py-1.5 rounded-lg bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 text-xs text-slate-900 dark:text-slate-100 focus:outline-none focus:border-blue-500"
                  >
                    <option value={30}>30 minutes before</option>
                    <option value={60}>1 hour before</option>
                    <option value={120}>2 hours before (Default)</option>
                    <option value={240}>4 hours before</option>
                    <option value={1440}>1 day before (24 hours)</option>
                    <option value={2880}>2 days before (48 hours)</option>
                  </select>
                  <button
                    type="button"
                    disabled={savingSettings}
                    onClick={handleSaveReminderSettings}
                    className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-white dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-200 transition-colors disabled:opacity-50"
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
