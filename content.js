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
    date: releaseDate(e),
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
    const cacheKey = `season:${season.id}`;
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
        const rec = byKey.get(e.key) || { key: e.key, n: e.n, seq: e.seq, season: e.season, title: e.title, thumb: e.thumb, versions: {} };
        rec.versions[wanted] = { id: e.id, date: e.date, dur: e.dur };
        rec.thumb = rec.thumb || e.thumb;
        byKey.set(e.key, rec);
      }
    });
    const episodes = [...byKey.values()].sort((a, b) => (a.seq ?? a.n) - (b.seq ?? b.n));
    await store.set(cacheKey, { fetchedAt: Date.now(), episodes });
    return episodes;
  }

  /**
   * Build the ranked model.
   * Each show gets:
   *   newestUnwatched: the unwatched episode with the latest "arrival" date,
   *     where arrival = English release if an English version exists, else Japanese.
   *   newestAny: the latest arrival regardless of watched state (for caught-up shows).
   */
  async function buildModel({ force = false, onStatus, onProgress } = {}) {
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
      for (const s of seasons) seasonJobs.push({ show, season: s });
    }, (d, n) => onProgress(d / n * 0.2));

    await mapLimit(seasonJobs, CONCURRENCY, async ({ show, season }) => {
      try {
        const eps = await loadSeason(season, force);
        show.episodes.push(...eps);
      } catch (e) {
        show.error = e.message;
      }
    }, (d, n) => onProgress(0.2 + d / n * 0.6));

    onStatus("Checking what you have already watched…");
    const ids = [];
    for (const show of shows) for (const ep of show.episodes) for (const v of Object.values(ep.versions)) ids.push(v.id);
    const playheads = await fetchPlayheads(ids);
    onProgress(0.95);

    const now = Date.now();
    for (const show of shows) {
      let newestUnwatched = null, newestAny = null, unwatchedCount = 0;
      for (const ep of show.episodes) {
        const en = ep.versions["en-US"], ja = ep.versions["ja-JP"];
        const arrival = en || ja;
        if (!arrival || !arrival.date || Date.parse(arrival.date) > now) continue; // not released yet
        const lang = en ? "en-US" : "ja-JP";
        const vs = Object.values(ep.versions);
        const watched = vs.some((v) => playheads.get(v.id)?.fully_watched);
        const started = vs.some((v) => (playheads.get(v.id)?.playhead || 0) > 0);
        const cand = { ep, lang, date: arrival.date, id: arrival.id, watched, started, dubbed: !!en };
        if (!newestAny || cand.date > newestAny.date) newestAny = cand;
        if (!watched) {
          unwatchedCount++;
          if (!newestUnwatched || cand.date > newestUnwatched.date) newestUnwatched = cand;
        }
      }
      show.newestUnwatched = newestUnwatched;
      show.newestAny = newestAny;
      show.unwatchedCount = unwatchedCount;
    }

    const byDateDesc = (pick) => (a, b) => ((pick(b) && pick(b).date) || "").localeCompare((pick(a) && pick(a).date) || "");
    const active = shows.filter((s) => s.newestUnwatched).sort(byDateDesc((s) => s.newestUnwatched));
    const caughtUp = shows.filter((s) => !s.newestUnwatched).sort(byDateDesc((s) => s.newestAny));
    onProgress(1);
    return { active, caughtUp, builtAt: Date.now(), showCount: shows.length };
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

  function card(show, { done }) {
    const c = show.newestUnwatched || show.newestAny;
    const href = c ? `/watch/${c.id}/${c.ep.slug || ""}` : `/series/${show.seriesId}/${show.slug}`;
    const thumb = (c && c.ep.thumb) || show.panelThumb;
    const lines = [];
    if (c) {
      const epLabel = `S${c.ep.season ?? "?"} E${c.ep.n}`;
      lines.push(el("div", { class: "bwl-line" }, [
        el("strong", { text: done ? "Latest: " : (c.started ? "Continue: " : "Next new: ") }),
        document.createTextNode(`${epLabel} · ${langLabel(c.lang)} · `),
        el("span", { class: "bwl-date", text: relTime(c.date) }),
        el("span", { class: "bwl-muted", text: `  (${fmtDate(c.date)})` }),
      ]));
      if (!done && c.lang === "ja-JP") lines.push(el("div", { class: "bwl-muted", text: "No English dub of this episode yet" }));
      if (!done) lines.push(el("div", { class: "bwl-muted", text: `${show.unwatchedCount} unwatched episode${show.unwatchedCount === 1 ? "" : "s"}` }));
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

  let root, statusEl, progressEl, gridsEl, model = null, prefs = { hideDone: false };

  function render() {
    gridsEl.replaceChildren();
    if (!model) return;
    const { active, caughtUp } = model;
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

  let loading = false;
  async function load(force) {
    if (loading) return;
    loading = true;
    setProgress(0);
    try {
      model = await buildModel({ force, onStatus: setStatus, onProgress: setProgress });
      await store.set("model", model);
      render();
      setStatus(`${model.showCount} shows · updated ${new Date(model.builtAt).toLocaleTimeString()}`);
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
    const hideDone = el("input", { type: "checkbox", onchange: (ev) => { prefs.hideDone = ev.target.checked; store.set("prefs", prefs); render(); } });
    root.append(
      el("div", { class: "bwl-bar" }, [
        el("h1", { text: "Better Watchlist" }),
        el("span", { class: "bwl-muted", text: "newest unwatched episode first · EN preferred, JA fallback" }),
        el("span", { class: "bwl-spacer" }),
        el("label", {}, [hideDone, document.createTextNode("Hide caught-up shows")]),
        el("button", { text: "Refresh", title: "Re-check playheads and new episodes (uses cached episode lists)", onclick: () => load(false) }),
        el("button", { text: "Full reload", title: "Ignore cache and refetch everything", onclick: () => load(true) }),
        el("button", { class: "bwl-primary", text: "Close", onclick: hide }),
      ]),
      el("div", { class: "bwl-progress" }, [progressEl]),
      statusEl,
      gridsEl,
    );
    document.documentElement.append(root);
    store.get("prefs").then((p) => { if (p) { prefs = p; hideDone.checked = !!p.hideDone; render(); } });
  }

  async function show() {
    buildUi();
    root.hidden = false;
    document.documentElement.style.overflow = "hidden";
    if (!model) {
      const cached = await store.get("model");
      if (cached) { model = cached; render(); setStatus(`Showing cached view from ${new Date(cached.builtAt).toLocaleString()} · refreshing…`); }
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
  window.__betterWatchlist = { show, hide, load, get model() { return model; } };
})();
