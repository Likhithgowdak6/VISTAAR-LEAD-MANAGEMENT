package com.vistaarverse.leadmanagement;

import android.util.Log;

import androidx.annotation.NonNull;

import com.capacitorjs.plugins.pushnotifications.MessagingService;
import com.google.firebase.messaging.RemoteMessage;

import java.util.Map;

/**
 * The app's FCM entry point, and the only place that runs while Vistaar is closed.
 *
 * EXTENDS CAPACITOR'S SERVICE RATHER THAN REPLACING IT. Firebase delivers a message to exactly
 * one service, so adding a second alongside Capacitor's would make which one runs depend on
 * manifest-merge ordering. Instead Capacitor's is removed in AndroidManifest.xml and this
 * subclasses it, calling super on every callback: normal push notifications and token
 * registration behave exactly as they did before this file existed.
 *
 * WHAT IS ADDED is one data message, `type=clock-alarm`, which the server sends inside the 24
 * hours before a reminder falls due. Handling it here is the entire point of the feature - this
 * is the only code path that exists on a phone whose owner has not opened the app.
 *
 * SUPER FIRST, ALWAYS. The clock-alarm work is best-effort and additive; the push pipeline that
 * already works in production is not allowed to depend on it, which is why super.onMessageReceived
 * runs before any of it and why everything after is wrapped.
 *
 * NOTHING ABOUT THE LEAD IS LOGGED. The label travels to the Clock app because the owner needs
 * to recognise the alarm, but it is never written to logcat - only the outcome code is.
 */
public class VistaarMessagingService extends MessagingService {

    private static final String TAG = "VistaarClockAlarm";

    static final String TYPE_KEY = "type";
    static final String TYPE_CLOCK_ALARM = "clock-alarm";
    static final String DUE_AT_KEY = "dueAtMillis";
    static final String LABEL_KEY = "label";

    @Override
    public void onMessageReceived(@NonNull RemoteMessage remoteMessage) {
        // The existing behaviour, untouched and unconditional.
        super.onMessageReceived(remoteMessage);

        try {
            handleClockAlarm(remoteMessage.getData());
        } catch (Exception error) {
            // A malformed message must never take down the service that also delivers ordinary
            // reminders. Firebase would otherwise log a crash and the owner would lose pushes.
            Log.w(TAG, "clock-alarm message failed safely: " + error.getClass().getSimpleName());
        }
    }

    /**
     * Acts on a clock-alarm data message, ignoring everything else.
     *
     * Package-private and taking a plain Map so it can be exercised without a RemoteMessage,
     * which is final and cannot be constructed in a unit test.
     */
    void handleClockAlarm(Map<String, String> data) {
        if (data == null || !TYPE_CLOCK_ALARM.equals(data.get(TYPE_KEY))) {
            return;
        }

        String rawDueAt = data.get(DUE_AT_KEY);

        if (rawDueAt == null) {
            Log.w(TAG, "clock-alarm message had no due time");
            return;
        }

        long dueAtMillis;

        try {
            dueAtMillis = Long.parseLong(rawDueAt.trim());
        } catch (NumberFormatException error) {
            Log.w(TAG, "clock-alarm message had an unparseable due time");
            return;
        }

        String label = data.get(LABEL_KEY);

        if (label == null || label.trim().isEmpty()) {
            label = "Vistaar reminder";
        }

        String outcome = ClockAlarmArmer.arm(this, dueAtMillis, System.currentTimeMillis(), label);

        // The outcome code only - never the label, never the task id. This one line is the
        // whole diagnosis when an owner reports that no alarm appeared.
        Log.i(TAG, "clock-alarm: " + outcome);
    }
}
