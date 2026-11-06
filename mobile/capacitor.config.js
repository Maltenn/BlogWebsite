// Capacitor 8 config for the OurSpace apps. The web layer is the unmodified ../public bundle.
// OURSPACE_ORIGIN (env var, or ourspace.config.json) is a BUILD-TIME setting: see docs/mobile/shells.md.
const cfg = require('./scripts/config.cjs');

/** @type {import('@capacitor/cli').CapacitorConfig} */
module.exports = {
  appId: cfg.appId,
  appName: cfg.appName,
  webDir: '../public',
  // The document's own canvas colour (app.css: body { background-color: #C3B1E1 }), so a rubber-band scroll or a resize
  // shows what the browser shows, never a white or black seam.
  backgroundColor: '#C3B1E1',
  server: {
    androidScheme: 'https',        // the page is https://localhost on Android (an app origin in contract.md); iOS stays capacitor://localhost
  },
  ios: {
    // 'never': the shell lays the web view out inside the safe area itself (ios/App/App/SceneDelegate.swift), so the page
    // is never under the notch and app.css needs no env(safe-area-inset-*).
    contentInset: 'never',
    backgroundColor: '#C3B1E1',
  },
  android: {
    backgroundColor: '#C3B1E1',
    // DELIBERATELY ABSENT: webContentsDebuggingEnabled and allowMixedContent. This file is written into the platform
    // projects by `cap sync` and ships in whatever APK / AAB is built next, so a value here cannot depend on the build type.
    //   webContentsDebuggingEnabled  Capacitor's own default is "on for a debuggable (debug) APK, off for a release"
    //                                (CapConfig.java); chrome://inspect would read the session token out of the web view.
    //   allowMixedContent            default off. A debug build that talks to an http:// dev origin from the https://localhost
    //                                page turns it on in android/.../MainActivity.java, for debuggable builds only.
    // scripts/check.mjs --release fails if a synced platform config says true to either.
  },
  plugins: {
    SystemBars: {
      style: 'DARK',               // light icons on the dark blue band behind the status bar
      insetsHandling: 'css',       // (default) the WebView stays inside the bars; the --safe-area-inset-* variables exist but nothing reads them
    },
    PushNotifications: { presentationOptions: ['badge', 'sound', 'alert'] },
  },
};
