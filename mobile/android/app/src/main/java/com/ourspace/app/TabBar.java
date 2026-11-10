package com.ourspace.app;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.RectF;
import android.graphics.Typeface;
import android.util.DisplayMetrics;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.HorizontalScrollView;
import android.widget.LinearLayout;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * The native tab bar (docs/mobile/deviations.md D3, D22, D23).
 *
 * Not a Material NavigationBar: that has a fixed 3-5 item model, its own label metrics, its own selection indicator
 * and its own badge shape, and the site's {@code .ms-tabs} is up to twelve bold-12px items that scroll sideways with a
 * pink pill badge and an active tab that inverts to white. So this is a real HorizontalScrollView of real clickable
 * Views — Android's own touch handling, fling physics, ripple-free press feedback, a haptic on tap — drawing what the
 * web bar is.
 *
 * Nothing here decides what the bar looks like. Every rectangle, colour, string and baseline arrives in a spec that
 * public/js/core/tabspec.js MEASURED from the live {@code .ms-tabs} in this very WebView milliseconds earlier, which
 * is what stops the bar drifting from app.css. tools/tabbar-check.mjs proves (48 cases, both engines, 0 pixels) that
 * a bar rebuilt from nothing but such a spec is pixel-identical to the web bar; what this file adds, and what only a
 * device can confirm, is that Canvas.drawText puts the same glyphs on the same baselines as the WebView does.
 *
 * The spec is in CSS pixels. On Android a CSS pixel is a density-independent pixel, so every number is multiplied by
 * {@code density} on the way to the canvas. The WebView is at the default scale (the page never zooms itself).
 */
public class TabBar extends LinearLayout {

    public interface OnTabTap { void onTabTap(String id, String href); }

    static final int SPEC_VERSION = 2;

    private final HorizontalScrollView scroller;
    private final FrameLayout canvas;
    private final View rule;
    private final List<ItemView> views = new ArrayList<>();
    private final float density;

    private Spec spec;
    private OnTabTap onTabTap;

    /* A vertical column of exactly two things: the scrolling bar, and the 1px rule under it (the web bar's
       `box-shadow: 0 1px 0 rgba(0,0,0,.25)`, which sits OUTSIDE the box and so is its own view). Every position comes
       from the spec by way of LayoutParams, so the normal measure/layout pass does the work and there is no custom
       onLayout fighting HorizontalScrollView over where its child goes. */
    public TabBar(Context context) {
        super(context);
        DisplayMetrics dm = getResources().getDisplayMetrics();
        density = dm.density;
        setOrientation(VERTICAL);

        scroller = new HorizontalScrollView(context);
        scroller.setHorizontalScrollBarEnabled(false);     // `.ms-tabs` hides its scrollbar (scrollbar-width: none)
        scroller.setFillViewport(true);
        scroller.setOverScrollMode(View.OVER_SCROLL_IF_CONTENT_SCROLLS);
        canvas = new FrameLayout(context);
        scroller.addView(canvas, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.MATCH_PARENT));
        addView(scroller, new LayoutParams(LayoutParams.MATCH_PARENT, 0));

