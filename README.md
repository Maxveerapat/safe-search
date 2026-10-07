# Search Safety Flagger — phone version (Chrome on Android)

Labels every Google result in normal Chrome on Android, lets each user hide categories, shows dated
history per site, and guides users through clearing their browsing history. Runs as a bookmark
called **ssf** (a "bookmarklet"). The admin keeps one list; users always get the latest one.

```
admin/            ← the only folder the admin edits
  sources.json      which public blocklists to use (+ report link)
  flags.csv         extra domains to flag, with dated events
  allow.csv         domains that must never be flagged
  build_list.py     daily build (run by GitHub automatically)
src/ssf.js        the bookmarklet source
build/            turns ssf.js into the bookmark + setup page
config/           test.json (mock admin data, lists fetched directly) / production.json
state/            first-seen dates (committed by the daily build — don't edit)
.github/workflows/update-list.yml   runs every day at 06:00 Bangkok time
```

---

## For the admin: one-time setup (about 15 minutes, free)

1. **Create a GitHub account** if you don't have one, then a new **public** repository (e.g. `safe-search`).
2. **Upload this folder** to the repository (GitHub → *Add file → Upload files*, drag everything in,
   including the hidden `.github` folder; or use `git push`).
3. **Turn on GitHub Pages:** repository → *Settings → Pages → Source: **GitHub Actions***.
4. **Run the first build:** *Actions → Update safety list → Run workflow*. Takes about 2 minutes.
5. **Your links** (replace USER and REPO):
   - Setup page for users: `https://USER.github.io/REPO/setup.html`
   - The list itself: `https://USER.github.io/REPO/list/manifest.json`
6. Send the setup link to users (LINE, email, QR code).

From then on the list rebuilds itself every morning at 06:00 Bangkok time.

## For the admin: everyday editing

All edits happen in the `admin/` folder, directly on github.com (open the file → ✏️ pencil → *Commit changes*).
Every commit rebuilds the list within ~2 minutes; users get admin changes the next time they run **ssf**.

**Flag a domain** — add rows to `admin/flags.csv`. One row per event, so a domain can have several dated rows:

| domain | category | date | event | reason |
|---|---|---|---|---|
| promo-scam.com | scam | 2026-10-01 | Reported by user | Fake free-credit promotion |
| promo-scam.com | scam | 2026-10-02 | Confirmed by admin | |

`category` must be one of: `adult`, `gambling`, `scam`, `fake`, `other`. Subdomains are covered automatically.

**Un-flag a site the public lists got wrong** — add it to `admin/allow.csv` (`domain,date,reason`).
The allowlist always wins over every list.

**Prefer a Google Sheet?** Make a sheet with the same columns, then *File → Share → Publish to web →
CSV* and paste the link into `admin_flags_csv` / `admin_allow_csv` in `admin/sources.json`.
The daily build reads it (edits show up by the next morning, or press *Run workflow*).

**"Report a mistake" link** — create a Google Form, get a pre-filled link, put `{domain}` where the
domain should go, and paste it as `report_url` in `admin/sources.json`.

**Change the public lists** — edit `groups` in `admin/sources.json`. Defaults (≈490,000 domains,
≈2.7 MB compressed daily download per phone):

| id | category | source | licence |
|---|---|---|---|
| hagezi-nsfw | adult | HaGeZi NSFW | GPL-3.0 |
| hagezi-gambling | gambling | HaGeZi Gambling (mini) | GPL-3.0 |
| hagezi-fake | fake | HaGeZi Fake | GPL-3.0 |
| hagezi-tif | scam | HaGeZi Threat Intelligence (mini) | GPL-3.0 |
| blp-scam | scam | Block List Project Scam | Unlicense |

Bigger lists = better coverage but a heavier daily download on phones.
Fake football-streaming sites are not well covered by public lists — add them to `flags.csv`.

**Releasing new features** (only when `src/` changes) — users must re-copy the bookmark from the setup page.
List changes never need that.

## For users

1. Open the setup link, tap **Copy code**.
2. Bookmark the page (⋮ → ☆ → Edit), name it **ssf**, paste the code as the URL.
3. After any Google search in Chrome: tap the address bar, type **ssf**, tap the ☆ suggestion.
4. **⚙ Filter** hides categories; tap a label for its dated history; **✕** (or running ssf again) turns it off.

## What it can't do (Chrome limits)

- It can't delete history by itself. With *Clear history when I turn off* switched on, tapping ✕
  shows the exact Chrome steps (2 taps under 15 minutes, ~4 taps for longer sessions).
- It runs only when the user types **ssf** after a search; it can't run automatically in Chrome.
- Searches in the Google app or home-screen widget aren't covered (they open the Google app, not Chrome).

## Developer notes

```
npm install
node build/build.mjs config/test.json dist/test          # test build: mock admin data, lists fetched directly
SSF_MANIFEST_URL=https://USER.github.io/REPO/list/manifest.json \
  node build/build.mjs config/production.json dist/prod  # what the workflow builds
python admin/build_list.py --base-url http://localhost:8000/   # local list build into site/
```
Lookups use binary search over sorted lists kept in IndexedDB on the phone (one download per day,
then ~100 ms per run). First-seen dates live in 256 small shard files fetched only when a label is tapped.
