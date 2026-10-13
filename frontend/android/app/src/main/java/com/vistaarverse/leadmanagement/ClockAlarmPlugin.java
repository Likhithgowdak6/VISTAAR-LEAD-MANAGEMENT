package com.vistaarverse.leadmanagement;

import android.content.Intent;
import android.content.pm.PackageManager;
import android.provider.AlarmClock;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Puts a reminder into the phone's own Clock app, as a real alarm.
 *
 * WHY THIS EXISTS ALONGSIDE THE NOTIFICATION. A local notification - even an exact one on a
 * high-importance channel - is a notification: it chimes once and sits in the shade. An owner
 * who asks to be reminded about a 2:20 call wants what their 6:15 wake-up does, which is ring
 * on the alarm stream until it is dealt with. Android has no API to make a notification behave
 * like that; the Clock app does it, and ACTION_SET_ALARM is how you ask the Clock app.
 *
 * WHAT THIS BUYS. The alarm is the Clock app's from the moment it is created. It rings at alarm
 * volume, it survives Vistaar being force-stopped or uninstalled, and it appears in the alarm
 * list next to the owner's own alarms.
 *
 * WHAT IT COSTS, because none of it is fixable from here:
 *
 *   1. ACTION_SET_ALARM takes an HOUR AND A MINUTE, not a date. The Clock app fires at the next
 *      occurrence of that time. The JS caller is therefore responsible for only ever sending a
 *      reminder that falls inside the next 24 hours, where "next occurrence" and "the moment the
 *      reminder is for" are the same instant. See clock-alarm.ts, which enforces that.
 *   2. THERE IS NO DELETE. The AlarmClock API can create and it can dismiss a ringing alarm; it
 *      cannot remove one. Completing or rescheduling a reminder in the CRM leaves whatever was
 *      already created in the Clock app, and the owner has to delete it there.
 *   3. EXTRA_SKIP_UI IS A REQUEST, NOT A GUARANTEE. The platform documents it as something the
 *      alarm app "should" honour. Most do and the alarm appears silently; some OEM clocks open
 *      their own screen instead, which is why this is only ever called from a foreground action.
 *
 * SET_ALARM is a normal permission, granted at install, with no runtime prompt - so unlike the
 * notification and exact-alarm settings there is nothing here for the owner to turn on.
 */
@CapacitorPlugin(name = "ClockAlarm")
public class ClockAlarmPlugin extends Plugin {

    /**
     * Whether anything on this device can answer ACTION_SET_ALARM.
     *
     * Checked rather than assumed: a phone can ship without a clock app that handles the intent,
     * and an unhandled startActivity throws ActivityNotFoundException. The caller uses this to
     * decide whether to tell the owner that Clock alarms are unavailable, instead of silently
     * doing nothing.
     *
     * Needs the <queries> entry in AndroidManifest.xml to return anything truthful on Android 11
     * and later, where package visibility is filtered by default.
     */
    @PluginMethod
    public void isAvailable(PluginCall call) {
        JSObject result = new JSObject();
        result.put("available", resolves(new Intent(AlarmClock.ACTION_SET_ALARM)));
        call.resolve(result);
    }

    /**
     * Creates one alarm in the Clock app.
     *
     * Rejects rather than resolving falsely when there is no clock app or the time is out of
     * range: the caller records what it believes it created, and a silent no-op here would leave
     * that record claiming an alarm exists that does not.
     */
    @PluginMethod
    public void set(PluginCall call) {
        Integer hour = call.getInt("hour");
        Integer minute = call.getInt("minute");

        if (hour == null || minute == null || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
            call.reject("INVALID_TIME");
            return;
        }

        String label = call.getString("label", "Vistaar reminder");

        Intent intent = new Intent(AlarmClock.ACTION_SET_ALARM)
            .putExtra(AlarmClock.EXTRA_HOUR, hour)
            .putExtra(AlarmClock.EXTRA_MINUTES, minute)
            .putExtra(AlarmClock.EXTRA_MESSAGE, label)
            // One alarm, for this reminder. Without EXTRA_DAYS the Clock app creates a one-shot
            // alarm, which is what a reminder is - a recurring one would outlive the thing it
            // was about and could never be removed from here.
            .putExtra(AlarmClock.EXTRA_SKIP_UI, Boolean.TRUE.equals(call.getBoolean("skipUi", true)));

        if (!resolves(intent)) {
            call.reject("NO_CLOCK_APP");
            return;
        }

        try {
            // From the Activity, deliberately, and not with FLAG_ACTIVITY_NEW_TASK. Android 10+
            // blocks activity launches from the background, so this only works while the app is
            // in the foreground - which is exactly when the sync that calls it runs.
            getActivity().startActivity(intent);
        } catch (Exception error) {
            call.reject("SET_ALARM_FAILED", error);
            return;
        }

        JSObject result = new JSObject();
        result.put("created", true);
        call.resolve(result);
    }

    private boolean resolves(Intent intent) {
        PackageManager packageManager = getContext().getPackageManager();

        return intent.resolveActivity(packageManager) != null;
    }
}
