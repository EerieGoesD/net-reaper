const toggle = document.getElementById('toggle');
const status = document.getElementById('status');
const logEl = document.getElementById('log');
const clearBtn = document.getElementById('clearLog');
const copyBtn = document.getElementById('copyLog');
const exportBtn = document.getElementById('exportLog');
const alertEl = document.getElementById('alert');
const alertFileEl = document.getElementById('alertFile');

// Show the "download not intercepted" alert if background opened the popup
// in response to a failed interception within the last 10 seconds.
chrome.storage.local.get('lastAlert', ({ lastAlert }) => {
  if (!lastAlert || !lastAlert.ts || Date.now() - lastAlert.ts > 10000) return;
  if (alertFileEl) {
    const name = lastAlert.filename || lastAlert.url || '';
    alertFileEl.innerHTML = name ? `<span class="filename">${name.replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]))}</span>` : '';
  }
  if (alertEl) alertEl.classList.add('show');
  chrome.storage.local.remove('lastAlert');
});

const MS_STORE_URL = 'https://apps.microsoft.com/detail/9MVK9K79NBZP?hl=en-us&gl=PT&ocid=pdpshare';
const getAppLink = document.getElementById('getAppLink');
if (getAppLink) {
  getAppLink.href = MS_STORE_URL;
}

// Load state
chrome.storage.local.get('enabled', (data) => {
  const on = data.enabled !== false;
  toggle.classList.toggle('on', on);
});

// Toggle
toggle.addEventListener('click', () => {
  const on = !toggle.classList.contains('on');
  toggle.classList.toggle('on', on);
  chrome.storage.local.set({ enabled: on });
});

// Check whether the desktop app is running by pinging through the native host.
// The host tries to connect to the app's named pipe; only if that succeeds is
// the app actually running. Just spawning the host process is not enough.
function setStatus(running) {
  if (running) {
    status.textContent = 'Net Reaper is running';
    status.className = 'status connected';
  } else {
    status.textContent = 'Net Reaper is not running';
    status.className = 'status disconnected';
  }
}

// One ping cycle: spawn a fresh native host process, send {ping:true}, settle
// status from the first reply (or from disconnect / 1500ms timeout). We do not
// keep a long-lived port because the host exits after each cycle by design.
function pingOnce() {
  let settled = false;
  let port;
  const settle = (running) => {
    if (settled) return;
    settled = true;
    setStatus(running);
    try { port && port.disconnect(); } catch (_) {}
  };

  try {
    port = chrome.runtime.connectNative('com.eerie.net_reaper');
  } catch {
    setStatus(false);
    return;
  }

  port.onMessage.addListener((msg) => {
    if (msg && msg.status === 'ok') settle(true);
    else if (msg && msg.status === 'error' && /not running/i.test(msg.message || '')) settle(false);
    else settle(true);
  });

  port.onDisconnect.addListener(() => settle(false));

  try {
    port.postMessage({ ping: true });
  } catch {
    settle(false);
    return;
  }

  setTimeout(() => settle(false), 1500);
}

// Initial check, then poll every 2 seconds while the popup is open so the
// status reflects the user starting or quitting Net Reaper without needing
// to close and reopen the popup.
pingOnce();
const statusInterval = setInterval(pingOnce, 2000);
window.addEventListener('unload', () => clearInterval(statusInterval));

// Get raw log text from storage
function getLogText(callback) {
  chrome.storage.local.get('debugLog', ({ debugLog = [] }) => {
    callback(debugLog.join('\n'));
  });
}

// Render debug log
function renderLog() {
  chrome.storage.local.get('debugLog', ({ debugLog = [] }) => {
    if (debugLog.length === 0) {
      logEl.innerHTML = '<span class="log-empty">No events yet</span>';
      return;
    }
    logEl.textContent = '';
    debugLog.forEach(line => {
      const div = document.createElement('div');
      if (line.includes('ERROR')) div.className = 'error';
      else if (line.includes('WARN')) div.className = 'warn';
      div.textContent = line;
      logEl.appendChild(div);
    });
    // Only auto-scroll if user is already near the bottom (not reading older logs)
    const isNearBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 40;
    if (isNearBottom) logEl.scrollTop = logEl.scrollHeight;
  });
}

renderLog();

// Auto-refresh while popup is open
const refreshInterval = setInterval(renderLog, 1000);

// Clear log
clearBtn.addEventListener('click', () => {
  chrome.storage.local.set({ debugLog: [] });
  logEl.innerHTML = '<span class="log-empty">Log cleared</span>';
});

// Copy logs to clipboard
copyBtn.addEventListener('click', () => {
  getLogText((text) => {
    if (!text) { flashBtn(copyBtn, 'Empty'); return; }
    navigator.clipboard.writeText(text).then(() => {
      flashBtn(copyBtn, 'Copied!');
    }).catch(() => {
      flashBtn(copyBtn, 'Failed');
    });
  });
});

// Export logs as .txt download
exportBtn.addEventListener('click', () => {
  getLogText((text) => {
    if (!text) { flashBtn(exportBtn, 'Empty'); return; }
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `net-reaper-log-${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    flashBtn(exportBtn, 'Saved!');
  });
});

// Brief visual feedback on buttons
function flashBtn(btn, label) {
  const original = btn.textContent;
  btn.textContent = label;
  btn.classList.add('copied');
  setTimeout(() => {
    btn.textContent = original;
    btn.classList.remove('copied');
  }, 1200);
}
