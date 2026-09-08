// @ts-check
// DOM contract: the selectors the extension hooks still exist on the live pages.
// Tests tagged @public run without login. A well-known, long-running series is used as the fixture.
const { test, expect } = require("@playwright/test");
const { CONTRACT: C, launch, isLoggedIn, hideConsentBanner, goto } = require("./helpers");

const SERIES_URL = "https://www.crunchyroll.com/series/GYZJ43JMR/that-time-i-got-reincarnated-as-a-slime";
const EPISODE_ID = "GE00374367ENUS"; // Slime S4 E3 (English audio)

let context, page;

test.describe("Crunchyroll DOM contract", () => {
  test.beforeAll(async () => {
    context = await launch({ withExtension: false });
    page = await context.newPage();
  });
  test.afterAll(async () => { await context?.close(); });

  test("series page: season selector, trigger, listbox, options and title spans @public", async () => {
    await goto(page, SERIES_URL);
    await hideConsentBanner(page);
    const sel = C.dom.seasonSelect;
    await expect(page.locator(sel.root).first(), sel.root).toBeVisible();
    await page.locator(sel.trigger).first().click();
    const listbox = page.locator(sel.listbox).first();
    await expect(listbox, sel.listbox).toBeVisible();
    const options = listbox.locator(sel.option);
    expect(await options.count(), "season options").toBeGreaterThan(1);
    const firstTitle = options.first().locator(sel.optionTitle);
    await expect(firstTitle, sel.optionTitle).toHaveText(/\S/);
    // Options must share one parent so a reorder is a sibling move.
    const parents = await options.evaluateAll((els) => new Set(els.map((e) => e.parentElement)).size);
    expect(parents, "all options under one parent").toBe(1);
    // Titles must match the API's season titles (same wording), otherwise reordering cannot map them.
    const titles = await options.locator(sel.optionTitle).allTextContents();
    expect(titles.map((t) => t.trim())).toContain("Season 1");
  });

  test("watch page: series link, See More Episodes button, season selector inside the panel @public", async () => {
    await goto(page, `https://www.crunchyroll.com/watch/${EPISODE_ID}/`);
    await hideConsentBanner(page);
    await expect(page.locator(C.dom.seriesLink).first(), C.dom.seriesLink).toHaveAttribute("href", C.dom.seriesIdFromHref);
    const seeMore = page.locator(C.dom.seeMoreEpisodes.selector, { hasText: C.dom.seeMoreEpisodes.text }).first();
    await expect(seeMore, "See More Episodes button").toBeVisible();
    await seeMore.click();
    await page.locator(C.dom.seasonSelect.trigger).first().click();
    const options = page.locator(C.dom.seasonSelect.listbox).first().locator(C.dom.seasonSelect.option);
    expect(await options.count(), "season options in the episode panel").toBeGreaterThan(1);
  });

  test("watch page: player iframe is on the expected host (login required to stream)", async () => {
    test.skip(!process.env.CRWP_PLAYER, "Player tests are opt-in (CRWP_PLAYER=1): Crunchyroll does not mount the player under automation in most environments");
    test.skip(!(await isLoggedIn(context)), "Not logged in: run `npm run login` first");
    await goto(page, `https://www.crunchyroll.com/watch/${EPISODE_ID}/`);
    await page.bringToFront();
    const frame = await page.waitForFunction(
      (host) => [...document.querySelectorAll("iframe")].some((f) => f.src.includes(host)),
      C.dom.player.frameHost, { timeout: 30_000 }
    ).then(() => page.frames().find((f) => f.url().includes(C.dom.player.frameHost)));
    expect(frame, `iframe on ${C.dom.player.frameHost}`).toBeTruthy();
  });

  test("player: a skip button with the expected markup appears when seeking into a marked segment", async () => {
    test.skip(!process.env.CRWP_PLAYER, "Player tests are opt-in (CRWP_PLAYER=1)");
    test.skip(!(await isLoggedIn(context)), "Not logged in: run `npm run login` first");
    // Find an episode of the fixture series that has skip events, from the public skip-events JSON.
    // Fetched from Node: the static host does not send CORS headers to www.crunchyroll.com pages.
    const evRes = await page.request.get(C.dom.player.skipEvents(EPISODE_ID));
    const ev = evRes.ok() ? await evRes.json() : null;
    const seg = ev && (ev.intro || ev.credits || ev.recap);
    test.skip(!seg, `no skip events published for ${EPISODE_ID}; pick another fixture episode`);
    await goto(page, `https://www.crunchyroll.com/watch/${EPISODE_ID}/`);
    await page.bringToFront();
    await page.waitForFunction((host) => [...document.querySelectorAll("iframe")].some((f) => f.src.includes(host)), C.dom.player.frameHost, { timeout: 30_000 });
    const frame = page.frames().find((f) => f.url().includes(C.dom.player.frameHost));
    const video = frame.locator("video").first();
    await expect(video).toBeAttached({ timeout: 30_000 });
    // Start playback (may need a click on the player) and seek into the segment.
    await frame.locator("body").click({ position: { x: 300, y: 200 } }).catch(() => {});
    await video.evaluate((v, t) => { v.currentTime = t + 2; return v.play().catch(() => {}); }, seg.start);
    const skip = frame.locator(C.dom.player.skipCandidates).first();
    await expect(skip, `skip element matching ${C.dom.player.skipCandidates}`).toBeVisible({ timeout: 20_000 });
    const btn = skip.locator(`xpath=ancestor-or-self::*[self::button or @role="button"][1]`);
    await expect(btn, "enclosing clickable button").toHaveCount(1);
    await expect(btn).toHaveText(/skip/i);
    await video.evaluate((v) => v.pause());
  });
});
