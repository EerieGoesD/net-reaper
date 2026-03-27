const HOST_NAME = 'com.eerie.net_reaper';

let enabled = true;
let port = null;

// Track request metadata for URLs - captures the HTTP method and the actual
// Cookie/Referer headers the browser sends, so we can replay them exactly.
const _requestMeta = new Map(); // url → { method, cookies, referer, ts }

// Capture HTTP method for every request (needed to detect POST downloads)
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    const existing = _requestMeta.get(details.url) || {};
    _requestMeta.set(details.url, { ...existing, method: details.method, ts: Date.now() });
    // Evict entries older than 60s or cap at 200 to prevent memory growth
    if (_requestMeta.size > 200) {
      for (const [url, entry] of _requestMeta) {
        if (Date.now() - entry.ts > 60000 || _requestMeta.size > 200) _requestMeta.delete(url);
      }
    }
  },
  { urls: ['<all_urls>'] }
);

// Capture actual Cookie + Referer headers the browser sends - this bypasses
// any privacy restrictions that block chrome.cookies.getAll (e.g. Brave Shields).
chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    const headers = details.requestHeaders || [];
    const cookieHeader = headers.find(h => h.name.toLowerCase() === 'cookie');
    const refererHeader = headers.find(h => h.name.toLowerCase() === 'referer');
    const existing = _requestMeta.get(details.url) || {};
    _requestMeta.set(details.url, {
      ...existing,
      cookies: cookieHeader?.value || null,
      referer: refererHeader?.value || null,
      ts: Date.now(),
    });
  },
  { urls: ['<all_urls>'] },
  ['requestHeaders', 'extraHeaders']
);

// ── Debug log (persisted so popup can read it) ──
async function log(msg) {
  const ts = new Date().toLocaleTimeString();
  const entry = `[${ts}] ${msg}`;
  console.log('[Net Reaper]', msg);
  try {
    const { debugLog = [] } = await chrome.storage.local.get('debugLog');
    debugLog.push(entry);
    if (debugLog.length > 50) debugLog.splice(0, debugLog.length - 50);
    await chrome.storage.local.set({ debugLog });
  } catch (_) {}
}

// Load saved state
chrome.storage.local.get('enabled', (data) => {
  if (data.enabled !== undefined) enabled = data.enabled;
  log(`Init - enabled: ${enabled}`);
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.enabled) {
    enabled = changes.enabled.newValue;
    log(`Toggle - enabled: ${enabled}`);
  }
});

// Connect to native messaging host
function connectHost() {
  try {
    log('Connecting to native host...');
    port = chrome.runtime.connectNative(HOST_NAME);

    port.onMessage.addListener((msg) => {
      log(`Host response: ${JSON.stringify(msg)}`);
    });

    port.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError?.message || 'unknown reason';
      log(`Host disconnected: ${err}`);
      port = null;
    });

    log('Native host port created');
  } catch (e) {
    log(`ERROR connecting to native host: ${e.message || e}`);
    port = null;
  }
}

// Read all cookies for a URL and return as a "key=val; key2=val2" string
async function getCookiesForUrl(url) {
  try {
    const hostname = new URL(url).hostname;
    // Try by URL first (most accurate - matches domain, path, secure flag)
    let cookies = await chrome.cookies.getAll({ url });
    log(`Cookie lookup by URL (${hostname}): found ${cookies.length} [${cookies.map(c => c.name).join(', ')}]`);

    // Fallback: also try the parent domain directly (catches cases where
    // cf_clearance is on .romsforever.co but getAll({url}) misses it)
    if (!cookies.some(c => c.name === 'cf_clearance')) {
      const parts = hostname.split('.');
      if (parts.length > 2) {
        const parentDomain = parts.slice(-2).join('.');
        const parentCookies = await chrome.cookies.getAll({ domain: parentDomain });
        log(`Cookie lookup by parent domain (.${parentDomain}): found ${parentCookies.length} [${parentCookies.map(c => c.name).join(', ')}]`);
        // Merge without duplicates
        const seen = new Set(cookies.map(c => `${c.domain}|${c.name}`));
        for (const c of parentCookies) {
          if (!seen.has(`${c.domain}|${c.name}`)) {
            cookies.push(c);
            seen.add(`${c.domain}|${c.name}`);
          }
        }
      }
    }

    if (cookies.length === 0) return null;
    log(`Total cookies for request: ${cookies.length} (${cookies.some(c => c.name === 'cf_clearance') ? 'has cf_clearance' : 'NO cf_clearance'})`);
    return cookies.map(c => `${c.name}=${c.value}`).join('; ');
  } catch (e) {
    log(`ERROR reading cookies: ${e.message || e}`);
    return null;
  }
}

// Intercept downloads
chrome.downloads.onCreated.addListener(async (downloadItem) => {
  log(`Download event fired: url=${downloadItem.url?.substring(0, 80)}, enabled=${enabled}`);

  if (!enabled) {
    log('Skipped - interception disabled');
    return;
  }
  const url = downloadItem.url || '';
  if (!url || url.startsWith('blob:') || url.startsWith('data:') || url.startsWith('file:') || url.startsWith('javascript:') || url.startsWith('chrome') || url.startsWith('edge') || url.startsWith('brave') || url.startsWith('about:')) {
    log(`Skipped - unsupported URL scheme`);
    return;
  }

  // Cancel the browser download
  try {
    await chrome.downloads.cancel(downloadItem.id);
    await chrome.downloads.erase({ id: downloadItem.id });
    log('Browser download cancelled');
  } catch (e) {
    log(`WARN cancel/erase failed: ${e.message || e}`);
  }

  // Get captured request metadata (method, cookies, referer) from webRequest listeners
  const meta = _requestMeta.get(downloadItem.url);
  _requestMeta.delete(downloadItem.url);

  const method = meta?.method || 'GET';
  const referer = meta?.referer || null;
  if (method !== 'GET') log(`Detected ${method} request for this download`);

  // Prefer cookies captured from the actual request headers (webRequest) -
  // this works even when chrome.cookies API is blocked by Brave Shields.
  // Fall back to chrome.cookies API if webRequest didn't capture any.
  let cookies = meta?.cookies || null;
  if (cookies) {
    const hasCf = cookies.includes('cf_clearance');
    log(`Cookies from request headers: ${cookies.length} chars (${hasCf ? 'has cf_clearance' : 'no cf_clearance'})`);
  } else {
    cookies = await getCookiesForUrl(downloadItem.url);
    if (cookies) {
      log(`Cookies from chrome.cookies API: ${cookies.length} chars`);
    } else {
      log('No cookies available from either source');
    }
  }

  // Connect to host if not connected
  if (!port) connectHost();

  if (port) {
    const msg = {
      url: downloadItem.url,
      filename: downloadItem.filename || null,
      filesize: downloadItem.totalBytes > 0 ? downloadItem.totalBytes : null,
      cookies,
      method,
      referer,
    };
    log(`Sending to host: ${msg.filename || 'unknown'} (method=${method}, ${msg.cookies ? 'with cookies' : 'no cookies'}${msg.referer ? ', has referer' : ''})`);
    port.postMessage(msg);
  } else {
    log('ERROR: No native host connection - falling back to browser download');
    chrome.downloads.download({ url: downloadItem.url });
  }
});

log('Service worker loaded');
