package app.safesearch.shield;

import android.content.Context;
import android.content.SharedPreferences;

/** App settings, shared by the app screen and the background service. */
final class Prefs {
    static final String FILE = "shield";
    static final String ENABLED = "enabled";          // protection on/off (the one switch)
    static final String SHOW_UNSAFE = "show_unsafe";  // false = hide not-safe results (default)
    static final String SEARCH_ONLY = "search_only";  // only act on search engine result pages
    static final String DIAG = "diag";                // last scan report, for testing

    private Prefs() {}

    static SharedPreferences get(Context c) {
        return c.getSharedPreferences(FILE, Context.MODE_PRIVATE);
    }
    static boolean enabled(Context c) { return get(c).getBoolean(ENABLED, true); }
    static boolean showUnsafe(Context c) { return get(c).getBoolean(SHOW_UNSAFE, false); }
    static boolean searchOnly(Context c) { return get(c).getBoolean(SEARCH_ONLY, true); }
}
