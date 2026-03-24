const HOST_NAME = 'com.eerie.net_reaper';

let enabled = true;
let port = null;

// Load saved state
chrome.storage.local.get('enabled', (data) => {
  if (data.enabled !== undefined) enabled = data.enabled;
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.enabled) enabled = changes.enabled.newValue;
});

// Connect to native messaging host
function connectHost() {
  try {
    port = chrome.runtime.connectNative(HOST_NAME);

    port.onMessage.addListener((msg) => {
      console.log('[Net Reaper] Host response:', msg);
    });

    port.onDisconnect.addListener(() => {
      console.log('[Net Reaper] Host disconnected');
      port = null;
    });
  } catch (e) {
    console.warn('[Net Reaper] Could not connect to native host:', e);
    port = null;
  }
}

// Intercept downloads
chrome.downloads.onCreated.addListener((downloadItem) => {
  if (!enabled) return;
  if (!downloadItem.url || downloadItem.url.startsWith('blob:') || downloadItem.url.startsWith('data:')) return;

  // Cancel the browser download
  chrome.downloads.cancel(downloadItem.id);
  chrome.downloads.erase({ id: downloadItem.id });

  // Connect to host if not connected
  if (!port) connectHost();

  if (port) {
    port.postMessage({
      url: downloadItem.url,
      filename: downloadItem.filename || null,
      filesize: downloadItem.totalBytes > 0 ? downloadItem.totalBytes : null,
    });
  } else {
    // Native host unavailable — fall back to browser download
    console.warn('[Net Reaper] App not running, falling back to browser download');
    chrome.downloads.download({ url: downloadItem.url });
  }
});
