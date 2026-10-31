package com.vistaarverse.leadmanagement;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    /**
     * Plugins that live in this app rather than in a node_modules package have to be registered
     * by hand - Capacitor only auto-discovers the ones it installed. Registering BEFORE
     * super.onCreate() is required: the bridge is built there, and a plugin added afterwards is
     * not in it, which surfaces in JS as "ClockAlarm does not have an implementation".
     */
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ClockAlarmPlugin.class);
        // Opens the system dialler with a lead's number. ACTION_DIAL only - no CALL_PHONE
        // permission is declared or requested. See NativeDialerPlugin.
        registerPlugin(NativeDialerPlugin.class);
        super.onCreate(savedInstanceState);

        // The channel a reminder push rings on, created here rather than from JS because it
        // has to exist before the FIRST push - which can arrive on an install where no JS has
        // ever run. A no-op once it exists. See ReminderChannel.
        ReminderChannel.ensure(this);
    }
}
