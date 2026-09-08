// Toolbar button: show the overlay on an open watchlist tab, or open one.
const WATCHLIST = "https://www.crunchyroll.com/watchlist";
const OPEN_URL = WATCHLIST + "#cr-watchlist-plus";

chrome.action.onClicked.addListener(async () => {
  const tabs = await chrome.tabs.query({ url: WATCHLIST + "*" });
  const tab = tabs[0];
  if (!tab || tab.id === undefined) {
    await chrome.tabs.create({ url: OPEN_URL });
    return;
  }
  await chrome.tabs.update(tab.id, { active: true });
  if (tab.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
  try {
    // Ask the content script directly; a same-URL navigation would be a no-op.
    const res = await chrome.tabs.sendMessage(tab.id, { type: "open" });
    if (res && res.ok) return;
  } catch {
    // no content script in that tab (e.g. loaded before install): fall through
  }
  await chrome.tabs.update(tab.id, { url: OPEN_URL });
});
