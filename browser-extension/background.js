// Haul Download Manager browser extension.
//
// 1. Automatic capture: when the browser starts a download, it is paused at once, handed to the Haul
//    desktop app through native messaging, and then removed from the browser. If Haul cannot be
//    reached (not installed, or the host is not registered yet), the browser download simply resumes.
// 2. Right-click menu: "Download with Haul" on links and media opens the link in Haul for review.
//
// Haul starts by itself when it is not running. Nothing is sent anywhere except to the Haul program
// on this PC.
const HOST = 'io.github.hauldm.app';
const MENU_ID = 'haul-download';

const DEFAULTS = {
  capture: true,
  // File types taken over from the browser. Everything else (web pages, small images…) stays with the browser.
  extensions:
    'zip rar 7z tar gz tgz bz2 xz zst iso cab img exe msi msix msixbundle appx apk jar dmg deb rpm ' +
    'mp4 mkv avi mov wmv flv webm m4v mpg mpeg ts 3gp mp3 m4a flac wav aac ogg opus wma pdf epub ' +
    'doc docx xls xlsx ppt pptx odt ods odp psd ai dwg bin dat vhd vhdx ova ovf torrent',
  // Also take over any file larger than this (MB), whatever its type. 0 = only the listed types.
  minSizeMb: 20,
  allTypes: false,
};

async function settings() {
  const stored = await chrome.storage.sync.get(DEFAULTS).catch(() => ({}));
  return { ...DEFAULTS, ...stored };
}

function sendToHaul(message) {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendNativeMessage(HOST, message, (reply) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else if (!reply || reply.ok !== true) reject(new Error((reply && reply.error) || 'Haul did not accept the download.'));
        else resolve(reply);
      });
    } catch (e) {
      reject(e);
    }
  });
}

function extensionOf(name) {
  const m = /\.([a-z0-9]{1,12})$/i.exec(name || '');
  return m ? m[1].toLowerCase() : '';
}

function fileNameOf(item) {
  const fromPath = (item.filename || '').split(/[\\/]/).pop();
  if (fromPath) return fromPath;
  try {
    const u = new URL(item.finalUrl || item.url);
    return decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '');
  } catch {
    return '';
  }
}

async function shouldCapture(item) {
  const s = await settings();
  if (!s.capture) return false;
  if (!/^https?:/i.test(item.finalUrl || item.url)) return false; // blob:, data:, file: stay with the browser
  if (item.byExtensionId) return false; // another extension's download
  if (s.allTypes) return true;
  const ext = extensionOf(fileNameOf(item));
  const wanted = new Set(String(s.extensions).toLowerCase().split(/[\s,]+/).filter(Boolean));
  if (wanted.has(ext)) return true;
  const size = item.totalBytes > 0 ? item.totalBytes : item.fileSize;
  return s.minSizeMb > 0 && size > 0 && size >= s.minSizeMb * 1024 * 1024;
}

const handled = new Set();

// The download has just started: the browser knows the URL, often the size, and sometimes the name.
chrome.downloads.onCreated.addListener((item) => void capture(item));

// Fires once the browser has decided the file name; a download created a moment ago gets a better name here.
if (chrome.downloads.onDeterminingFilename) {
  chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
    suggest();
    if (!handled.has(item.id)) void capture(item);
  });
}

async function capture(item) {
  if (handled.has(item.id)) return;
  if (!(await shouldCapture(item))) return;
  handled.add(item.id);
  // Stop the browser's own transfer right away, but keep it so it can go on if Haul is not there.
  let paused = false;
  try {
    await chrome.downloads.pause(item.id);
    paused = true;
  } catch {
    /* already finished or cannot be paused: still offer it to Haul */
  }
  try {
    await sendToHaul({ type: 'add', url: item.finalUrl || item.url, fileName: fileNameOf(item), referrer: item.referrer || '', auto: true });
  } catch (e) {
    console.warn('Haul not reachable, the browser keeps the download:', e.message);
    if (paused) await chrome.downloads.resume(item.id).catch(() => {});
    return;
  }
  // Haul has it: drop the browser's copy (cancel removes its partial file; erase removes the list entry).
  await chrome.downloads.cancel(item.id).catch(() => {});
  await chrome.downloads.erase({ id: item.id }).catch(() => {});
}

// ------------------------------------------------------------------ right-click menu

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: MENU_ID, title: 'Download with Haul', contexts: ['link', 'image', 'video', 'audio'] });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_ID) return;
  const target = info.linkUrl || info.srcUrl;
  if (!target || !/^https?:\/\//i.test(target)) return; // the app only accepts http(s) links
  try {
    // Through the host when it is registered (no browser prompt); Haul shows the link for review.
    await sendToHaul({ type: 'add', url: target, referrer: info.pageUrl || '', auto: false });
  } catch {
    // Otherwise the haul:// link: the browser asks once whether to open Haul.
    const deepLink = `haul://add?url=${encodeURIComponent(target)}`;
    if (tab && tab.id !== undefined) chrome.tabs.update(tab.id, { url: deepLink });
    else chrome.tabs.create({ url: deepLink });
  }
});

// The options page asks whether Haul can be reached.
chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  if (msg && msg.type === 'ping') {
    sendToHaul({ type: 'ping' }).then(
      (reply) => respond({ ok: true, version: reply.version }),
      (e) => respond({ ok: false, error: e.message }),
    );
    return true;
  }
  return false;
});
