const toggle = document.getElementById('toggle');
const status = document.getElementById('status');

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
  // If we get here without immediate disconnect, it's connected
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
