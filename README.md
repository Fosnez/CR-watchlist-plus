# CR Watchlist Plus

A small Chrome extension that gives your Crunchyroll watchlist the one sort order it should have shipped with:

> **The show with the newest episode you haven't watched yet comes first.**

English release dates are used when an English dub of that episode exists, Japanese otherwise. Episodes you already finished in either language stay finished, so a dub arriving months after you watched the sub does not drag a show back to the top. Shows with nothing left to watch drop into a greyed "Caught up" section.

![The overlay on a real watchlist](docs/screenshot.png)

Everything runs inside your browser, in your existing Crunchyroll login. No server, no account details stored, no analytics. The only network traffic is to crunchyroll.com, using the same internal endpoints the site's own watchlist page calls.

---

## Why

Crunchyroll's "Recent Activity" sort bumps a show whenever *anything* about it changes. A German dub landing for a show you finished three years ago puts it above the series that aired a new episode yesterday. The other sorts (date added, alphabetical, date watched) do not help either. There is no server-side option for "newest episode", let alone "newest episode I haven't seen, in a language I watch".

## What it does

- Reads your watchlist, every season (and movie, and OVA collection) of every show, and every episode in both Japanese and English audio.
- Reads your playheads for **both** language versions of each episode, so an episode watched in Japanese counts as watched when the English dub arrives.
- Treats an episode as watched once you are past an adjustable share of its runtime (default 75%), because Crunchyroll only sets its own completed flag if you sit through the ending theme. Skipping the credits otherwise leaves finished episodes at 83 to 89% and they resurface as unwatched.
- Optionally assumes everything *before* the last episode you watched in a series is watched too (see below). This fills gaps such as pre-merger Funimation history that never reached Crunchyroll.
- Ranks shows by the newest unwatched episode's arrival date and renders its own grid over the watchlist page. Each card links to that exact episode in the language shown.
- Caches episode lists for 12 hours, so the first open takes 10 to 30 seconds and later opens a couple of seconds.

## Install (unpacked, Chrome or any Chromium browser)

1. Download this repository: **Code → Download ZIP**, then unzip it somewhere permanent. Or `git clone` it.
2. Open `chrome://extensions` in the address bar.
3. Turn on **Developer mode** (toggle, top right).
4. Click **Load unpacked** and choose the unzipped folder (the one containing `manifest.json`).
5. Go to <https://www.crunchyroll.com/watchlist>, logged in. An orange **Better Watchlist** button appears bottom-right. Click it.

You can also click the extension's toolbar icon, which opens the watchlist with the overlay already showing. Pin it via the puzzle-piece menu if you want it visible.

### Updating

Pull or re-download the folder, then on `chrome://extensions` click the reload arrow on the extension card. Cached data survives; if a change alters the cache format the first open simply refetches.

### Uninstall

Remove it from `chrome://extensions`. Nothing is left behind on Crunchyroll's side; the extension never writes to your account.

## Controls

| Control | What it does |
|---|---|
| **Watched at N%** slider | Threshold past which an episode counts as watched (50 to 100, default 75). Also counts an episode watched if within 5 minutes of the end, or if Crunchyroll's own flag is set. |
| **Assume earlier episodes watched** | The high-water rule, on by default. Everything before the last episode you actually watched in a series is treated as watched. Cards show how many episodes were inferred. |
| **Hide caught-up** | Hides the greyed section of shows with nothing left. |
| **Refresh** | Re-reads your watchlist and playheads, reusing cached episode lists. Use after watching something. |
| **Full reload** | Drops the cache and refetches everything. Use if a new episode has not shown up within 12 hours. |

Settings re-rank instantly from cached data. Changing the slider or toggle never triggers a refetch.

## How the ranking works

For each show:

1. Instalments (seasons, movies, OVA collections) are put in **chronological order by the original air date of their first episode**, with Crunchyroll's episode sequence kept inside each. Crunchyroll's own season order is editorial and often lists OVAs and movies after the main run.
2. For each episode, collect the Japanese and English versions with their ids and release dates. *Arrival date* is the English release if an English version exists, else the Japanese release.
3. An episode is **watched** if either version is fully watched, or either version's playhead is past the slider threshold or within five minutes of the end.
4. With the high-water rule on, every episode that precedes the last watched one (in the order from step 1) is also treated as watched.
5. The show's sort key is the latest arrival date among its unwatched, already-released episodes. Shows with none are ranked by their latest arrival overall and shown under "Caught up".

Card labels use Crunchyroll's instalment title ("S2 E9", "Operation Desert Pasta", "OVA Season 1 E3") rather than its internal season counter, which numbers movies and OVAs as seasons.

To prefer Japanese over English, change `PREFERRED` at the top of `content.js`.

## Known issues and edge cases

- **OVA collections spanning years.** An OVA "season" is placed by the air date of its *first* episode, but Crunchyroll often groups OVAs released over several years into one collection. A late OVA can therefore sit before a TV season that aired after it, and the high-water rule will infer it watched once you finish that season. Slime's "OVA Season 1" (2019 to 2020) is the live example. Per-episode ordering would fix this but breaks recap and special episodes that air out of sequence; the trade-off is left as is. Turn the high-water rule off if it bites.
- **The high-water rule is an inference.** It cannot tell "watched elsewhere or skipped on purpose" from "abandoned halfway". A movie you stopped at 51% before finishing the next season will be treated as watched. Cards show the inferred count so you can see when it has acted.
- **Messy instalment names.** Labels strip the series name and "(English Dub)" and recognise "Season 2", "Season2" and Roman numerals, but instalments whose title is only a year or a subtitle show that fragment, for example "2199 E1".
- **Legacy dub seasons.** Very old catalogue entries where the dub is a separate season with no version links are treated as separate instalments, so watched-in-Japanese suppression does not apply to them.
- **Unofficial API.** Crunchyroll can change endpoints or the web client id without notice. If the overlay shows "Token exchange failed", compare the `WEB_CLIENT_BASIC` constant in `content.js` with the Authorization header the site sends to `/auth/v1/token` (DevTools → Network).
- **Chrome only.** Manifest V3 with a service worker. Firefox would need a `browser_specific_settings` block and a background script.

## Files

| File | Purpose |
|---|---|
| `manifest.json` | Extension manifest (MV3). Content script on crunchyroll.com, storage permission, toolbar action. |
| `content.js` | Everything: token exchange, API calls, caching, ranking, UI. |
| `content.css` | Overlay styling. |
| `background.js` | Toolbar click → open or focus the watchlist with the overlay. |
| `docs/screenshot.png` | The image above. |

## Privacy

The extension reads your watchlist, episode metadata and playheads from crunchyroll.com and stores derived data in the extension's local storage on your machine. It sends nothing anywhere else and never modifies your Crunchyroll account.

## Licence

MIT. Not affiliated with or endorsed by Crunchyroll.
