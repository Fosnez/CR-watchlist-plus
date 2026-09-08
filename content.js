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

  // ---------------------------------------------------------------- config
  const APP_NAME = "CR Watchlist Plus";
  const OPEN_HASH = "#cr-watchlist-plus";
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
  const EPISODES_TTL_MS = 12 * 60 * 60 * 1000; // cache season episode lists 12h
  const CONCURRENCY = 6;
  const DEFAULT_PREFS = { watchedPct: 75, highWater: true, hideDone: true, languages: DEFAULT_LANGUAGES, strictLanguages: true, skipIntro: true, skipCredits: true, skipRecap: false };
  // Crunchyroll only sets `fully_watched` if you sit through the ending theme.
  // Skipping the credits leaves the playhead at roughly 80-90%, so treat an
  // episode as watched once past prefs.watchedPct OR within this many seconds
  // of the end (the tail rule only applies to episodes longer than the tail).
  const WATCHED_TAIL_SECONDS = 300;
  // Crunchyroll's PUBLIC web-app client id ("noaihdevm_6iyg0a8l0q" with an
  // empty secret), shipped in the site's own JS bundle. Not a secret and not
  // tied to any user; it is what the site sends when it refreshes its token.
  const WEB_CLIENT_BASIC = "bm9haWhkZXZtXzZpeWcwYThsMHE6";
  // Preferences live in a cookie on crunchyroll.com. Chrome caps cookie lifetime
  // at 400 days; we ask for that and rewrite the cookie on every open, so in
  // practice it never expires while the extension is in use.
  const COOKIE_MAX_AGE = 400 * 24 * 60 * 60;
  const PREFS_COOKIE = "cr_watchlist_plus_prefs";
  const ACTIVE_COOKIE = "cr_watchlist_plus_active";
  const DATA_KEY = "data:v4";
  const seasonKey = (langs, seasonId) => `season:v4:${langs.join("+")}:${seasonId}`;

  // --------------------------------------------------------------- storage
  // Result cache: chrome.storage.local when running as an extension; a
  // localStorage fallback so the same file can be pasted into the page console
  // for testing. Preferences are NOT kept here; they live in the cookie only.
  const isExtension = typeof chrome !== "undefined" && !!(chrome.storage && chrome.storage.local);
  const store = isExtension
    ? {
        get: (k) => chrome.storage.local.get(k).then((r) => r[k]),
        set: (k, v) => chrome.storage.local.set({ [k]: v }),
      }
    : {
        get: async (k) => { try { const v = localStorage.getItem("bwl:" + k); return v ? JSON.parse(v) : undefined; } catch { return undefined; } },
        set: async (k, v) => { try { localStorage.setItem("bwl:" + k, JSON.stringify(v)); } catch {} },
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
      for (const k of ["skipIntro", "skipCredits", "skipRecap", "strictLanguages"]) if (typeof p[k] === "boolean") out[k] = p[k];
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
      const hits = document.querySelectorAll('[data-testid*="skip" i], [aria-label*="skip" i]');
      if (!hits.length) return;
      const prefs = currentPrefs();
      for (const el of hits) {
        const btn = el.closest('[role="button"], button') || el;
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
  if (window.top !== window) return; // inside the player (or any other) iframe: auto-skip only

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
    const r = await fetch("/auth/v1/token", {
      method: "POST",
      credentials: "include",
      headers: { Authorization: "Basic " + WEB_CLIENT_BASIC, "Content-Type": "application/x-www-form-urlencoded" },
      body: `grant_type=etp_rt_cookie&device_type=Chrome&device_id=${await deviceId()}`,
    });
    if (!r.ok) throw new Error(`Token exchange failed (${r.status}). Are you logged in to Crunchyroll?`);
    const j = await r.json();
    token = { access_token: j.access_token, account_id: j.account_id, expiresAt: Date.now() + (j.expires_in || 300) * 1000 };
    return token;
  }

  async function api(path, retries = { auth: 0, rate: 0 }) {
    const t = await getToken();
    const r = await fetch(path, { headers: { Authorization: "Bearer " + t.access_token } });
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
      const j = await api(`/content/v2/discover/${t.account_id}/watchlist?n=100&start=${start}&order=desc&locale=en-US`);
      const page = j.data || [];
      items.push(...page);
      if (page.length < 100) break;
      if (Number.isFinite(j.total) && items.length >= j.total) break;
      start += 100;
    }
    return items;
  }

  const fetchSeasons = (seriesId) => api(`/content/v2/cms/series/${seriesId}/seasons?locale=en-US`).then((j) => j.data || []);
  const fetchEpisodes = (seasonId, audio) => api(`/content/v2/cms/seasons/${seasonId}/episodes?locale=en-US&preferred_audio_language=${audio}`).then((j) => j.data || []);

  async function fetchPlayheads(ids) {
    const t = await getToken();
    const out = {};
    for (let i = 0; i < ids.length; i += 80) {
      const chunk = ids.slice(i, i + 80);
      const j = await api(`/content/v2/${t.account_id}/playheads?content_ids=${chunk.join(",")}&locale=en-US`);
      for (const p of j.data || []) out[p.content_id] = { playhead: p.playhead, fully_watched: !!p.fully_watched };
    }
    return out;
  }

  // ------------------------------------------------------------------ core
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const ts = (iso) => { const n = iso ? Date.parse(iso) : NaN; return Number.isNaN(n) ? null : n; };

  async function mapLimit(items, limit, fn, onProgress) {
    let next = 0, done = 0;
    async function worker() {
      while (next < items.length) {
        const i = next++;
        try { await fn(items[i], i); } catch (e) { console.error(`[${APP_NAME}]`, e); }
        done++;
        onProgress && onProgress(done, items.length);
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
      return { id: g.id, title: row.title || "", number: row.season_number };
    });
  }

  // Merge key that does not depend on which audio version a row came from.
  const episodeKey = (raw, seasonId) => raw.identifier || `${seasonId}|${raw.season_number ?? ""}|${raw.sequence_number ?? raw.episode_number ?? raw.id}`;

  async function loadSeason(season, langs, force) {
    const cacheKey = seasonKey(langs, season.id);
    if (!force) {
      const cached = await store.get(cacheKey);
      if (cached && Date.now() - cached.fetchedAt < EPISODES_TTL_MS) return cached.episodes;
    }
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
          air: raw.episode_air_date || null,
          thumb: pickThumb(raw.images),
          versions: {},
        };
        rec.air = rec.air || raw.episode_air_date || null;
        rec.thumb = rec.thumb || pickThumb(raw.images);
        rec.versions[locale] = { id: raw.id, date: releaseDate(raw), dur: raw.duration_ms || null, slug: raw.slug_title || "" };
        byKey.set(key, rec);
      }
    });
    const episodes = [...byKey.values()].sort(episodeSeqOrder);
    await store.set(cacheKey, { fetchedAt: Date.now(), episodes });
    return episodes;
  }

  const seqOf = (e) => (Number.isFinite(e.seq) ? e.seq : Number.isFinite(e.n) ? e.n : Infinity);
  const episodeSeqOrder = (a, b) => (seqOf(a) - seqOf(b)) || String(a.key).localeCompare(String(b.key));

  /** Fetch everything needed to rank: watchlist, episodes per instalment, playheads. */
  async function fetchData({ force = false, langs, onStatus, onProgress }) {
    onStatus("Reading your watchlist…");
    const wl = await fetchWatchlist();
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

    onStatus(`Loading seasons and episodes for ${shows.length} shows…`);
    const seasonJobs = [];
    await mapLimit(shows, CONCURRENCY, async (show) => {
      try {
        const seasons = canonicalSeasons(await fetchSeasons(show.seriesId));
        seasons.forEach((s, order) => seasonJobs.push({ show, season: s, order }));
      } catch (e) {
        show.error = `seasons: ${e.message}`;
      }
    }, (d, n) => onProgress(d / n * 0.2));

    await mapLimit(seasonJobs, CONCURRENCY, async ({ show, season, order }) => {
      try {
        const eps = await loadSeason(season, langs, force);
        show.episodes.push(...eps.map((e) => ({ ...e, catalogueOrder: order })));
      } catch (e) {
        show.failed.push(season.title || season.id);
      }
    }, (d, n) => onProgress(0.2 + d / n * 0.6));
    for (const show of shows) assignInstalmentOrder(show);

    onStatus("Checking what you have already watched…");
    const ids = [];
    for (const show of shows) for (const ep of show.episodes) for (const v of Object.values(ep.versions)) ids.push(v.id);
    const playheads = await fetchPlayheads(ids);
    onProgress(1);
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
        el("strong", { text: done ? "Latest: " : c.started ? "Continue: " : "Next new: " }),
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
      el("div", { class: "bwl-body" }, [el("div", { class: "bwl-title", text: show.title }), ...lines]),
    ]);
  }

  // ------------------------------------------------------------ ui: state
  let root, statusEl, progressEl, gridsEl, toggleBtn, modal, taglineEl;
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
  const setProgress = (f) => { if (progressEl) progressEl.style.width = `${Math.round(f * 100)}%`; };

  let loading = false;
  async function load(force) {
    if (loading) return;
    loading = true;
    setProgress(0);
    try {
      data = await fetchData({ force, langs: prefs.languages, onStatus: setStatus, onProgress: setProgress });
      render();
      setStatus(`${data.showCount} shows · updated ${new Date(data.builtAt).toLocaleTimeString()}`);
    } catch (e) {
      console.error(`[${APP_NAME}]`, e);
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
        el("div", { class: "bwl-modal-actions" }, [
          el("button", { text: "Cancel", onclick: close }),
          el("button", { class: "bwl-primary", text: "Save", onclick: save }),
        ]),
      ]),
    ]);
    root.append(modal);
    document.addEventListener("keydown", onKey);
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
        el("div", { class: "bwl-heading" }, [el("h1", { text: APP_NAME }), (taglineEl = el("div", { class: "bwl-tagline", text: tagline(prefs) }))]),
        el("span", { class: "bwl-spacer" }),
        el("button", { text: "Settings", onclick: openSettings }),
        el("button", { text: "Refresh", title: "Re-check playheads and new episodes (uses cached episode lists)", onclick: () => load(false) }),
        el("button", { text: "Full reload", title: "Ignore cache and refetch everything", onclick: () => load(true) }),
        el("button", { class: "bwl-primary", text: "Normal Watchlist", title: "Back to Crunchyroll's own watchlist", onclick: () => hide(true) }),
      ]),
      el("div", { class: "bwl-progress" }, [progressEl]),
      statusEl,
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
      }
    }
    load(false);
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

  // ------------------------------------------------------- page lifecycle
  // Offer the button on the My Lists pages. Auto-open there if the overlay was
  // active when the user left (e.g. to watch an episode) or if asked via hash.
  const onListPage = () => /^\/(watchlist|crunchylists|history)\b/.test(location.pathname);
  function init() {
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
