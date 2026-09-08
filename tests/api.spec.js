// @ts-check
// API contract: every endpoint and field the extension reads still exists and is shaped as expected.
// Needs a logged-in profile (npm run login).
const { test, expect } = require("@playwright/test");
const { CONTRACT: C, launch, isLoggedIn, getToken, apiGet, missingFields, goto } = require("./helpers");

let context, page, token, accountId, sample = {};

test.describe("Crunchyroll API contract", () => {
  test.beforeAll(async () => {
    context = await launch({ withExtension: false });
    page = await context.newPage();
    await goto(page, C.api.origin + "/watchlist");
    test.skip(!(await isLoggedIn(context)), "Not logged in: run `npm run login` first");
  });
  test.afterAll(async () => { await context?.close(); });

  test("token exchange with the public web client id", async () => {
    const r = await getToken(page);
    expect(r.status, "POST /auth/v1/token status").toBe(200);
    expect(missingFields(r.json, C.api.token.fields), "token fields").toEqual([]);
    token = r.json.access_token; accountId = r.json.account_id;
  });

  test("watchlist: paging fields and panel/episode_metadata shape", async () => {
    const r = await apiGet(page, token, `${C.api.watchlist.path(accountId)}?${C.api.watchlist.query}`);
    expect(r.status).toBe(200);
    expect(missingFields(r.json, C.api.watchlist.fields)).toEqual([]);
    expect(Array.isArray(r.json.data)).toBe(true);
    test.skip(r.json.data.length === 0, "Watchlist is empty; add a show to test further");
    const item = r.json.data[0];
    expect(missingFields(item, C.api.watchlist.itemFields), "watchlist item").toEqual([]);
    expect(missingFields(item.panel, C.api.watchlist.panelFields), "panel").toEqual([]);
    expect(missingFields(item.panel.episode_metadata, C.api.watchlist.episodeMetadataFields), "episode_metadata").toEqual([]);
    expect(Array.isArray(item.panel.images?.thumbnail?.[0]), "panel.images.thumbnail[0] is an array of sizes").toBe(true);
    sample.seriesId = item.panel.episode_metadata.series_id;
  });

  test("seasons: versions carry an original-audio guid", async () => {
    const r = await apiGet(page, token, `${C.api.seasons.path(sample.seriesId)}?${C.api.seasons.query}`);
    expect(r.status).toBe(200);
    expect(missingFields(r.json, C.api.seasons.fields)).toEqual([]);
    expect(r.json.data.length).toBeGreaterThan(0);
    for (const s of r.json.data) expect(missingFields(s, C.api.seasons.itemFields), `season ${s.id}`).toEqual([]);
    const withVersions = r.json.data.find((s) => Array.isArray(s.versions) && s.versions.length);
    expect(withVersions, "at least one season lists audio versions").toBeTruthy();
    for (const v of withVersions.versions) expect(missingFields(v, C.api.seasons.versionFields), "version").toEqual([]);
    expect(withVersions.versions.some((v) => v.original === true), "one version flagged original").toBe(true);
    sample.seasonId = (withVersions.versions.find((v) => v.original) || withVersions.versions[0]).guid;
  });

  test("episodes: preferred_audio_language returns that language's version ids and dates", async () => {
    const ja = await apiGet(page, token, `${C.api.episodes.path(sample.seasonId)}?${C.api.episodes.query("ja-JP")}`);
    expect(ja.status).toBe(200);
    expect(ja.json.data.length).toBeGreaterThan(0);
    const e = ja.json.data[0];
    expect(missingFields(e, C.api.episodes.itemFields), "episode fields").toEqual([]);
    expect(typeof e.identifier, "identifier is a string shared across audio versions").toBe("string");
    expect(e.identifier).not.toMatch(/(ENUS|JAJP)$/); // must not encode the audio version
    expect(Date.parse(e.episode_air_date), "episode_air_date parses").not.toBeNaN();
    expect(Date.parse(e.premium_available_date), "premium_available_date parses").not.toBeNaN();
    expect(typeof e.duration_ms).toBe("number");
    expect(Array.isArray(e.versions) && e.versions.length > 0, "episode.versions lists audio versions").toBe(true);
    // Asking for a different audio must give a different id for the same identifier when that dub exists.
    const en = await apiGet(page, token, `${C.api.episodes.path(sample.seasonId)}?${C.api.episodes.query("en-US")}`);
    expect(en.status).toBe(200);
    const enE = en.json.data.find((x) => x.identifier === e.identifier);
    expect(enE, "same identifier present in the en-US listing").toBeTruthy();
    if (e.versions.some((v) => v.audio_locale === "en-US")) expect(enE.audio_locale).toBe("en-US");
    sample.ids = [e.id, enE.id].filter(Boolean);
  });

  test("playheads: batch lookup by content_ids", async () => {
    const r = await apiGet(page, token, `${C.api.playheads.path(accountId)}?${C.api.playheads.query(sample.ids)}`);
    expect(r.status).toBe(200);
    expect(missingFields(r.json, C.api.playheads.fields)).toEqual([]);
    expect(Array.isArray(r.json.data)).toBe(true);
    for (const p of r.json.data) expect(missingFields(p, C.api.playheads.itemFields), "playhead").toEqual([]);
    // A batch of the configured size must be accepted (URL length / server cap).
    const many = Array.from({ length: C.api.playheads.batchSize }, (_, i) => `G${String(i).padStart(8, "0")}`);
    const big = await apiGet(page, token, `${C.api.playheads.path(accountId)}?${C.api.playheads.query(many)}`);
    expect(big.status, `playheads accepts ${C.api.playheads.batchSize} ids`).toBe(200);
  });
});
