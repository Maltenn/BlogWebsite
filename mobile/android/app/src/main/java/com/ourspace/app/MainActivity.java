package com.ourspace.app;

import android.content.pm.ApplicationInfo;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.graphics.drawable.LayerDrawable;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebSettings;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;

import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;

import com.getcapacitor.BridgeActivity;

import org.json.JSONObject;

/**
 * The activity around Capacitor's WebView. Capacitor 8's SystemBars plugin keeps the WebView inside the safe area (the
 * page is not drawn under the bars, so app.css needs no env(safe-area-inset-*)); what shows behind the bars is the decor
 * view's background. paintBands() makes that the two colours the site's own chrome has at the top and the bottom.
 *
 * The splash is an overlay on the WebView's frame: two bitmaps rendered from the real index.html + app.css
 * (mobile/scripts/make-splash.mjs): the header block on top, the footer block at the bottom, white between, which is the
 * page's first frame. public/js/core/native.js asks for it to go (ShellPlugin.hideSplash) once that frame is on screen.
 */
public class MainActivity extends BridgeActivity {
    // the CSS widths (dp) make-splash.mjs renders; a device in between uses the widest one that fits
    private static final int[] SPLASH_WIDTHS = {320, 360, 384, 393, 411, 412, 432, 600, 768, 800};

    private FrameLayout splash;
    private TabBar tabBar;
    private TabBar.OnTabTap tapListener;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ShellPlugin.class);
        super.onCreate(savedInstanceState);
        allowCleartextInDebug();
        paintBands();
        addTabBar();
        showSplash();
        // if the page never says it has drawn (the bridge failed to start), the splash must not be permanent
        new Handler(Looper.getMainLooper()).postDelayed(this::hideSplash, 8000);
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        // SystemBars repaints the decor view on a configuration change; put the bands back
        getWindow().getDecorView().post(this::paintBands);
    }

    /**
     * A debug build pointed at an http:// dev Worker (http://10.0.2.2:8787) loads it from the https://localhost page, which
     * the web view calls mixed content. That allowance is for debuggable builds ONLY: it is not in capacitor.config.js (the
     * synced config is the same file in every build type), and a release build never gets here. Cleartext at the network
     * layer is separately off in release (src/debug/ holds the only network_security_config).
     */
    private void allowCleartextInDebug() {
        boolean debuggable = (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        if (!debuggable || getBridge() == null || getBridge().getWebView() == null) return;
        getBridge().getWebView().getSettings().setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    private void paintBands() {
        ColorDrawable home = new ColorDrawable(Color.parseColor("#eef4ff"));
        ColorDrawable status = new ColorDrawable(Color.parseColor("#1c3f94"));
        LayerDrawable bands = new LayerDrawable(new android.graphics.drawable.Drawable[] {home, status});
        bands.setLayerGravity(1, Gravity.TOP | Gravity.FILL_HORIZONTAL);
        bands.setLayerHeight(1, dp(64));      // taller than any status bar or cutout; the WebView covers the excess
        getWindow().getDecorView().setBackground(bands);
    }

    /**
     * The native tab bar goes BELOW the WebView, not over it: Capacitor's own view is moved into a vertical column
     * with the bar under it, so the page's viewport really is shorter and the site's position-fixed bottom furniture
     * (.ms-fab, .ms-resumebar, #toasts) lands on top of the bar instead of behind it. deviations.md D22.
     *
     * The bar draws nothing until public/js/core/tabbar.js has measured the page's own `.ms-tabs` and sent a spec, so
     * at launch it is 0dp high and the layout is exactly what it was before this existed.
     */
    private void addTabBar() {
        ViewGroup content = findViewById(android.R.id.content);
        if (content == null || content.getChildCount() == 0) return;
        View bridgeRoot = content.getChildAt(0);
        content.removeView(bridgeRoot);

        LinearLayout column = new LinearLayout(this);
        column.setOrientation(LinearLayout.VERTICAL);
        column.addView(bridgeRoot, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        tabBar = new TabBar(this);
        tabBar.setOnTabTap((id, href) -> {
            if (tapListener != null) tapListener.onTabTap(id, href);
        });
        column.addView(tabBar, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        content.addView(column, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        // while the keyboard is up the bar goes away, as a native bottom bar does, so a composer is never typed into
        // with 28dp of navigation stuck between it and the keys
        ViewCompat.setOnApplyWindowInsetsListener(column, (v, insets) -> {
            boolean keyboard = insets.isVisible(WindowInsetsCompat.Type.ime());
            if (tabBar != null) tabBar.setVisibility(keyboard ? View.GONE : (tabBar.barHeightPx() > 0 ? View.VISIBLE : View.GONE));
            return insets;
        });
    }

    /** ShellPlugin registers here in load(), and turns a tap into the plugin's own 'tabTap' event. */
    void setTabTapListener(TabBar.OnTabTap l) { this.tapListener = l; }

    /** Called from ShellPlugin on the main thread: draw a measured bar, or null to take it away. */
    boolean setTabs(JSONObject spec) {
        if (tabBar == null) return false;
        tabBar.show(spec);
        boolean drawn = tabBar.barHeightPx() > 0;
        tabBar.setVisibility(drawn ? View.VISIBLE : View.GONE);
        return drawn;
    }

    private void showSplash() {
        int widthDp = getResources().getConfiguration().screenWidthDp;
        int pick = SPLASH_WIDTHS[0];
        for (int w : SPLASH_WIDTHS) {
            if (w <= widthDp) pick = w;
        }
        int topId = getResources().getIdentifier("splash_top_" + pick, "drawable", getPackageName());
        int footId = getResources().getIdentifier("splash_foot_" + pick, "drawable", getPackageName());
        if (topId == 0 || footId == 0) return;

        FrameLayout overlay = new FrameLayout(this);
        overlay.setBackgroundColor(Color.WHITE);              // #ms-content is white
        overlay.setClickable(false);
        overlay.addView(strip(topId, Gravity.TOP));
        overlay.addView(strip(footId, Gravity.BOTTOM));
        // android.R.id.content is inside the decor padding SystemBars applies, i.e. exactly the WebView's frame
        ((ViewGroup) findViewById(android.R.id.content)).addView(overlay, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        splash = overlay;
    }

    private ImageView strip(int drawableId, int gravity) {
        ImageView v = new ImageView(this);
        v.setImageResource(drawableId);
        v.setAdjustViewBounds(true);                          // scale to the width, keep the proportions
        v.setScaleType(ImageView.ScaleType.FIT_CENTER);
        v.setLayoutParams(new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, gravity));
        return v;
    }

    /** Called from ShellPlugin on the main thread. */
    void hideSplash() {
        if (splash == null) return;
        View s = splash;
        splash = null;
        ((ViewGroup) s.getParent()).removeView(s);
    }
}
