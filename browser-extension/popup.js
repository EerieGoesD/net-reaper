const toggle = document.getElementById('toggle');
const status = document.getElementById('status');
const logEl = document.getElementById('log');
const clearBtn = document.getElementById('clearLog');
const copyBtn = document.getElementById('copyLog');
const exportBtn = document.getElementById('exportLog');

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

// Check connection by attempting to connect to the native host
try {
  const port = chrome.runtime.connectNative('com.eerie.net_reaper');
  port.onDisconnect.addListener(() => {
    if (chrome.runtime.lastError) {
      status.textContent = 'Net Reaper is not running';
      status.className = 'status disconnected';
    }
  });
  setTimeout(() => {
    if (port) {
      status.textContent = 'Net Reaper is running';
      status.className = 'status connected';
      port.disconnect();
    }
  }, 300);
} catch {
  status.textContent = 'Net Reaper is not running';
  status.className = 'status disconnected';
}

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
