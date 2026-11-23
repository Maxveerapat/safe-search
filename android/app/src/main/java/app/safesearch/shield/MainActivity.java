package app.safesearch.shield;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.ComponentName;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.provider.Settings;
import android.text.TextUtils;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.CompoundButton;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.Switch;
import android.widget.TextView;
import android.widget.Toast;

/** The app: one place to turn protection on/off and choose whether not-safe results are hidden. */
public class MainActivity extends Activity {
    private TextView status, diag;
    private Button access;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        ScrollView scroll = new ScrollView(this);
        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        col.setPadding(dp(20), dp(28), dp(20), dp(28));
        scroll.addView(col);

        TextView title = text("Search Safety Shield", 24, true);
        col.addView(title);
        col.addView(text("Hides search results for sites that can't load safely on your connection, in every browser. Checked live from this phone.", 14, false));

        status = text("", 14, true);
        status.setPadding(dp(14), dp(12), dp(14), dp(12));
        col.addView(space(16));
        col.addView(status);
        access = new Button(this);
        access.setText("Open Accessibility settings");
        access.setOnClickListener(v -> startActivity(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)));
        col.addView(access);
        col.addView(text("In Accessibility, open “Installed apps” (or “Downloaded apps”) → Search Safety Shield → turn it on. "
                + "If Android says the setting is restricted: App info → ⋮ (top right) → “Allow restricted settings”, then try again.", 12, false));

        col.addView(space(20));
        col.addView(toggle("Protection", "Turn the shield on or off for all browsers.", Prefs.ENABLED, true));
        col.addView(toggle("Show not-safe results", "Off: not-safe results are hidden. On: they're shown with a ⛔ Not safe label.", Prefs.SHOW_UNSAFE, false));
        col.addView(toggle("Search pages only", "Only act on search engine result pages (recommended).", Prefs.SEARCH_ONLY, true));

        col.addView(space(24));
        col.addView(text("Diagnostics (for testing)", 16, true));
        col.addView(text("Open a search in your browser, then come back here and tap Refresh.", 12, false));
        LinearLayout row = new LinearLayout(this);
        Button refresh = new Button(this); refresh.setText("Refresh");
        refresh.setOnClickListener(v -> showDiag());
        Button copy = new Button(this); copy.setText("Copy diagnostics");
        copy.setOnClickListener(v -> {
            ClipboardManager cm = (ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
            cm.setPrimaryClip(ClipData.newPlainText("Search Safety Shield diagnostics", diag.getText()));
            Toast.makeText(this, "Copied", Toast.LENGTH_SHORT).show();
        });
        row.addView(refresh); row.addView(copy);
        col.addView(row);
        diag = text("", 12, false);
        diag.setTypeface(Typeface.MONOSPACE);
        diag.setTextIsSelectable(true);
        col.addView(diag);

        setContentView(scroll);
    }

    @Override
    protected void onResume() {
        super.onResume();
        boolean on = serviceEnabled();
        status.setText(on ? "✓ Accessibility access is on: the shield can work in your browsers." : "Accessibility access is off. The shield can't see your browsers until you turn it on.");
        GradientDrawable bg = new GradientDrawable();
        bg.setCornerRadius(dp(10));
        bg.setColor(Color.parseColor(on ? "#E6F4EA" : "#FEF7E0"));
        status.setBackground(bg);
        status.setTextColor(Color.parseColor(on ? "#137333" : "#7A4F01"));
        access.setVisibility(on ? View.GONE : View.VISIBLE);
        showDiag();
    }

    private void showDiag() {
        String d = Prefs.get(this).getString(Prefs.DIAG, null);
        diag.setText(d == null ? "(nothing yet)" : d);
    }

    private boolean serviceEnabled() {
        String list = Settings.Secure.getString(getContentResolver(), Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
        if (TextUtils.isEmpty(list)) return false;
        String me = new ComponentName(this, ShieldService.class).flattenToString();
        for (String s : list.split(":")) if (s.equalsIgnoreCase(me)) return true;
        return false;
    }

    private View toggle(String label, String sub, String key, boolean def) {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(0, dp(10), 0, dp(10));
        Switch s = new Switch(this);
        s.setText(label);
        s.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        s.setChecked(Prefs.get(this).getBoolean(key, def));
        s.setOnCheckedChangeListener((CompoundButton b, boolean v) -> Prefs.get(this).edit().putBoolean(key, v).apply());
        box.addView(s);
        box.addView(text(sub, 12, false));
        return box;
    }

    private TextView text(String s, int sp, boolean bold) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        if (bold) t.setTypeface(Typeface.DEFAULT_BOLD);
        t.setPadding(0, dp(4), 0, dp(4));
        t.setGravity(Gravity.START);
        return t;
    }

    private View space(int h) { View v = new View(this); v.setMinimumHeight(dp(h)); return v; }

    private int dp(int v) { return Math.round(v * getResources().getDisplayMetrics().density); }
}
