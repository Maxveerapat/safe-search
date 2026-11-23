# Search Safety Shield · Android prototype · test guide

This prototype answers three open questions before we build the full product:
1. Can the app see search results in each browser? (and does the browser pass link addresses, or only the printed site names?)
2. Do the covers and badges stay in place while scrolling?
3. Does the 3-second live check feel right?

## Install (once)
1. On the phone, open the download link (GitHub → your safe-search repo → Releases → "android-latest" → SearchSafetyShield.apk).
2. Android asks to allow installing from Chrome: allow it, then Install.
3. Open **Search Safety Shield** → **Open Accessibility settings** → Installed (Downloaded) apps → Search Safety Shield → On.
   - If it says the setting is **restricted**: Settings → Apps → Search Safety Shield → ⋮ (top right) → **Allow restricted settings**, then try again.

## Tests
| # | Do this | Expect |
|---|---|---|
| 1 | Chrome: Google `porn` | Not-safe results covered by a grey box "⛔ Hidden · not safe" within ~3 s; safe results untouched |
| 2 | Scroll up and down, slowly then fast | Covers follow the results (a short lag is expected; report how bad) |
| 3 | Tap a grey cover | Nothing opens; a message explains how to show it |
| 4 | App → turn on **Show not-safe results** → back to Chrome | Covers disappear; every result shows ✓ Safe / ⛔ Not safe |
| 5 | New search in Google's own box, tap More results | New results handled automatically, nothing to tap |
| 6 | Same search in **Bing** or **DuckDuckGo** | Works the same |
| 7 | Same search in a **second browser** (Samsung Internet, Firefox, Edge…) | Works the same |
| 8 | App → **Protection** off | All covers/badges gone in every browser |
| 9 | Open a normal site (not a search page) | Nothing is drawn |

## After each browser test
App → Diagnostics → **Refresh** → **Copy diagnostics** → paste it to Claude (one paste per browser).
Key lines: "Found via link address" vs "via printed site name", and "results found".
