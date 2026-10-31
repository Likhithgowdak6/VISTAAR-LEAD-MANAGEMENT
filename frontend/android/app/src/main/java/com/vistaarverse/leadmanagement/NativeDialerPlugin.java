package com.vistaarverse.leadmanagement;

import android.content.Intent;
import android.net.Uri;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Opens the phone's own dialler with a lead's number already filled in.
 *
 * ACTION_DIAL, AND DELIBERATELY NOT ACTION_CALL. The difference is not cosmetic:
 *
 *   ACTION_DIAL shows the number in the dialler and waits for the user to press call. It is
 *   documented as requiring NO permission, precisely because the user remains the one who
 *   decides to place the call.
 *
 *   ACTION_CALL dials immediately and requires the CALL_PHONE runtime permission. Vistaar does
 *   not declare it, does not request it, and must not: an app that can silently place calls is
 *   a different trust proposition, it is a permission Google Play scrutinises, and it removes
 *   the agent's last chance to notice they are about to ring the wrong customer.
 *
 * WHAT THIS PLUGIN DOES NOT DO, and cannot. It does not place the call, does not observe
 * whether the call connected, does not know how long it lasted, and does not record anything.
 * Android exposes none of that to an ordinary app: call state needs READ_PHONE_STATE plus a
 * foreground service to survive backgrounding, and the two sides of a cellular call need
 * CAPTURE_AUDIO_OUTPUT, which is signature|privileged and unobtainable here. The outcome of a
 * call is therefore supplied by a human in the app afterwards - see CallOutcomeDialog.
 *
 * NO LOGGING. The number is a customer's phone number. It goes from the call parameter into the
 * Intent and nowhere else; it is never written to logcat, not even on the failure path.
 */
@CapacitorPlugin(name = "NativeDialer")
public class NativeDialerPlugin extends Plugin {

    @PluginMethod
    public void openDialler(PluginCall call) {
        String number = call.getString("number");

        if (number == null || number.trim().isEmpty()) {
            // No number in the message, so the rejection cannot leak one either.
            call.reject("NO_NUMBER");
            return;
        }

        try {
            // Uri.encode, not string concatenation: a '+' in an E.164 number is a reserved
            // character in a URI and an unencoded one is read as a space, which quietly drops
            // the country code and dials a domestic number instead.
            Intent intent = new Intent(Intent.ACTION_DIAL, Uri.parse("tel:" + Uri.encode(number.trim())));

            // The plugin is invoked from a WebView, which is not an Activity context for intent
            // purposes on every OEM. NEW_TASK makes the handover reliable rather than depending
            // on how the host happened to be launched.
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);

            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception error) {
            // A handset with no dialler at all is not a real phone, but a tablet is - and the
            // UI has to be able to say "this device cannot place calls" rather than appearing
            // to do nothing. The exception message is not forwarded, in case it echoes the URI.
            call.reject("NO_DIALLER");
        }
    }
}
