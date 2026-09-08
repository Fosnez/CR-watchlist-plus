# Better Watchlist for Crunchyroll

A small, unpacked Chrome extension that re-sorts your Crunchyroll watchlist the way it should have been sorted in the first place:

**newest episode you have not watched yet, first.**
The English release date is used when an English dub of that episode exists, otherwise the Japanese release date.

Because watched status is checked per language version, an episode you already finished in Japanese does not resurface when its English dub lands months later. Shows with nothing left to watch drop to a greyed "Caught up" section, which you can hide.

Everything runs inside your browser, in your existing logged-in session. No server, no stored password. The only network traffic is to crunchyroll.com, using the same internal endpoints the site's own page uses.

## Install (unpacked)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick this folder.
4. Go to <https://www.crunchyroll.com/watchlist>. An orange **Better Watchlist** button appears bottom-right. Click it.
   You can also click the extension's toolbar icon, which opens the watchlist with the overlay already open.

The first load fetches every season of every show (a few hundred small requests, typically 10 to 30 seconds). Episode lists are cached for 12 hours in extension storage, so later opens take a couple of seconds: only the watchlist and your playheads are re-read.

## Controls

- **Watched at N%** slider (default 75). An episode counts as watched once its playhead passes this share of the runtime, or is within five minutes of the end. Crunchyroll only sets its own completed flag if you sit through the ending theme, so credits-skippers otherwise see finished episodes resurface.
- **Assume earlier episodes watched** (on by default). Everything released before the last episode you actually watched in a series is treated as watched. This covers history Crunchyroll never recorded, such as pre-merger Funimation viewing, and old OVAs or movies you skipped. Instalments (seasons, movies, OVA collections) are ordered by the original air date of their first episode, with Crunchyroll's episode sequence kept inside each. Crunchyroll's own catalogue order is editorial and often appends OVAs and movies after the main run.
- **Hide caught-up** hides the greyed section.
- **Refresh** re-reads your watchlist and playheads, reusing cached episode lists.
- **Full reload** throws the cache away and refetches everything. Use it if a newly released episode is not showing up within 12 hours.

Each card links straight to the episode it names, in the language shown on the badge. Episode labels use Crunchyroll's instalment title ("S2 E9", "Operation Desert Pasta", "OVA Season 1 E3"), not its internal season counter, which numbers movies and OVAs as seasons.

## How the ranking works

For each show, for each episode:

1. Collect the Japanese and English versions (their ids and release dates).
2. Arrival date = English release if an English version exists, else Japanese.
3. The episode is *watched* if **either** version is fully watched in your playheads, **or** its playhead is past the slider threshold (default 75%) or within five minutes of the end.
4. With the high-water rule on, every episode that precedes the last watched one is also treated as watched. Precedence = instalment air-date order, then episode sequence.

Settings re-rank instantly from cached data; no refetch.

A show's sort key is the latest arrival date among its unwatched, already-released episodes. Shows with no unwatched episodes are ranked by their latest arrival overall and shown in the "Caught up" section.

Change the language preference in `content.js` (`PREFERRED`) if you want, say, Japanese first.

## Known limits

- Unofficial API. Crunchyroll can change endpoints or the web client id at any time. If the overlay shows "Token exchange failed", the client id constant `WEB_CLIENT_BASIC` in `content.js` is the first thing to check against what the site sends to `/auth/v1/token`.
- Very old catalogue entries where the dub is a separate "season" without version links are treated as separate seasons, so the watched-in-Japanese suppression does not apply to them.
- Chrome only for now (Manifest V3). Firefox would need a `browser_specific_settings` block and a background script instead of a service worker.
