/*
 * Better Watchlist for Crunchyroll — content script.
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
 * Nothing leaves the browser except requests to crunchyroll.com.
 */
(() => {
  "use strict";

  // ---------------------------------------------------------------- config
  const PREFERRED = ["en-US", "ja-JP"]; // order of preference
  const EPISODES_TTL_MS = 12 * 60 * 60 * 1000; // cache season episode lists 12h
  const CONCURRENCY = 6;
  // Crunchyroll only sets `fully_watched` if you sit through the ending theme.
  // Skipping the credits leaves the playhead at roughly 80-90%, so treat an episode as
  // watched once you are past this fraction OR within this many seconds of the end.
  const DEFAULT_WATCHED_PCT = 75; // adjustable in the UI
  const WATCHED_TAIL_SECONDS = 300;
  // Public client id the Crunchyroll web app uses for the cookie -> token grant.
  const WEB_CLIENT_BASIC = "bm9haWhkZXZtXzZpeWcwYThsMHE6";
  const DEVICE_ID = "8b0ec7a1-3f9b-4a3e-9c2f-0e1d2c3b4a59";

  // --------------------------------------------------------------- storage
  // chrome.storage.local when running as an extension; localStorage fallback
  // so the same file can be pasted into a console for testing.
  const store = (() => {
    const hasChrome = typeof chrome !== "undefined" && chrome.storage && chrome.storage.local;
    if (hasChrome) {
      return {
        get: (k) => chrome.storage.local.get(k).then((r) => r[k]),
        set: (k, v) => chrome.storage.local.set({ [k]: v }),
        remove: (k) => chrome.storage.local.remove(k),
      };
    }
    return {
      get: async (k) => {
        try { const v = localStorage.getItem("bwl:" + k); return v ? JSON.parse(v) : undefined; } catch { return undefined; }
      },
      set: async (k, v) => { try { localStorage.setItem("bwl:" + k, JSON.stringify(v)); } catch {} },
      remove: async (k) => { try { localStorage.removeItem("bwl:" + k); } catch {} },
    };
  })();

  // ------------------------------------------------------------------- api
  let token = null; // { access_token, account_id, expiresAt }

  async function getToken() {
    if (token && Date.now() < token.expiresAt - 20_000) return token;
    const r = await fetch("/auth/v1/token", {
      method: "POST",
      credentials: "include",
      headers: {
        Authorization: "Basic " + WEB_CLIENT_BASIC,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: `grant_type=etp_rt_cookie&device_type=Chrome&device_id=${DEVICE_ID}`,
    });
    if (!r.ok) throw new Error(`Token exchange failed (${r.status}). Are you logged in to Crunchyroll?`);
    const j = await r.json();
    token = { access_token: j.access_token, account_id: j.account_id, expiresAt: Date.now() + (j.expires_in || 300) * 1000 };
    return token;
  }

  async function api(path, attempt = 0) {
    const t = await getToken();
    const r = await fetch(path, { headers: { Authorization: "Bearer " + t.access_token } });
    if (r.status === 401 && attempt === 0) { token = null; return api(path, 1); }
    if (r.status === 429 && attempt < 3) {
      await sleep(1000 * (attempt + 1));
      return api(path, attempt + 1);
    }
    if (!r.ok) throw new Error(`${r.status} ${path.split("?")[0]}`);
    return r.json();
  }

  async function fetchWatchlist() {
    const t = await getToken();
    const items = [];
    let start = 0;
    for (;;) {
      const j = await api(`/content/v2/discover/${t.account_id}/watchlist?n=100&start=${start}&order=desc&locale=en-US`);
      items.push(...(j.data || []));
      if (!j.data || j.data.length < 100 || items.length >= (j.total || 0)) break;
      start += 100;
    }
    return items;
  }

  const fetchSeasons = (seriesId) =>
    api(`/content/v2/cms/series/${seriesId}/seasons?locale=en-US`).then((j) => j.data || []);

  const fetchEpisodes = (seasonId, audio) =>
    api(`/content/v2/cms/seasons/${seasonId}/episodes?locale=en-US&preferred_audio_language=${audio}`).then((j) => j.data || []);

  async function fetchPlayheads(ids) {
    const t = await getToken();
    const out = new Map();
    for (let i = 0; i < ids.length; i += 80) {
      const chunk = ids.slice(i, i + 80);
      const j = await api(`/content/v2/${t.account_id}/playheads?content_ids=${chunk.join(",")}&locale=en-US`);
      for (const p of j.data || []) out.set(p.content_id, p);
    }
    return out;
  }

  // ------------------------------------------------------------------ core
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function mapLimit(items, limit, fn, onProgress) {
    const results = new Array(items.length);
    let next = 0, done = 0;
    async function worker() {
      while (next < items.length) {
        const i = next++;
        try { results[i] = await fn(items[i], i); } catch (e) { results[i] = { error: e }; }
        done++;
        onProgress && onProgress(done, items.length);
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
  }

  function isWatched(playhead, durationMs, fraction) {
    if (!playhead) return false;
    if (playhead.fully_watched) return true;
    const dur = (durationMs || 0) / 1000;
    if (!dur || !playhead.playhead) return false;
    return playhead.playhead / dur >= fraction || dur - playhead.playhead <= WATCHED_TAIL_SECONDS;
  }

  const releaseDate = (e) => e.premium_available_date || e.availability_starts || e.upload_date || e.episode_air_date || null;

  // Compact form of an episode entry kept in cache.
  const slim = (e) => ({
    id: e.id,
    key: e.identifier || `${e.season_id}|${e.sequence_number}`,
    audio: e.audio_locale,
    n: e.episode_number ?? e.sequence_number,
    seq: e.sequence_number,
    season: e.season_number,
    title: e.title,
    date: releaseDate(e),          // when it became available on Crunchyroll (drives "newness")
    air: e.episode_air_date || null, // original broadcast/theatrical date (drives chronology)
    dur: e.duration_ms,
    thumb: pickThumb(e.images),
    slug: e.slug_title || "",
  });

  function pickThumb(images) {
    const arr = images && images.thumbnail && images.thumbnail[0];
    if (!arr || !arr.length) return null;
    const best = arr.find((i) => i.width >= 640) || arr[arr.length - 1];
    return best.source;
  }

  // Season versions collapse to one canonical season (the original-audio guid).
  function canonicalSeasons(seasons) {
    const seen = new Map();
    for (const s of seasons) {
      const versions = Array.isArray(s.versions) && s.versions.length ? s.versions : [{ guid: s.id, audio_locale: s.audio_locale, original: true }];
      const orig = versions.find((v) => v.original) || versions[0];
      if (!seen.has(orig.guid)) seen.set(orig.guid, { id: orig.guid, number: s.season_number, title: s.title });
    }
    return [...seen.values()];
  }

  async function loadSeason(season, force) {
    const cacheKey = `season:v2:${season.id}`;
    if (!force) {
      const cached = await store.get(cacheKey);
      if (cached && Date.now() - cached.fetchedAt < EPISODES_TTL_MS) return cached.episodes;
    }
    const lists = await Promise.all(PREFERRED.map((audio) => fetchEpisodes(season.id, audio)));
    // Merge per episode: one record with a version per audio language.
    const byKey = new Map();
    lists.forEach((list, idx) => {
      const wanted = PREFERRED[idx];
      for (const raw of list) {
        const e = slim(raw);
        if (e.audio !== wanted) continue; // the API fell back to another language: no version in `wanted`
        const rec = byKey.get(e.key) || { key: e.key, n: e.n, seq: e.seq, season: e.season, inst: season.id, instTitle: season.title, air: e.air, title: e.title, thumb: e.thumb, versions: {} };
        rec.air = rec.air || e.air;
        rec.versions[wanted] = { id: e.id, date: e.date, dur: e.dur };
        rec.thumb = rec.thumb || e.thumb;
        byKey.set(e.key, rec);
      }
    });
    const episodes = [...byKey.values()].sort((a, b) => (a.seq ?? a.n) - (b.seq ?? b.n));
    await store.set(cacheKey, { fetchedAt: Date.now(), episodes });
    return episodes;
  }

  /** Fetch everything needed to rank: watchlist, episodes per season, playheads. */
  async function fetchData({ force = false, onStatus, onProgress } = {}) {
    onStatus("Reading your watchlist…");
    const wl = await fetchWatchlist();
    const shows = wl.map((it) => {
      const m = it.panel.episode_metadata || {};
      return {
        seriesId: m.series_id || it.panel.id,
        title: m.series_title || it.panel.title,
        slug: m.series_slug_title || it.panel.slug_title || "",
        panelThumb: pickThumb(it.panel.images),
        upNext: m.episode_number ? { season: m.season_number, n: m.episode_number, id: it.panel.id } : null,
        crFullyWatched: !!it.fully_watched,
        isNew: !!it.new,
        episodes: [],
        error: null,
      };
    });

    onStatus(`Loading seasons and episodes for ${shows.length} shows…`);
    let seasonJobs = [];
    await mapLimit(shows, CONCURRENCY, async (show) => {
      const seasons = canonicalSeasons(await fetchSeasons(show.seriesId));
      seasons.forEach((s, order) => seasonJobs.push({ show, season: s, order }));
    }, (d, n) => onProgress(d / n * 0.2));

    await mapLimit(seasonJobs, CONCURRENCY, async ({ show, season, order }) => {
      try {
        const eps = await loadSeason(season, force);
        show.episodes.push(...eps.map((e) => ({ ...e, catalogueOrder: order })));
      } catch (e) {
        show.error = e.message;
      }
    }, (d, n) => onProgress(0.2 + d / n * 0.6));
    for (const show of shows) assignInstalmentOrder(show);

    onStatus("Checking what you have already watched…");
    const ids = [];
    for (const show of shows) for (const ep of show.episodes) for (const v of Object.values(ep.versions)) ids.push(v.id);
    const playheadMap = await fetchPlayheads(ids);
    const playheads = Object.fromEntries(playheadMap); // plain object so it survives storage
    onProgress(1);
    return { shows, playheads, builtAt: Date.now(), showCount: shows.length };
  }

  /**
   * Instalment chronology. Crunchyroll's own season order is editorial: OVA and
   * movie "seasons" are often appended after the main run (Slime lists both OVA
   * collections after Season 4). We order instalments by the original air date of
   * their first episode, then keep Crunchyroll's episode sequence inside each
   * instalment. Air date, not Crunchyroll availability date, because catalogue
   * back-fills (a 2019 movie added in 2026) would otherwise land in the wrong place.
   */
  const epChrono = (e) => e.air || (e.versions["ja-JP"] && e.versions["ja-JP"].date) || (e.versions["en-US"] && e.versions["en-US"].date) || "";
  function assignInstalmentOrder(show) {
    const start = new Map(); // instalment id -> earliest air date
    const catalogue = new Map();
    for (const e of show.episodes) {
      const d = epChrono(e);
      if (d && (!start.has(e.inst) || d < start.get(e.inst))) start.set(e.inst, d);
      catalogue.set(e.inst, e.catalogueOrder);
    }
    const ordered = [...catalogue.keys()].sort((a, b) =>
      (start.get(a) || "9999").localeCompare(start.get(b) || "9999") || (catalogue.get(a) - catalogue.get(b)));
    const rankOf = new Map(ordered.map((id, i) => [id, i]));
    for (const e of show.episodes) e.sOrder = rankOf.get(e.inst);
    show.instalments = ordered.map((id) => ({ id, title: show.episodes.find((e) => e.inst === id)?.instTitle, start: start.get(id) || null }));
  }
  const episodeOrder = (a, b) => (a.sOrder - b.sOrder) || ((a.seq ?? a.n) - (b.seq ?? b.n));

  /**
   * Rank the fetched data. Pure: re-run it when a preference changes.
   * Each show gets:
   *   newestUnwatched: the unwatched episode with the latest "arrival" date,
   *     where arrival = English release if an English version exists, else Japanese.
   *   newestAny: the latest arrival regardless of watched state (for caught-up shows).
   * With prefs.highWater on, every episode that precedes the last one you
   * actually watched (instalments in air-date order, episodes in sequence) is
   * assumed watched too. This covers history that never made it into Crunchyroll
   * (e.g. pre-merger Funimation) and old specials you skipped.
   */
  function rank(data, prefs) {
    const { shows, playheads } = data;
    const fraction = (prefs.watchedPct ?? DEFAULT_WATCHED_PCT) / 100;
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
        const en = ep.versions["en-US"], ja = ep.versions["ja-JP"];
        const arrival = en || ja;
        if (!arrival || !arrival.date || Date.parse(arrival.date) > now) return; // not released yet
        const lang = en ? "en-US" : "ja-JP";
        const started = Object.values(ep.versions).some((v) => (playheads[v.id]?.playhead || 0) > 0);
        const cand = { ep, lang, date: arrival.date, id: arrival.id, watched: flags[i], started, dubbed: !!en };
        if (!newestAny || cand.date > newestAny.date) newestAny = cand;
        if (!flags[i]) {
          unwatchedCount++;
          if (!newestUnwatched || cand.date > newestUnwatched.date) newestUnwatched = cand;
        }
      });
      show.newestUnwatched = newestUnwatched;
      show.newestAny = newestAny;
      show.unwatchedCount = unwatchedCount;
      show.inferredWatched = inferred;
    }
    const byDateDesc = (pick) => (a, b) => ((pick(b) && pick(b).date) || "").localeCompare((pick(a) && pick(a).date) || "");
    return {
      active: shows.filter((s) => s.newestUnwatched).sort(byDateDesc((s) => s.newestUnwatched)),
      caughtUp: shows.filter((s) => !s.newestUnwatched).sort(byDateDesc((s) => s.newestAny)),
    };
  }

  // -------------------------------------------------------------------- ui
  const $ = (sel, root = document) => root.querySelector(sel);
  const el = (tag, attrs = {}, children = []) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") n.className = v;
      else if (k === "text") n.textContent = v;
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v);
    }
    for (const c of children) if (c) n.append(c);
    return n;
  };

  function relTime(iso) {
    const d = Date.parse(iso);
    if (!d) return "";
    const days = Math.floor((Date.now() - d) / 86_400_000);
    if (days <= 0) return "today";
    if (days === 1) return "yesterday";
    if (days < 14) return `${days} days ago`;
    if (days < 60) return `${Math.floor(days / 7)} weeks ago`;
    if (days < 730) return `${Math.floor(days / 30)} months ago`;
    return `${Math.floor(days / 365)} years ago`;
  }
  const fmtDate = (iso) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  const langLabel = (l) => (l === "en-US" ? "EN" : l === "ja-JP" ? "JA" : l);

  // "Season 2" -> "S2 E9". Other instalments (movie, OVA collection) keep their
  // title, minus the series name and audio suffixes Crunchyroll sometimes prepends.
  function instalmentLabel(show, ep) {
    let t = ep.instTitle || "";
    if (show.title && t.toLowerCase().startsWith(show.title.toLowerCase())) t = t.slice(show.title.length);
    t = t.replace(/\((English|Japanese|[A-Za-z]+) Dub\)/i, "").replace(/^[\s:\-–]+|[\s:\-–]+$/g, "").trim();
    const m = /^Season\s*(\d+)/i.exec(t);
    if (m) return `S${m[1]} E${ep.n}`;
    const roman = { II: 2, III: 3, IV: 4, V: 5, VI: 6 }[t.toUpperCase()];
    if (roman) return `S${roman} E${ep.n}`;
    if (!t) return `S${ep.season ?? "?"} E${ep.n}`;
    const short = t.length > 30 ? t.slice(0, 28) + "…" : t;
    const single = show.episodes.filter((e) => e.inst === ep.inst).length === 1;
    return single ? short : `${short} E${ep.n}`;
  }

  function card(show, { done }) {
    const c = show.newestUnwatched || show.newestAny;
    const href = c ? `/watch/${c.id}/${c.ep.slug || ""}` : `/series/${show.seriesId}/${show.slug}`;
    const thumb = (c && c.ep.thumb) || show.panelThumb;
    const lines = [];
    if (c) {
      const epLabel = instalmentLabel(show, c.ep);
      lines.push(el("div", { class: "bwl-line" }, [
        el("strong", { text: done ? "Latest: " : (c.started ? "Continue: " : "Next new: ") }),
        document.createTextNode(`${epLabel} · ${langLabel(c.lang)} · `),
        el("span", { class: "bwl-date", text: relTime(c.date) }),
        el("span", { class: "bwl-muted", text: `  (${fmtDate(c.date)})` }),
      ]));
      if (!done && c.lang === "ja-JP") lines.push(el("div", { class: "bwl-muted", text: "No English dub of this episode yet" }));
      if (!done) lines.push(el("div", { class: "bwl-muted", text: `${show.unwatchedCount} unwatched episode${show.unwatchedCount === 1 ? "" : "s"}` + (show.inferredWatched ? ` · ${show.inferredWatched} earlier assumed watched` : "") }));
      if (done) lines.push(el("div", { class: "bwl-muted", text: "All caught up" }));
    } else {
      lines.push(el("div", { class: "bwl-muted", text: show.error ? `Could not load: ${show.error}` : "No released episodes found" }));
    }
    return el("a", { class: "bwl-card" + (done ? " bwl-done" : ""), href }, [
      el("div", { class: "bwl-thumb" }, [
        thumb ? el("img", { src: thumb, loading: "lazy", alt: "" }) : null,
        c ? el("span", { class: `bwl-badge bwl-lang-${c.lang === "en-US" ? "en" : "ja"}`, text: langLabel(c.lang) }) : null,
        !done && c && (Date.now() - Date.parse(c.date)) < 7 * 86_400_000 ? el("span", { class: "bwl-badge bwl-new", text: "NEW" }) : null,
      ]),
      el("div", { class: "bwl-body" }, [el("div", { class: "bwl-title", text: show.title }), ...lines]),
    ]);
  }

  let root, statusEl, progressEl, gridsEl, data = null, view = null;
  const DEFAULT_PREFS = { hideDone: false, highWater: true, watchedPct: DEFAULT_WATCHED_PCT };
  let prefs = { ...DEFAULT_PREFS };

  function render() {
    gridsEl.replaceChildren();
    if (!data) return;
    view = rank(data, prefs);
    const { active, caughtUp } = view;
    gridsEl.append(el("div", { class: "bwl-section-title", text: `New for you (${active.length})` }));
    gridsEl.append(el("div", { class: "bwl-grid" }, active.map((s) => card(s, { done: false }))));
    if (!active.length) gridsEl.append(el("div", { class: "bwl-empty", text: "Nothing unwatched. Enjoy the break." }));
    if (!prefs.hideDone) {
      gridsEl.append(el("div", { class: "bwl-section-title", text: `Caught up (${caughtUp.length})` }));
      gridsEl.append(el("div", { class: "bwl-grid" }, caughtUp.map((s) => card(s, { done: true }))));
    }
  }

  function setStatus(msg, isError = false) {
    statusEl.textContent = msg;
    statusEl.classList.toggle("bwl-error", isError);
  }
  const setProgress = (f) => { progressEl.style.width = `${Math.round(f * 100)}%`; };
  const savePrefs = () => store.set("prefs", prefs);

  let loading = false;
  async function load(force) {
    if (loading) return;
    loading = true;
    setProgress(0);
    try {
      data = await fetchData({ force, onStatus: setStatus, onProgress: setProgress });
      await store.set("data", data);
      render();
      setStatus(`${data.showCount} shows · updated ${new Date(data.builtAt).toLocaleTimeString()}`);
    } catch (e) {
      console.error("[Better Watchlist]", e);
      setStatus(`Failed: ${e.message}`, true);
    } finally {
      loading = false;
      setProgress(0);
    }
  }

  function buildUi() {
    if (root) return;
    root = el("div", { id: "bwl-root", hidden: "" });
    statusEl = el("div", { class: "bwl-status" });
    progressEl = el("div");
    gridsEl = el("div");

    const hideDone = el("input", { type: "checkbox", onchange: (ev) => { prefs.hideDone = ev.target.checked; savePrefs(); render(); } });
    const highWater = el("input", { type: "checkbox", onchange: (ev) => { prefs.highWater = ev.target.checked; savePrefs(); render(); } });
    const pctLabel = el("span", { class: "bwl-pct" });
    const pct = el("input", {
      type: "range", min: "50", max: "100", step: "5", class: "bwl-slider",
      oninput: (ev) => { prefs.watchedPct = Number(ev.target.value); pctLabel.textContent = `${prefs.watchedPct}%`; render(); },
      onchange: savePrefs,
    });
    const syncControls = () => {
      hideDone.checked = !!prefs.hideDone;
      highWater.checked = !!prefs.highWater;
      pct.value = String(prefs.watchedPct);
      pctLabel.textContent = `${prefs.watchedPct}%`;
    };
    syncControls();

    root.append(
      el("div", { class: "bwl-bar" }, [
        el("h1", { text: "Better Watchlist" }),
        el("span", { class: "bwl-muted", text: "newest unwatched episode first · EN preferred, JA fallback" }),
        el("span", { class: "bwl-spacer" }),
        el("label", { title: "An episode counts as watched once the playhead passes this share of its runtime (Crunchyroll's own flag needs you to sit through the credits)" }, [
          document.createTextNode("Watched at "), pct, pctLabel,
        ]),
        el("label", { title: "Assume everything before the last episode you watched in a series is watched too" }, [highWater, document.createTextNode("Assume earlier episodes watched")]),
        el("label", {}, [hideDone, document.createTextNode("Hide caught-up")]),
        el("button", { text: "Refresh", title: "Re-check playheads and new episodes (uses cached episode lists)", onclick: () => load(false) }),
        el("button", { text: "Full reload", title: "Ignore cache and refetch everything", onclick: () => load(true) }),
        el("button", { class: "bwl-primary", text: "Close", onclick: hide }),
      ]),
      el("div", { class: "bwl-progress" }, [progressEl]),
      statusEl,
      gridsEl,
    );
    document.documentElement.append(root);
    store.get("prefs").then((p) => { if (p) { prefs = { ...DEFAULT_PREFS, ...p }; syncControls(); render(); } });
  }

  async function show() {
    buildUi();
    root.hidden = false;
    document.documentElement.style.overflow = "hidden";
    if (!data) {
      const cached = await store.get("data");
      if (cached) { data = cached; render(); setStatus(`Showing cached view from ${new Date(cached.builtAt).toLocaleString()} · refreshing…`); }
    }
    load(false);
  }
  function hide() {
    if (!root) return;
    root.hidden = true;
    document.documentElement.style.overflow = "";
    if (location.hash === "#better-watchlist") history.replaceState(null, "", location.pathname + location.search);
  }

  function mountToggle() {
    if ($("#bwl-toggle")) return;
    document.documentElement.append(el("button", { id: "bwl-toggle", text: "Better Watchlist", onclick: show }));
  }

  // Only offer the button on the My Lists pages; open automatically when asked via hash.
  const onListPage = () => /^\/(watchlist|crunchylists|history)\b/.test(location.pathname);
  function init() {
    if (onListPage()) mountToggle();
    if (location.hash === "#better-watchlist") show();
  }
  init();
  window.addEventListener("hashchange", init);
  // Crunchyroll is a SPA: watch for client-side navigation.
  let lastPath = location.pathname;
  setInterval(() => {
    if (location.pathname !== lastPath) { lastPath = location.pathname; init(); }
  }, 800);

  // Expose for console testing.
  window.__betterWatchlist = { show, hide, load, rank, get data() { return data; }, get view() { return view; }, get prefs() { return prefs; }, set prefs(p) { prefs = { ...prefs, ...p }; } };
})();
