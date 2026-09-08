/*
 * CR Watchlist Plus — the Crunchyroll contract.
 *
 * Every assumption this extension makes about Crunchyroll lives here: endpoint
 * paths, the response fields we read, and the DOM selectors we hook. The content
 * script reads it at runtime and the test suite in tests/ checks each entry
 * against the live site, so when Crunchyroll changes something the failing test
 * names the exact line to update.
 *
 * Loaded before content.js as a plain content script (shared global scope), and
 * required directly by the Playwright tests.
 */
(() => {
  "use strict";
  const CONTRACT = {
    // ---------------------------------------------------------------- API
    api: {
      origin: "https://www.crunchyroll.com",
      token: {
        path: "/auth/v1/token",
        grant: "etp_rt_cookie",
        // Crunchyroll's PUBLIC web-app client id ("noaihdevm_6iyg0a8l0q", empty secret).
        basic: "bm9haWhkZXZtXzZpeWcwYThsMHE6",
        fields: ["access_token", "expires_in", "account_id"],
      },
      watchlist: {
        path: (accountId) => `/content/v2/discover/${accountId}/watchlist`,
        query: "n=100&start=0&order=desc&locale=en-US",
        fields: ["total", "data"],
        itemFields: ["panel"],
        panelFields: ["id", "title", "images", "episode_metadata"],
        episodeMetadataFields: ["series_id", "series_title", "series_slug_title"],
      },
      seasons: {
        path: (seriesId) => `/content/v2/cms/series/${seriesId}/seasons`,
        query: "locale=en-US",
        fields: ["data"],
        itemFields: ["id", "title", "season_number", "audio_locale", "versions", "number_of_episodes"],
        versionFields: ["guid", "audio_locale", "original"],
      },
      episodes: {
        path: (seasonId) => `/content/v2/cms/seasons/${seasonId}/episodes`,
        query: (audio) => `locale=en-US&preferred_audio_language=${audio}`,
        fields: ["data"],
        itemFields: ["id", "identifier", "audio_locale", "episode_number", "sequence_number", "season_number", "title", "slug_title", "duration_ms", "images", "episode_air_date", "premium_available_date", "versions"],
      },
      playheads: {
        path: (accountId) => `/content/v2/${accountId}/playheads`,
        query: (ids) => `content_ids=${ids.join(",")}&locale=en-US`,
        batchSize: 80,
        fields: ["data"],
        itemFields: ["content_id", "playhead", "fully_watched"],
      },
    },

    // ---------------------------------------------------------------- DOM
    dom: {
      // Pages we mount the launcher on.
      listPagePath: /^\/(watchlist|crunchylists|history)\b/,
      // A link that reveals the series id on a watch page.
      seriesLink: 'a[href^="/series/"], a[href*="crunchyroll.com/series/"]',
      seriesIdFromHref: /\/series\/([A-Z0-9]+)/i,
      // The episode (version) id in a watch page URL; the same id the playheads endpoint uses.
      watchIdFromPath: /^\/watch\/([A-Z0-9]+)/i,
      // Shared season selector on series pages and in the player's episode panel.
      seasonSelect: {
        root: ".erc-seasons-select",
        trigger: '.erc-seasons-select [role="button"]',
        listbox: '.erc-seasons-select [role="listbox"]',
        option: '[role="option"]',
        optionTitle: '[class*="option__text--"]', // the inner title span; "option__text-wrapper" also exists
      },
      // Button on a watch page that reveals the episode panel (with the season selector).
      seeMoreEpisodes: { selector: "button", text: /see more episodes/i },
      // Player iframe origin and the skip buttons inside it.
      player: {
        frameHost: "static.crunchyroll.com",
        skipCandidates: '[data-testid*="skip" i], [aria-label*="skip" i]',
        skipButton: '[role="button"], button',
        // Public per-episode skip-event timings (not used by the extension; the
        // tests use it to seek into an intro and prove the button appears).
        skipEvents: (episodeId) => `https://static.crunchyroll.com/skip-events/production/${episodeId}.json`,
      },
    },
  };
  globalThis.CRWP_CONTRACT = CONTRACT;
  if (typeof module !== "undefined" && module.exports) module.exports = CONTRACT;
})();
