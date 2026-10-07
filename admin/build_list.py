#!/usr/bin/env python3
"""Daily list build for Search Safety Flagger.

Downloads the blocklists in admin/sources.json, merges the admin's own flags and
allowlist (CSV files or published Google Sheet CSV links), records when each domain
was first seen, and writes the files the phone bookmarklet downloads:

  site/list/manifest.json          small, fetched on every run (admin edits show up at once)
  site/list/groups/<id>.txt        one sorted domain list per source, refreshed daily
  site/list/history/<xx>.json      first-seen dates, split into 256 shards, fetched on tap

Usage:  python admin/build_list.py --base-url https://USER.github.io/REPO/
"""
import argparse, csv, datetime as dt, hashlib, io, json, os, sys, urllib.request
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CATS = {"adult", "gambling", "scam", "fake", "other"}
BKK = dt.timezone(dt.timedelta(hours=7))


def fnv1a(s: str) -> int:
    h = 0x811C9DC5
    for ch in s:  # matches the JS version (charCodeAt) for ASCII/punycode domains
        h ^= ord(ch)
        h = (h * 0x01000193) & 0xFFFFFFFF
    return h


def shard_of(domain: str) -> str:
    return format(fnv1a(domain) & 0xFF, "02x")


def fetch(url: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": "search-safety-flagger-list-build"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read().decode("utf-8", "replace")


def read_text(path_or_url: str) -> str:
    if path_or_url.startswith(("http://", "https://")):
        return fetch(path_or_url)
    p = path_or_url if os.path.isabs(path_or_url) else os.path.join(ROOT, path_or_url)
    if not os.path.exists(p):
        return ""
    with open(p, encoding="utf-8-sig") as f:
        return f.read()


def parse_domains(text: str) -> set:
    out = set()
    for line in text.splitlines():
        line = line.strip()
        if not line or line[0] in "#!":
            continue
        if line.startswith("||"):
            line = line[2:].split("^")[0]
        parts = line.split()
        d = (parts[1] if len(parts) > 1 else parts[0]).lower().rstrip(".")
        if "." in d and " " not in d:
            out.add(d)
    return out


def norm(d: str) -> str:
    d = d.strip().lower()
    for p in ("https://", "http://"):
        if d.startswith(p):
            d = d[len(p):]
    d = d.split("/")[0]
    return d[4:] if d.startswith("www.") else d


def read_csv(path_or_url: str) -> list:
    text = read_text(path_or_url) if path_or_url else ""
    if not text.strip():
        return []
    return [{(k or "").strip().lower(): (v or "").strip() for k, v in row.items()} for row in csv.DictReader(io.StringIO(text))]


def load_state(path: str) -> dict:
    state = {}
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            for line in f:
                parts = line.rstrip("\n").split("\t")
                if len(parts) == 3:
                    state[(parts[0], parts[1])] = parts[2]
    return state


def save_state(path: str, state: dict):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        for (d, g), date in sorted(state.items()):
            f.write(f"{d}\t{g}\t{date}\n")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base-url", default=os.environ.get("SSF_BASE_URL", "http://localhost:8000/"),
                    help="Public URL where the site/ folder is served, e.g. https://USER.github.io/REPO/")
    ap.add_argument("--out", default=os.path.join(ROOT, "site"))
    ap.add_argument("--state", default=os.path.join(ROOT, "state", "first_seen.tsv"))
    args = ap.parse_args()
    base = args.base_url.rstrip("/") + "/"

    with open(os.path.join(HERE, "sources.json"), encoding="utf-8") as f:
        cfg = json.load(f)
    now = dt.datetime.now(BKK)
    today = now.date().isoformat()

    # ---- admin data
    admin_rows = read_csv(cfg.get("admin_flags_csv", ""))
    allow_rows = read_csv(cfg.get("admin_allow_csv", ""))
    admin = {}
    problems = []
    for r in admin_rows:
        d = norm(r.get("domain", ""))
        if not d or "." not in d:
            continue
        cat = r.get("category", "other").lower() or "other"
        if cat not in CATS:
            problems.append(f"{d}: unknown category '{cat}', using 'other'")
            cat = "other"
        e = admin.setdefault(d, {"domain": d, "category": cat, "reason": "", "history": []})
        e["category"] = cat  # latest row wins
        if r.get("reason"):
            e["reason"] = r["reason"]
        if r.get("event") or r.get("date"):
            e["history"].append({"date": r.get("date") or today, "event": r.get("event") or "Updated"})
    allow = []
    for r in allow_rows:
        d = norm(r.get("domain", ""))
        if d and "." in d:
            allow.append({"domain": d, "date": r.get("date") or today, "reason": r.get("reason", "")})

    # ---- lists
    state = load_state(args.state)
    first_run = not state
    groups_out, sources_out = [], {}
    seen_by_domain = defaultdict(dict)
    os.makedirs(os.path.join(args.out, "list", "groups"), exist_ok=True)
    for g in cfg["groups"]:
        try:
            domains = parse_domains(fetch(g["url"]))
        except Exception as e:  # keep yesterday's file if a source is down
            problems.append(f"{g['id']}: download failed ({e}); kept previous copy")
            prev = os.path.join(args.out, "list", "groups", g["id"] + ".txt")
            if not os.path.exists(prev):
                continue
            with open(prev, encoding="utf-8") as f:
                domains = set(filter(None, f.read().split("\n")))
        for d in domains:
            key = (d, g["id"])
            if key not in state:
                state[key] = today
            seen_by_domain[d][g["id"]] = state[key]
        text = "\n".join(sorted(domains))
        with open(os.path.join(args.out, "list", "groups", g["id"] + ".txt"), "w", encoding="utf-8") as f:
            f.write(text + "\n")
        digest = hashlib.sha1(text.encode()).hexdigest()[:10]
        groups_out.append({"id": g["id"], "cat": g["cat"], "src": g["id"], "sort": False, "count": len(domains),
                           "url": f"{base}list/groups/{g['id']}.txt?v={digest}"})
        sources_out[g["id"]] = {"name": g["name"], "short": g.get("short", g["name"]), "license": g.get("license", ""), "home": g["url"]}

    # forget domains that left every list (keeps the state file from growing forever)
    live = {(d, gid) for d, m in seen_by_domain.items() for gid in m}
    state = {k: v for k, v in state.items() if k in live}
    save_state(args.state, state)

    # ---- history shards
    shards = defaultdict(dict)
    for d, m in seen_by_domain.items():
        shards[shard_of(d)][d] = m
    hist_dir = os.path.join(args.out, "list", "history")
    os.makedirs(hist_dir, exist_ok=True)
    for i in range(256):
        sh = format(i, "02x")
        with open(os.path.join(hist_dir, sh + ".json"), "w", encoding="utf-8") as f:
            json.dump(shards.get(sh, {}), f, separators=(",", ":"))

    version = hashlib.sha1("|".join(g["url"] for g in groups_out).encode()).hexdigest()[:12]
    manifest = {
        "version": version,
        "updated": now.isoformat(timespec="minutes"),
        "sources": sources_out,
        "groups": groups_out,
        "admin": sorted(admin.values(), key=lambda e: e["domain"]),
        "allow": allow,
        "historyBase": f"{base}list/history",
        "reportUrl": cfg.get("report_url", ""),
        "note": "First-seen dates start from the first build" if first_run else "",
    }
    with open(os.path.join(args.out, "list", "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, separators=(",", ":"))

    total = sum(g["count"] for g in groups_out)
    print(f"Built {len(groups_out)} lists, {total:,} entries, {len(admin)} admin flags, {len(allow)} allowed → {args.out}/list")
    for p in problems:
        print("WARNING:", p, file=sys.stderr)


if __name__ == "__main__":
    main()
