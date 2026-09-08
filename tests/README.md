# Contract tests

These tests pin down every assumption CR Watchlist Plus makes about Crunchyroll and check them against the **live site**, so that when Crunchyroll changes its API or markup, a failing check names the exact thing that moved. They are for development only; nothing in this folder is used by the extension at runtime.

The assumptions themselves live in one file at the repo root, [`contract.js`](../contract.js), which the content script reads at runtime and both runners below import. Fix a contract change there and the extension and the tests follow together.

There are two runners, because Crunchyroll treats automated browsers with suspicion:

| Runner | Where it runs | Good for | Cannot do |
|---|---|---|---|
| **Playwright suite** (`*.spec.js`) | A separate Chrome profile launched by Playwright | Repeatable API and page-markup checks; CI-style pass/fail | Load the unpacked extension in branded Chrome 137+; mount the video player (Crunchyroll refuses under automation) |
| **In-page checker** (`inpage/contract-check.js`) | Your real, logged-in browser with the extension installed | Everything, including the installed extension and the player page, with your real fingerprint | Run unattended |

## Be gentle with the site

Every site call in both runners is **paced: one call per 10 seconds by default**. Running the suite repeatedly in quick succession earned a 403 on the token endpoint during development; that is bot protection, not a contract break, and it clears after a while. Override the interval only when you know what you are doing:

```bash
CRWP_MIN_INTERVAL_MS=3000 npx playwright test      # Playwright suite
await crwpContractCheck({ minIntervalMs: 3000 })     # in-page checker
```

A full Playwright run is roughly 20 paced calls, so expect about four minutes. Run it when you suspect a change, not on every save.

## Playwright suite

One-time setup:

```bash
cd tests
npm install
npm run login        # opens a browser: log in to Crunchyroll once; the session is kept in tests/.profile
```

`tests/.profile` is git-ignored and never committed. It holds a real Crunchyroll session, so treat it like a password and delete it if you hand the machine over.

Running:

```bash
npm test                    # API + DOM contracts (needs the login above); extension tests skip under branded Chrome
npm run test:public         # only the tests that need no login (series/watch page markup)
CRWP_PLAYER=1 npm test      # also try the player tests (usually skipped: see limits)
CRWP_BROWSER=chromium npm test   # Playwright's own Chromium, which does honour --load-extension
```

Tests run headed, one at a time, using your installed Google Chrome by default.

| File | Checks |
|---|---|
| `api.spec.js` | Token exchange with the public web client id; watchlist paging and panel shape; seasons with audio `versions` and an `original` flag; episodes carry `identifier`, air and availability dates, `duration_ms`, and `preferred_audio_language` selects the version; playheads batch lookup accepts the configured batch size. |
| `dom.spec.js` | Series page season selector (root, trigger, listbox, options, title spans, options share one parent, titles match API wording); watch page series link and "See More Episodes" panel; opt-in: player iframe host, and a skip button with the expected markup when seeking into a published intro/credits segment. |
| `extension.spec.js` | The extension itself, when the browser loads it: launcher mounts, overlay loads real data with no failed items, cards carry title/episode/badge/date, settings save to the `.crunchyroll.com` cookie and re-rank, Normal Watchlist clears the active flag, the native season dropdown is reordered with date prefixes. |

## In-page checker

`inpage/contract-check.js` is a single self-contained script (built from `contract.js` plus `inpage/checker.src.js`; rebuild with `npm run build:inpage` after editing either). Run it in your everyday browser, where the extension is installed and you are logged in:

1. Open a Crunchyroll page. Which page decides which DOM checks run: a `/series/…` page checks the season dropdown (and whether the extension reordered it with date prefixes), a `/watch/…` page checks the episode panel and the player frame, `/watchlist` checks that the launcher mounted. API checks run on any page.
2. DevTools → Console, paste the file's contents, then run `await crwpContractCheck()`.
3. Read the PASS / FAIL / SKIP lines and the summary table. FAIL lines name the contract entry and what was seen.

Claude for Chrome (or any tool that can execute JavaScript in your tab) can run the same script for you; that is how it was verified during development.

## When a check fails

1. Read the message: it names the selector or field from `contract.js`.
2. If it is a 403 on the token exchange, wait and retry before assuming anything: that is rate limiting.
3. Open the live page in DevTools, find the new selector or field.
4. Update `contract.js` (and, if the shape changed rather than the name, the code that consumes it), run `npm run build:inpage`, re-run.
5. Commit the contract change with a note of what Crunchyroll changed.

## Limits

- **Extension loading in Playwright.** Google Chrome 137 and later ignore `--load-extension`, so `extension.spec.js` skips under the default browser. Playwright's own Chromium honours it (`CRWP_BROWSER=chromium`), but that build failed to start on the development machine (a side-by-side configuration error), so the extension's end-to-end behaviour was verified with the in-page checker and by hand instead.
- **The player.** Crunchyroll does not mount the video player in automated or hidden tabs, so the player tests are opt-in and expected to skip in most environments. The in-page checker on a real `/watch/` page covers the same checks.
- **Fixtures.** The DOM tests use *That Time I Got Reincarnated as a Slime* because it has numbered seasons and OVA collections. If it leaves the catalogue, change `SERIES_URL` and `EPISODE_ID` in `dom.spec.js` and `extension.spec.js`.