        rule = new View(context);
        addView(rule, new LayoutParams(LayoutParams.MATCH_PARENT, 0));
        setVisibility(GONE);
    }

    public void setOnTabTap(OnTabTap l) { this.onTabTap = l; }

    /** The height the shell must reserve, in pixels: the bar plus its rule. 0 when there is nothing to draw. */
    public int barHeightPx() {
        if (spec == null) return 0;
        return Math.round((float) (spec.h + spec.ruleH) * density);
    }

    /**
     * Draw this spec, or null to show nothing.
     * @return true when the height changed and the shell must lay out again
     */
    public boolean show(JSONObject json) {
        int was = barHeightPx();
        Spec next = Spec.from(json);
        if (next == null || next.items.isEmpty()) {
            spec = null;
            canvas.removeAllViews();
            views.clear();
            setVisibility(GONE);
            return was != 0;
        }
        spec = next;
        setVisibility(VISIBLE);
        canvas.setBackgroundColor(next.bg);
        rule.setBackgroundColor(next.ruleColor);

        int barPx = Math.round((float) next.h * density);
        int rulePx = next.ruleH > 0 ? Math.max(1, Math.round((float) next.ruleH * density)) : 0;
        ((LayoutParams) scroller.getLayoutParams()).height = barPx;
        ((LayoutParams) rule.getLayoutParams()).height = rulePx;
        rule.setVisibility(rulePx > 0 ? VISIBLE : GONE);
        FrameLayout.LayoutParams canvasLp = (FrameLayout.LayoutParams) canvas.getLayoutParams();
        canvasLp.width = Math.round((float) Math.max(next.contentW, next.w) * density);
        canvasLp.height = barPx;

        if (views.size() != next.items.size()) {
            canvas.removeAllViews();
            views.clear();
            for (Item it : next.items) {
                ItemView v = new ItemView(getContext(), it, density);
                v.setOnClickListener(x -> {
                    v.performHapticFeedback(android.view.HapticFeedbackConstants.CLOCK_TICK);   // the web bar's tabs buzz too
                    if (onTabTap != null) onTabTap.onTabTap(v.item.id, v.item.href);
                });
                canvas.addView(v, new FrameLayout.LayoutParams(0, 0));
                views.add(v);
            }
        } else {
            for (int i = 0; i < views.size(); i++) views.get(i).apply(next.items.get(i));
        }
        // every tab's position is the measured one, handed to the layout system rather than drawn by hand
        for (int i = 0; i < views.size(); i++) {
            Item it = next.items.get(i);
            FrameLayout.LayoutParams lp = (FrameLayout.LayoutParams) views.get(i).getLayoutParams();
            lp.width = Math.round((float) it.w * density);
            lp.height = Math.round((float) it.h * density);
            lp.leftMargin = Math.round((float) it.x * density);
            lp.topMargin = Math.round((float) it.y * density);
            views.get(i).setLayoutParams(lp);
        }
        requestLayout();
        post(this::scrollActiveIntoView);
        return barHeightPx() != was;
    }

    /** The active tab is brought into view, which the web bar does not do and a native bar is expected to. */
    private void scrollActiveIntoView() {
        if (spec == null) return;
        for (int i = 0; i < spec.items.size(); i++) {
            if (!spec.items.get(i).on) continue;
            Item it = spec.items.get(i);
            int x = Math.round((float) it.x * density);
            int w = Math.round((float) it.w * density);
            int pad = Math.round(8 * density);
            if (x < scroller.getScrollX() || x + w > scroller.getScrollX() + scroller.getWidth()) {
                scroller.scrollTo(Math.max(0, x - pad), 0);
            }
            return;
        }
    }

    /* ------------------------------------------------------------------ one tab */

    private static class ItemView extends View {
        Item item;
        private final float density;
        private final Paint fill = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Paint text = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final RectF pill = new RectF();

        ItemView(Context c, Item item, float density) {
            super(c);
            this.density = density;
            setClickable(true);
            setFocusable(true);
            apply(item);
        }

        // The web bar's `.ms-tab:hover { background: #4477aa }` has no touch equivalent; a dim while held is the
        // native stand-in (deviations.md D23). Done through the pressed state rather than a touch listener, so the
        // view's own click, long-press and accessibility handling are untouched.
        @Override
        public void setPressed(boolean pressed) {
            super.setPressed(pressed);
            setAlpha(pressed ? 0.6f : 1f);
        }

        void apply(Item next) {
            item = next;
            setContentDescription(next.label.trim());
            setSelected(next.on);
            invalidate();
        }

        @Override
        protected void onDraw(Canvas c) {
            if (Color.alpha(item.bg) > 0) {
                fill.setColor(item.bg);
                c.drawRect(0, 0, getWidth(), getHeight(), fill);
            }
            drawRun(c, item.label, item.textX - item.x, item.baseline - item.y, item.font, item.fg);
            if (item.badge != null) {
                Badge b = item.badge;
                pill.set((float) ((b.x - item.x) * density), (float) ((b.y - item.y) * density),
                    (float) ((b.x - item.x + b.w) * density), (float) ((b.y - item.y + b.h) * density));
                float radius = (float) (Math.min(b.r, b.h / 2) * density);
                fill.setColor(b.bg);
                c.drawRoundRect(pill, radius, radius, fill);
                drawRun(c, b.s, b.textX - item.x, b.baseline - item.y, b.font, b.fg);
            }
        }

        private void drawRun(Canvas c, String s, double x, double baseline, FontSpec f, int colour) {
            if (s == null || s.isEmpty()) return;
            text.setTypeface(f.typeface());
            text.setTextSize((float) (f.size * density));
            text.setColor(colour);
            text.setTextAlign(Paint.Align.LEFT);
            // Canvas.drawText takes the baseline directly, which is exactly what the spec carries
            c.drawText(s, (float) (x * density), (float) (baseline * density), text);
        }
    }

    /* ------------------------------------------------------------------ the spec, as JSON arrives */

    private static int colour(String hex) {
        // '#rrggbbaa' — the only colour form that crosses the bridge (tabspec.js `hex`). Anything else is transparent,
        // which shows up as a missing fill rather than a wrong one.
        if (hex == null) return Color.TRANSPARENT;
        String s = hex.startsWith("#") ? hex.substring(1) : hex;
        if (s.length() != 8) return Color.TRANSPARENT;
        try {
            long v = Long.parseLong(s, 16);
            return Color.argb((int) (v & 0xff), (int) ((v >> 24) & 0xff), (int) ((v >> 16) & 0xff), (int) ((v >> 8) & 0xff));
        } catch (NumberFormatException e) { return Color.TRANSPARENT; }
    }

    /* The font the WEBVIEW resolved, not a font chosen here. `families` is app.css's own list
       ('MS Sans Serif', Tahoma, 'Segoe UI', Arial, sans-serif). Android has none of them, so the WebView falls through
       to its generic sans — Roboto on a Pixel, One UI Sans on a Samsung — and Typeface.create("sans-serif", …) is the
       same fall-through on the same device. Asking for "Arial" here would get a silent Roboto substitute on some
       devices and something else on others; asking for the generic gets the device's real answer. (deviations.md D4.) */
    private static class FontSpec {
        final List<String> families = new ArrayList<>();
        double size = 12;
        double weight = 400;
        boolean italic;
        private Typeface cached;

        /* Walks the SAME family list app.css gives the WebView, and stops at the first generic keyword. Named
           families are deliberately skipped: Android has no lookup that can answer "is this family installed?" —
           Typeface.create() never fails and silently hands back a substitute — so taking its word would mean picking
           a font on a guess. None of the names in app.css's list ('MS Sans Serif', Tahoma, 'Segoe UI', Arial) exists
           on Android anyway, so the WebView falls through to the generic too, and this ends on the same face it does:
           Roboto on a Pixel, One UI Sans on a Samsung. (deviations.md D4.) If a named family is ever bundled with the
           app, this is the method that has to learn about it. */
        Typeface typeface() {
            if (cached != null) return cached;
            int style = (weight >= 600 ? Typeface.BOLD : Typeface.NORMAL) | (italic ? Typeface.ITALIC : 0);
            String generic = "sans-serif";
            for (String f : families) {
                String key = f == null ? "" : f.toLowerCase(Locale.ROOT);
                if (GENERIC.contains(key)) { generic = key; break; }
            }
            cached = Typeface.create(Typeface.create(generic, Typeface.NORMAL), style);
            return cached;
        }

        static final List<String> GENERIC = java.util.Arrays.asList(
            "serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui",
            "ui-serif", "ui-sans-serif", "ui-monospace", "ui-rounded", "math", "emoji", "fangsong");

        static FontSpec from(JSONObject o) {
            FontSpec f = new FontSpec();
            if (o == null) return f;
            JSONArray fam = o.optJSONArray("families");
            if (fam != null) for (int i = 0; i < fam.length(); i++) f.families.add(fam.optString(i));
            f.size = o.optDouble("size", 12);
            f.weight = o.optDouble("weight", 400);
            f.italic = o.optBoolean("italic", false);
            return f;
        }
    }

    private static class Badge {
        String s; double x, y, w, h, r, textX, baseline; int bg, fg; FontSpec font;
    }

    private static class Item {
        String id, href, label; boolean on;
        double x, y, w, h, textX, baseline;
        int bg, fg; FontSpec font; Badge badge;
    }

    private static class Spec {
        double w, h, contentW, ruleH;
        int bg, ruleColor;
        final List<Item> items = new ArrayList<>();

        static Spec from(JSONObject o) {
            if (o == null || o.optInt("v", -1) != SPEC_VERSION) return null;
            Spec s = new Spec();
            s.w = o.optDouble("w", 0);
            s.h = o.optDouble("h", 0);
            s.contentW = o.optDouble("contentW", s.w);
            s.bg = colour(o.optString("bg", null));
            JSONObject rule = o.optJSONObject("rule");
            s.ruleH = rule == null ? 0 : rule.optDouble("h", 0);
            s.ruleColor = rule == null ? Color.TRANSPARENT : colour(rule.optString("color", null));
            JSONArray items = o.optJSONArray("items");
            if (items == null) return null;
            for (int i = 0; i < items.length(); i++) {
                JSONObject j = items.optJSONObject(i);
                if (j == null) continue;
                Item it = new Item();
                it.id = j.optString("id", String.valueOf(i));
                it.href = j.isNull("href") ? null : j.optString("href", null);
                it.label = j.optString("label", "");
                it.on = j.optBoolean("on", false);
                it.x = j.optDouble("x", 0); it.y = j.optDouble("y", 0);
                it.w = j.optDouble("w", 0); it.h = j.optDouble("h", 0);
                it.bg = colour(j.optString("bg", null));
                it.fg = colour(j.optString("fg", null));
                it.font = FontSpec.from(j.optJSONObject("font"));
                it.textX = j.optDouble("textX", it.x);
                it.baseline = j.optDouble("baseline", it.y);
                JSONObject b = j.optJSONObject("badge");
                if (b != null) {
                    Badge badge = new Badge();
                    badge.s = b.optString("s", "");
                    badge.x = b.optDouble("x", 0); badge.y = b.optDouble("y", 0);
                    badge.w = b.optDouble("w", 0); badge.h = b.optDouble("h", 0);
                    badge.r = b.optDouble("r", 0);
                    badge.bg = colour(b.optString("bg", null));
                    badge.fg = colour(b.optString("fg", null));
                    badge.font = FontSpec.from(b.optJSONObject("font"));
                    badge.textX = b.optDouble("textX", badge.x);
                    badge.baseline = b.optDouble("baseline", badge.y);
                    badge.s = badge.s == null ? "" : badge.s;
                    it.badge = badge;
                }
                s.items.add(it);
            }
            return s;
        }
    }
}
