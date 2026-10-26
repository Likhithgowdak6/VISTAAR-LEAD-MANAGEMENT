package com.vistaarverse.leadmanagement;

import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.provider.AlarmClock;
import android.provider.Settings;

import java.util.Calendar;
import java.util.TimeZone;

/**
 * Creates one alarm in the phone's Clock app, from anywhere - including a closed app.
 *
 * THE PLATFORM PROBLEM, STATED ONCE. ACTION_SET_ALARM is the only API Android has for putting an
 * alarm into the Clock app, and it is an ACTIVITY action. There is no provider to insert into:
 * android.provider.AlarmClock is 23 String constants and a constructor, with no CONTENT_URI and
 * no methods (contrast CalendarContract.Events, which does have one - that is why a background
 * service can silently add a calendar event but not an alarm). So this must call startActivity,
 * and Android 10+ blocks that from the background unless an exemption applies.
 *
 * THE EXEMPTION THIS RELIES ON is "the app has the SYSTEM_ALERT_WINDOW permission granted by the
 * user" - one of eight documented, and the only one an ordinary app can reach. Receiving a
 * high-priority FCM message is not an exemption. An exact alarm firing is not an exemption. A
 * foreground service is not an exemption. If the owner has not granted it, this declines and
 * says so; it does not try and hope.
 *
 * WHY THE 24-HOUR RULE IS NOT NEGOTIABLE. ACTION_SET_ALARM takes an hour and a minute. It has no
 * concept of a date, and the Clock app rings at the NEXT occurrence of that time of day. For a
 * reminder due less than 24 hours out, the next occurrence IS the due instant. For one due
 * further out, the next occurrence is EARLIER - up to a full day early - and the owner is woken
 * for a call that is not until tomorrow. So the server sends the arming message inside that
 * window, and this checks again rather than trusting it: a message delayed in the FCM queue, or
 * a handset whose clock disagrees with the server's, would otherwise create a wrong alarm.
 *
 * LOCAL TIME IS THE HANDSET'S, NOT THE SERVER'S. The wire carries an absolute instant in epoch
 * millis and the hour and minute are computed here, in the device's own zone. A reminder set in
 * Asia/Kolkata on a phone that has since travelled still rings at the right moment.
 *
 * EVERY OUTCOME IS A REASON CODE, never a silent return. Which of these came back is the whole
 * diagnosis when an owner says "no alarm appeared", and it is logged without any of the
 * reminder's content.
 */
final class ClockAlarmArmer {

    /** The window inside which hour:minute identifies exactly one instant. */
    static final long WINDOW_MS = 24L * 60L * 60L * 1000L;

    static final String OK = "created";
    static final String NO_OVERLAY_PERMISSION = "no_overlay_permission";
    static final String OUT_OF_WINDOW = "out_of_window";
    static final String ALREADY_PAST = "already_past";
    static final String NO_CLOCK_APP = "no_clock_app";
    static final String LAUNCH_BLOCKED = "launch_blocked";

    private ClockAlarmArmer() {}

    /**
     * Whether a background launch would be permitted right now.
     *
     * Below Android 6 there is no such setting and no background restriction either, so the
     * answer is yes. `canDrawOverlays` is the exact check the platform itself applies.
     */
    static boolean canLaunchFromBackground(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
            return true;
        }

        return Settings.canDrawOverlays(context);
    }

    /**
     * Creates the alarm, or explains why it did not.
     *
     * @param dueAtMillis the reminder's absolute due instant
     * @param nowMillis   injected rather than read from the clock, so the window arithmetic is
     *                    testable and so both bounds are judged against one consistent instant
     */
    static String arm(Context context, long dueAtMillis, long nowMillis, String label) {
        // Checked FIRST, before anything observable. A blocked startActivity is silent - the
        // platform logs "Background activity launch blocked!" to its own logcat tag and the
        // caller gets neither an exception nor a return value - so asking beforehand is the
        // only way this can report the truth.
        if (!canLaunchFromBackground(context)) {
            return NO_OVERLAY_PERMISSION;
        }

        if (dueAtMillis <= nowMillis) {
            return ALREADY_PAST;
        }

        if (dueAtMillis - nowMillis >= WINDOW_MS) {
            return OUT_OF_WINDOW;
        }

        Calendar due = Calendar.getInstance(TimeZone.getDefault());
        due.setTimeInMillis(dueAtMillis);

        Intent intent = new Intent(AlarmClock.ACTION_SET_ALARM)
            .putExtra(AlarmClock.EXTRA_HOUR, due.get(Calendar.HOUR_OF_DAY))
            .putExtra(AlarmClock.EXTRA_MINUTES, due.get(Calendar.MINUTE))
            .putExtra(AlarmClock.EXTRA_MESSAGE, label)
            // A REQUEST, NOT A GUARANTEE - the platform says alarm apps "should" honour it.
            // Most create the alarm silently; an OEM clock that ignores it will put its own
            // screen up instead. That cannot be prevented from here and is the known cost of
            // this feature.
            .putExtra(AlarmClock.EXTRA_SKIP_UI, true)
            // Required when starting an activity from a Service or receiver context, which is
            // where this runs. Without it the platform throws.
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);

        if (intent.resolveActivity(context.getPackageManager()) == null) {
            return NO_CLOCK_APP;
        }

        try {
            context.startActivity(intent);
        } catch (Exception error) {
            // Covers ActivityNotFoundException from a clock app that disappeared between the
            // resolve and the launch, and the SecurityException some OEMs throw where the
            // platform would merely have logged.
            return LAUNCH_BLOCKED;
        }

        return OK;
    }
}
