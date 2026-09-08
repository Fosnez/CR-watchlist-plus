// Toolbar button: open (or focus) the Crunchyroll watchlist with the
// Better Watchlist overlay requested via the URL hash.
const TARGET = "https://www.crunchyroll.com/watchlist#better-watchlist";

chrome.action.onClicked.addListener(async () => {
  const tabs = await chrome.tabs.query({ url: "https://www.crunchyroll.com/watchlist*" });
  if (tabs.length) {
    await chrome.tabs.update(tabs[0].id, { active: true, url: TARGET });
    await chrome.windows.update(tabs[0].windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: TARGET });
  }
});
