// @ts-check
// End-to-end smoke test of the unpacked extension against the live site. Needs a logged-in profile.
const { test, expect } = require("@playwright/test");
const { launch, isLoggedIn, hideConsentBanner, goto } = require("./helpers");

const SERIES_URL = "https://www.crunchyroll.com/series/GYZJ43JMR/that-time-i-got-reincarnated-as-a-slime";

let context, page;

test.describe("CR Watchlist Plus end to end", () => {
  test.beforeAll(async () => {
    context = await launch({ withExtension: true });
    page = await context.newPage();
    await goto(page, "https://www.crunchyroll.com/watchlist");
    test.skip(!(await isLoggedIn(context)), "Not logged in: run `npm run login` first");
    await hideConsentBanner(page);
  });
  test.afterAll(async () => { await context?.close(); });

  test("launcher mounts on the watchlist and the overlay loads real data", async () => {
    const toggle = page.locator("#bwl-toggle");
    const mounted = await toggle.waitFor({ state: "visible", timeout: 20_000 }).then(() => true, () => false);
    test.skip(!mounted, "Extension did not load: branded Chrome 137+ ignores --load-extension. Use CRWP_BROWSER=chromium, or run tests/inpage/contract-check.js in your real browser.");
    await toggle.click();
    await expect(page.locator("#bwl-root")).toBeVisible();
    await expect(toggle, "launch button hidden while overlay is open").toBeHidden();
    await expect(page.locator(".bwl-status"), "load completes").toHaveText(/\d+ shows · updated .* · loaded in/, { timeout: 90_000 });
    const failed = await page.locator(".bwl-log-line.bwl-log-fail").count();
    expect(failed, "no FAILED lines in the activity log").toBe(0);
    await expect(page.locator(".bwl-section-title").first()).toHaveText(/New for you \(\d+\)/);
    expect(await page.locator(".bwl-card").count(), "cards rendered").toBeGreaterThan(0);
    // Every active card names an episode, a language badge and a date.
    const first = page.locator(".bwl-grid").first().locator(".bwl-card").first();
    await expect(first.locator(".bwl-title")).toHaveText(/\S/);
    await expect(first.locator(".bwl-ep-title")).toHaveText(/\S/);
    await expect(first.locator(".bwl-badge").first()).toBeAttached();
    await expect(first.locator(".bwl-line")).toHaveText(/(Next|Continue): .* · (EN|JA|[A-Z]{2}) · /);
  });

  test("settings dialog opens, saves to the cookie, and re-ranks", async () => {
    await page.locator(".bwl-bar button", { hasText: "Settings" }).click();
    const modal = page.locator(".bwl-modal");
    await expect(modal).toBeVisible();
    await expect(modal.locator("h3")).toHaveText(["Watchlist", "Audio languages", "Player"]);
    const hideDone = modal.locator(".bwl-setting", { hasText: "Hide caught-up shows" }).locator("input[type=checkbox]");
    const wasChecked = await hideDone.isChecked();
    await hideDone.click();
    await modal.locator("button", { hasText: "Save" }).click();
    await expect(modal).toBeHidden();
    const cookies = await context.cookies("https://www.crunchyroll.com");
    const prefs = JSON.parse(decodeURIComponent(cookies.find((c) => c.name === "cr_watchlist_plus_prefs").value));
    expect(prefs.hideDone).toBe(!wasChecked);
    expect(cookies.find((c) => c.name === "cr_watchlist_plus_prefs").domain, "cookie shared with player subdomain").toBe(".crunchyroll.com");
    // Put it back.
    await page.locator(".bwl-bar button", { hasText: "Settings" }).click();
    await modal.locator(".bwl-setting", { hasText: "Hide caught-up shows" }).locator("input[type=checkbox]").click();
    await modal.locator("button", { hasText: "Save" }).click();
  });

  test("Normal Watchlist closes the overlay and clears the active flag", async () => {
    await page.locator(".bwl-bar button", { hasText: "Normal Watchlist" }).click();
    await expect(page.locator("#bwl-root")).toBeHidden();
    await expect(page.locator("#bwl-toggle")).toBeVisible();
    const cookies = await context.cookies("https://www.crunchyroll.com");
    expect(cookies.find((c) => c.name === "cr_watchlist_plus_active"), "active flag removed").toBeUndefined();
  });

  test("series page: native season dropdown is reordered by air date with date prefixes", async () => {
    await goto(page, SERIES_URL);
    await hideConsentBanner(page);
    await page.locator(".erc-seasons-select [role=button]").first().click();
    const titles = page.locator('.erc-seasons-select [role="listbox"] [role="option"] [class*="option__text--"]');
    await expect(titles.first(), "date prefix applied").toHaveText(/^\d{4}-\d{2}-\d{2} · /, { timeout: 30_000 });
    const texts = (await titles.allTextContents()).map((t) => t.trim());
    const dates = texts.map((t) => t.slice(0, 10));
    expect([...dates].sort(), "options are in ascending date order").toEqual(dates);
    expect(texts.find((t) => /OVA Season 1/.test(t)), "OVA Season 1 present").toBeTruthy();
    expect(texts.indexOf(texts.find((t) => /OVA Season 1/.test(t)))).toBeLessThan(texts.indexOf(texts.find((t) => /· Season 2$/.test(t))));
  });
});
