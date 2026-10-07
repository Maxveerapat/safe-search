/* Search Safety Flagger — mobile bookmarklet (runs on Google search results in Chrome).
 * Built into a javascript: bookmark by build/build.mjs, which replaces __SSF_CONFIG__.
 * Run once: labels + filter bar. Run again (or tap ✕): turns off.
 */
(() => {
  "use strict";
  const CONFIG = __SSF_CONFIG__;
  const VERSION = CONFIG.buildVersion || "dev";

  // Second run on the same page = turn off.
  if (window.__ssf && window.__ssf.active) { window.__ssf.turnOff(); return; }

  // ---------------------------------------------------------------- constants
  const CATS = {
    adult:    { name: "Adult",                short: "Adult" },
    gambling: { name: "Gambling",             short: "Gambling" },
    scam:     { name: "Scam & phishing",      short: "Scam" },
    fake:     { name: "Fake shops & streams", short: "Fake" },
    other:    { name: "Other (admin)",        short: "Flagged" }
  };
  const ORDER = ["adult", "gambling", "scam", "fake", "other"];
  const FILTER_KEYS = [...ORDER, "clean"];
  const PRESETS = {
    all:     { name: "Show all",         hide: {} },
    flagged: { name: "Hide all flagged", hide: { adult: 1, gambling: 1, scam: 1, fake: 1, other: 1 } },
    only:    { name: "Flagged only",     hide: { clean: 1 } }
  };
  const DAY = 864e5;
  const SESSION_GAP = 3 * 36e5; // 3h without running ssf = previous session is over

  // ---------------------------------------------------------------- small helpers
  const $el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  const store = {
    get(k, d) { try { const v = localStorage.getItem("ssf:" + k); return v ? JSON.parse(v) : d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem("ssf:" + k, JSON.stringify(v)); } catch { /* ignore */ } }
  };
  const fmtDate = (d) => {
    const x = typeof d === "number" ? new Date(d) : new Date(String(d).length === 10 ? d + "T00:00:00" : d);
    return isNaN(x) ? String(d) : x.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
  };
  const fmtTime = (t) => new Date(t).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const fmtDur = (ms) => {
    const m = Math.max(1, Math.round(ms / 6e4));
    if (m < 60) return m + " min";
    const h = Math.floor(m / 60), r = m % 60;
    if (h < 48) return h + " h" + (r ? " " + r + " min" : "");
    return Math.round(h / 24) + " days";
  };
  const fnv1a = (s) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h >>> 0; };
  const shardOf = (d) => (fnv1a(d) & 0xff).toString(16).padStart(2, "0");
  const normHost = (h) => h.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");

  // ---------------------------------------------------------------- IndexedDB cache
  const idb = (() => {
    let dbp;
    const open = () => dbp || (dbp = new Promise((res, rej) => {
      const r = indexedDB.open("ssf", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("files");
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    }));
    const run = async (mode, fn) => {
      const db = await open();
      return new Promise((res, rej) => {
        const t = db.transaction("files", mode);
        const req = fn(t.objectStore("files"));
        t.oncomplete = () => res(req && req.result);
        t.onerror = () => rej(t.error);
      });
    };
    return {
      get: (k) => run("readonly", (s) => s.get(k)).catch(() => null),
      set: (k, v) => run("readwrite", (s) => s.put(v, k)).catch(() => null)
    };
  })();

  // ---------------------------------------------------------------- list data
  const data = {
    manifest: null,
    groups: [],          // { id, cat, src, text, starts, count }
    admin: new Map(),    // domain -> entry
    allow: new Map(),    // domain -> entry
    sources: {},
    stats: { chars: 0, ms: 0, fromCache: true, errors: [] },
    history: new Map()   // shard -> object
  };

  function buildIndex(text) {
    const starts = [];
    let p = text.indexOf("\n");
    while (p !== -1 && p < text.length - 1) { starts.push(p + 1); p = text.indexOf("\n", p + 1); }
    return { text, starts: Int32Array.from(starts) };
  }
  function lineAt(g, i) { const s = g.starts[i]; return g.text.slice(s, g.text.indexOf("\n", s)); }
  function groupHas(g, d) {
    let lo = 0, hi = g.starts.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1, v = lineAt(g, mid);
      if (v === d) return true;
      if (v < d) lo = mid + 1; else hi = mid - 1;
    }
    return false;
  }
  function normaliseList(raw, sort) {
    const out = [];
    for (let line of raw.split(/\r?\n/)) {
      line = line.trim();
      if (!line || line[0] === "#" || line[0] === "!") continue;
      // accept hosts ("0.0.0.0 x"), adblock ("||x^") and plain domain formats
      if (line.startsWith("||")) line = line.slice(2).replace(/\^.*$/, "");
      const sp = line.split(/\s+/);
      line = (sp.length > 1 ? sp[1] : sp[0]).toLowerCase();
      if (line.includes(".")) out.push(line);
    }
    if (sort) out.sort();
    const uniq = [];
    for (let i = 0; i < out.length; i++) if (i === 0 || out[i] !== out[i - 1]) uniq.push(out[i]);
    return "\n" + uniq.join("\n") + "\n";
  }

  async function fetchText(url) {
    const r = await fetch(url, { credentials: "omit", cache: "no-cache" });
    if (!r.ok) throw new Error("HTTP " + r.status + " for " + url);
    return r.text();
  }

  async function loadManifest() {
    if (!CONFIG.manifestUrl) return CONFIG.manifest;
    const cached = await idb.get("manifest");
    try {
      const m = JSON.parse(await fetchText(CONFIG.manifestUrl));
      idb.set("manifest", m);
      return m;
    } catch (e) {
      data.stats.errors.push("Manifest: " + e.message);
      if (cached) return cached;
      throw e;
    }
  }

  async function loadGroup(g, version, force, onDone) {
    const key = "g:" + g.url;
    const cached = await idb.get(key);
    const fresh = cached && cached.version === version && Date.now() - cached.savedAt < DAY;
    if (cached && (fresh || !force)) {
      if (!fresh) refreshGroup(g, version, key); // stale: use now, refresh in background
      onDone();
      return { ...g, ...buildIndex(cached.text) };
    }
    const t0 = performance.now();
    const raw = await fetchText(g.url);
    const text = normaliseList(raw, g.sort !== false);
    data.stats.chars += raw.length;
    data.stats.ms += performance.now() - t0;
    data.stats.fromCache = false;
    await idb.set(key, { text, version, savedAt: Date.now() });
    onDone();
    return { ...g, ...buildIndex(text) };
  }
  function refreshGroup(g, version, key) {
    fetchText(g.url)
      .then((raw) => idb.set(key, { text: normaliseList(raw, g.sort !== false), version, savedAt: Date.now() }))
      .catch((e) => data.stats.errors.push(g.id + " refresh: " + e.message));
  }

  async function loadAll(onProgress) {
    const m = await loadManifest();
    data.manifest = m;
    data.sources = m.sources || {};
    data.admin = new Map((m.admin || []).map((a) => [normHost(a.domain), a]));
    data.allow = new Map((m.allow || []).map((a) => [normHost(a.domain), a]));
    const groups = m.groups || [];
    let done = 0;
    const tick = () => onProgress(++done, groups.length);
    const results = await Promise.allSettled(groups.map((g) => loadGroup(g, m.version, false, tick)));
    data.groups = [];
    results.forEach((r, i) => {
      if (r.status === "fulfilled") data.groups.push(r.value);
      else data.stats.errors.push((groups[i].id || "list") + ": " + (r.reason && r.reason.message || r.reason));
    });
  }

  async function hasAnyCache(m) {
    for (const g of (m && m.groups) || []) if (await idb.get("g:" + g.url)) return true;
    return false;
  }

  // lookup: walk up the domain labels; allowlist wins; collect all hits
  function lookup(host) {
    const parts = normHost(host).split(".");
    const hits = [];
    let admin = null, matched = null;
    for (let i = 0; i < parts.length - 1; i++) {
      const d = parts.slice(i).join(".");
      if (data.allow.has(d)) return { allowed: data.allow.get(d), matched: d, hits: [] };
      if (!admin && data.admin.has(d)) { admin = data.admin.get(d); matched = matched || d; }
      for (const g of data.groups) {
        if (!hits.some((h) => h.group === g.id) && groupHas(g, d)) {
          hits.push({ group: g.id, cat: g.cat, src: g.src, domain: d });
          matched = matched || d;
        }
      }
    }
    const cats = new Set(hits.map((h) => h.cat));
    if (admin) cats.add(ORDER.includes(admin.category) ? admin.category : "other");
    const sorted = ORDER.filter((c) => cats.has(c));
    return { hits, admin, matched, cats: sorted, primary: sorted[0] || null };
  }

  async function historyFor(domain) {
    const base = data.manifest && data.manifest.historyBase;
    if (!base) return null;
    const sh = shardOf(domain);
    if (!data.history.has(sh)) {
      data.history.set(sh, fetchText(base.replace(/\/$/, "") + "/" + sh + ".json").then(JSON.parse).catch(() => ({})));
    }
    const obj = await data.history.get(sh);
    return obj[domain] || null;
  }

  // ---------------------------------------------------------------- styles
  const PAGE_CSS = `
.ssf-lbl{all:unset;display:inline-flex;align-items:center;gap:4px;margin:6px 0 4px;padding:3px 10px;border-radius:999px;
  font:600 12px/18px Roboto,Arial,sans-serif;cursor:pointer;-webkit-tap-highlight-color:transparent}
.ssf-lbl:focus-visible{outline:2px solid #1a73e8;outline-offset:2px}
.ssf-c-adult{background:#fce4f1;color:#a3195b}.ssf-c-gambling{background:#fde7e9;color:#b3261e}
.ssf-c-scam{background:#efe6ff;color:#6b2fc9}.ssf-c-fake{background:#fff4d6;color:#8a5a00}
.ssf-c-other{background:#fde7e9;color:#b3261e}.ssf-c-clean{background:#e6f4ea;color:#137333}
.ssf-hidden{display:none!important}
.ssf-collapsed{all:unset;display:block;box-sizing:border-box;width:100%;margin:6px 0;padding:8px 12px;border:1px dashed #c4c7c5;
  border-radius:10px;font:13px/18px Roboto,Arial,sans-serif;color:#5f6368;cursor:pointer}
.ssf-collapsed b{color:#1a73e8}
@media (prefers-color-scheme:dark){
 .ssf-c-adult{background:#45182e;color:#ff9ccc}.ssf-c-gambling,.ssf-c-other{background:#4a1c1f;color:#f6aea9}
 .ssf-c-scam{background:#2e2050;color:#c7a8ff}.ssf-c-fake{background:#3a2f12;color:#f2c66b}
 .ssf-c-clean{background:#193826;color:#81c995}.ssf-collapsed{border-color:#5f6368;color:#9aa0a6}.ssf-collapsed b{color:#8ab4f8}}`;

  const UI_CSS = `
:host{all:initial}
*{box-sizing:border-box;font-family:Roboto,Arial,sans-serif}
.v{--bg:#fff;--fg:#1f1f1f;--mu:#5f6368;--ln:#e3e3e3;--ac:#1a73e8;--acs:#e8f0fe;--bad:#b3261e;--ok:#137333;--chip:#f1f3f4}
@media (prefers-color-scheme:dark){.v{--bg:#202124;--fg:#e8eaed;--mu:#9aa0a6;--ln:#3c4043;--ac:#8ab4f8;--acs:#28344d;--bad:#f2b8b5;--ok:#81c995;--chip:#303134}}
.bar{position:fixed;left:8px;right:8px;bottom:calc(10px + env(safe-area-inset-bottom,0px));z-index:2147483646;display:flex;align-items:center;gap:6px;
  padding:6px 6px 6px 12px;background:var(--bg);color:var(--fg);border:1px solid var(--ln);border-radius:16px;box-shadow:0 6px 24px rgba(0,0,0,.22);font-size:13px}
.bar .cnt{display:flex;gap:6px;flex-wrap:wrap;min-width:0;flex:1}
.pill{padding:2px 8px;border-radius:999px;font-weight:700;font-size:12px;white-space:nowrap}
.p-bad{background:#fde7e9;color:#b3261e}.p-ok{background:#e6f4ea;color:#137333}.p-mu{background:var(--chip);color:var(--mu)}
@media (prefers-color-scheme:dark){.p-bad{background:#4a1c1f;color:#f6aea9}.p-ok{background:#193826;color:#81c995}}
button{font:inherit;color:inherit;border:0;background:none;cursor:pointer;-webkit-tap-highlight-color:transparent}
button:focus-visible{outline:2px solid var(--ac);outline-offset:2px}
.ib{min-width:40px;height:36px;padding:0 12px;border-radius:12px;background:var(--chip);font-weight:700;font-size:13px}
.ib.x{min-width:36px;padding:0;font-size:18px;color:var(--mu)}
.shade{position:fixed;inset:0;z-index:2147483646;background:rgba(0,0,0,.4)}
.sheet{position:fixed;left:0;right:0;bottom:0;z-index:2147483647;max-height:86vh;overflow-y:auto;background:var(--bg);color:var(--fg);
  border-radius:18px 18px 0 0;padding:8px 18px calc(18px + env(safe-area-inset-bottom,0px));box-shadow:0 -8px 30px rgba(0,0,0,.25);font-size:14px;line-height:1.45}
.grab{width:40px;height:4px;border-radius:4px;background:var(--ln);margin:2px auto 12px}
h2{margin:0 0 4px;font-size:18px;line-height:1.3}
h3{margin:16px 0 6px;font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--mu)}
.sub{color:var(--mu);font-size:13px;margin:0 0 8px}
.bad h2{color:var(--bad)} .ok h2{color:var(--ok)}
.row{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid var(--ln)}
.row:last-child{border-bottom:0}
.seg{display:inline-flex;border:1px solid var(--ln);border-radius:10px;overflow:hidden;flex:none}
.seg button{padding:6px 12px;font-size:13px;font-weight:700}
.seg button.on{background:#1a73e8;color:#fff}
.seg button.on.h{background:#b3261e;color:#fff}
.chips{display:flex;flex-wrap:wrap;gap:6px}
.chip{padding:7px 12px;border-radius:999px;border:1px solid var(--ln);font-weight:700;font-size:13px}
.chip.on{background:var(--acs);border-color:var(--ac);color:var(--ac)}
.sw{width:42px;height:24px;border-radius:999px;background:#bdc1c6;position:relative;flex:none}
.sw::after{content:"";position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:50%;background:#fff;transition:left .15s}
.sw.on{background:#1e8e3e}.sw.on::after{left:21px}
.btn{display:block;width:100%;margin-top:14px;padding:12px;border-radius:12px;background:var(--ac);color:var(--bg);font-weight:700;font-size:15px;text-align:center}
.btn.g{background:var(--chip);color:var(--fg);margin-top:8px}
dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 14px;margin:8px 0 0}
dt{color:var(--mu)} dd{margin:0;word-break:break-word}
ul.tl{list-style:none;margin:0;padding:0}
ul.tl li{display:grid;grid-template-columns:96px 1fr;gap:8px;padding:6px 0;border-bottom:1px dashed var(--ln)}
ul.tl li:last-child{border-bottom:0}
.d{color:var(--ac);font-variant-numeric:tabular-nums}
ol.steps{margin:8px 0 0;padding-left:22px;display:grid;gap:6px}
.note{margin-top:10px;padding:10px 12px;border-radius:10px;background:var(--chip);color:var(--mu);font-size:13px}
.warn{background:#fef7e0;color:#7a4f01}
@media (prefers-color-scheme:dark){.warn{background:#3a2f12;color:#f2c66b}}
.prog{height:6px;border-radius:999px;background:var(--chip);overflow:hidden;margin:12px 0 6px}
.prog i{display:block;height:100%;width:0;background:var(--ac);transition:width .3s}
.toast{position:fixed;left:50%;bottom:calc(70px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);z-index:2147483647;
  max-width:calc(100vw - 32px);padding:8px 14px;border-radius:999px;background:#1f1f1f;color:#fff;font-size:13px;font-weight:600;
  box-shadow:0 4px 16px rgba(0,0,0,.3);text-align:center;transition:opacity .3s}
a{color:var(--ac);font-weight:700;text-decoration:none}
.mono{font-family:ui-monospace,Menlo,monospace;font-size:12px;word-break:break-all}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}`;

  function adoptCss(target, css) {
    try {
      const sh = new CSSStyleSheet();
      sh.replaceSync(css);
      target.adoptedStyleSheets = [...target.adoptedStyleSheets, sh];
      return () => { target.adoptedStyleSheets = target.adoptedStyleSheets.filter((s) => s !== sh); };
    } catch {
      const st = $el("style"); st.textContent = css;
      (target === document ? document.head : target).append(st);
      return () => st.remove();
    }
  }

  // ---------------------------------------------------------------- state
  const prefs = Object.assign({ preset: "all", hide: {}, hiddenStyle: "collapse", autoClear: false, firstRunDone: false }, store.get("prefs", {}));
  const save = () => store.set("prefs", prefs);
  let host, root, view, removePageCss, observer, scanTimer;
  let sheetEl = null, shadeEl = null;
  const results = new Set(); // boxes we've tagged

  // ---------------------------------------------------------------- UI shell
  function mountUi() {
    removePageCss = adoptCss(document, PAGE_CSS);
    host = $el("div");
    host.id = "ssf-host";
    host.style.cssText = "position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647";
    root = host.attachShadow({ mode: "open" });
    adoptCss(root, UI_CSS);
    view = $el("div", "v");
    root.append(view);
    document.documentElement.append(host);
  }

  let toastTimer;
  function toast(text, ms = 3500) {
    view.querySelector(".toast")?.remove();
    const t = $el("div", "toast", text);
    view.append(t);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.style.opacity = "0"; setTimeout(() => t.remove(), 300); }, ms);
  }

  function closeSheet() { sheetEl?.remove(); shadeEl?.remove(); sheetEl = shadeEl = null; }
  function openSheet(cls, build, { dismissable = true } = {}) {
    closeSheet();
    shadeEl = $el("div", "shade");
    if (dismissable) shadeEl.addEventListener("click", closeSheet);
    sheetEl = $el("div", "sheet " + (cls || ""));
    sheetEl.setAttribute("role", "dialog");
    sheetEl.append($el("div", "grab"));
    build(sheetEl);
    // swipe down to close
    let y0 = null;
    sheetEl.addEventListener("touchstart", (e) => { y0 = sheetEl.scrollTop === 0 ? e.touches[0].clientY : null; }, { passive: true });
    sheetEl.addEventListener("touchend", (e) => { if (dismissable && y0 != null && e.changedTouches[0].clientY - y0 > 80) closeSheet(); y0 = null; });
    view.append(shadeEl, sheetEl);
    return sheetEl;
  }
  const btn = (text, cls, fn) => { const b = $el("button", cls, text); b.type = "button"; b.addEventListener("click", fn); return b; };
  function seg(options, value, onPick, hideKey) {
    const s = $el("div", "seg");
    options.forEach(([val, label]) => {
      const b = btn(label, val === value ? "on" + (val === hideKey ? " h" : "") : "", () => onPick(val));
      b.setAttribute("aria-pressed", String(val === value));
      s.append(b);
    });
    return s;
  }
  function switchRow(label, on, onToggle, sub) {
    const r = $el("div", "row");
    const t = $el("div"); t.append($el("div", null, label));
    if (sub) t.append($el("div", "sub", sub));
    const s = btn("", "sw" + (on ? " on" : ""), onToggle);
    s.setAttribute("role", "switch"); s.setAttribute("aria-checked", String(on)); s.setAttribute("aria-label", label);
    r.append(t, s);
    return r;
  }

  // ---------------------------------------------------------------- bar
  let barEl;
  function renderBar() {
    if (!barEl) {
      barEl = $el("div", "bar");
      view.append(barEl);
    }
    barEl.replaceChildren();
    const counts = { flagged: 0, clean: 0, hidden: 0 };
    results.forEach((b) => {
      if (b.dataset.ssfCats === "clean") counts.clean++; else counts.flagged++;
      if (b.classList.contains("ssf-hidden") && b.dataset.ssfReveal !== "1") counts.hidden++;
    });
    const c = $el("div", "cnt");
    c.append($el("span", "pill p-bad", "⚠ " + counts.flagged + " flagged"), $el("span", "pill p-ok", "✓ " + counts.clean));
    if (counts.hidden) c.append($el("span", "pill p-mu", counts.hidden + " hidden"));
    barEl.append(c, btn("⚙ Filter", "ib", openFilter), btn("✕", "ib x", () => turnOff()));
    barEl.lastChild.setAttribute("aria-label", "Turn off");
  }

  // ---------------------------------------------------------------- scanning
  function resultRoot() { return document.querySelector("#rso") || document.querySelector("#search") || document.querySelector("#main") || document.body; }
  const RESULT_SEL = "a[href]:has(h3), a[href]:has([role='heading'])";
  const TITLE_SEL = "a h3, a [role='heading']";

  function realUrl(a) {
    try {
      const u = new URL(a.href, location.href);
      if (/(^|\.)google\./.test(u.hostname) && u.pathname === "/url") {
        const q = u.searchParams.get("q") || u.searchParams.get("url");
        return q ? new URL(q) : null;
      }
      return u;
    } catch { return null; }
  }
  function containerOf(a, stop) {
    let n = a;
    while (n.parentElement && n.parentElement !== stop && n.parentElement !== document.body &&
           n.parentElement.querySelectorAll(TITLE_SEL).length <= 1) n = n.parentElement;
    return n;
  }

  function makeLabel(hostName, info) {
    const cat = info.allowed ? "clean" : info.primary || "clean";
    let text;
    if (cat === "clean") text = info.allowed ? "✓ Not flagged · allowed by admin" : "✓ Not flagged";
    else {
      const srcs = new Set(info.hits.filter((h) => h.cat === cat).map((h) => (data.sources[h.src] || {}).short || h.src));
      if (info.admin && (ORDER.includes(info.admin.category) ? info.admin.category : "other") === cat) srcs.add("Admin");
      const extra = info.cats.length > 1 ? " +" + (info.cats.length - 1) : "";
      text = "⚠ " + CATS[cat].short + " · " + [...srcs].slice(0, 2).join(", ") + extra;
    }
    const b = $el("button", "ssf-lbl ssf-c-" + cat, text);
    b.type = "button";
    b.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); openDetail(hostName, info); });
    return b;
  }

  function scan() {
    const stop = resultRoot();
    let added = 0;
    stop.querySelectorAll(RESULT_SEL).forEach((a) => {
      if (a.dataset.ssfDone) return;
      a.dataset.ssfDone = "1";
      if (a.closest("#ssf-host")) return;
      const u = realUrl(a);
      if (!u || !/^https?:$/.test(u.protocol) || /(^|\.)google\.[a-z.]+$/.test(u.hostname) || /(^|\.)(gstatic|googleusercontent)\.com$/.test(u.hostname)) return;
      const hostName = normHost(u.hostname);
      const info = lookup(hostName);
      const label = makeLabel(hostName, info);
      a.insertAdjacentElement("afterend", label);
      const box = containerOf(a, stop);
      const cats = info.allowed || !info.cats.length ? ["clean"] : info.cats;
      const prev = box.dataset.ssfCats;
      box.dataset.ssfCats = prev && prev !== "clean" ? prev : cats.join(" ");
      results.add(box);
      added++;
    });
    if (added) applyFilter();
    return added;
  }

  function isHidden(box) {
    if (box.dataset.ssfReveal === "1") return false;
    return box.dataset.ssfCats.split(" ").some((c) => prefs.hide[c]);
  }
  function applyFilter() {
    results.forEach((box) => {
      const hide = isHidden(box);
      box.classList.toggle("ssf-hidden", hide);
      let ph = box.previousElementSibling && box.previousElementSibling.classList.contains("ssf-collapsed") ? box.previousElementSibling : null;
      if (hide && prefs.hiddenStyle === "collapse") {
        if (!ph) {
          ph = $el("button", "ssf-collapsed");
          ph.type = "button";
          ph.addEventListener("click", () => { box.dataset.ssfReveal = "1"; applyFilter(); });
          box.before(ph);
        }
        const cats = box.dataset.ssfCats.split(" ").filter((c) => prefs.hide[c]);
        const names = cats.map((c) => (c === "clean" ? "unflagged" : CATS[c].short));
        ph.replaceChildren(document.createTextNode("1 " + names.join("/") + " result hidden · "), $el("b", null, "Show"));
      } else if (ph) ph.remove();
    });
    renderBar();
  }

  // ---------------------------------------------------------------- sheets
  function presetOf() {
    for (const [k, p] of Object.entries(PRESETS)) {
      if (FILTER_KEYS.every((c) => !!p.hide[c] === !!prefs.hide[c])) return k;
    }
    return "custom";
  }

  function openFilter() {
    openSheet("", (s) => {
      s.append($el("h2", null, "Filter"), $el("p", "sub", "Choose what to hide. Your choice is remembered for every search on this phone."));
      const chips = $el("div", "chips");
      const cur = presetOf();
      Object.entries(PRESETS).forEach(([k, p]) => chips.append(btn(p.name, "chip" + (cur === k ? " on" : ""), () => {
        prefs.hide = { ...p.hide }; prefs.preset = k; save(); revealReset(); applyFilter(); openFilter();
      })));
      chips.append($el("span", "chip" + (cur === "custom" ? " on" : ""), "Custom"));
      s.append(chips, $el("h3", null, "Each category"));
      [...ORDER, "clean"].forEach((c) => {
        const r = $el("div", "row");
        r.append($el("span", null, c === "clean" ? "Not flagged" : CATS[c].name));
        r.append(seg([["show", "Show"], ["hide", "Hide"]], prefs.hide[c] ? "hide" : "show", (v) => {
          if (v === "hide") prefs.hide[c] = 1; else delete prefs.hide[c];
          prefs.preset = presetOf(); save(); revealReset(); applyFilter(); openFilter();
        }, "hide"));
        s.append(r);
      });
      s.append($el("h3", null, "Hidden results"));
      const r = $el("div", "row");
      r.append($el("span", null, "Show as"), seg([["collapse", "One line"], ["remove", "Remove"]], prefs.hiddenStyle, (v) => {
        prefs.hiddenStyle = v; save(); applyFilter(); openFilter();
      }));
      s.append(r);

      s.append($el("h3", null, "Privacy"));
      s.append(switchRow("Clear history when I turn off", prefs.autoClear, () => {
        prefs.autoClear = !prefs.autoClear; save(); openFilter();
      }, "Shows the exact Chrome steps to delete this session when you tap ✕."));
      const ga = $el("div", "note");
      ga.append(document.createTextNode("Google may also keep your searches in your Google Account. Manage that at "), $el("b", null, "myactivity.google.com"), document.createTextNode("."));
      s.append(ga);

      s.append($el("h3", null, "Safety list"));
      s.append(listStatus());
      s.append(btn("Done", "btn", closeSheet));
    });
  }
  function revealReset() { results.forEach((b) => { delete b.dataset.ssfReveal; }); }

  function listStatus() {
    const m = data.manifest || {};
    const dl = $el("dl");
    const add = (k, v) => dl.append($el("dt", null, k), $el("dd", null, v));
    const total = data.groups.reduce((n, g) => n + g.starts.length, 0);
    add("Updated", m.updated ? fmtDate(m.updated) : "—");
    add("Domains", total.toLocaleString("en-US") + " in " + data.groups.length + " lists");
    add("Admin entries", String(data.admin.size) + " flagged, " + data.allow.size + " allowed");
    if (!data.stats.fromCache) add("Downloaded", (data.stats.chars / 1048576).toFixed(1) + " MB (before compression) in " + (data.stats.ms / 1000).toFixed(1) + " s");
    else add("Downloaded", "Using saved copy");
    add("Build", VERSION);
    const wrap = $el("div"); wrap.append(dl);
    if (data.stats.errors.length) {
      const n = $el("div", "note warn");
      n.append($el("b", null, "Problems: "), document.createTextNode(data.stats.errors.join(" · ")));
      wrap.append(n);
    }
    return wrap;
  }

  function openDetail(hostName, info) {
    const flagged = !info.allowed && info.cats.length > 0;
    openSheet(flagged ? "bad" : "ok", (s) => {
      s.append($el("h2", null, flagged ? "⚠ " + info.cats.map((c) => CATS[c].name).join(" · ") : "✓ Not flagged"));
      s.append($el("p", "sub", hostName));
      const dl = $el("dl");
      const add = (k, v) => dl.append($el("dt", null, k), $el("dd", null, v));
      if (info.allowed) {
        add("Status", "Allowed by admin");
        if (info.allowed.reason) add("Reason", info.allowed.reason);
        if (info.allowed.date) add("Since", fmtDate(info.allowed.date));
      } else if (flagged) {
        if (info.matched && info.matched !== hostName) add("Matched", info.matched);
        const srcNames = [...new Set(info.hits.map((h) => (data.sources[h.src] || {}).name || h.src))];
        if (info.admin) srcNames.push("Admin");
        add("Flagged by", srcNames.join(", "));
        if (info.admin && info.admin.reason) add("Admin reason", info.admin.reason);
        add("Confirmed", data.manifest && data.manifest.updated ? fmtDate(data.manifest.updated) + " (latest list)" : "Latest list");
      } else {
        add("Status", "Not on any list");
        add("Checked", new Date().toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }));
        add("List date", data.manifest && data.manifest.updated ? fmtDate(data.manifest.updated) : "—");
      }
      s.append(dl);

      if (flagged) {
        s.append($el("h3", null, "History"));
        const ul = $el("ul", "tl");
        const events = [];
        (info.admin && info.admin.history || []).forEach((h) => events.push({ date: h.date, text: h.event + " (admin)" }));
        const ph = $el("li"); ph.append($el("span", "d", "…"), $el("span", null, "Loading dates"));
        ul.append(ph);
        s.append(ul);
        const render = (hist) => {
          ul.replaceChildren();
          const all = [...events];
          if (hist) Object.entries(hist).forEach(([src, date]) => all.push({ date, text: "First seen in " + ((data.sources[src] || {}).name || src) }));
          if (data.manifest && data.manifest.updated && info.hits.length) all.push({ date: String(data.manifest.updated).slice(0, 10), text: "Still listed (daily check)" });
          all.sort((a, b) => String(b.date).localeCompare(String(a.date)));
          if (!all.length) ul.append($el("li", null, "No dated history yet."));
          all.forEach((e) => { const li = $el("li"); li.append($el("span", "d", fmtDate(e.date)), $el("span", null, e.text)); ul.append(li); });
          if (!hist && info.hits.length && !(data.manifest && data.manifest.historyBase)) {
            s.insertBefore($el("div", "note", "First-seen dates for list entries appear once the admin's daily list is set up."), ul.nextSibling);
          }
        };
        const d = info.hits[0] && info.hits[0].domain;
        (d ? historyFor(d) : Promise.resolve(null)).then(render);
      }

      const report = (data.manifest && data.manifest.reportUrl) || CONFIG.reportUrl;
      if (report) {
        const a = $el("a", null, flagged ? "Report a mistake →" : "Report this site →");
        a.href = report.replace("{domain}", encodeURIComponent(hostName)).replace("{type}", flagged ? "false-positive" : "report");
        a.target = "_blank"; a.rel = "noopener";
        const p = $el("p"); p.style.marginTop = "14px"; p.append(a);
        s.append(p);
      }
      s.append(btn("Close", "btn g", closeSheet));
    });
  }

  function openFirstRun(next) {
    let choice = "all";
    const build = () => openSheet("", (s) => {
      s.append($el("h2", null, "Welcome to Search Safety Flagger"), $el("p", "sub", "Every Google result gets a safety label. What should be hidden?"));
      const chips = $el("div", "chips");
      [["all", "Show all, label only"], ["flagged", "Hide all flagged"], ["custom", "Custom…"]].forEach(([k, n]) =>
        chips.append(btn(n, "chip" + (choice === k ? " on" : ""), () => { choice = k; build(); })));
      s.append(chips);
      s.append($el("h3", null, "Privacy"));
      s.append(switchRow("Clear history when I turn off", prefs.autoClear, () => { prefs.autoClear = !prefs.autoClear; build(); },
        "When you tap ✕, you get the exact Chrome steps to delete this session."));
      s.append($el("p", "sub", "You can change these any time with ⚙ Filter."));
      s.append(btn("Start", "btn", () => {
        if (choice !== "custom") prefs.hide = { ...PRESETS[choice].hide };
        prefs.preset = choice; prefs.firstRunDone = true; save(); closeSheet(); next(choice === "custom");
      }));
    }, { dismissable: false });
    build();
  }

  function openLoading() {
    const s = openSheet("", (s) => {
      s.append($el("h2", null, "Downloading the safety list"));
      const pr = $el("div", "prog"); pr.append($el("i")); s.append(pr);
      s.append($el("p", "sub", "First time only, then refreshed once a day in the background."));
    }, { dismissable: false });
    return (done, total) => { const i = s.querySelector(".prog i"); if (i) i.style.width = Math.round((done / Math.max(1, total)) * 100) + "%"; };
  }

  // ---------------------------------------------------------------- session + clear guide
  function rangeFor(ms) {
    const m = ms / 6e4;
    if (m <= 14) return { quick: true, name: "Last 15 minutes" };
    if (m <= 58) return { name: "Last hour" };
    if (m <= 24 * 60 - 2) return { name: "Last 24 hours" };
    if (m <= 7 * 24 * 60 - 2) return { name: "Last 7 days" };
    if (m <= 28 * 24 * 60 - 2) return { name: "Last 4 weeks" };
    return { name: "All time", all: true };
  }
  function openClearGuide(start, { previous = false, then } = {}) {
    const now = Date.now();
    const r = rangeFor(now - start);
    openSheet("", (s) => {
      s.append($el("h2", null, previous ? "Your last session wasn't cleared" : "Flagger off. Clear this session?"));
      s.append($el("p", "sub", "Started " + fmtDate(start) + " " + fmtTime(start) + " · " + fmtDur(now - start) + " ago"));
      const ol = $el("ol", "steps");
      const li = (...parts) => { const l = $el("li"); parts.forEach((p) => l.append(typeof p === "string" ? document.createTextNode(p) : p)); ol.append(l); };
      li("Tap Chrome's ", $el("b", null, "⋮"), " menu (top right)");
      li("Tap ", $el("b", null, "Delete browsing data"));
      if (r.quick) li("Check it says ", $el("b", null, "Last 15 minutes"), ", then tap ", $el("b", null, "Delete"));
      else {
        li("Set the time range to ", $el("b", null, r.name), " (tap ", $el("b", null, "More options"), " if you don't see it)");
        li("To stay signed in to sites, untick ", $el("b", null, "Cookies and site data"));
        li("Tap ", $el("b", null, "Delete"));
      }
      s.append(ol);
      if (!r.quick) s.append($el("div", "note warn", r.all
        ? "This session is older than 4 weeks, so Chrome can only clear it with All time, which deletes all your history."
        : "Chrome clears by time, so this also removes anything else you browsed in the " + r.name.toLowerCase() + "."));
      s.append(btn("Got it", "btn", () => { closeSheet(); then && then(); }));
      s.append(btn("Skip this time", "btn g", () => { closeSheet(); then && then(); }));
    }, { dismissable: false });
  }

  function startSession() {
    const now = Date.now();
    const s = store.get("session", null);
    if (s && !s.ended && now - s.lastActive <= SESSION_GAP) {
      s.lastActive = now; store.set("session", s); return { prev: null };
    }
    store.set("session", { start: now, lastActive: now, ended: false });
    return { prev: s && !s.ended ? s : null };
  }
  function touchSession() { const s = store.get("session", null); if (s && !s.ended) { s.lastActive = Date.now(); store.set("session", s); } }

  // ---------------------------------------------------------------- on / off
  function cleanupPage() {
    observer && observer.disconnect();
    document.querySelectorAll(".ssf-lbl, .ssf-collapsed").forEach((n) => n.remove());
    results.forEach((b) => { b.classList.remove("ssf-hidden"); delete b.dataset.ssfCats; delete b.dataset.ssfReveal; });
    results.clear();
    document.querySelectorAll("[data-ssf-done]").forEach((a) => delete a.dataset.ssfDone);
    removePageCss && removePageCss();
  }
  function turnOff() {
    if (!window.__ssf.active) return;
    window.__ssf.active = false;
    cleanupPage();
    barEl && barEl.remove(); barEl = null;
    const s = store.get("session", null);
    if (s) { s.ended = true; store.set("session", s); }
    const finish = () => host && host.remove();
    if (prefs.autoClear && s) openClearGuide(s.start, { then: finish });
    else { closeSheet(); toast("Search Safety Flagger is off", 1800); setTimeout(finish, 2000); }
  }

  async function turnOn() {
    window.__ssf = { active: true, turnOff };
    mountUi();
    if (!/(^|\.)google\.[a-z.]+$/.test(location.hostname) || !/^\/search/.test(location.pathname)) {
      toast("Run ssf on a Google search results page", 3500);
      window.__ssf.active = false;
      setTimeout(() => host.remove(), 3800);
      return;
    }
    const { prev } = startSession();

    const go = async (openCustom) => {
      // load lists (blocking only when nothing is cached yet)
      let progress = null;
      try {
        const m = CONFIG.manifestUrl ? (await idb.get("manifest")) : CONFIG.manifest;
        if (!(await hasAnyCache(m))) progress = openLoading();
        await loadAll(progress || (() => {}));
      } catch (e) {
        data.stats.errors.push(e.message || String(e));
      }
      if (progress) closeSheet();
      if (!window.__ssf.active) return;
      scan();
      renderBar();
      const flagged = [...results].filter((b) => b.dataset.ssfCats !== "clean").length;
      if (!data.groups.length) toast("Couldn't download the safety list · tap ⚙ Filter for details", 5000);
      else toast(results.size + " results · " + flagged + " flagged · list " + (data.manifest.updated ? fmtDate(data.manifest.updated) : "loaded"));
      observer = new MutationObserver(() => { clearTimeout(scanTimer); scanTimer = setTimeout(() => { scan(); touchSession(); }, 300); });
      observer.observe(resultRoot(), { childList: true, subtree: true });
      if (openCustom) openFilter();
      else if (prev && prefs.autoClear) openClearGuide(prev.start, { previous: true });
    };

    if (!prefs.firstRunDone) openFirstRun(go);
    else go(false);
  }

  turnOn().catch((e) => { try { toast("Search Safety Flagger error: " + e.message, 6000); } catch { alert("Search Safety Flagger error: " + e.message); } });
})();
