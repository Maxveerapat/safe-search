# Phone test — TEST build (Chrome on Android)

The TEST build needs no admin setup: it downloads the real public lists (HaGeZi, Block List Project)
straight from GitHub, and has 3 MOCK admin entries + 1 MOCK allowlist entry built in:

| Domain | What you should see | Why |
|---|---|---|
| pantip.com | ⚠ Flagged · Admin | mock admin entry ("other") |
| sanook.com | ⚠ Flagged · Admin | mock admin entry ("other") |
| quora.com | ⚠ Fake · Admin | mock admin entry ("fake") |
| *.wikipedia.org | ✓ Not flagged · allowed by admin | mock allowlist entry |

These sites are **not** actually unsafe — they're there so you can see admin features on everyday searches.

## Setup
1. Open the setup page **in Chrome on the phone** and tap **Copy code**
   (or copy everything in `dist/test/bookmarklet.txt`).
2. Bookmark any page → Edit → name `ssf` → paste the code as the URL → save.

## Checks

| # | Do this | Expect | If not, tell me |
|---|---|---|---|
| 1 | Google `ดูบอลสด วันนี้`, then type `ssf` in the address bar and tap the ☆ suggestion | "Welcome" sheet slides up | Nothing happens at all → Chrome blocked the bookmark from running |
| 2 | Tap **Start** | "Downloading the safety list" bar, then labels on results | "Couldn't download the safety list" → tap ⚙ Filter, screenshot the Problems box |
| 3 | ⚙ Filter → Safety list section | Note **Downloaded … MB in … s** and **Domains** | Send me both numbers + Wi-Fi or mobile data |
| 4 | Look at the results | Every normal result has a label; gambling sites say ⚠ Gambling · HaGeZi | Results with no label → screenshot (Google layout differs) |
| 5 | Google `pantip คอนโด`, run `ssf` | No welcome sheet, labels appear in about a second (saved copy); pantip = ⚠ Flagged · Admin | |
| 6 | Tap a pantip label | Sheet with reason + 3 dated history rows | |
| 7 | ⚙ Filter → Gambling: Hide, Adult: Hide → Done | Those results become "1 Gambling result hidden · Show" | |
| 8 | Tap **Show** on one line | That result comes back | |
| 9 | ⚙ Filter → Show as: **Remove** | Hidden results disappear completely; bar says "N hidden" | |
| 10 | New search — filter still applied? | Yes, remembered | |
| 11 | ⚙ Filter → turn on **Clear history when I turn off** → Done → tap ✕ | "Flagger off. Clear this session?" with Chrome steps | |
| 12 | Follow the steps in Chrome's ⋮ menu | The steps match what Chrome shows | Send a screenshot of Chrome's screen if wording differs |
| 13 | Search `bangkok wikipedia`, run ssf | Wikipedia = ✓ Not flagged · allowed by admin | |
| 14 | Scroll down until Google loads more results | New results get labels too | |
| 15 | Run `ssf` twice on the same page | Second run turns it off | |
| 16 | Phone in dark mode | Everything readable | |

The most important answers are **#1, #2 and #3** — they decide whether the approach works on real Google.
