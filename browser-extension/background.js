// Adds "Download with Haul" to the context menu of links and media.
// The link is handed to the Haul desktop app through its haul:// URL scheme; the browser asks the
// user to allow opening the app, and Haul shows the link for review before anything downloads.
const MENU_ID = 'haul-download';

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: MENU_ID,
    title: 'Download with Haul',
    contexts: ['link', 'image', 'video', 'audio'],
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID) return;
  const target = info.linkUrl || info.srcUrl;
  if (!target || !/^https?:\/\//i.test(target)) return; // the app only accepts http(s) links
  const deepLink = `haul://add?url=${encodeURIComponent(target)}`;
  // Navigating a tab to an external protocol launches the handler without leaving the page.
  if (tab && tab.id !== undefined) chrome.tabs.update(tab.id, { url: deepLink });
  else chrome.tabs.create({ url: deepLink });
});
