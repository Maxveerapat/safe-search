package app.safesearch.shield;

import android.accessibilityservice.AccessibilityService;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.graphics.Rect;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.TextUtils;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import android.widget.TextView;
import android.widget.Toast;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Date;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Reads what a browser shows (through Android's Accessibility feature), finds search results,
 * checks each result's site live, and draws on top of the browser:
 *   – a grey cover over each not-safe result (default), or
 *   – a ✓ Safe / ⛔ Not safe badge next to every result (when "Show not-safe results" is on).
 * Works the same in any browser and on any search engine; nothing is installed in the browser.
 */
public class ShieldService extends AccessibilityService implements SharedPreferences.OnSharedPreferenceChangeListener {

    // Browsers we act in. Other apps are ignored.
    private static final Set<String> BROWSERS = new HashSet<>(Arrays.asList(
            "com.android.chrome", "com.chrome.beta", "com.chrome.dev", "com.chrome.canary",
            "com.sec.android.app.sbrowser", "com.sec.android.app.sbrowser.beta",
            "org.mozilla.firefox", "org.mozilla.firefox_beta", "org.mozilla.fenix", "org.mozilla.focus",
            "com.microsoft.emmx", "com.opera.browser", "com.opera.mini.native", "com.opera.gx",
            "com.brave.browser", "com.duckduckgo.mobile.android", "com.vivaldi.browser",
            "com.kiwibrowser.browser", "com.mi.globalbrowser", "com.huawei.browser", "com.UCMobile.intl",
            "com.yandex.browser", "com.ecosia.android"));

    // Search engines, so the shield only acts on result pages (and never hides the engine's own links).
    private static final Pattern SEARCH_PAGE = Pattern.compile(
            "(^|[/.])(google\\.[a-z.]+/search|bing\\.com/search|duckduckgo\\.com|search\\.yahoo\\.|yandex\\.[a-z]+/search|ecosia\\.org/search|search\\.brave\\.com|startpage\\.com|sogou\\.com|baidu\\.com/s|naver\\.com.*search|coccoc\\.com/search)");
    private static final Pattern ENGINE_DOMAIN = Pattern.compile(
            "(^|\\.)(google\\.[a-z.]+|gstatic\\.com|googleusercontent\\.com|youtube\\.com|bing\\.com|microsoft\\.com|duckduckgo\\.com|yahoo\\.[a-z.]+|yandex\\.[a-z]+|ecosia\\.org|brave\\.com|startpage\\.com|baidu\\.com|naver\\.com|coccoc\\.com)$");

    // A domain as search engines print it under a result title: "pantip.com › topic", "https://www.x.com", "x.co.th/..."
    private static final Pattern DOMAIN = Pattern.compile(
            "(?:https?://)?(?:www\\.)?((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,24})(?=$|[\\s/›:>?#…·|,)])",
            Pattern.CASE_INSENSITIVE);
    private static final String[] URL_EXTRA_KEYS = {"url", "AccessibilityNodeInfo.url", "href", "link"};
    private static final String[] URL_BAR_IDS = {
            ":id/url_bar", ":id/mozac_browser_toolbar_url_view", ":id/location_bar_edit_text",
            ":id/url_field", ":id/omnibarTextInput", ":id/address_bar_edit_text", ":id/url"};

    private static final int MAX_NODES = 5000;

    private final Handler main = new Handler(Looper.getMainLooper());
    private WindowManager wm;
    private SiteChecker checker;
    private final Map<String, View> overlays = new HashMap<>();
    private boolean scanQueued;
    private long lastScan;
    private final Runnable scanTask = () -> { scanQueued = false; scan(); };

    // ------------------------------------------------------------------ lifecycle
    @Override
    protected void onServiceConnected() {
        wm = (WindowManager) getSystemService(WINDOW_SERVICE);
        checker = new SiteChecker(() -> requestScan(0));
        Prefs.get(this).registerOnSharedPreferenceChangeListener(this);
    }

    @Override
    public void onSharedPreferenceChanged(SharedPreferences p, String key) {
        if (Prefs.DIAG.equals(key)) return;
        clearOverlays();
        requestScan(0);
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent e) {
        if (e == null || e.getPackageName() == null) return;
        String pkg = e.getPackageName().toString();
        if (pkg.equals(getPackageName())) return;
        if (!Prefs.enabled(this)) { clearOverlays(); return; }
        if (!BROWSERS.contains(pkg)) {
            if (e.getEventType() == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) clearOverlays();
            return;
        }
        // Scrolling moves the results: reposition quickly. Other changes: a little later.
        requestScan(e.getEventType() == AccessibilityEvent.TYPE_VIEW_SCROLLED ? 30 : 120);
    }

    @Override
    public void onInterrupt() { clearOverlays(); }

    @Override
    public void onDestroy() {
        clearOverlays();
        Prefs.get(this).unregisterOnSharedPreferenceChangeListener(this);
        super.onDestroy();
    }

    private void requestScan(long delay) {
        if (scanQueued) return;
        scanQueued = true;
        long since = System.currentTimeMillis() - lastScan;
        main.postDelayed(scanTask, Math.max(delay, since < 80 ? 80 - since : 0));
    }

    // ------------------------------------------------------------------ scanning
    private static final class Hit {
        final String domain; final Rect bounds; final String source;
        Hit(String d, Rect b, String s) { domain = d; bounds = b; source = s; }
    }

    private void scan() {
        lastScan = System.currentTimeMillis();
        if (!Prefs.enabled(this)) { clearOverlays(); return; }
        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root == null || root.getPackageName() == null || !BROWSERS.contains(root.getPackageName().toString())) {
            clearOverlays();
            return;
        }
        String pkg = root.getPackageName().toString();
        String urlBar = findUrlBar(root);
        boolean searchPage = urlBar != null && SEARCH_PAGE.matcher(urlBar.toLowerCase(Locale.ROOT)).find();
        if (Prefs.searchOnly(this) && urlBar != null && !searchPage) {
            clearOverlays();
            report(pkg, urlBar, false, 0, null, new ArrayList<>(), new TreeSet<>(), 0, 0, "Not a search results page, nothing done");
            return;
        }

        AccessibilityNodeInfo web = findWebView(root);
        Rect content = new Rect();
        (web != null ? web : root).getBoundsInScreen(content);

        // Walk the page, collect links that point to (or show) another site.
        List<Hit> hits = new ArrayList<>();
        Set<String> extraKeys = new TreeSet<>();
        int[] visited = {0};
        walk(web != null ? web : root, hits, extraKeys, visited, 0);

        // Keep one hit per result: drop links nested inside a bigger link to the same site.
        hits.sort((a, b) -> a.bounds.top != b.bounds.top ? a.bounds.top - b.bounds.top : b.bounds.height() - a.bounds.height());
        List<Hit> results = new ArrayList<>();
        for (Hit h : hits) {
            boolean dup = false;
            for (Hit r : results) {
                if (r.domain.equals(h.domain) && Rect.intersects(r.bounds, h.bounds)) { dup = true; break; }
            }
            if (!dup && Rect.intersects(h.bounds, content) && h.bounds.height() >= 16) results.add(h);
        }

        boolean showUnsafe = Prefs.showUnsafe(this);
        Map<String, View> keep = new HashMap<>();
        int covered = 0, badges = 0;
        for (int i = 0; i < results.size(); i++) {
            Hit h = results.get(i);
            SiteChecker.Entry st = checker.get(h.domain);
            String key = h.domain + "@" + i;
            if (st.state == SiteChecker.State.NOTSAFE && !showUnsafe) {
                // Cover the whole result: from this result's top to the next result's top.
                int top = Math.max(content.top, h.bounds.top - dp(6));
                int nextTop = i + 1 < results.size() ? results.get(i + 1).bounds.top - dp(6) : h.bounds.bottom + h.bounds.height() + dp(24);
                int bottom = Math.min(content.bottom, Math.max(nextTop, h.bounds.bottom + dp(6)));
                if (bottom - top > dp(20)) {
                    keep.put("c:" + key, showCover("c:" + key, h.domain, new Rect(content.left, top, content.right, bottom)));
                    covered++;
                }
            } else {
                int x = Math.min(h.bounds.right, content.right) - dp(120);
                int y = h.bounds.top;
                if (y >= content.top && y + dp(24) <= content.bottom) {
                    keep.put("b:" + key, showBadge("b:" + key, st, Math.max(content.left, x), y));
                    badges++;
                }
            }
        }
        // remove overlays for results no longer on screen
        Iterator<Map.Entry<String, View>> it = overlays.entrySet().iterator();
        while (it.hasNext()) {
            Map.Entry<String, View> e = it.next();
            if (!keep.containsKey(e.getKey())) { removeView(e.getValue()); it.remove(); }
        }
        report(pkg, urlBar, searchPage, visited[0], web, results, extraKeys, covered, badges, null);
    }

    private void walk(AccessibilityNodeInfo n, List<Hit> out, Set<String> extraKeys, int[] visited, int depth) {
        if (n == null || visited[0] > MAX_NODES || depth > 80) return;
        visited[0]++;
        Bundle ex = n.getExtras();
        String url = null;
        if (ex != null && !ex.isEmpty()) {
            for (String k : ex.keySet()) if (extraKeys.size() < 40) extraKeys.add(k);
            for (String k : URL_EXTRA_KEYS) {
                CharSequence v = ex.getCharSequence(k);
                if (v != null && v.length() > 0) { url = v.toString(); break; }
            }
        }
        if (n.isClickable() || url != null) {
            String domain = null, source = null;
            if (url != null) { domain = domainOf(url); source = "link address"; }
            if (domain == null) { domain = domainInText(n, 0); source = "text"; }
            if (domain != null && !ENGINE_DOMAIN.matcher(domain).find()) {
                Rect r = new Rect();
                n.getBoundsInScreen(r);
                if (!r.isEmpty()) out.add(new Hit(domain, r, source));
            }
        }
        for (int i = 0; i < n.getChildCount(); i++) walk(n.getChild(i), out, extraKeys, visited, depth + 1);
    }

    /** First domain printed inside a link (search engines print the site under each result title). */
    private static String domainInText(AccessibilityNodeInfo n, int depth) {
        if (n == null || depth > 4) return null;
        for (CharSequence cs : new CharSequence[]{n.getText(), n.getContentDescription()}) {
            if (TextUtils.isEmpty(cs)) continue;
            Matcher m = DOMAIN.matcher(cs.toString().toLowerCase(Locale.ROOT));
            while (m.find()) {
                String d = m.group(1);
                if (looksLikeDomain(d)) return stripWww(d);
            }
        }
        for (int i = 0; i < n.getChildCount() && i < 12; i++) {
            String d = domainInText(n.getChild(i), depth + 1);
            if (d != null) return d;
        }
        return null;
    }

    private static boolean looksLikeDomain(String d) {
        String tld = d.substring(d.lastIndexOf('.') + 1);
        // avoid file names and decimals like "photo.jpg" or "v1.2"
        return !tld.matches("jpg|jpeg|png|gif|webp|pdf|html|htm|php|aspx|js|css|mp4|mp3|zip|exe") && !tld.matches("\\d+");
    }

    private static String domainOf(String url) {
        try {
            android.net.Uri u = android.net.Uri.parse(url);
            String host = u.getHost();
            if (host == null) return null;
            String q = u.getQueryParameter("q");            // google.com/url?q=https://site
            if (host.contains("google.") && "/url".equals(u.getPath()) && q != null) host = android.net.Uri.parse(q).getHost();
            return host == null ? null : stripWww(host.toLowerCase(Locale.ROOT));
        } catch (Exception e) { return null; }
    }

    private static String stripWww(String d) { return d.startsWith("www.") ? d.substring(4) : d; }

    private static String findUrlBar(AccessibilityNodeInfo root) {
        for (String id : URL_BAR_IDS) {
            String pkgId = root.getPackageName() + id;
            List<AccessibilityNodeInfo> l = root.findAccessibilityNodeInfosByViewId(pkgId);
            if (l != null) for (AccessibilityNodeInfo n : l) if (!TextUtils.isEmpty(n.getText())) return n.getText().toString();
        }
        return null;
    }

    private static AccessibilityNodeInfo findWebView(AccessibilityNodeInfo n) {
        if (n == null) return null;
        if (n.getClassName() != null && n.getClassName().toString().equals("android.webkit.WebView")) return n;
        for (int i = 0; i < n.getChildCount(); i++) {
            AccessibilityNodeInfo w = findWebView(n.getChild(i));
            if (w != null) return w;
        }
        return null;
    }

    // ------------------------------------------------------------------ overlays
    private WindowManager.LayoutParams params(int x, int y, int w, int h, boolean touchable) {
        WindowManager.LayoutParams lp = new WindowManager.LayoutParams(
                w, h, WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                        | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN
                        | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS
                        | (touchable ? 0 : WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE),
                PixelFormat.TRANSLUCENT);
        lp.gravity = Gravity.TOP | Gravity.START;
        lp.x = x; lp.y = y;
        if (Build.VERSION.SDK_INT >= 28) lp.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
        return lp;
    }

    private View showCover(String key, String domain, Rect r) {
        View v = overlays.get(key);
        WindowManager.LayoutParams lp = params(r.left, r.top, r.width(), r.height(), true);
        if (!(v instanceof TextView) || !"cover".equals(v.getTag())) {
            if (v != null) removeView(v);
            TextView t = new TextView(this);
            t.setTag("cover");
            t.setGravity(Gravity.CENTER);
            t.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
            t.setTextColor(Color.parseColor("#5F6368"));
            GradientDrawable bg = new GradientDrawable();
            bg.setColor(Color.parseColor("#F1F3F4"));
            bg.setCornerRadius(dp(10));
            bg.setStroke(dp(1), Color.parseColor("#DADCE0"));
            t.setBackground(bg);
            // taps on a covered result do nothing (the site isn't opened); explain where to change it
            t.setOnClickListener(x -> Toast.makeText(this, "Hidden because it can't load safely. Turn on “Show not-safe results” in Search Safety Shield to see it.", Toast.LENGTH_LONG).show());
            v = t;
            addView(v, lp);
            overlays.put(key, v);
        } else {
            wm.updateViewLayout(v, lp);
        }
        ((TextView) v).setText("⛔ Hidden · not safe\n" + domain);
        return v;
    }

    private View showBadge(String key, SiteChecker.Entry st, int x, int y) {
        View v = overlays.get(key);
        WindowManager.LayoutParams lp = params(x, y, WindowManager.LayoutParams.WRAP_CONTENT, WindowManager.LayoutParams.WRAP_CONTENT, false);
        TextView t;
        if (!(v instanceof TextView) || !"badge".equals(v.getTag())) {
            if (v != null) removeView(v);
            t = new TextView(this);
            t.setTag("badge");
            t.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
            t.setPadding(dp(8), dp(2), dp(8), dp(2));
            addView(t, lp);
            overlays.put(key, t);
        } else {
            t = (TextView) v;
            wm.updateViewLayout(t, lp);
        }
        String text; int fg, bgc;
        switch (st.state) {
            case SAFE: text = "✓ Safe"; fg = Color.parseColor("#137333"); bgc = Color.parseColor("#E6F4EA"); break;
            case NOTSAFE: text = "⛔ Not safe"; fg = Color.parseColor("#B3261E"); bgc = Color.parseColor("#FDE7E9"); break;
            default: text = "⏳ Checking"; fg = Color.parseColor("#5F6368"); bgc = Color.parseColor("#F1F3F4");
        }
        t.setText(text);
        t.setTextColor(fg);
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(bgc);
        bg.setCornerRadius(dp(12));
        t.setBackground(bg);
        return t;
    }

    private void addView(View v, WindowManager.LayoutParams lp) {
        try { wm.addView(v, lp); } catch (Exception ignored) { }
    }

    private void removeView(View v) {
        try { wm.removeViewImmediate(v); } catch (Exception ignored) { }
    }

    private void clearOverlays() {
        for (View v : overlays.values()) removeView(v);
        overlays.clear();
    }

    private int dp(int v) { return Math.round(v * getResources().getDisplayMetrics().density); }

    // ------------------------------------------------------------------ diagnostics (shown in the app)
    private long lastReport;

    private void report(String pkg, String urlBar, boolean searchPage, int visited, AccessibilityNodeInfo web,
                        List<Hit> results, Set<String> extraKeys, int covered, int badges, String note) {
        long now = System.currentTimeMillis();
        if (now - lastReport < 1500) return; // keep it cheap
        lastReport = now;
        StringBuilder sb = new StringBuilder();
        sb.append("Time: ").append(new SimpleDateFormat("HH:mm:ss", Locale.US).format(new Date(now))).append('\n');
        sb.append("Browser: ").append(pkg).append('\n');
        sb.append("Address bar: ").append(urlBar == null ? "(not readable)" : urlBar).append('\n');
        sb.append("Search page: ").append(searchPage).append(" · web view found: ").append(web != null).append('\n');
        if (note != null) sb.append(note).append('\n');
        sb.append("Nodes read: ").append(visited).append(" · results found: ").append(results.size())
          .append(" · covered: ").append(covered).append(" · badges: ").append(badges).append('\n');
        int viaUrl = 0;
        for (Hit h : results) if ("link address".equals(h.source)) viaUrl++;
        sb.append("Found via link address: ").append(viaUrl).append(" · via printed site name: ").append(results.size() - viaUrl).append('\n');
        sb.append("Extra data keys seen: ").append(extraKeys.isEmpty() ? "(none)" : TextUtils.join(", ", extraKeys)).append('\n');
        sb.append("Results:\n");
        for (int i = 0; i < Math.min(15, results.size()); i++) {
            Hit h = results.get(i);
            SiteChecker.Entry e = checker.peek(h.domain);
            sb.append("  ").append(h.domain).append(" [").append(h.source).append("] ")
              .append(e == null ? "?" : e.state + (e.provisional ? "*" : "") + (e.ms > 0 ? " " + e.ms + "ms" : ""))
              .append(" @").append(h.bounds.top).append('\n');
        }
        Prefs.get(this).edit().putString(Prefs.DIAG, sb.toString()).apply();
    }
}
