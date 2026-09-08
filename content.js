/*
 * CR Watchlist Plus — content script.
 *
 * Runs on crunchyroll.com in your logged-in session. Uses the same internal
 * JSON endpoints the site itself uses to:
 *   1. exchange your session cookie for a short-lived bearer token,
 *   2. read your watchlist, every show's seasons, and every season's episodes
 *      in both Japanese and English audio,
 *   3. read your playheads so an episode watched in either language counts as
 *      watched,
 *   4. rank shows by the newest episode you have NOT watched yet, using the
 *      English release date when a dub exists and the Japanese date otherwise.
 *
 * It also runs inside the video player iframe, where it clicks Crunchyroll's
 * own "Skip Intro / Recap / Credits" buttons according to your settings.
 *
 * Nothing leaves the browser except requests to crunchyroll.com.
 */
(() => {
  "use strict";

  // Everything Crunchyroll-specific (endpoints, fields, selectors) is in contract.js,
  // loaded before this file. tests/ checks the same object against the live site.
  const C = globalThis.CRWP_CONTRACT;
  if (!C) { console.error("[CR Watchlist Plus] contract.js did not load; aborting"); return; }

  // ---------------------------------------------------------------- config
  const APP_NAME = "CR Watchlist Plus";
  const OPEN_HASH = "#cr-watchlist-plus";
  // Update check: the manifest on the repository's main branch is exactly what
  // "Download ZIP" would give you. Fetched at most once a day, only if enabled
  // in Settings, and the only request this extension makes off crunchyroll.com.
  const REPO_URL = "https://github.com/Fosnez/CR-watchlist-plus";
  const MANIFEST_URL = "https://raw.githubusercontent.com/Fosnez/CR-watchlist-plus/main/manifest.json";
  const UPDATE_CHECK_KEY = "update_check"; // { at, version }
  // Audio locales Crunchyroll offers. Order here is only the order shown in Settings.
  const LOCALES = [
    ["en-US", "English"], ["ja-JP", "Japanese"], ["de-DE", "German"], ["fr-FR", "French"],
    ["es-419", "Spanish (Latin America)"], ["es-ES", "Spanish (Spain)"], ["pt-BR", "Portuguese (Brazil)"],
    ["it-IT", "Italian"], ["ru-RU", "Russian"], ["pl-PL", "Polish"], ["tr-TR", "Turkish"], ["ar-SA", "Arabic"],
    ["hi-IN", "Hindi"], ["ta-IN", "Tamil"], ["te-IN", "Telugu"], ["ko-KR", "Korean"], ["zh-CN", "Chinese (Mandarin)"],
    ["id-ID", "Indonesian"], ["ms-MY", "Malay"], ["th-TH", "Thai"], ["vi-VN", "Vietnamese"], ["ca-ES", "Catalan"],
  ];
  const LOCALE_NAME = Object.fromEntries(LOCALES);
  const DEFAULT_LANGUAGES = ["en-US", "ja-JP"];
  const HOUR = 60 * 60 * 1000, DAY = 24 * HOUR;
  // Cache lifetimes. An instalment is "active" while its newest episode is less
  // than ACTIVE_WINDOW old; everything else is dormant. These are fallbacks: the
  // per-season episode counts in the seasons response act as a fingerprint, and
  // a changed fingerprint refetches an instalment's episodes whatever its age.
  const ACTIVE_WINDOW_MS = 30 * DAY;
  const TTL = {
    active: HOUR,             // airing (or a dub still catching up)
    latestDormant: 7 * DAY,   // a show's latest instalment, nothing new for 30 days: may resume (split cour)
    dormant: 30 * DAY,        // older instalment with unwatched episodes: a dub could still arrive
    dormantWatched: 365 * DAY,// older instalment, every episode watched: nothing left that can matter
    seasonsActive: HOUR,      // the show's seasons list while any instalment is active
    seasonsDormant: DAY,      // seasons list of a dormant show; a new season is listed long before it airs
    watching: 6 * HOUR,       // how long a "currently watching" note from a /watch/ page stays relevant
  };
  const CONCURRENCY = 6;      // items worked on at once within a phase
  const MAX_IN_FLIGHT = 8;    // hard cap on simultaneous API requests, shared by every phase
  const DEFAULT_PREFS = { watchedPct: 75, highWater: true, hideDone: true, languages: DEFAULT_LANGUAGES, strictLanguages: true, skipIntro: true, skipCredits: true, skipRecap: false, checkUpdates: true };
  // Crunchyroll only sets `fully_watched` if you sit through the ending theme.
  // Skipping the credits leaves the playhead at roughly 80-90%, so treat an
  // episode as watched once past prefs.watchedPct OR within this many seconds
  // of the end (the tail rule only applies to episodes longer than the tail).
  const WATCHED_TAIL_SECONDS = 300;
  // Preferences live in a cookie on crunchyroll.com. Chrome caps cookie lifetime
  // at 400 days; we ask for that and rewrite the cookie on every open, so in
  // practice it never expires while the extension is in use.
  const COOKIE_MAX_AGE = 400 * 24 * 60 * 60;
  const PREFS_COOKIE = "cr_watchlist_plus_prefs";
  const ACTIVE_COOKIE = "cr_watchlist_plus_active";
  const DATA_KEY = "data:v5";
  const seasonKey = (langs, seasonId) => `season:v5:${langs.join("+")}:${seasonId}`;
  const seasonsListKey = (seriesId) => `seasons:v1:${seriesId}`;
  const PLAYHEADS_KEY = "playheads:v1"; // { [versionId]: { playhead, fully_watched, observed? } }
  const WATCHING_KEY = "watching";       // { id, at } written by the top frame on /watch/ pages
  const OBS_PREFIX = "obs:";             // obs:<versionId> -> { playhead, at } sampled in the player frame

  // --------------------------------------------------------------- storage
  // Result cache: chrome.storage.local when running as an extension; a
  // localStorage fallback so the same file can be pasted into the page console
  // for testing. Preferences are NOT kept here; they live in the cookie only.
  const isExtension = typeof chrome !== "undefined" && !!(chrome.storage && chrome.storage.local);
  const VERSION = (isExtension && chrome.runtime && chrome.runtime.getManifest && chrome.runtime.getManifest().version) || "dev";
  const store = isExtension
    ? {
        get: (k) => chrome.storage.local.get(k).then((r) => r[k]),
        set: (k, v) => chrome.storage.local.set({ [k]: v }),
        remove: (ks) => chrome.storage.local.remove(ks),
        keys: () => chrome.storage.local.get(null).then((r) => Object.keys(r)),
      }
    : {
        get: async (k) => { try { const v = localStorage.getItem("bwl:" + k); return v ? JSON.parse(v) : undefined; } catch { return undefined; } },
        set: async (k, v) => { try { localStorage.setItem("bwl:" + k, JSON.stringify(v)); } catch {} },
        remove: async (ks) => { for (const k of [].concat(ks)) localStorage.removeItem("bwl:" + k); },
        keys: async () => Object.keys(localStorage).filter((k) => k.startsWith("bwl:")).map((k) => k.slice(4)),
      };

  const readCookie = (name) => {
    const m = document.cookie.match(new RegExp("(?:^|; )" + name.replace(/[$()*+.?[\\\]^{|}]/g, "\\$&") + "=([^;]*)"));
    return m ? decodeURIComponent(m[1]) : null;
  };
  // Domain=.crunchyroll.com so the player iframe (static.crunchyroll.com) sees the same settings.
  const COOKIE_ATTRS = "Path=/; Domain=.crunchyroll.com; SameSite=Lax; Secure";
  const writeCookie = (name, value, maxAge = COOKIE_MAX_AGE) => {
    document.cookie = `${name}=${encodeURIComponent(value)}; Max-Age=${maxAge}; ${COOKIE_ATTRS}`;
  };
  const deleteCookie = (name) => { document.cookie = `${name}=; Max-Age=0; ${COOKIE_ATTRS}`; };

  function sanitizePrefs(p) {
    const out = { ...DEFAULT_PREFS };
    if (p && typeof p === "object") {
      if (Number.isFinite(p.watchedPct)) out.watchedPct = Math.min(100, Math.max(50, Math.round(p.watchedPct / 5) * 5));
      if (typeof p.highWater === "boolean") out.highWater = p.highWater;
      if (typeof p.hideDone === "boolean") out.hideDone = p.hideDone;
      for (const k of ["skipIntro", "skipCredits", "skipRecap", "strictLanguages", "checkUpdates"]) if (typeof p[k] === "boolean") out[k] = p[k];
      if (Array.isArray(p.languages)) {
        const langs = [...new Set(p.languages.filter((l) => LOCALE_NAME[l]))];
        if (langs.length) out.languages = langs;
      }
    }
    return out;
  }
  // First run writes the defaults; every later run rewrites the same values,
  // which restarts the 400-day clock.
  function loadPrefs() {
    let raw = null;
    try { raw = JSON.parse(readCookie(PREFS_COOKIE)); } catch { raw = null; }
    const prefs = sanitizePrefs(raw);
    savePrefs(prefs);
    return prefs;
  }
  const savePrefs = (prefs) => writeCookie(PREFS_COOKIE, JSON.stringify(prefs));
  function currentPrefs() {
    try { return sanitizePrefs(JSON.parse(readCookie(PREFS_COOKIE))); } catch { return { ...DEFAULT_PREFS }; }
  }

  // ------------------------------------------------------------- auto-skip
  // The video player is an iframe on static.crunchyroll.com. When one of its
  // "Skip Intro / Skip Recap / Skip Credits" buttons becomes visible, click it
  // if that kind is enabled in Settings. Runs in every frame; cheap when idle.
  const SKIP_KIND_BY_WORD = [
    [/recap/i, "skipRecap"],
    [/credit|outro|ending/i, "skipCredits"],
    [/intro|opening/i, "skipIntro"],
  ];
  // Classify by what the user can read on the button. Crunchyroll reuses test
  // ids and aria-labels across its skip buttons, so those are only a fallback
  // when the button carries no visible text at all.
  function skipKind(el, btn) {
    const text = ((btn && btn.textContent) || el.textContent || "").trim();
    const meta = [el.getAttribute("data-testid"), el.getAttribute("aria-label"), btn && btn.getAttribute("aria-label")].filter(Boolean).join(" ");
    const hay = text || meta;
    if (!/skip/i.test(hay) && !/skip/i.test(meta)) return null;
    for (const [re, kind] of SKIP_KIND_BY_WORD) if (re.test(hay)) return { kind, label: text || meta };
    return null;
  }
  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none" && cs.opacity !== "0";
  }
  function startAutoSkip() {
    const lastClick = {};
    let scheduled = false;
    const scan = () => {
      scheduled = false;
      const hits = document.querySelectorAll(C.dom.player.skipCandidates);
      if (!hits.length) return;
      const prefs = currentPrefs();
      for (const el of hits) {
        const btn = el.closest(C.dom.player.skipButton) || el;
        const hit = skipKind(el, btn);
        if (!hit) continue;
        if (!isVisible(btn) || btn.disabled) continue;
        if (!prefs[hit.kind]) { console.debug(`[${APP_NAME}] skip button seen, left alone (${hit.kind} off): "${hit.label}"`); continue; }
        const now = Date.now();
        if (now - (lastClick[hit.kind] || 0) < 1500) continue;
        lastClick[hit.kind] = now;
        btn.click();
        console.info(`[${APP_NAME}] auto-skipped ${hit.kind}: "${hit.label}"`);
        return;
      }
    };
    const schedule = () => { if (!scheduled) { scheduled = true; setTimeout(scan, 150); } };
    const observe = () => {
      if (!document.body) return false;
      new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style", "data-testid"] });
      setInterval(scan, 1000); // belt and braces: the buttons animate in via CSS in some builds
      return true;
    };
    if (!observe()) document.addEventListener("DOMContentLoaded", observe, { once: true });
  }
  startAutoSkip();

  // ---------------------------------------------------- observed playheads
  // Wherever the <video> lives (Crunchyroll has rendered the player both in the
  // page and in an iframe on static.crunchyroll.com): sample it and note how far
  // you are into the episode named by the /watch/ URL. In the top frame that is
  // this page's URL; in an iframe it is the `watching` note the top frame wrote.
  // The overlay uses these notes to draw the right state the instant you come
  // back, before Crunchyroll's own record has been re-read. They never replace
  // that record: a note is only a hint, so a bad sample can last at most until
  // the next refresh. A sample is committed only when two consecutive readings
  // for the same id advance, so the moment autoplay swaps episodes cannot pin
  // the old position onto the new id.
  function startPlayheadObserver() {
    let last = null; // { id, t }
    setInterval(async () => {
      const video = document.querySelector("video");
      if (!video || !(video.duration > 0) || !(video.currentTime > 0)) return;
      let id = null;
      if (window.top === window) { const m = location.pathname.match(C.dom.watchIdFromPath); id = m && m[1]; }
      else { const w = await store.get(WATCHING_KEY); id = w && Date.now() - w.at <= TTL.watching ? w.id : null; }
      if (!id) return;
      const t = Math.floor(video.currentTime);
      if (last && last.id === id && t > last.t) await store.set(OBS_PREFIX + id, { playhead: t, duration: Math.round(video.duration), at: Date.now() });
      last = { id, t };
    }, 5000);
  }
  startPlayheadObserver();
  if (window.top !== window) return; // inside an iframe: auto-skip and observation only

  // Per-install device id for the token grant (not a user identifier; it just
  // stops every install from presenting the same device to Crunchyroll).
  async function deviceId() {
    let id = await store.get("device_id");
    if (!id) {
      id = (crypto.randomUUID && crypto.randomUUID()) || "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => { const r = (Math.random() * 16) | 0; return (c === "x" ? r : (r & 3) | 8).toString(16); });
      await store.set("device_id", id);
    }
    return id;
  }

  // ------------------------------------------------------------------- api
  let token = null; // { access_token, account_id, expiresAt }

  async function getToken() {
    if (token && Date.now() < token.expiresAt - 20_000) return token;
    const r = await fetch(C.api.token.path, {
      method: "POST",
      credentials: "include",
      headers: { Authorization: "Basic " + C.api.token.basic, "Content-Type": "application/x-www-form-urlencoded" },
      body: `grant_type=${C.api.token.grant}&device_type=Chrome&device_id=${await deviceId()}`,
    });
    if (!r.ok) throw new Error(`Token exchange failed (${r.status}). Are you logged in to Crunchyroll?`);
    const j = await r.json();
    token = { access_token: j.access_token, account_id: j.account_id, expiresAt: Date.now() + (j.expires_in || 300) * 1000 };
    return token;
  }

  // Global request gate: at most MAX_IN_FLIGHT calls to Crunchyroll at any moment,
  // whatever the phase and however many languages are selected.
  const gate = (() => {
    let active = 0; const queue = [];
    const release = () => { active--; const next = queue.shift(); if (next) { active++; next(); } };
    return async (fn) => {
      if (active >= MAX_IN_FLIGHT) await new Promise((r) => queue.push(r)); else active++;
      try { return await fn(); } finally { release(); }
    };
  })();

  async function api(path, retries = { auth: 0, rate: 0 }) {
    const t = await getToken();
    const r = await gate(() => fetch(path, { headers: { Authorization: "Bearer " + t.access_token } }));
    if (r.status === 401 && retries.auth < 1) { token = null; return api(path, { ...retries, auth: retries.auth + 1 }); }
    if (r.status === 429 && retries.rate < 3) { await sleep(1000 * (retries.rate + 1)); return api(path, { ...retries, rate: retries.rate + 1 }); }
    if (!r.ok) throw new Error(`${r.status} ${path.split("?")[0]}`);
    return r.json();
  }

  async function fetchWatchlist() {
    const t = await getToken();
    const items = [];
    let start = 0;
    for (;;) {
      const j = await api(`${C.api.watchlist.path(t.account_id)}?${C.api.watchlist.query.replace("start=0", `start=${start}`)}`);
      const page = j.data || [];
      items.push(...page);
      if (page.length < 100) break;
      if (Number.isFinite(j.total) && items.length >= j.total) break;
      start += 100;
    }
    return items;
  }

  const fetchSeasons = (seriesId) => api(`${C.api.seasons.path(seriesId)}?${C.api.seasons.query}`).then((j) => j.data || []);
  const fetchEpisodes = (seasonId, audio) => api(`${C.api.episodes.path(seasonId)}?${C.api.episodes.query(audio)}`).then((j) => j.data || []);

  async function fetchPlayheads(ids, onBatch) {
    const t = await getToken();
    const out = {};
    const chunks = [];
    const B = C.api.playheads.batchSize;
    for (let i = 0; i < ids.length; i += B) chunks.push(ids.slice(i, i + B));
    if (!chunks.length) { onBatch && onBatch(1, 1, 0); return out; }
    let done = 0;
    await mapLimit(chunks, CONCURRENCY, async (chunk) => {
      const j = await api(`${C.api.playheads.path(t.account_id)}?${C.api.playheads.query(chunk)}`);
      for (const p of j.data || []) out[p.content_id] = { playhead: p.playhead, fully_watched: !!p.fully_watched };
      onBatch && onBatch(++done, chunks.length, (j.data || []).length);
    });
    return out;
  }

  // ------------------------------------------------------------------ core
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const ts = (iso) => { const n = iso ? Date.parse(iso) : NaN; return Number.isNaN(n) ? null : n; };

  async function mapLimit(items, limit, fn) {
    let next = 0;
    async function worker() {
      while (next < items.length) {
        const i = next++;
        try { await fn(items[i], i); } catch (e) { console.error(`[${APP_NAME}]`, e); }
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  }

  function isWatched(playhead, durationMs, fraction) {
    if (!playhead) return false;
    if (playhead.fully_watched) return true;
    const dur = (durationMs || 0) / 1000;
    const pos = playhead.playhead || 0;
    if (!dur || !pos) return false; // no duration known: only Crunchyroll's own flag can settle it
    if (pos / dur >= fraction) return true;
    return dur > WATCHED_TAIL_SECONDS && dur - pos <= WATCHED_TAIL_SECONDS;
  }

  const releaseDate = (e) => e.premium_available_date || e.availability_starts || e.upload_date || e.episode_air_date || null;

  function pickThumb(images) {
    const arr = images && images.thumbnail && images.thumbnail[0];
    if (!arr || !arr.length) return null;
    const best = arr.find((i) => i.width >= 640) || arr[arr.length - 1];
    return best.source;
  }

  // One canonical instalment per original-audio season guid. Crunchyroll lists a
  // row per audio version; keep the row that IS the original version if present.
  function canonicalSeasons(seasons) {
    const groups = new Map();
    for (const s of seasons) {
      const versions = Array.isArray(s.versions) && s.versions.length ? [...s.versions] : [{ guid: s.id, audio_locale: s.audio_locale, original: true }];
      versions.sort((a, b) => String(a.guid).localeCompare(String(b.guid)));
      const orig = versions.find((v) => v.original) || versions[0];
      const g = groups.get(orig.guid) || { id: orig.guid, audio: orig.audio_locale, rows: [] };
      g.rows.push(s);
      groups.set(orig.guid, g);
    }
    return [...groups.values()].map((g) => {
      const row = g.rows.find((r) => r.audio_locale === g.audio) || g.rows.find((r) => r.id === g.id) || g.rows[0];
      // Fingerprint: episode count per audio version. Changes when an episode
      // is added to the original run or a dub catches up, which is exactly when
      // a cached episode list must be refetched.
      const fp = g.rows.map((r) => `${r.audio_locale || "und"}:${r.number_of_episodes ?? "?"}`).sort().join(",");
      return { id: g.id, title: row.title || "", number: row.season_number, fp };
    });
  }

  // Merge key that does not depend on which audio version a row came from.
  const episodeKey = (raw, seasonId) => raw.identifier || `${seasonId}|${raw.season_number ?? ""}|${raw.sequence_number ?? raw.episode_number ?? raw.id}`;

  const newestRelease = (episodes) => {
    let best = null;
    for (const e of episodes) for (const v of Object.values(e.versions)) { const d = ts(v.date); if (d !== null && (best === null || d > best)) best = d; }
    return best;
  };
  const allWatched = (episodes, playheads, fraction) => episodes.length > 0 && episodes.every((e) => Object.values(e.versions).some((v) => isWatched(playheads[v.id], v.dur, fraction)));

  /**
   * Decide, per instalment, whether its cached episode list can be reused.
   * `entries` are the cached records (or undefined) in the same order as
   * `seasons`. Tiers, from the caches alone, no requests:
   *   missing  no cache                              -> fetch
   *   changed  fingerprint differs from the seasons  -> fetch
   *   active   newest episode under 30 days old      -> TTL.active
   *   latest   the show's newest instalment, dormant -> TTL.latestDormant
   *   watched  older instalment, all watched         -> TTL.dormantWatched
   *   dormant  older instalment, unwatched episodes  -> TTL.dormant
   */
  function classifyInstalments(seasons, entries, playheads, fraction) {
    const now = Date.now();
    const newest = entries.map((en) => (en ? newestRelease(en.episodes) : null));
    const latest = newest.reduce((best, d, i) => (d !== null && (best < 0 || d > newest[best]) ? i : best), -1);
    return seasons.map((season, i) => {
      const en = entries[i];
      if (!en) return { tier: "missing", fresh: false };
      if (en.fp !== season.fp) return { tier: "changed", fresh: false };
      let tier, ttl;
      if (newest[i] !== null && now - newest[i] < ACTIVE_WINDOW_MS) { tier = "active"; ttl = TTL.active; }
      else if (i === latest || newest[i] === null) { tier = "latest"; ttl = TTL.latestDormant; }
      else if (allWatched(en.episodes, playheads, fraction)) { tier = "watched"; ttl = TTL.dormantWatched; }
      else { tier = "dormant"; ttl = TTL.dormant; }
      return { tier, fresh: now - en.fetchedAt < ttl };
    });
  }

  /** Seasons list, then every instalment's episodes, for one show. Returns cache statistics. */
  async function loadShow(show, { force, langs, fraction, playheads, log, onInstalments, tick }) {
    const listKey = seasonsListKey(show.seriesId);
    const cachedList = force ? null : await store.get(listKey);
    let seasons = cachedList && Array.isArray(cachedList.seasons) ? cachedList.seasons : null;
    const readEntries = () => Promise.all(seasons.map((s) => store.get(seasonKey(langs, s.id))));
    let entries = seasons ? await readEntries() : [];
    let tiers = seasons ? classifyInstalments(seasons, entries, playheads, fraction) : [];
    // The seasons list is refetched hourly while anything is airing (its episode
    // counts are the fingerprint), daily otherwise.
    const settled = seasons && tiers.every((t) => t.tier !== "active" && t.tier !== "missing");
    let listCached = true;
    if (!seasons || Date.now() - cachedList.fetchedAt > (settled ? TTL.seasonsDormant : TTL.seasonsActive)) {
      seasons = canonicalSeasons(await fetchSeasons(show.seriesId));
      await store.set(listKey, { fetchedAt: Date.now(), seasons });
      listCached = false;
      entries = await readEntries();
      tiers = classifyInstalments(seasons, entries, playheads, fraction);
    }
    log(`Seasons: ${show.title} · ${seasons.length} instalment${seasons.length === 1 ? "" : "s"}${listCached ? " (cached)" : ""}`);
    onInstalments(seasons.length);
    tick();
    let episodesCached = 0;
    await Promise.all(seasons.map(async (season, order) => {
      const { tier, fresh } = tiers[order];
      const label = season.title || season.id;
      try {
        let eps;
        if (!force && fresh) { eps = entries[order].episodes; episodesCached++; }
        else eps = await fetchSeasonEpisodes(season, langs);
        show.episodes.push(...eps.map((e) => ({ ...e, catalogueOrder: order })));
        log(`Episodes: ${show.title} · ${label} · ${eps.length} ep${eps.length === 1 ? "" : "s"} · ${tier}${fresh && !force ? " (cached)" : ` (fetched ${langs.map(langLabel).join(", ")})`}`);
      } catch (e) {
        show.failed.push(label);
        log(`Episodes: ${show.title} · ${label} · FAILED (${e.message})`);
      }
      tick();
    }));
    return { listCached, episodesCached, instalments: seasons.length };
  }

  async function fetchSeasonEpisodes(season, langs) {
    const lists = await Promise.all(langs.map((audio) => fetchEpisodes(season.id, audio)));
    const byKey = new Map();
    lists.forEach((list, idx) => {
      const wanted = langs[idx];
      for (const raw of list) {
        const locale = raw.audio_locale || "und";
        // The API falls back to another language when `wanted` has no version.
        // Keep the row if it IS the wanted language, or if it is a language we
        // never ask for (e.g. a Korean original) so such shows are not empty.
        if (locale !== wanted && langs.includes(locale)) continue;
        const key = episodeKey(raw, season.id);
        const rec = byKey.get(key) || {
          key,
          n: raw.episode_number ?? null,
          seq: raw.sequence_number ?? null,
          season: raw.season_number ?? null,
          inst: season.id,
          instTitle: season.title,
          title: null, // episode title, preferring the first chosen language's wording
          air: raw.episode_air_date || null,
          thumb: pickThumb(raw.images),
          versions: {},
        };
        if (raw.title && (!rec.title || locale === langs[0])) rec.title = raw.title;
        rec.air = rec.air || raw.episode_air_date || null;
        rec.thumb = rec.thumb || pickThumb(raw.images);
        rec.versions[locale] = { id: raw.id, date: releaseDate(raw), dur: raw.duration_ms || null, slug: raw.slug_title || "" };
        byKey.set(key, rec);
      }
    });
    const episodes = [...byKey.values()].sort(episodeSeqOrder);
    await store.set(seasonKey(langs, season.id), { fetchedAt: Date.now(), episodes, fp: season.fp });
    return episodes;
  }

  // Fold the player frame's samples into the playhead cache as hints. A hint
  // only wins over a cached record it exceeds, and never over Crunchyroll's own
  // completed flag.
  async function mergeObservations(playheads) {
    const keys = (await store.keys()).filter((k) => k.startsWith(OBS_PREFIX));
    let merged = 0;
    for (const k of keys) {
      const obs = await store.get(k);
      const id = k.slice(OBS_PREFIX.length);
      const cur = playheads[id];
      if (obs && Number.isFinite(obs.playhead) && !(cur && (cur.fully_watched || (cur.playhead || 0) >= obs.playhead))) {
        playheads[id] = { playhead: obs.playhead, fully_watched: false, observed: true };
        merged++;
      }
    }
    if (keys.length) await store.remove(keys);
    return merged;
  }

  // Drop cache entries this run did not touch (old language combinations,
  // shows removed from the watchlist, the retired per-instalment date cache).
  async function sweepCaches(usedKeys) {
    const stale = (await store.keys()).filter((k) => /^(season:|seasons:|inst-start:|obs:)/.test(k) && !usedKeys.has(k));
    if (stale.length) await store.remove(stale);
    return stale.length;
  }

  const seqOf = (e) => (Number.isFinite(e.seq) ? e.seq : Number.isFinite(e.n) ? e.n : Infinity);
  const episodeSeqOrder = (a, b) => (seqOf(a) - seqOf(b)) || String(a.key).localeCompare(String(b.key));

  /**
   * Progress model. Work is counted in request-sized units per phase; the
   * wall-clock rate of finished units gives the ETA, so cached seasons (near
   * instant) and rate-limit backoffs (slow) both feed straight into it.
   */
  function makeTracker(onProgress) {
    const phases = []; // { name, total, done, start, end }
    const t0 = Date.now();
    let current = null;
    const unitTime = (ph) => (ph && ph.done >= 3 && ph.start ? ((ph.end || Date.now()) - ph.start) / ph.done : null);
    const emit = () => {
      let doneUnits = 0, totalUnits = 0, etaMs = 0, fallback = 0.25 * 1000;
      for (const ph of phases) { const ut = unitTime(ph); if (ut) fallback = ut; }
      for (const ph of phases) {
        doneUnits += ph.done; totalUnits += ph.total;
        const remaining = Math.max(0, ph.total - ph.done);
        etaMs += remaining * (unitTime(ph) ?? fallback);
      }
      const haveRate = phases.some((ph) => unitTime(ph) !== null);
      onProgress(totalUnits ? Math.min(1, doneUnits / totalUnits) : 0, haveRate ? etaMs / 1000 : null, current ? current.name : "");
    };
    return {
      phase(name, total) { current = { name, total: Math.max(1, Math.round(total)), done: 0, start: Date.now(), end: null }; phases.push(current); emit(); return current; },
      retotal(total) { if (current) current.total = Math.max(current.done, Math.round(total)); emit(); },
      tick(n = 1) { if (current) current.done = Math.min(current.total, current.done + n); emit(); },
      finish() { if (current) { current.done = current.total; current.end = Date.now(); } emit(); },
      elapsed: () => (Date.now() - t0) / 1000,
    };
  }

  /** Fetch everything needed to rank: watchlist, episodes per instalment, playheads. */
  async function fetchData({ force = false, langs, fraction, highWater, onStatus, onProgress, onLog }) {
    const log = onLog || (() => {});
    const tracker = makeTracker(onProgress);

    // Known playheads from earlier runs, plus anything the player frame observed.
    const known = (!force && (await store.get(PLAYHEADS_KEY))) || {};
    const observed = await mergeObservations(known);
    if (observed) log(`Playheads: ${observed} position${observed === 1 ? "" : "s"} noted while watching`);

    tracker.phase("Reading watchlist", 1);
    onStatus("Reading your watchlist…");
    const wl = await fetchWatchlist();
    tracker.finish();
    log(`Watchlist: ${wl.length} show${wl.length === 1 ? "" : "s"}`);
    const shows = wl.map((it) => {
      const m = it.panel.episode_metadata || {};
      return {
        seriesId: m.series_id || it.panel.id,
        title: m.series_title || it.panel.title,
        slug: m.series_slug_title || it.panel.slug_title || "",
        panelThumb: pickThumb(it.panel.images),
        episodes: [],
        error: null,      // whole show failed to load
        failed: [],       // instalments that failed to load (partial data)
      };
    });

    // Phase 2: one unit per show (its seasons list) plus one per instalment as
    // they become known. Each unit is a request or two, or a cache hit.
    onStatus(`Loading seasons and episodes for ${shows.length} shows…`);
    const phase = tracker.phase("Loading shows", shows.length);
    const stats = { instalments: 0, episodesCached: 0, listsCached: 0 };
    await mapLimit(shows, CONCURRENCY, async (show) => {
      try {
        const r = await loadShow(show, {
          force, langs, fraction, playheads: known, log,
          onInstalments: (n) => { stats.instalments += n; tracker.retotal(phase.total + n); },
          tick: () => tracker.tick(),
        });
        stats.episodesCached += r.episodesCached;
        if (r.listCached) stats.listsCached++;
      } catch (e) {
        show.error = `seasons: ${e.message}`;
        log(`Seasons: ${show.title} · FAILED (${e.message})`);
        tracker.tick();
      }
    });
    tracker.finish();
    for (const show of shows) assignInstalmentOrder(show);

    // Phase 3: playheads, one unit per 80 ids. An episode already known to be
    // watched in any language (under the current threshold), or preceding one
    // that is while the high-water rule is on, is not asked about again in any
    // language: a position only ever moves forward. Full reload starts from nothing.
    const ids = [], toFetch = [], playheads = {};
    for (const show of shows) {
      const eps = [...show.episodes].sort(episodeOrder);
      const done = eps.map((ep) => Object.values(ep.versions).some((v) => { const r = known[v.id]; return r && !r.observed && isWatched(r, v.dur, fraction); }));
      const last = highWater ? done.lastIndexOf(true) : -1;
      eps.forEach((ep, i) => {
        for (const v of Object.values(ep.versions)) {
          ids.push(v.id);
          if (done[i] || i < last) { if (known[v.id]) playheads[v.id] = known[v.id]; } else toFetch.push(v.id);
        }
      });
    }
    const batches = Math.max(1, Math.ceil(toFetch.length / C.api.playheads.batchSize));
    onStatus(`Checking what you have already watched (${toFetch.length} of ${ids.length} episode versions)…`);
    tracker.phase("Checking playheads", batches);
    const fetched = await fetchPlayheads(toFetch, (i, n, got) => { log(`Playheads: batch ${i}/${n} · ${got} with progress`); tracker.tick(); });
    tracker.finish();
    for (const id of toFetch) { const rec = fetched[id] || known[id]; if (rec) playheads[id] = rec; } // server record wins; a hint stands in only where there is none
    // Persist only ids on today's watchlist, so removed shows fall out of the cache.
    try { await store.set(PLAYHEADS_KEY, playheads); } catch (e) { console.warn(`[${APP_NAME}] could not cache playheads:`, e); }
    if (force) {
      const used = new Set();
      for (const show of shows) { used.add(seasonsListKey(show.seriesId)); for (const ep of show.episodes) used.add(seasonKey(langs, ep.inst)); }
      const swept = await sweepCaches(used);
      if (swept) log(`Cache: removed ${swept} stale entr${swept === 1 ? "y" : "ies"}`);
    }
    log(`Done in ${tracker.elapsed().toFixed(1)}s · ${stats.instalments} instalments (${stats.episodesCached} from cache, ${stats.listsCached}/${shows.length} season lists from cache) · ${ids.length} versions (${ids.length - toFetch.length} known watched, ${toFetch.length} checked in ${toFetch.length ? batches : 0} batch${batches === 1 ? "" : "es"})`);
    return { shows, playheads, languages: langs, builtAt: Date.now(), showCount: shows.length };
  }

  /**
   * Instalment chronology. Crunchyroll's own season order is editorial: OVA and
   * movie "seasons" are often appended after the main run. We order instalments
   * by the original air date of their first episode, then keep Crunchyroll's
   * episode sequence inside each. Air date rather than availability date, so a
   * back-filled 2019 movie lands in 2019 and not on the day it was added.
   */
  function epChrono(e) {
    const a = ts(e.air);
    if (a !== null) return a;
    let best = null;
    for (const v of Object.values(e.versions)) { const d = ts(v.date); if (d !== null && (best === null || d < best)) best = d; }
    return best;
  }
  function assignInstalmentOrder(show) {
    const start = new Map(), catalogue = new Map(), title = new Map();
    for (const e of show.episodes) {
      const d = epChrono(e);
      if (d !== null && (!start.has(e.inst) || d < start.get(e.inst))) start.set(e.inst, d);
      catalogue.set(e.inst, e.catalogueOrder);
      title.set(e.inst, e.instTitle);
    }
    const ordered = [...catalogue.keys()].sort((a, b) => ((start.get(a) ?? Infinity) - (start.get(b) ?? Infinity)) || (catalogue.get(a) - catalogue.get(b)) || String(a).localeCompare(String(b)));
    const rankOf = new Map(ordered.map((id, i) => [id, i]));
    for (const e of show.episodes) e.sOrder = rankOf.get(e.inst);
    show.instalments = ordered.map((id) => ({ id, title: title.get(id), start: start.get(id) ?? null }));
  }
  const episodeOrder = (a, b) => (a.sOrder - b.sOrder) || episodeSeqOrder(a, b);

  // The version whose arrival date drives newness: first chosen language present.
  // With strict mode off, an episode available only in other languages still counts.
  function arrivalVersion(ep, prefs) {
    for (const l of prefs.languages) if (ep.versions[l]) return { lang: l, v: ep.versions[l] };
    if (prefs.strictLanguages) return null;
    const other = Object.keys(ep.versions).sort()[0];
    return other ? { lang: other, v: ep.versions[other] } : null;
  }

  /**
   * Rank the fetched data. Pure: re-run when a preference changes.
   * With prefs.highWater on, every episode that precedes the last one you
   * actually watched (instalments in air-date order, episodes in sequence) is
   * assumed watched too, covering history that never reached Crunchyroll.
   */
  function rank(data, prefs) {
    const { shows, playheads } = data;
    const fraction = prefs.watchedPct / 100;
    const now = Date.now();
    for (const show of shows) {
      const eps = [...show.episodes].sort(episodeOrder);
      const flags = eps.map((ep) => Object.values(ep.versions).some((v) => isWatched(playheads[v.id], v.dur, fraction)));
      let inferred = 0;
      if (prefs.highWater) {
        const last = flags.lastIndexOf(true);
        for (let i = 0; i < last; i++) if (!flags[i]) { flags[i] = true; inferred++; }
      }
      let newestUnwatched = null, newestAny = null, unwatchedCount = 0;
      eps.forEach((ep, i) => {
        const a = arrivalVersion(ep, prefs);
        const at = a ? ts(a.v.date) : null;
        if (at === null || at > now) return; // not in your languages / not released yet / no usable date
        const started = Object.values(ep.versions).some((v) => (playheads[v.id]?.playhead || 0) > 0);
        const cand = { ep, lang: a.lang, at, id: a.v.id, slug: a.v.slug, watched: flags[i], started };
        if (!newestAny || cand.at > newestAny.at) newestAny = cand;
        if (!flags[i]) {
          unwatchedCount++;
          if (!newestUnwatched || cand.at > newestUnwatched.at) newestUnwatched = cand;
        }
      });
      show.newestUnwatched = newestUnwatched;
      show.newestAny = newestAny;
      show.unwatchedCount = unwatchedCount;
      show.inferredWatched = inferred;
    }
    const byAtDesc = (pick) => (a, b) => ((pick(b)?.at ?? -Infinity) - (pick(a)?.at ?? -Infinity)) || a.title.localeCompare(b.title);
    const problems = shows.filter((s) => s.error || (s.failed.length && !s.newestUnwatched));
    const rest = shows.filter((s) => !problems.includes(s));
    return {
      active: rest.filter((s) => s.newestUnwatched).sort(byAtDesc((s) => s.newestUnwatched)),
      caughtUp: rest.filter((s) => !s.newestUnwatched).sort(byAtDesc((s) => s.newestAny)),
      problems: problems.sort((a, b) => a.title.localeCompare(b.title)),
    };
  }

  // -------------------------------------------------------------------- ui
  const el = (tag, attrs = {}, children = []) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === "class") n.className = v;
      else if (k === "text") n.textContent = v;
      else if (k === "checked") n.checked = !!v;
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? "" : v);
    }
    for (const c of children) if (c) n.append(typeof c === "string" ? document.createTextNode(c) : c);
    return n;
  };

  function relTime(at) {
    const days = Math.floor((Date.now() - at) / 86_400_000);
    if (days <= 0) return "today";
    if (days === 1) return "yesterday";
    if (days < 14) return `${days} days ago`;
    if (days < 60) return `${Math.floor(days / 7)} weeks ago`;
    if (days < 730) return `${Math.floor(days / 30)} months ago`;
    return `${Math.floor(days / 365)} years ago`;
  }
  const fmtDate = (at) => new Date(at).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  const langLabel = (l) => (l === "en-US" ? "EN" : l === "ja-JP" ? "JA" : (l || "").split("-")[0].toUpperCase());
  const langName = (l) => (LOCALE_NAME[l] ? `${LOCALE_NAME[l]} audio` : l);
  // Flags drawn in CSS; anything else gets a text badge.
  const FLAG_CLASS = { "en-US": "en", "ja-JP": "ja", "de-DE": "de", "fr-FR": "fr", "it-IT": "it", "ru-RU": "ru" };

  // "Season 2" -> "S2 E9". Other instalments (movie, OVA collection) keep their
  // title, minus the series name and audio suffixes Crunchyroll sometimes adds.
  function instalmentLabel(show, ep) {
    let t = ep.instTitle || "";
    if (show.title && t.toLowerCase().startsWith(show.title.toLowerCase())) t = t.slice(show.title.length);
    t = t.replace(/\(([A-Za-z]+) Dub\)/i, "").replace(/^[\s:\-–]+|[\s:\-–]+$/g, "").trim();
    const epPart = Number.isFinite(ep.n) ? ` E${ep.n}` : "";
    const m = /^Season\s*(\d+)\b/i.exec(t);
    if (m) return `S${m[1]}${epPart}`;
    const roman = { II: 2, III: 3, IV: 4, V: 5, VI: 6 }[t.toUpperCase()];
    if (roman) return `S${roman}${epPart}`;
    if (!t) return `S${Number.isFinite(ep.season) ? ep.season : "?"}${epPart}`;
    const short = t.length > 30 ? t.slice(0, 28) + "…" : t;
    const single = show.episodes.filter((e) => e.inst === ep.inst).length === 1;
    return single ? short : `${short}${epPart}`;
  }

  function card(show, { done }) {
    const c = show.newestUnwatched || show.newestAny;
    const href = c ? `/watch/${c.id}/${c.slug || ""}` : `/series/${show.seriesId}/${show.slug}`;
    const thumb = (c && c.ep.thumb) || show.panelThumb;
    const lines = [];
    if (c) {
      lines.push(el("div", { class: "bwl-line" }, [
        el("strong", { text: done ? "Latest: " : c.started ? "Continue: " : "Next: " }),
        `${instalmentLabel(show, c.ep)} · ${langLabel(c.lang)} · `,
        el("span", { class: "bwl-date", text: relTime(c.at) }),
        el("span", { class: "bwl-muted", text: `  (${fmtDate(c.at)})` }),
      ]));
      if (!done && c.lang !== prefs.languages[0]) lines.push(el("div", { class: "bwl-muted", text: `No ${LOCALE_NAME[prefs.languages[0]] || prefs.languages[0]} audio for this episode yet` }));
      if (!done) lines.push(el("div", { class: "bwl-muted", text: `${show.unwatchedCount} unwatched episode${show.unwatchedCount === 1 ? "" : "s"}` + (show.inferredWatched ? ` · ${show.inferredWatched} earlier assumed watched` : "") }));
      if (done) lines.push(el("div", { class: "bwl-muted", text: "All caught up" }));
    } else {
      lines.push(el("div", { class: "bwl-muted", text: show.error ? `Could not load: ${show.error}` : "No released episodes found" }));
    }
    if (show.failed.length) lines.push(el("div", { class: "bwl-warn", text: `Could not load: ${show.failed.join(", ")}. Ranking may be stale.` }));
    // Flag badge: drawn in CSS (SVG) for EN/JA because Chrome on Windows cannot
    // render flag emoji; other languages fall back to a text badge.
    const flagClass = c ? (FLAG_CLASS[c.lang] ? `bwl-flag bwl-lang-${FLAG_CLASS[c.lang]}` : "bwl-lang-other") : "";
    const hasFlag = flagClass.includes("bwl-flag");
    return el("a", { class: "bwl-card" + (done ? " bwl-done" : ""), href }, [
      el("div", { class: "bwl-thumb" }, [
        thumb ? el("img", { src: thumb, loading: "lazy", alt: "" }) : null,
        c ? el("span", { class: `bwl-badge ${flagClass}`, title: langName(c.lang), "aria-label": langName(c.lang), text: hasFlag ? "" : langLabel(c.lang) }) : null,
        !done && c && Date.now() - c.at < 7 * 86_400_000 ? el("span", { class: "bwl-badge bwl-new", text: "NEW" }) : null,
      ]),
      el("div", { class: "bwl-body" }, [
        el("div", { class: "bwl-title", text: show.title }),
        c && c.ep.title ? el("div", { class: "bwl-ep-title", text: c.ep.title }) : null,
        ...lines,
      ]),
    ]);
  }

  // ------------------------------------------------------- update check
  const versionNum = (v) => String(v).split(".").map((n) => parseInt(n, 10) || 0);
  const isNewer = (a, b) => { const x = versionNum(a), y = versionNum(b); for (let i = 0; i < Math.max(x.length, y.length); i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); } return false; };
  async function checkForUpdate() {
    if (!updateEl) return;
    updateEl.hidden = true;
    if (!prefs.checkUpdates || VERSION === "dev") return;
    let rec = await store.get(UPDATE_CHECK_KEY);
    if (!rec || Date.now() - rec.at > DAY) {
      try {
        const r = await fetch(MANIFEST_URL, { cache: "no-store" });
        if (!r.ok) throw new Error(String(r.status));
        const j = await r.json();
        if (typeof j.version !== "string") throw new Error("no version");
        rec = { at: Date.now(), version: j.version };
        await store.set(UPDATE_CHECK_KEY, rec);
      } catch (e) { console.debug(`[${APP_NAME}] update check skipped:`, e.message); return; }
    }
    if (isNewer(rec.version, VERSION)) { updateEl.textContent = `v${rec.version} available`; updateEl.hidden = false; }
  }

  // ------------------------------------------------------------ ui: state
  let root, statusEl, progressEl, gridsEl, toggleBtn, modal, taglineEl, etaEl, logEl, logWrap, logToggle, updateEl;
  const tagline = (p) => `newest unwatched episode first · audio: ${p.languages.map(langLabel).join(" › ")}${p.strictLanguages ? "" : " › any"}`;
  let data = null, view = null, prefs = { ...DEFAULT_PREFS };
  let prevHtmlOverflow = "";

  function render() {
    if (!gridsEl) return;
    gridsEl.replaceChildren();
    if (!data) return;
    view = rank(data, prefs);
    const { active, caughtUp, problems } = view;
    gridsEl.append(el("div", { class: "bwl-section-title", text: `New for you (${active.length})` }));
    gridsEl.append(el("div", { class: "bwl-grid" }, active.map((s) => card(s, { done: false }))));
    if (!active.length) gridsEl.append(el("div", { class: "bwl-empty", text: "Nothing unwatched. Enjoy the break." }));
    if (problems.length) {
      gridsEl.append(el("div", { class: "bwl-section-title bwl-section-warn", text: `Could not load (${problems.length}) — try Refresh` }));
      gridsEl.append(el("div", { class: "bwl-grid" }, problems.map((s) => card(s, { done: false }))));
    }
    if (!prefs.hideDone) {
      gridsEl.append(el("div", { class: "bwl-section-title", text: `Caught up (${caughtUp.length})` }));
      gridsEl.append(el("div", { class: "bwl-grid" }, caughtUp.map((s) => card(s, { done: true }))));
    } else if (caughtUp.length) {
      gridsEl.append(el("div", { class: "bwl-footnote", text: `${caughtUp.length} caught-up show${caughtUp.length === 1 ? "" : "s"} hidden · change in Settings` }));
    }
  }

  function setStatus(msg, isError = false) {
    if (!statusEl) return;
    statusEl.textContent = msg;
    statusEl.classList.toggle("bwl-error", isError);
  }
  const fmtEta = (sec) => (sec === null ? "estimating…" : sec < 1.5 ? "almost done" : sec < 60 ? `about ${Math.max(2, Math.round(sec / 5) * 5)}s left` : `about ${Math.round(sec / 60)} min left`);
  let progressPhase = "";
  const setProgress = (f, etaSec, phase) => {
    if (progressEl) progressEl.style.width = `${Math.round(f * 100)}%`;
    if (!etaEl) return;
    if (phase === undefined) { etaEl.textContent = ""; return; } // reset between runs
    progressPhase = phase || progressPhase;
    etaEl.textContent = `${Math.round(f * 100)}% · ${fmtEta(etaSec === undefined ? null : etaSec)}`;
  };
  const LOG_MAX = 500;
  let logCount = 0;
  const appendLog = (line) => {
    if (!logEl) return;
    const stamp = new Date().toLocaleTimeString(undefined, { hour12: false });
    logEl.append(el("div", { class: "bwl-log-line" + (/FAILED/.test(line) ? " bwl-log-fail" : ""), text: `${stamp}  ${line}` }));
    if (++logCount > LOG_MAX) { logEl.firstChild.remove(); logCount--; }
    logEl.scrollTop = logEl.scrollHeight;
  };
  const setLogOpen = (open, { sticky = false } = {}) => {
    logWrap.hidden = !open;
    logToggle.textContent = open ? "Hide activity log" : "Show activity log";
    if (sticky) logUserChoice = open;
  };
  let logUserChoice = null; // null = follow loading state; true/false = user pinned it

  let loading = false;
  async function load(force) {
    if (loading) return;
    loading = true;
    logEl.replaceChildren(); logCount = 0;
    logToggle.hidden = false;
    if (logUserChoice !== false) setLogOpen(true);
    setProgress(0, null, "Starting");
    const started = Date.now();
    try {
      data = await fetchData({ force, langs: prefs.languages, fraction: prefs.watchedPct / 100, highWater: prefs.highWater, onStatus: setStatus, onProgress: setProgress, onLog: appendLog });
      render();
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      setStatus(`${data.showCount} shows · updated ${new Date(data.builtAt).toLocaleTimeString()} · loaded in ${secs}s`);
      if (logUserChoice !== true) setLogOpen(false);
    } catch (e) {
      console.error(`[${APP_NAME}]`, e);
      appendLog(`FAILED: ${e.message}`);
      setStatus(`Failed: ${e.message}`, true);
    } finally {
      loading = false;
      setProgress(0);
    }
    // Persisting is best-effort: a quota failure must not undo a successful run.
    if (data) { try { await store.set(DATA_KEY, data); } catch (e) { console.warn(`[${APP_NAME}] could not cache results:`, e); } }
  }

  // --------------------------------------------------------- ui: settings
  function openSettings() {
    if (modal) modal.remove();
    const draft = { ...prefs };
    const pctLabel = el("span", { class: "bwl-pct", text: `${draft.watchedPct}%` });
    const pct = el("input", { type: "range", min: "50", max: "100", step: "5", value: String(draft.watchedPct), class: "bwl-slider",
      oninput: (ev) => { draft.watchedPct = Number(ev.target.value); pctLabel.textContent = `${draft.watchedPct}%`; } });
    const highWater = el("input", { type: "checkbox", checked: draft.highWater, onchange: (ev) => { draft.highWater = ev.target.checked; } });
    const hideDone = el("input", { type: "checkbox", checked: draft.hideDone, onchange: (ev) => { draft.hideDone = ev.target.checked; } });
    const toggle = (key) => el("input", { type: "checkbox", checked: draft[key], onchange: (ev) => { draft[key] = ev.target.checked; } });
    const skipIntro = toggle("skipIntro"), skipCredits = toggle("skipCredits"), skipRecap = toggle("skipRecap");
    const strict = toggle("strictLanguages");
    const checkUpdates = toggle("checkUpdates");
    draft.languages = [...draft.languages];
    // Ordered language picker: chosen languages first (in priority order) with
    // up/down controls, then the rest alphabetically.
    const langList = el("div", { class: "bwl-langs" });
    const renderLangs = () => {
      langList.replaceChildren();
      const chosen = draft.languages;
      const rest = LOCALES.map(([c]) => c).filter((c) => !chosen.includes(c)).sort((a, b) => LOCALE_NAME[a].localeCompare(LOCALE_NAME[b]));
      [...chosen, ...rest].forEach((code) => {
        const i = chosen.indexOf(code);
        const on = i >= 0;
        const cb = el("input", { type: "checkbox", checked: on, onchange: (ev) => {
          if (ev.target.checked) { if (!chosen.includes(code)) chosen.push(code); }
          else if (chosen.length > 1) { chosen.splice(chosen.indexOf(code), 1); }
          renderLangs();
        } });
        const move = (dir) => { const j = i + dir; if (j < 0 || j >= chosen.length) return; [chosen[i], chosen[j]] = [chosen[j], chosen[i]]; renderLangs(); };
        langList.append(el("div", { class: "bwl-lang" + (on ? " bwl-lang-on" : "") }, [
          el("label", {}, [cb, el("span", { class: "bwl-lang-rank", text: on ? `${i + 1}.` : "" }), el("span", { text: LOCALE_NAME[code] }), el("span", { class: "bwl-muted", text: ` ${code}` })]),
          on ? el("span", { class: "bwl-lang-move" }, [
            el("button", { type: "button", text: "▲", title: "Higher priority", disabled: i === 0, onclick: () => move(-1) }),
            el("button", { type: "button", text: "▼", title: "Lower priority", disabled: i === chosen.length - 1, onclick: () => move(1) }),
          ]) : null,
        ]));
      });
    };
    renderLangs();
    const close = () => { if (modal) modal.remove(); modal = null; document.removeEventListener("keydown", onKey); };
    const onKey = (ev) => { if (ev.key === "Escape") close(); };
    const save = () => {
      const before = prefs.languages.join(",");
      prefs = sanitizePrefs(draft);
      savePrefs(prefs);
      taglineEl.textContent = tagline(prefs);
      close();
      checkForUpdate();
      if (prefs.languages.join(",") !== before) load(false); // new languages need new episode lists
      else render();
    };
    const setting = (title, help, control) => el("label", { class: "bwl-setting" }, [
      el("div", { class: "bwl-setting-text" }, [el("strong", { text: title }), el("div", { class: "bwl-muted", text: help })]),
      el("div", { class: "bwl-setting-control" }, control),
    ]);
    modal = el("div", { class: "bwl-modal-backdrop", onclick: (ev) => { if (ev.target === modal) close(); } }, [
      el("div", { class: "bwl-modal", role: "dialog", "aria-label": "Settings" }, [
        el("h2", { text: "Settings" }),
        el("h3", { text: "Watchlist" }),
        setting("Count an episode as watched at", "Crunchyroll only sets its own flag if you sit through the credits. Anything past this share of the runtime, or within 5 minutes of the end, counts as watched.", [pct, pctLabel]),
        setting("Assume earlier episodes watched", "Everything before the last episode you actually watched in a series is treated as watched. Fills gaps Crunchyroll never recorded.", [highWater]),
        setting("Hide caught-up shows", "Hide shows with nothing left to watch.", [hideDone]),
        el("h3", { text: "Audio languages" }),
        el("div", { class: "bwl-setting bwl-setting-block" }, [
          el("div", { class: "bwl-setting-text" }, [el("strong", { text: "Languages you watch, in order of preference" }), el("div", { class: "bwl-muted", text: "An episode's arrival date is its release in the first of these it is available in. Changing the list refetches episode data (one request per language per season)." })]),
          langList,
        ]),
        setting("Only count episodes available in these languages", "On: a show with no episode in your languages is not listed as new. Off: such episodes still count, dated by whatever language they exist in.", [strict]),
        el("h3", { text: "Player" }),
        setting("Skip intro", "Click Crunchyroll's \"Skip Intro\" button as soon as it appears.", [skipIntro]),
        setting("Skip credits", "Click \"Skip Credits\" as soon as it appears.", [skipCredits]),
        setting("Skip recap", "Click \"Skip Recap\" as soon as it appears. Off by default: recaps are sometimes worth watching.", [skipRecap]),
        el("h3", { text: "Updates" }),
        setting("Check for new versions", "Once a day, read the version number from the project's GitHub repository and show a notice in the header if it is newer. The only request this extension makes to anything other than crunchyroll.com.", [checkUpdates]),
        el("div", { class: "bwl-modal-actions" }, [
          el("button", { text: "Cancel", onclick: close }),
          el("button", { class: "bwl-primary", text: "Save", onclick: save }),
        ]),
      ]),
    ]);
    root.append(modal);
    document.addEventListener("keydown", onKey);
  }

  // Crunchyroll's own nav magnifier (same geometry as its icon set).
  function searchIcon() {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("width", "24"); svg.setAttribute("height", "24"); svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("fill", "currentColor");
    path.setAttribute("d", "M15.5 14h-.79l-.28-.27A6.47 6.47 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z");
    svg.append(path);
    return svg;
  }

  // ------------------------------------------------------------ ui: shell
  function buildUi() {
    if (root) return;
    root = el("div", { id: "bwl-root", hidden: true });
    statusEl = el("div", { class: "bwl-status" });
    progressEl = el("div");
    gridsEl = el("div");
    root.append(
      el("div", { class: "bwl-bar" }, [
        el("div", { class: "bwl-heading" }, [
          el("h1", {}, [
            el("a", { href: "https://www.crunchyroll.com/", class: "bwl-home", title: "Crunchyroll home", text: APP_NAME }),
            el("a", { href: REPO_URL, target: "_blank", rel: "noopener", class: "bwl-version", title: "Open the project on GitHub", text: `v${VERSION}` }),
            (updateEl = el("a", { href: REPO_URL, target: "_blank", rel: "noopener", class: "bwl-update", title: "A newer version is on GitHub: download it and reload the extension", hidden: true })),
          ]),
          (taglineEl = el("div", { class: "bwl-tagline", text: tagline(prefs) })),
        ]),
        el("span", { class: "bwl-spacer" }),
        el("a", { href: "/search", class: "bwl-iconbtn", title: "Search", "aria-label": "Search" }, [searchIcon()]),
        el("button", { text: "Settings", onclick: openSettings }),
        el("button", { text: "Refresh", title: "Re-check airing shows and unwatched episodes; everything known to be finished is skipped", onclick: () => load(false) }),
        el("button", { text: "Full reload", title: "Forget every cache and refetch everything, including watched positions", onclick: () => load(true) }),
        el("button", { class: "bwl-primary", text: "Normal Watchlist", title: "Back to Crunchyroll's own watchlist", onclick: () => hide(true) }),
      ]),
      el("div", { class: "bwl-progress" }, [progressEl]),
      el("div", { class: "bwl-status-row" }, [
        statusEl,
        (etaEl = el("span", { class: "bwl-eta" })),
        (logToggle = el("button", { class: "bwl-link", text: "Show activity log", hidden: true, onclick: () => setLogOpen(logWrap.hidden, { sticky: true }) })),
      ]),
      (logWrap = el("div", { class: "bwl-log-wrap", hidden: true }, [(logEl = el("div", { class: "bwl-log", role: "log", "aria-live": "polite" }))])),
      gridsEl,
    );
    document.documentElement.append(root);
  }

  let showing = false;
  async function show() {
    buildUi();
    prefs = loadPrefs(); // also (re)writes the cookie: defaults on first run, refreshed clock otherwise
    taglineEl.textContent = tagline(prefs);
    writeCookie(ACTIVE_COOKIE, "1");
    checkForUpdate();
    if (showing) return;
    showing = true;
    root.hidden = false;
    if (toggleBtn) toggleBtn.hidden = true;
    prevHtmlOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";
    if (!data) {
      const cached = await store.get(DATA_KEY);
      if (cached && Array.isArray(cached.shows) && cached.playheads) {
        data = cached;
        render();
        setStatus(`Showing cached view from ${new Date(cached.builtAt).toLocaleString()} · refreshing…`);
        await quickRefresh();
      }
    }
    load(false);
  }

  // Back from watching something: re-read that one show's unwatched positions
  // (one request) so its card is right before the full refresh gets there.
  async function quickRefresh() {
    if (loading || !data) return;
    const w = await store.get(WATCHING_KEY);
    if (!w || Date.now() - w.at > TTL.watching) return;
    const show = data.shows.find((s) => s.episodes.some((ep) => Object.values(ep.versions).some((v) => v.id === w.id)));
    if (!show) return;
    const fraction = prefs.watchedPct / 100;
    const ids = [];
    for (const ep of show.episodes) for (const v of Object.values(ep.versions)) if (!isWatched(data.playheads[v.id], v.dur, fraction)) ids.push(v.id);
    if (!ids.length) return;
    try { Object.assign(data.playheads, await fetchPlayheads(ids)); render(); }
    catch (e) { console.warn(`[${APP_NAME}] quick refresh failed:`, e.message); }
  }

  // userInitiated: the user chose "Normal Watchlist", so stop auto-reopening.
  function hide(userInitiated) {
    if (userInitiated) deleteCookie(ACTIVE_COOKIE);
    if (!showing) return;
    showing = false;
    root.hidden = true;
    if (modal) { modal.remove(); modal = null; }
    document.documentElement.style.overflow = prevHtmlOverflow;
    if (toggleBtn && onListPage()) toggleBtn.hidden = false;
    if (location.hash === OPEN_HASH) history.replaceState(null, "", location.pathname + location.search);
  }

  function mountToggle() {
    if (toggleBtn && toggleBtn.isConnected) return;
    toggleBtn = el("button", { id: "bwl-toggle", text: APP_NAME, onclick: () => show() });
    document.documentElement.append(toggleBtn);
  }

  // ---------------------------------------------- native season dropdown
  // Crunchyroll's series page and the player's "see more episodes" panel share
  // one season selector (.erc-seasons-select). Its options follow Crunchyroll's
  // editorial order (OVAs and movies appended at the end). We reorder the
  // option nodes to our air-date order. Moving the existing nodes keeps React's
  // event handling intact; an observer re-applies the order after re-renders.
  const instalmentOrderCache = new Map(); // seriesId -> Promise<{ titles: string[] }>

  // Shows on your watchlist already have their seasons and episodes cached by
  // the overlay; only shows outside it cost requests here (seasons list, then
  // one episode request per instalment in your first language, kept for a week).
  async function instalmentOrderFor(seriesId) {
    if (instalmentOrderCache.has(seriesId)) return instalmentOrderCache.get(seriesId);
    const job = (async () => {
      const langs = currentPrefs().languages;
      const cachedList = await store.get(seasonsListKey(seriesId));
      const seasons = cachedList && Array.isArray(cachedList.seasons) ? cachedList.seasons : canonicalSeasons(await fetchSeasons(seriesId));
      const starts = await Promise.all(seasons.map(async (season, i) => {
        const main = await store.get(seasonKey(langs, season.id));
        if (main) {
          let start = null;
          for (const e of main.episodes) { const d = epChrono(e); if (d !== null && (start === null || d < start)) start = d; }
          return { i, season, start };
        }
        const key = `inst-start:${season.id}`;
        let rec = await store.get(key);
        if (!rec || Date.now() - rec.at > TTL.latestDormant) {
          let start = null;
          try {
            const eps = await fetchEpisodes(season.id, langs[0]);
            for (const e of eps) { const d = ts(e.episode_air_date) ?? ts(releaseDate(e)); if (d !== null && (start === null || d < start)) start = d; }
          } catch (e) { console.warn(`[${APP_NAME}] instalment start lookup failed for ${season.title}:`, e.message); }
          rec = { start, at: Date.now() };
          await store.set(key, rec);
        }
        return { i, season, start: rec.start };
      }));
      starts.sort((a, b) => ((a.start ?? Infinity) - (b.start ?? Infinity)) || (a.i - b.i));
      const startsByTitle = {};
      for (const x of starts) startsByTitle[(x.season.title || "").trim()] = x.start;
      return { titles: starts.map((x) => (x.season.title || "").trim()), starts: startsByTitle };
    })();
    instalmentOrderCache.set(seriesId, job);
    job.catch(() => instalmentOrderCache.delete(seriesId));
    return job;
  }

  function pageSeriesId() {
    const m = location.pathname.match(/^\/series\/([A-Z0-9]+)/i);
    if (m) return m[1];
    const a = document.querySelector(C.dom.seriesLink);
    const m2 = a && a.getAttribute("href").match(C.dom.seriesIdFromHref);
    return m2 ? m2[1] : null;
  }

  const fmtIsoDate = (at) => new Date(at).toISOString().slice(0, 10);
  // The option's textContent is title + episode count run together ("Season 125 Episodes"); read the title span.
  const optionTitleEl = (opt) => opt.querySelector(C.dom.seasonSelect.optionTitle) || opt.firstElementChild || opt;
  const optionTitle = (opt) => (optionTitleEl(opt).textContent || "").replace(/^\d{4}-\d{2}-\d{2}\s+·\s+/, "").trim();

  // Reorder the option nodes under each parent that holds them, and prefix each
  // title with the air date we sorted by, e.g. "2019-07-09 · OVA Season 1".
  function reorderSeasonDropdown(scope, order) {
    const options = [...scope.querySelectorAll(C.dom.seasonSelect.option)];
    if (options.length < 2) return false;
    const rankOf = new Map(order.titles.map((t, i) => [t, i]));
    let changed = false;
    const parents = new Set(options.map((o) => o.parentElement));
    for (const parent of parents) {
      const opts = [...parent.children].filter((c) => c.getAttribute("role") === "option");
      const keyed = opts.map((o, i) => ({ o, i, rank: rankOf.get(optionTitle(o)) }));
      if (keyed.filter((k) => k.rank !== undefined).length < 2) continue; // titles did not match: leave Crunchyroll's order alone
      keyed.sort((a, b) => ((a.rank ?? Infinity) - (b.rank ?? Infinity)) || (a.i - b.i));
      if (!keyed.every((k, idx) => k.o === opts[idx])) { for (const k of keyed) parent.append(k.o); changed = true; }
      for (const k of keyed) {
        const at = order.starts[optionTitle(k.o)];
        if (at === undefined || at === null) continue;
        const elT = optionTitleEl(k.o);
        const want = `${fmtIsoDate(at)} · ${optionTitle(k.o)}`;
        if (elT.textContent.trim() !== want) { elT.textContent = want; changed = true; }
      }
    }
    return changed;
  }

  function watchSeasonDropdowns() {
    let pending = false;
    const apply = async () => {
      pending = false;
      const boxes = document.querySelectorAll(C.dom.seasonSelect.listbox);
      if (!boxes.length) return;
      const seriesId = pageSeriesId();
      if (!seriesId) return;
      let order;
      try { order = await instalmentOrderFor(seriesId); } catch (e) { console.warn(`[${APP_NAME}] season order lookup failed:`, e.message); return; }
      for (const box of boxes) if (reorderSeasonDropdown(box, order)) console.info(`[${APP_NAME}] season list reordered by air date`);
    };
    const schedule = () => { if (!pending) { pending = true; setTimeout(apply, 120); } };
    new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
    schedule();
  }
  watchSeasonDropdowns();

  // ------------------------------------------------------- page lifecycle
  // Offer the button on the My Lists pages. Auto-open there if the overlay was
  // active when the user left (e.g. to watch an episode) or if asked via hash.
  const onListPage = () => C.dom.listPagePath.test(location.pathname);
  function init() {
    const watching = location.pathname.match(C.dom.watchIdFromPath);
    if (watching) store.set(WATCHING_KEY, { id: watching[1], at: Date.now() });
    if (onListPage()) {
      mountToggle();
      if (location.hash === OPEN_HASH || readCookie(ACTIVE_COOKIE) === "1") show();
      else toggleBtn.hidden = showing;
    } else {
      if (toggleBtn) toggleBtn.hidden = true;
      if (showing) hide(false); // left the list page inside the SPA; keep the active flag so we come back
    }
  }
  init();
  window.addEventListener("hashchange", init);
  let lastPath = location.pathname;
  setInterval(() => { if (location.pathname !== lastPath) { lastPath = location.pathname; init(); } }, 1000);

  // Toolbar button (background.js) asks an already-open watchlist tab to show the overlay.
  if (isExtension && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
      if (msg && msg.type === "open") { const ok = onListPage(); if (ok) show(); reply({ ok }); }
    });
  }

  // Exposed for the paste-into-console test harness only. As an installed
  // extension this lives in the isolated world and is NOT visible to the page.
  window.__crWatchlistPlus = { show, hide, load, rank, get data() { return data; }, get view() { return view; }, get prefs() { return prefs; } };
})();
