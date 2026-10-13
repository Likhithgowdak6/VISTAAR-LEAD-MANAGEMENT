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
        super.onCreate(savedInstanceState);
    }
}
