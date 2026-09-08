// @ts-check
// Shared launcher: a persistent Chromium profile (so you log in once) with the
// unpacked extension loaded from the repo root. All page loads and API calls go
// through pace(), which keeps at least CRWP_MIN_INTERVAL_MS between calls to the
// site (default 10 s) so a test run never looks like a scraper.
const path = require("path");
const fs = require("fs");
const { chromium } = require("@playwright/test");

const ROOT = path.resolve(__dirname, "..");
const PROFILE = path.join(__dirname, ".profile");
const CONTRACT = require(path.join(ROOT, "contract.js"));

// ------------------------------------------------------------------ pacing
const MIN_INTERVAL_MS = Number(process.env.CRWP_MIN_INTERVAL_MS ?? 10_000);
let lastCall = 0;
let queue = Promise.resolve();
/** Wait until at least MIN_INTERVAL_MS has passed since the previous site call. Serialised across callers. */
function pace(label = "") {
  const run = async () => {
    const wait = Math.max(0, lastCall + MIN_INTERVAL_MS - Date.now());
    if (wait > 0) { if (process.env.CRWP_VERBOSE) console.log(`  pacing ${Math.round(wait / 1000)}s before ${label}`); await new Promise((r) => setTimeout(r, wait)); }
    lastCall = Date.now();
  };
  queue = queue.then(run, run);
  return queue;
}

/** Paced navigation. Use this instead of page.goto in specs. */
async function goto(page, url, opts = { waitUntil: "domcontentloaded" }) {
  await pace(`goto ${url}`);
  return page.goto(url, opts);
}

// ---------------------------------------------------------------- browser
/** Launch a browser with the extension. `withExtension:false` gives a plain browser for pure-site checks. */
async function launch({ withExtension = true, headless = false } = {}) {
  fs.mkdirSync(PROFILE, { recursive: true });
  const args = ["--no-first-run", "--no-default-browser-check"];
  if (withExtension) args.push(`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`);
  // Installed Google Chrome by default (set CRWP_BROWSER=chromium|msedge to change).
  // Note: branded Chrome 137+ ignores --load-extension; the extension.spec tests
  // detect that and skip. Playwright's own Chromium (CRWP_BROWSER=chromium) honours it.
  const context = await chromium.launchPersistentContext(PROFILE, {
    headless,
    channel: process.env.CRWP_BROWSER || "chrome",
    args,
    viewport: { width: 1440, height: 900 },
    ignoreDefaultArgs: ["--disable-extensions"],
  });
  return context;
}

/** True when the profile carries a Crunchyroll session (etp_rt cookie). */
async function isLoggedIn(context) {
  const cookies = await context.cookies("https://www.crunchyroll.com");
  return cookies.some((c) => c.name === "etp_rt");
}

// -------------------------------------------------------------------- API
/** Exchange the session cookie for a bearer token, exactly as the extension does. Returns { status, json }. */
async function getToken(page) {
  await pace("token");
  return page.evaluate(async (t) => {
    const r = await fetch(t.path, {
      method: "POST",
      credentials: "include",
      headers: { Authorization: "Basic " + t.basic, "Content-Type": "application/x-www-form-urlencoded" },
      body: `grant_type=${t.grant}&device_type=Chrome&device_id=00000000-0000-4000-8000-000000000000`,
    });
    return { status: r.status, json: r.ok ? await r.json() : null };
  }, CONTRACT.api.token);
}

/** Paced GET of a Crunchyroll API path from inside the page with a bearer token. */
async function apiGet(page, token, pathWithQuery) {
  await pace(pathWithQuery.split("?")[0]);
  return page.evaluate(async ({ p, tok }) => {
    const r = await fetch(p, { headers: { Authorization: "Bearer " + tok } });
    return { status: r.status, json: r.ok ? await r.json() : null };
  }, { p: pathWithQuery, tok: token });
}

/** Returns the named fields that are missing (undefined) on an object. */
function missingFields(obj, fields) {
  return fields.filter((f) => obj === null || obj === undefined || obj[f] === undefined);
}

/** Hide Crunchyroll's cookie banner overlay (no consent is given or declined; it is only hidden). */
async function hideConsentBanner(page) {
  await page.addStyleTag({ content: '#onetrust-consent-sdk, [class*="cookie" i], [id*="onetrust" i] { display: none !important; }' }).catch(() => {});
}

module.exports = { ROOT, PROFILE, CONTRACT, MIN_INTERVAL_MS, pace, goto, launch, isLoggedIn, getToken, apiGet, missingFields, hideConsentBanner };
