import React from 'react';
import { GoogleCalendarIntegrationCard } from '../components/google-calendar/GoogleCalendarIntegrationCard';

const CalendarPage: React.FC = () => {
  return (
    <div className="mx-auto max-w-4xl space-y-6 p-4 sm:p-6 lg:p-8 animate-fade-in">
      {/* Page Title & Overview */}
      <div>
        <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">
          Calendar &amp; Schedule
        </h1>
        <p className="mt-1 text-xs sm:text-sm text-slate-500 dark:text-slate-400 max-w-2xl leading-relaxed">
          Manage your connected Google Calendars, monitor two-way sync, and configure automated WhatsApp meeting reminders and handset alarms.
        </p>
      </div>

      {/* Primary Integration Card */}
      <GoogleCalendarIntegrationCard />

      {/* Feature Highlights / Info Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-2">
        <div className="p-4 rounded-2xl border border-slate-200/80 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xs">
          <div className="w-8 h-8 rounded-xl bg-blue-50 dark:bg-blue-950/40 text-blue-600 dark:text-blue-400 flex items-center justify-center text-sm font-bold mb-3">
            🔄
          </div>
          <h3 className="text-xs font-bold text-slate-900 dark:text-slate-100">
            Real-Time Push Sync
          </h3>
          <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed">
            Changes in Google Calendar trigger instant incremental synchronization via webhooks.
          </p>
        </div>

        <div className="p-4 rounded-2xl border border-slate-200/80 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xs">
          <div className="w-8 h-8 rounded-xl bg-indigo-50 dark:bg-indigo-950/40 text-indigo-600 dark:text-indigo-400 flex items-center justify-center text-sm font-bold mb-3">
            🤖
          </div>
          <h3 className="text-xs font-bold text-slate-900 dark:text-slate-100">
            Smart Classification
          </h3>
          <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed">
            Events are matched to leads automatically. Personal events never receive customer reminders.
          </p>
        </div>

        <div className="p-4 rounded-2xl border border-slate-200/80 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xs">
          <div className="w-8 h-8 rounded-xl bg-emerald-50 dark:bg-emerald-950/40 text-emerald-600 dark:text-emerald-400 flex items-center justify-center text-sm font-bold mb-3">
            🔔
          </div>
          <h3 className="text-xs font-bold text-slate-900 dark:text-slate-100">
            Automated WhatsApp Reminders
          </h3>
          <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed">
            Scheduled WhatsApp alerts fire before confirmed meetings to guarantee zero missed consultations.
          </p>
        </div>
      </div>
    </div>
  );
};

export default CalendarPage;

