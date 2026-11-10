package com.ourspace.app;

import android.app.Activity;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * OurSpaceShell, as public/js/core/native.js sees it.
 *   hideSplash()      the page has painted its first frame: take the splash overlay away.
 *   setTabs({ spec }) draw the native tab bar from a spec public/js/core/tabspec.js measured off the live
 *                     `.ms-tabs`; spec: null takes it away. deviations.md D3, D22.
 *   'tabTap' event    { id, href } when one is tapped; core/tabbar.js routes it through the page's own router.
 * (iOS also has authenticate(); on Android the sign-in sheet is a Custom Tab opened by @capacitor/browser, and the
 * ourspace:// return arrives as App.appUrlOpen, so there is nothing to do here for it.)
 */
@CapacitorPlugin(name = "OurSpaceShell")
public class ShellPlugin extends Plugin {

    @Override
    public void load() {
        Activity a = getActivity();
        if (a instanceof MainActivity) {
            ((MainActivity) a).setTabTapListener((id, href) -> {
                JSObject ev = new JSObject();
                ev.put("id", id);
                ev.put("href", href);
                notifyListeners("tabTap", ev);
            });
        }
    }

    @PluginMethod
    public void hideSplash(final PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (getActivity() instanceof MainActivity) ((MainActivity) getActivity()).hideSplash();
            call.resolve();
        });
    }

    @PluginMethod
    public void setTabs(final PluginCall call) {
        // getObject returns null for an explicit JSON null, which is how the page asks for the bar to go away
        final JSObject spec = call.getObject("spec");
        getActivity().runOnUiThread(() -> {
            Activity a = getActivity();
            if (!(a instanceof MainActivity)) { call.reject("no shell activity"); return; }
            boolean drawn = ((MainActivity) a).setTabs(spec);
            JSObject r = new JSObject();
            r.put("drawn", drawn);
            call.resolve(r);
        });
    }
}
