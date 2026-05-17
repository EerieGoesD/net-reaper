const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const clipboardManager = window.__TAURI__.clipboardManager;

// ── State ──
let downloads = [];
let selectedId = null;
let defaultSaveDir = '';
let lastSaveDir = localStorage.getItem('nr_lastSaveDir') || '';
let skipAskDir = localStorage.getItem('nr_skipAskDir') === 'true';
let debugMode = localStorage.getItem('nr_debugMode') === 'true';
let smoothSpeedEta = localStorage.getItem('nr_smoothSpeed') === 'true';
let autoClearCompleted = localStorage.getItem('nr_autoClear') === 'true';
let clipboardMonitor = localStorage.getItem('nr_clipMon') === 'true';
const debugFilters = { info: true, warn: true, error: true, event: true };

// Per-domain / per-extension routing rules. Each rule: { pattern, folder }
// Pattern matches a domain (substring of hostname) or an extension (".mp4" or "mp4").
function getRules() {
  try { return JSON.parse(localStorage.getItem('nr_rules') || '[]'); }
  catch { return []; }
}
function saveRules(rules) {
  localStorage.setItem('nr_rules', JSON.stringify(rules));
}

function ruleMatchesUrl(rule, url, filename) {
  if (!rule || !rule.pattern) return false;
  const p = rule.pattern.trim().toLowerCase();
  if (!p) return false;
  // Extension match: ".mp4" or "mp4"
  if (p.startsWith('.') || /^[a-z0-9]{2,5}$/.test(p)) {
    const ext = p.replace(/^\./, '');
    const name = (filename || url.split('/').pop() || '').toLowerCase().split('?')[0];
    return name.endsWith('.' + ext);
  }
  // Domain match: substring of hostname
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host.includes(p);
  } catch {
    return false;
  }
}

function findMatchingRule(url, filename) {
  const rules = getRules();
  for (const r of rules) {
    if (ruleMatchesUrl(r, url, filename)) return r;
  }
  return null;
}

function isHlsUrl(url) {
  try {
    const u = new URL(url);
    return u.pathname.toLowerCase().endsWith('.m3u8') || u.pathname.toLowerCase().includes('.m3u8');
  } catch {
    return /\.m3u8(\?|$)/i.test(url);
  }
}

function deriveHlsFilename(url) {
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').filter(Boolean).pop() || 'video';
    const base = last.replace(/\.m3u8.*$/i, '').replace(/[^\w.\-]/g, '_') || 'video';
    return base + '.mp4';
  } catch {
    return 'video.mp4';
  }
}

// ── DOM ──
const $ = (s) => document.querySelector(s);
const downloadList = $('#downloadList');
const emptyState = $('#emptyState');
const urlInput = $('#urlInput');
const addBtn = $('#addBtn');
const pauseAllBtn = $('#pauseAllBtn');
const resumeAllBtn = $('#resumeAllBtn');
const clearCompletedBtn = $('#clearCompletedBtn');
const globalStatus = $('#globalStatus');
const footerActive = $('#footerActive');
const footerCompleted = $('#footerCompleted');
const footerSpeed = $('#footerSpeed');
const saveDirInput = $('#saveDir');
const browseDirBtn = $('#browseDirBtn');
const scheduleInput = $('#scheduleInput');
const scheduleClearBtn = $('#scheduleClearBtn');

// ── Navigation ──
document.querySelectorAll('.nav-item').forEach(item => {
  item.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    item.classList.add('active');
    const panel = document.getElementById('panel-' + item.dataset.panel);
    if (panel) panel.classList.add('active');
  });
});

// ── Debug System ──
function initDebug() {
  const check = $('#debugCheck');
  const nav = $('#navDebug');
  const wrap = $('#debugToggleWrap');

  function applyDebugState() {
    check.classList.toggle('on', debugMode);
    check.innerHTML = debugMode ? '&#10003;' : '';
    nav.style.display = debugMode ? '' : 'none';
    // If debug panel is active but debug got disabled, switch to downloads
    if (!debugMode) {
      const debugPanel = $('#panel-debug');
      if (debugPanel && debugPanel.classList.contains('active')) {
        document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
        document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
        $('[data-panel="downloads"]').classList.add('active');
        $('#panel-downloads').classList.add('active');
      }
    }
  }

  wrap.addEventListener('click', () => {
    debugMode = !debugMode;
    localStorage.setItem('nr_debugMode', debugMode);
    applyDebugState();
    if (debugMode) dbg('info', 'Debug mode enabled');
  });

  applyDebugState();

  // Filter buttons
  document.querySelectorAll('.debug-filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const level = btn.dataset.level;
      debugFilters[level] = !debugFilters[level];
      btn.classList.toggle('active', debugFilters[level]);
      applyDebugFilters();
    });
  });

  // Clear button
  const clearBtn = $('#debugClearBtn');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      const log = $('#debugLog');
      log.innerHTML = '<div class="debug-empty">Log cleared.</div>';
    });
  }

  // Copy All button
  const copyBtn = $('#debugCopyBtn');
  if (copyBtn) {
    copyBtn.addEventListener('click', async () => {
      const rows = getDebugLogData();
      if (rows.length === 0) return;
      const text = rows.map(r => `${r.ts}  ${r.level.padEnd(5)}  ${r.msg}`).join('\n');
      const original = copyBtn.textContent;
      try {
        await navigator.clipboard.writeText(text);
        copyBtn.textContent = 'Copied!';
      } catch (e) {
        copyBtn.textContent = 'Failed';
      }
      setTimeout(() => { copyBtn.textContent = original; }, 1200);
    });
  }

  // Export button & menu
  const exportBtn = $('#debugExportBtn');
  const exportMenu = $('#debugExportMenu');
  if (exportBtn && exportMenu) {
    exportBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      exportMenu.classList.toggle('open');
    });
    document.addEventListener('click', () => exportMenu.classList.remove('open'));

    exportMenu.querySelectorAll('button').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        exportMenu.classList.remove('open');
        exportDebugLog(btn.dataset.format);
      });
    });
  }
}

function getDebugLogData() {
  const lines = document.querySelectorAll('.debug-line');
  const rows = [];
  lines.forEach(line => {
    const ts = line.querySelector('.ts')?.textContent || '';
    const tag = line.querySelector('.tag')?.textContent || '';
    const msg = line.querySelector('.msg')?.textContent || '';
    rows.push({ ts, level: tag, msg });
  });
  return rows;
}

function exportDebugLog(format) {
  const rows = getDebugLogData();
  if (rows.length === 0) return;

  let content, mime, ext;

  if (format === 'csv') {
    const header = 'Timestamp,Level,Message';
    const csvRows = rows.map(r => `"${r.ts}","${r.level}","${r.msg.replace(/"/g, '""')}"`);
    content = header + '\n' + csvRows.join('\n');
    mime = 'text/csv';
    ext = 'csv';
  } else {
    content = rows.map(r => `${r.ts}  ${r.level.padEnd(5)}  ${r.msg}`).join('\n');
    mime = 'text/plain';
    ext = 'txt';
  }

  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `net-reaper-debug-${new Date().toISOString().slice(0,19).replace(/:/g,'-')}.${ext}`;
  a.click();
  URL.revokeObjectURL(url);
  dbg('info', `Debug log exported as ${ext.toUpperCase()}`);
}

function dbg(level, msg) {
  if (!debugMode) return;
  const log = $('#debugLog');
  if (!log) return;

  // Remove empty state
  const empty = log.querySelector('.debug-empty');
  if (empty) empty.remove();

  const time = new Date().toTimeString().slice(0, 8) + '.' + String(new Date().getMilliseconds()).padStart(3, '0');
  const line = document.createElement('div');
  line.className = `debug-line lvl-${level}`;
  line.dataset.level = level;
  line.style.display = debugFilters[level] ? '' : 'none';
  line.innerHTML = `<span class="ts">${time}</span><span class="tag">${level.toUpperCase()}</span><span class="msg">${escapeHtml(msg)}</span>`;
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function applyDebugFilters() {
  const search = ($('#debugSearch')?.value || '').toLowerCase();
  document.querySelectorAll('.debug-line').forEach(line => {
    const level = line.dataset.level;
    const matchesLevel = debugFilters[level];
    const matchesSearch = !search || (line.querySelector('.msg')?.textContent || '').toLowerCase().includes(search);
    line.style.display = (matchesLevel && matchesSearch) ? '' : 'none';
  });
}

$('#debugSearch')?.addEventListener('input', () => applyDebugFilters());

initDebug();

// ── "Always ask where to save" toggle ──
(function initAskDirToggle() {
  const check = $('#askDirCheck');
  const wrap = $('#askDirToggleWrap');

  function apply() {
    const alwaysAsk = !skipAskDir;
    check.classList.toggle('on', alwaysAsk);
    check.innerHTML = alwaysAsk ? '&#10003;' : '';
  }
  apply();

  wrap.addEventListener('click', () => {
    skipAskDir = !skipAskDir;
    localStorage.setItem('nr_skipAskDir', skipAskDir);
    apply();
    dbg('info', `Always ask where to save: ${!skipAskDir}`);
  });
})();

// ── Toast Notifications ──
function showToast(type, title, msg, duration = 6000) {
  const container = $('#toastContainer');
  const icons = { error: '&#9888;', warn: '&#9888;', success: '&#10003;', info: '&#8505;' };
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `
    <div class="toast-icon">${icons[type] || icons.info}</div>
    <div class="toast-body">
      <div class="toast-title">${escapeHtml(title)}</div>
      <div class="toast-msg">${escapeHtml(msg).replace(/\n/g, '<br>')}</div>
    </div>
    <button class="toast-close">&times;</button>
  `;
  toast.querySelector('.toast-close').addEventListener('click', () => dismiss(toast));
  container.appendChild(toast);

  const timer = setTimeout(() => dismiss(toast), duration);

  function dismiss(el) {
    clearTimeout(timer);
    el.classList.add('toast-out');
    el.addEventListener('animationend', () => el.remove());
  }
}

// ── Auto-clear completed toggle (synced between Downloads bar and Settings) ──
(function initAutoClearToggle() {
  const checkDl = $('#autoClearCheckDl');
  const checkSettings = $('#autoClearCheckSettings');
  const wrapDl = $('#autoClearToggleDl');
  const wrapSettings = $('#autoClearToggleSettings');

  function apply() {
    [checkDl, checkSettings].forEach(el => {
      if (!el) return;
      el.classList.toggle('on', autoClearCompleted);
      el.innerHTML = autoClearCompleted ? '&#10003;' : '';
    });
  }
  apply();

  function toggle() {
    autoClearCompleted = !autoClearCompleted;
    localStorage.setItem('nr_autoClear', autoClearCompleted);
    apply();
    dbg('info', `Auto-clear completed: ${autoClearCompleted}`);
  }

  if (wrapDl) wrapDl.addEventListener('click', toggle);
  if (wrapSettings) wrapSettings.addEventListener('click', toggle);
})();

// ── Schedule input ──
(function initScheduleInput() {
  if (!scheduleInput || !scheduleClearBtn) return;
  function update() {
    const has = !!scheduleInput.value;
    scheduleInput.classList.toggle('has-value', has);
    scheduleClearBtn.style.display = has ? '' : 'none';
  }
  scheduleInput.addEventListener('change', update);
  scheduleClearBtn.addEventListener('click', () => {
    scheduleInput.value = '';
    update();
  });
  update();
})();

// ── Segments setting ──
(function initSegmentsSetting() {
  const input = $('#segments');
  if (!input) return;
  const saved = localStorage.getItem('nr_segments');
  if (saved !== null) input.value = saved;
  input.addEventListener('change', async () => {
    const parsed = parseInt(input.value, 10);
    let n = Math.max(1, Math.min(16, Number.isFinite(parsed) ? parsed : 8));
    input.value = n;
    localStorage.setItem('nr_segments', String(n));
    try { await invoke('set_segments', { count: n }); } catch (e) { dbg('error', `set_segments failed: ${e}`); }
    dbg('info', `Parallel segments set to ${n}`);
  });
})();

// ── Clipboard monitor ──
(function initClipboardMonitor() {
  const wrap = $('#clipMonToggleWrap');
  const check = $('#clipMonCheck');
  if (!wrap || !check) return;
  function apply() {
    check.classList.toggle('on', clipboardMonitor);
    check.innerHTML = clipboardMonitor ? '&#10003;' : '';
  }
  apply();
  wrap.addEventListener('click', () => {
    clipboardMonitor = !clipboardMonitor;
    localStorage.setItem('nr_clipMon', clipboardMonitor);
    apply();
    dbg('info', `Clipboard monitor: ${clipboardMonitor}`);
  });
})();

let _lastSeenClip = '';
let _ignoredUrls = new Set();
let _activePromptUrl = null;
function isLikelyDownloadUrl(text) {
  if (!text || text.length > 2048) return false;
  text = text.trim();
  if (!/^https?:\/\//i.test(text)) return false;
  // avoid HTML pages: heuristic - prefer URLs with a path that looks like a file or known stream
  try {
    const u = new URL(text);
    const path = u.pathname.toLowerCase();
    // Direct file or m3u8 -> likely download
    if (/\.[a-z0-9]{2,5}(\?|$)/i.test(path)) return true;
    return false;
  } catch { return false; }
}

function showClipboardPrompt(url) {
  if (_activePromptUrl === url) return;
  // Remove any existing
  document.querySelectorAll('.clipboard-prompt').forEach(el => el.remove());
  _activePromptUrl = url;

  const el = document.createElement('div');
  el.className = 'clipboard-prompt';
  el.innerHTML = `
    <div class="clipboard-prompt-text">
      <div class="clipboard-prompt-title">Download URL detected on clipboard?</div>
      <div class="clipboard-prompt-url" title="${escapeHtml(url)}">${escapeHtml(url)}</div>
    </div>
    <div class="clipboard-prompt-actions">
      <button class="btn btn-accent btn-sm" data-action="download">Download</button>
      <button class="btn btn-ghost btn-sm" data-action="ignore">Ignore</button>
    </div>
  `;
  document.body.appendChild(el);

  const close = () => { el.remove(); _activePromptUrl = null; };

  el.querySelector('[data-action="download"]').addEventListener('click', () => {
    urlInput.value = url;
    close();
    addDownload();
  });
  el.querySelector('[data-action="ignore"]').addEventListener('click', () => {
    _ignoredUrls.add(url);
    close();
  });

  // Auto-dismiss after 12s
  setTimeout(() => { if (_activePromptUrl === url) close(); }, 12000);
}

async function pollClipboard() {
  if (!clipboardMonitor || !document.hasFocus()) return;
  try {
    const text = await clipboardManager.readText();
    if (!text || text === _lastSeenClip) return;
    _lastSeenClip = text;
    if (_ignoredUrls.has(text)) return;
    if (!isLikelyDownloadUrl(text)) return;
    // Avoid prompting again if it's already in the active list
    if (downloads.some(d => d.url === text)) return;
    showClipboardPrompt(text);
  } catch (e) {
    // Permission denied or plugin missing - silently skip
  }
}
setInterval(pollClipboard, 1500);

// ── Per-domain rules UI ──
function renderRules() {
  const list = $('#rulesList');
  if (!list) return;
  const rules = getRules();
  list.innerHTML = '';
  if (rules.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'rules-empty';
    empty.textContent = 'No rules yet. Add one below to auto-route downloads by extension or domain.';
    list.appendChild(empty);
    return;
  }
  rules.forEach((r, idx) => {
    const el = document.createElement('div');
    el.className = 'rule-item';
    el.innerHTML = `
      <span class="rule-pattern">${escapeHtml(r.pattern)}</span>
      <span class="rule-arrow">&rarr;</span>
      <span class="rule-folder" title="${escapeHtml(r.folder)}">${escapeHtml(r.folder)}</span>
      <button class="rule-remove" title="Remove">&times;</button>
    `;
    el.querySelector('.rule-remove').addEventListener('click', () => {
      const all = getRules();
      all.splice(idx, 1);
      saveRules(all);
      renderRules();
    });
    list.appendChild(el);
  });
}
(function initRulesUI() {
  const addBtn = $('#ruleAddBtn');
  const browseBtn = $('#ruleBrowseBtn');
  const patternIn = $('#ruleNewPattern');
  const folderIn = $('#ruleNewFolder');
  if (!addBtn || !patternIn || !folderIn) return;
  addBtn.addEventListener('click', () => {
    const pattern = patternIn.value.trim();
    const folder = folderIn.value.trim();
    if (!pattern || !folder) {
      showToast('warn', 'Missing fields', 'Both a pattern and a folder are required.');
      return;
    }
    const rules = getRules();
    rules.push({ pattern, folder });
    saveRules(rules);
    patternIn.value = '';
    folderIn.value = '';
    renderRules();
    dbg('info', `Rule added: ${pattern} -> ${folder}`);
  });
  if (browseBtn) {
    browseBtn.addEventListener('click', async () => {
      try {
        const { open } = window.__TAURI__.dialog;
        const dir = await open({ directory: true, multiple: false, title: 'Choose target folder for this rule' });
        if (dir) folderIn.value = dir;
      } catch (e) { console.error(e); }
    });
  }
  renderRules();
})();

// ── Scheduler tick: every 30s, start any queued downloads whose scheduled time has arrived ──
async function tickScheduler() {
  const now = new Date();
  for (const d of downloads) {
    if (d.status !== 'Queued' || !d.scheduled_at) continue;
    const t = new Date(d.scheduled_at);
    if (isNaN(t.getTime())) continue;
    if (t <= now) {
      const max = getMaxConcurrent();
      const active = getActiveCount();
      if (active >= max) break;
      dbg('info', `Scheduled time reached for ${d.filename || d.id}; starting`);
      try {
        await invoke('start_queued_download', { id: d.id });
        d.status = 'Downloading';
      } catch (e) {
        dbg('error', `Scheduler start failed: ${e}`);
      }
    }
  }
}
setInterval(tickScheduler, 30000);

// ── History ──
const historyStatusFilters = { Completed: true, Downloading: true, Paused: true, Failed: true, Cancelled: true, Queued: true };
function getHistory() {
  try {
    return JSON.parse(localStorage.getItem('nr_history') || '[]');
  } catch { return []; }
}

function saveHistory(history) {
  // Keep last 500 entries
  localStorage.setItem('nr_history', JSON.stringify(history.slice(0, 500)));
}

// On app startup, any history entry that isn't in a terminal state
// (Completed, Failed, Cancelled) and isn't still alive in the Rust
// download manager is stale - the download was actually interrupted when
// the app was closed. Rust state is in-memory only, so nothing resumes.
// Mark these as Failed so the History view is honest. The liveIds check
// prevents touching entries that are still running (e.g. dev webview reload
// while Rust keeps the process alive).
function sanitizeStaleHistoryOnStartup() {
  const history = getHistory();
  const terminal = new Set(['Completed', 'Failed', 'Cancelled']);
  const liveIds = new Set(downloads.map(d => d.id));
  let touched = 0;
  for (const entry of history) {
    if (!terminal.has(entry.status) && !liveIds.has(entry.id)) {
      entry.status = 'Failed';
      entry.updated = new Date().toISOString();
      touched++;
    }
  }
  if (touched > 0) {
    saveHistory(history);
    dbg('info', `Sanitized ${touched} interrupted history entr${touched === 1 ? 'y' : 'ies'} -> Failed`);
  }
}

function addOrUpdateHistory(download) {
  const history = getHistory();

  // Find existing entry by download ID or url+filename match
  const existingIdx = history.findIndex(h => h.id === download.id);

  const entry = {
    id: download.id,
    filename: download.filename,
    url: download.url,
    size: download.total_bytes || download.downloaded_bytes || 0,
    status: download.status,
    save_path: download.save_path,
    date: existingIdx >= 0 ? history[existingIdx].date : new Date().toISOString(),
    updated: new Date().toISOString(),
  };

  if (existingIdx >= 0) {
    // Update existing entry in place
    history[existingIdx] = entry;
  } else {
    // New entry at top
    history.unshift(entry);
  }

  saveHistory(history);
  renderHistory();
}

function renderHistory() {
  const list = $('#historyList');
  const empty = $('#historyEmpty');
  const countEl = $('#historyCount');
  const search = ($('#historySearch')?.value || '').toLowerCase();
  const history = getHistory();

  const filtered = history.filter(h => {
    if (!historyStatusFilters[h.status]) return false;
    if (search && !h.filename.toLowerCase().includes(search) && !h.url.toLowerCase().includes(search)) return false;
    return true;
  });

  // Sort
  const sortVal = $('#historySort')?.value || 'date-desc';
  const [sortKey, sortDir] = sortVal.split('-');
  filtered.sort((a, b) => {
    let cmp = 0;
    if (sortKey === 'date') cmp = new Date(a.date) - new Date(b.date);
    else if (sortKey === 'size') cmp = (a.size || 0) - (b.size || 0);
    else if (sortKey === 'name') cmp = (a.filename || '').localeCompare(b.filename || '');
    return sortDir === 'desc' ? -cmp : cmp;
  });

  // Remove old items (not the empty state)
  list.querySelectorAll('.history-item').forEach(el => el.remove());

  if (filtered.length === 0) {
    empty.style.display = 'flex';
    empty.querySelector('p').textContent = search ? 'No matches found' : 'No download history yet';
  } else {
    empty.style.display = 'none';
  }

  countEl.textContent = `${filtered.length} item${filtered.length !== 1 ? 's' : ''}`;

  filtered.forEach(h => {
    const el = document.createElement('div');
    el.className = 'history-item';

    const statusMap = {
      Completed:   { cls: 'completed',   icon: '&#10003;' },
      Failed:      { cls: 'failed',      icon: '&#10007;' },
      Cancelled:   { cls: 'cancelled',   icon: '&#8635;' },
      Downloading: { cls: 'downloading', icon: '&#8595;' },
      Paused:      { cls: 'paused',      icon: '&#9646;&#9646;' },
      Queued:      { cls: 'queued',      icon: '&#8943;' },
    };
    const { cls: iconClass, icon } = statusMap[h.status] || statusMap.Cancelled;
    const date = new Date(h.date);
    const dateStr = date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    el.innerHTML = `
      <div class="history-icon ${iconClass}">${icon}</div>
      <div class="history-info">
        <div class="history-filename">${escapeHtml(h.filename || 'Unknown')}</div>
        <div class="history-meta">
          <span>${h.size > 0 ? formatBytes(h.size) : '-'}</span>
          <span>${dateStr}</span>
          <span>${h.status}</span>
        </div>
        <div class="history-url">${escapeHtml(h.url)}</div>
      </div>
      <div class="history-actions">
        ${h.save_path ? '<button class="history-open-folder" title="Open file location">&#128194;</button>' : ''}
        <button class="history-redownload" title="Download again">Redownload</button>
      </div>
    `;

    const openFolderBtn = el.querySelector('.history-open-folder');
    if (openFolderBtn) {
      openFolderBtn.addEventListener('click', () => {
        invoke('show_in_folder', { path: h.save_path });
      });
    }

    el.querySelector('.history-redownload').addEventListener('click', () => {
      urlInput.value = h.url;
      // Switch to downloads panel
      document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
      document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
      $('[data-panel="downloads"]').classList.add('active');
      $('#panel-downloads').classList.add('active');
      addDownload();
    });

    list.appendChild(el);
  });
}

// Search
document.getElementById('historySearch')?.addEventListener('input', () => renderHistory());
document.getElementById('historySort')?.addEventListener('change', () => renderHistory());

// History status filter buttons
document.querySelectorAll('.history-filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const status = btn.dataset.status;
    historyStatusFilters[status] = !historyStatusFilters[status];
    btn.classList.toggle('active', historyStatusFilters[status]);
    renderHistory();
  });
});

// Clear history
document.getElementById('historyClearBtn')?.addEventListener('click', () => {
  localStorage.removeItem('nr_history');
  dbg('info', 'Download history cleared');
  renderHistory();
});

// Initial render
renderHistory();

// ── Helpers ──
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return (bytes / Math.pow(k, i)).toFixed(i > 0 ? 1 : 0) + ' ' + sizes[i];
}

function formatSpeed(bps) {
  if (!bps) return '';
  return formatBytes(bps) + '/s';
}

function formatEta(remainingBytes, speedBps) {
  if (!speedBps || speedBps <= 0 || !remainingBytes || remainingBytes <= 0) return '';
  let secs = Math.ceil(remainingBytes / speedBps);
  if (secs < 60) return `${secs}${t('time.s')}`;
  const mins = Math.floor(secs / 60); secs = secs % 60;
  if (mins < 60) return `${mins}${t('time.m')} ${secs}${t('time.s')}`;
  const hrs = Math.floor(mins / 60); const rmins = mins % 60;
  return `${hrs}${t('time.h')} ${rmins}${t('time.m')}`;
}

function statusClass(status) {
  return status.toLowerCase();
}

// ── Render Downloads ──
function render() {
  if (downloads.length === 0) {
    emptyState.style.display = 'flex';
    // Clear any download items
    downloadList.querySelectorAll('.dl-item').forEach(el => el.remove());
  } else {
    emptyState.style.display = 'none';
    renderDownloadItems();
  }
  updateFooter();
}

function renderDownloadItems() {
  const existing = new Map();
  downloadList.querySelectorAll('.dl-item').forEach(el => {
    existing.set(el.dataset.id, el);
  });

  const currentIds = new Set(downloads.map(d => d.id));

  // Remove items no longer in the list
  existing.forEach((el, id) => {
    if (!currentIds.has(id)) el.remove();
  });

  downloads.forEach((d) => {
    let el = existing.get(d.id);
    if (!el) {
      el = createDownloadElement(d);
      downloadList.appendChild(el);
    }
    updateDownloadElement(el, d);
  });
}

function createDownloadElement(d) {
  const el = document.createElement('div');
  el.className = 'dl-item';
  el.dataset.id = d.id;
  el.innerHTML = `
    <div class="dl-row-top">
      <span class="dl-filename"></span>
      <span class="dl-status"></span>
      <span class="dl-size"></span>
      <span class="dl-eta"></span>
      <span class="dl-speed"></span>
      <div class="dl-actions">
        <button class="btn-icon btn-pause" title="Pause">
          <svg viewBox="0 0 16 16" fill="currentColor" stroke="none"><rect x="4" y="3" width="3" height="10" rx="0.5"/><rect x="9" y="3" width="3" height="10" rx="0.5"/></svg>
        </button>
        <button class="btn-icon btn-resume" title="Resume" style="display:none">
          <svg viewBox="0 0 16 16" fill="currentColor" stroke="none"><path d="M4 2.5l9 5.5-9 5.5z"/></svg>
        </button>
        <button class="btn-icon btn-cancel" title="Cancel">
          <svg viewBox="0 0 16 16" stroke="currentColor" fill="none" stroke-width="1.5"><path d="M4 4l8 8M12 4l-8 8"/></svg>
        </button>
        <button class="btn-icon btn-retry" title="Retry" style="display:none">
          <svg viewBox="0 0 16 16" stroke="currentColor" fill="none" stroke-width="1.5"><path d="M2 8a6 6 0 0111.5-2.5M14 2v4h-4"/><path d="M14 8a6 6 0 01-11.5 2.5M2 14v-4h4"/></svg>
        </button>
        <button class="btn-icon btn-remove" title="Remove" style="display:none">
          <svg viewBox="0 0 16 16" stroke="currentColor" fill="none" stroke-width="1.5"><path d="M5 3V2h6v1M2 4h12M4 4v9a1 1 0 001 1h6a1 1 0 001-1V4"/></svg>
        </button>
      </div>
    </div>
    <div class="dl-progress-wrap"><div class="dl-progress-bar"></div></div>
    <div class="dl-row-bottom">
      <span class="dl-url"></span>
    </div>
  `;

  el.querySelector('.btn-pause').addEventListener('click', (e) => {
    e.stopPropagation();
    dbg('info', `Pause clicked: ${d.id} (${d.filename || 'unknown'})`);
    invoke('pause_download', { id: d.id });
  });
  el.querySelector('.btn-resume').addEventListener('click', (e) => {
    e.stopPropagation();
    dbg('info', `Resume clicked: ${d.id} (${d.filename || 'unknown'})`);
    invoke('resume_download', { id: d.id });
  });
  el.querySelector('.btn-cancel').addEventListener('click', async (e) => {
    e.stopPropagation();
    dbg('warn', `Cancel clicked: ${d.id} (${d.filename || 'unknown'})`);
    // Queued downloads aren't in the download loop, so cancel_download flag is never read.
    // Remove them directly instead.
    if (d.status === 'Queued') {
      await invoke('remove_download', { id: d.id });
      downloads = downloads.filter(dl => dl.id !== d.id);
      render();
      return;
    }
    invoke('cancel_download', { id: d.id });
  });
  el.querySelector('.btn-retry').addEventListener('click', async (e) => {
    e.stopPropagation();
    dbg('info', `Retry clicked: ${d.id} (${d.filename || 'unknown'}) - resetting in place to reuse cookies/UA/referer`);
    try {
      // Use retry_download (which calls reset_for_retry under the hood) so the
      // cookies/UA/referer/method maps the extension populated stay attached
      // to this id. The previous implementation did remove + add_download
      // with cookies: null, which is why retries failed instantly on
      // Cloudflare-protected URLs with "extension did not forward cookies/UA".
      delete _smoothedSpeeds[d.id];
      await invoke('retry_download', { id: d.id });
      downloads = await invoke('get_downloads');
      render();
    } catch (err) {
      dbg('error', `Retry failed: ${err}`);
      showToast('error', 'Retry failed', String(err));
    }
  });
  el.querySelector('.btn-remove').addEventListener('click', (e) => {
    e.stopPropagation();
    dbg('info', `Remove clicked: ${d.id}`);
    invoke('remove_download', { id: d.id });
    downloads = downloads.filter(dl => dl.id !== d.id);
    delete _smoothedSpeeds[d.id];
    render();
  });

  el.addEventListener('click', () => {
    selectedId = d.id;
    downloadList.querySelectorAll('.dl-item').forEach(item => {
      item.classList.toggle('selected', item.dataset.id === d.id);
    });
  });

  return el;
}

function updateDownloadElement(el, d) {
  el.querySelector('.dl-filename').textContent = d.filename || 'Resolving...';
  el.querySelector('.dl-url').textContent = d.url;

  // Size + percentage
  const dlPct = d.total_bytes > 0 ? ((d.downloaded_bytes / d.total_bytes) * 100).toFixed(1) : null;
  const sizeText = d.total_bytes > 0
    ? `${formatBytes(d.downloaded_bytes)} / ${formatBytes(d.total_bytes)} (${dlPct}%)`
    : d.downloaded_bytes > 0 ? formatBytes(d.downloaded_bytes) : '';
  el.querySelector('.dl-size').textContent = sizeText;

  // Speed + ETA
  const displaySpeed = d.status === 'Downloading' && smoothSpeedEta
    ? (_smoothedSpeeds[d.id] ?? d.speed_bps)
    : d.speed_bps;
  el.querySelector('.dl-speed').textContent =
    d.status === 'Downloading' ? formatSpeed(displaySpeed) : '';
  const remaining = (d.total_bytes || 0) - (d.downloaded_bytes || 0);
  el.querySelector('.dl-eta').textContent =
    d.status === 'Downloading' ? formatEta(remaining, displaySpeed) : '';

  // Status badge
  const badge = el.querySelector('.dl-status');
  badge.textContent = d.status === 'Starting' ? 'Starting, Please Wait...' : d.status;
  badge.className = 'dl-status ' + statusClass(d.status);

  // Progress bar
  const bar = el.querySelector('.dl-progress-bar');
  const pct = d.total_bytes > 0 ? (d.downloaded_bytes / d.total_bytes) * 100 : 0;
  bar.style.width = pct + '%';
  bar.className = 'dl-progress-bar ' + statusClass(d.status);

  // Action buttons visibility
  const isPaused = d.status === 'Paused';
  const isActive = d.status === 'Downloading' || d.status === 'Queued' || d.status === 'Starting';
  const isFailed = d.status === 'Failed' || d.status === 'Cancelled';
  const isDone = d.status === 'Completed' || isFailed;

  el.querySelector('.btn-pause').style.display = isActive ? '' : 'none';
  el.querySelector('.btn-resume').style.display = isPaused ? '' : 'none';
  el.querySelector('.btn-cancel').style.display = (isActive || isPaused) ? '' : 'none';
  el.querySelector('.btn-retry').style.display = isFailed ? '' : 'none';
  el.querySelector('.btn-remove').style.display = isDone ? '' : 'none';
}

// ── Overall progress: average of individual percentages ──
let _completedCount = 0;       // number of downloads that completed (each counts as 100%)
const _trackedIds = new Set(); // IDs currently counted in overall progress

// ── Speed Graph ──
let showSpeedGraph = localStorage.getItem('nr_speedGraph') !== 'false';
let showSpeedStats = localStorage.getItem('nr_speedStats') !== 'false';
const speedHistory = [];
const _smoothedSpeeds = {};
const SMOOTH_ALPHA = 0.2;
const SPEED_HISTORY_MAX = 60;
let _graphRafPending = false;
let _lastSampleTime = 0;
let _peakSpeed = 0;
let _diskBytesLastTick = 0;
let _diskSpeed = 0;
let _lastDiskCalcTime = 0;

(function initSpeedGraphToggle() {
  const check = $('#speedGraphCheckSettings');
  const wrap = $('#speedGraphToggleSettings');
  const statsCheck = $('#speedStatsCheckSettings');
  const statsWrap = $('#speedStatsToggleSettings');

  const smoothCheck = $('#smoothSpeedCheckSettings');
  const smoothWrap = $('#smoothSpeedToggleSettings');

  function apply() {
    check.classList.toggle('on', showSpeedGraph);
    check.innerHTML = showSpeedGraph ? '&#10003;' : '';
    statsCheck.classList.toggle('on', showSpeedStats);
    statsCheck.innerHTML = showSpeedStats ? '&#10003;' : '';
    $('.speed-graph-stats').style.display = showSpeedStats ? '' : 'none';
    smoothCheck.classList.toggle('on', smoothSpeedEta);
    smoothCheck.innerHTML = smoothSpeedEta ? '&#10003;' : '';
  }
  apply();

  wrap.addEventListener('click', () => {
    showSpeedGraph = !showSpeedGraph;
    localStorage.setItem('nr_speedGraph', showSpeedGraph);
    apply();
  });

  statsWrap.addEventListener('click', () => {
    showSpeedStats = !showSpeedStats;
    localStorage.setItem('nr_speedStats', showSpeedStats);
    apply();
  });

  smoothWrap.addEventListener('click', () => {
    smoothSpeedEta = !smoothSpeedEta;
    localStorage.setItem('nr_smoothSpeed', smoothSpeedEta);
    apply();
  });
})();

function updateSpeedGraph() {
  const wrap = $('#speedGraphWrap');
  const hasActive = downloads.some(d => d.status === 'Downloading' || d.status === 'Queued' || d.status === 'Starting');

  const now = Date.now();
  const totalSpeed = downloads
    .filter(d => d.status === 'Downloading')
    .reduce((sum, d) => sum + (smoothSpeedEta ? (_smoothedSpeeds[d.id] ?? d.speed_bps) : d.speed_bps || 0), 0);

  // Track peak
  if (totalSpeed > _peakSpeed) _peakSpeed = totalSpeed;

  // Estimate disk write speed (total downloaded bytes delta)
  const totalDownloaded = downloads
    .filter(d => d.status === 'Downloading')
    .reduce((sum, d) => sum + (d.downloaded_bytes || 0), 0);
  if (_lastDiskCalcTime > 0 && now - _lastDiskCalcTime > 0) {
    const elapsed = (now - _lastDiskCalcTime) / 1000;
    const delta = totalDownloaded - _diskBytesLastTick;
    _diskSpeed = delta > 0 ? Math.round(delta / elapsed) : 0;
  }
  _diskBytesLastTick = totalDownloaded;
  _lastDiskCalcTime = now;

  // Always update stats (even when graph is hidden)
  $('#graphNetwork').textContent = formatSpeed(totalSpeed);
  $('#graphPeak').textContent = formatSpeed(_peakSpeed);
  $('#graphDisk').textContent = formatSpeed(_diskSpeed);

  // Reset stats when nothing is active
  if (!hasActive) {
    speedHistory.length = 0;
    _peakSpeed = 0;
    _diskSpeed = 0;
    _diskBytesLastTick = 0;
    _lastDiskCalcTime = 0;
    $('#graphNetwork').textContent = '0 B/s';
    $('#graphPeak').textContent = '0 B/s';
    $('#graphDisk').textContent = '0 B/s';
  }

  // Graph visibility controlled by setting only
  if (!showSpeedGraph || !hasActive) {
    wrap.style.display = 'none';
    return;
  }

  wrap.style.display = '';

  // Sample into history at ~1s intervals
  if (now - _lastSampleTime >= 1000) {
    speedHistory.push(totalSpeed);
    if (speedHistory.length > SPEED_HISTORY_MAX) speedHistory.shift();
    _lastSampleTime = now;
  }

  // Batch canvas draws with rAF
  if (!_graphRafPending) {
    _graphRafPending = true;
    requestAnimationFrame(() => {
      _graphRafPending = false;
      drawGraph(totalSpeed);
    });
  }
}

function drawGraph(currentSpeed) {
  const canvas = $('#speedGraph');
  if (!canvas) return;

  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  if (rect.width === 0) return;

  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);

  const w = rect.width;
  const h = rect.height;
  const padTop = 4;
  const padBot = 2;
  const graphH = h - padTop - padBot;

  // Use history + current speed as the latest point for smooth real-time feel
  const data = [...speedHistory, currentSpeed];
  const maxSpeed = Math.max(_peakSpeed, ...data, 1024); // scale to peak
  const step = w / (SPEED_HISTORY_MAX);
  const startIdx = SPEED_HISTORY_MAX + 1 - data.length;

  ctx.clearRect(0, 0, w, h);

  // Grid lines (bottom = 0, top = peak)
  ctx.strokeStyle = 'rgba(34,34,40,0.6)';
  ctx.lineWidth = 0.5;
  // Bottom line (0)
  ctx.beginPath(); ctx.moveTo(0, h - padBot); ctx.lineTo(w, h - padBot); ctx.stroke();
  // Top line (peak) - dashed yellow
  ctx.setLineDash([3, 3]);
  ctx.strokeStyle = 'rgba(234,179,8,0.2)';
  ctx.beginPath(); ctx.moveTo(0, padTop); ctx.lineTo(w, padTop); ctx.stroke();
  ctx.setLineDash([]);

  // Update Y-axis labels (numbers only)
  const peakVal = maxSpeed >= 1073741824 ? (maxSpeed / 1073741824).toFixed(1)
    : maxSpeed >= 1048576 ? (maxSpeed / 1048576).toFixed(1)
    : maxSpeed >= 1024 ? (maxSpeed / 1024).toFixed(0)
    : maxSpeed.toString();
  $('#graphYMax').textContent = peakVal;

  if (data.length < 2) return;

  // Build points
  const pts = data.map((v, i) => ({
    x: (startIdx + i) * step,
    y: padTop + graphH - (v / maxSpeed) * graphH
  }));

  // Fill
  const grad = ctx.createLinearGradient(0, padTop, 0, h);
  grad.addColorStop(0, 'rgba(99,102,241,0.2)');
  grad.addColorStop(1, 'rgba(99,102,241,0)');

  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) {
    const cpx = (pts[i - 1].x + pts[i].x) / 2;
    ctx.bezierCurveTo(cpx, pts[i - 1].y, cpx, pts[i].y, pts[i].x, pts[i].y);
  }
  ctx.lineTo(pts[pts.length - 1].x, h);
  ctx.lineTo(pts[0].x, h);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  // Line
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) {
    const cpx = (pts[i - 1].x + pts[i].x) / 2;
    ctx.bezierCurveTo(cpx, pts[i - 1].y, cpx, pts[i].y, pts[i].x, pts[i].y);
  }
  ctx.strokeStyle = '#6366f1';
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

function updateFooter() {
  const active = downloads.filter(d => d.status === 'Downloading' || d.status === 'Queued' || d.status === 'Starting').length;
  const completed = downloads.filter(d => d.status === 'Completed').length;
  const totalSpeed = downloads
    .filter(d => d.status === 'Downloading')
    .reduce((sum, d) => sum + (smoothSpeedEta ? (_smoothedSpeeds[d.id] ?? d.speed_bps) : d.speed_bps || 0), 0);

  footerActive.textContent = `${active} ${t('footer.active')}`;
  footerCompleted.textContent = `${completed} ${t('footer.completed')}`;
  footerSpeed.textContent = totalSpeed > 0 ? formatSpeed(totalSpeed) : '';
  globalStatus.textContent = active > 0 ? `${active} downloading…` : '';

  updateOverallProgress();
  updateSpeedGraph();
}

function updateOverallProgress() {
  const wrap = $('#overallProgress');
  const bar = $('#overallBar');
  const text = $('#overallText');
  const pct = $('#overallPct');

  // Include downloading, queued, and paused
  const tracked = downloads.filter(d =>
    d.status === 'Downloading' || d.status === 'Queued' || d.status === 'Paused' || d.status === 'Starting'
  );

  // Track IDs - when one leaves, only count it as 100% if it actually completed
  const currentIds = new Set(tracked.map(d => d.id));
  for (const id of _trackedIds) {
    if (!currentIds.has(id)) {
      const gone = downloads.find(d => d.id === id);
      if (gone && gone.status === 'Completed') {
        _completedCount++;
      }
      _trackedIds.delete(id);
    }
  }
  for (const id of currentIds) _trackedIds.add(id);

  const totalCount = tracked.length + _completedCount;

  if (totalCount === 0) {
    wrap.style.display = 'none';
    return;
  }

  // Reset once everything is done
  if (tracked.length === 0) {
    _completedCount = 0;
    _trackedIds.clear();
    wrap.style.display = 'none';
    return;
  }

  wrap.style.display = '';

  // Each download contributes its individual % (0-100), completed ones contribute 100
  const activePercentSum = tracked.reduce((sum, d) => {
    if (d.total_bytes > 0) return sum + (d.downloaded_bytes / d.total_bytes) * 100;
    return sum; // queued (unknown size) = 0%
  }, 0);
  const percent = (activePercentSum + _completedCount * 100) / totalCount;

  const downloading = tracked.filter(d => d.status === 'Downloading' || d.status === 'Starting').length;
  const queued = tracked.filter(d => d.status === 'Queued').length;
  const paused = tracked.filter(d => d.status === 'Paused').length;

  const parts = [];
  if (downloading > 0) parts.push(`${downloading} ${t('overall.downloading')}`);
  if (queued > 0) parts.push(`${queued} ${t('overall.queued')}`);
  if (paused > 0) parts.push(`${paused} ${t('overall.paused')}`);
  const totalSpeed = tracked.filter(d => d.status === 'Downloading').reduce((s, d) => s + (smoothSpeedEta ? (_smoothedSpeeds[d.id] ?? d.speed_bps) : d.speed_bps || 0), 0);
  const activeTotalBytes = tracked.reduce((sum, d) => sum + (d.total_bytes || 0), 0);
  const activeDownloadedBytes = tracked.reduce((sum, d) => sum + (d.downloaded_bytes || 0), 0);
  const etaStr = formatEta(activeTotalBytes - activeDownloadedBytes, totalSpeed);
  text.textContent = `${parts.join(', ')} - ${percent.toFixed(1)}%${etaStr ? ' - ' + etaStr + ' ' + t('overall.remaining') : ''}`;
  pct.textContent = `${percent.toFixed(1)}%`;

  bar.style.width = percent + '%';
  bar.classList.toggle('done', percent >= 100);
}

// ── Save Directory Picker Dialog ──
function showSaveDirDialog(initialDir, initialFilename) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'dialog-overlay';

    overlay.innerHTML = `
      <div class="dialog-box">
        <div class="dialog-title">Choose download location</div>
        <div class="dialog-body">
          <label>File Name</label>
          <input type="text" id="dlgFilename" value="${escapeHtml(initialFilename)}" spellcheck="false" style="font-family:var(--mono);font-size:12px;" />
          <label>Save to</label>
          <div style="display:flex;gap:8px;">
            <input type="text" id="dlgSaveDir" value="${escapeHtml(initialDir)}" style="flex:1" />
            <button class="btn btn-ghost" id="dlgBrowse">Browse</button>
          </div>
          <div style="display:flex;align-items:center;gap:8px;margin-top:6px;cursor:pointer;" id="dlgDontAskWrap">
            <div class="toggle-box" id="dlgDontAskBox" style="width:16px;height:16px;border:1.5px solid var(--border);border-radius:3px;display:flex;align-items:center;justify-content:center;font-size:10px;transition:all 0.15s;">${skipAskDir ? '&#10003;' : ''}</div>
            <span style="font-size:12px;font-family:var(--mono);color:var(--text-dim);">Don't ask again</span>
          </div>
        </div>
        <div class="dialog-actions">
          <button class="btn btn-ghost" id="dlgCancel">Cancel</button>
          <button class="btn btn-accent" id="dlgConfirm">Download</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    let dontAsk = skipAskDir;
    const box = overlay.querySelector('#dlgDontAskBox');
    const wrap = overlay.querySelector('#dlgDontAskWrap');

    function updateCheckbox() {
      box.innerHTML = dontAsk ? '&#10003;' : '';
      box.style.background = dontAsk ? 'var(--accent)' : 'transparent';
      box.style.borderColor = dontAsk ? 'var(--accent)' : 'var(--border)';
      box.style.color = dontAsk ? '#fff' : '';
    }
    updateCheckbox();

    wrap.addEventListener('click', () => {
      dontAsk = !dontAsk;
      updateCheckbox();
    });

    overlay.querySelector('#dlgBrowse').addEventListener('click', async () => {
      try {
        const { open } = window.__TAURI__.dialog;
        const dir = await open({ directory: true, multiple: false, title: 'Choose download folder' });
        if (dir) overlay.querySelector('#dlgSaveDir').value = dir;
      } catch (e) {
        console.error('Dialog error:', e);
      }
    });

    overlay.querySelector('#dlgCancel').addEventListener('click', () => {
      overlay.remove();
      resolve(null);
    });

    overlay.querySelector('#dlgConfirm').addEventListener('click', () => {
      const dir = overlay.querySelector('#dlgSaveDir').value.trim();
      const filename = overlay.querySelector('#dlgFilename').value.trim();
      if (!dir) return;

      // Persist preferences
      skipAskDir = dontAsk;
      localStorage.setItem('nr_skipAskDir', dontAsk);
      lastSaveDir = dir;
      localStorage.setItem('nr_lastSaveDir', dir);
      saveDirInput.value = dir;

      overlay.remove();
      resolve({ dir, filename });
    });

    // Focus the filename input
    const fnInput = overlay.querySelector('#dlgFilename');
    fnInput.focus();
    // Select just the name part (before the last dot)
    const dotIdx = initialFilename.lastIndexOf('.');
    if (dotIdx > 0) {
      fnInput.setSelectionRange(0, dotIdx);
    } else {
      fnInput.select();
    }

    overlay.querySelectorAll('#dlgFilename, #dlgSaveDir').forEach(el => {
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') overlay.querySelector('#dlgConfirm').click();
        if (e.key === 'Escape') overlay.querySelector('#dlgCancel').click();
      });
    });
  });
}

// ── Speed Limit ──
const speedLimitInput = $('#speedLimit');
if (speedLimitInput) {
  speedLimitInput.addEventListener('change', () => {
    const kbps = Math.max(0, parseInt(speedLimitInput.value, 10) || 0);
    invoke('set_speed_limit', { kbps });
    dbg('info', `Speed limit set to ${kbps === 0 ? 'unlimited' : kbps + ' KB/s'}`);
  });
}

// ── Concurrency Control ──
function getMaxConcurrent() {
  const val = parseInt($('#maxConcurrent')?.value, 10);
  return (val > 0 && val <= 10) ? val : 3;
}

function getActiveCount() {
  return downloads.filter(d => d.status === 'Downloading' || d.status === 'Starting').length;
}

let _startingQueued = false;
async function tryStartQueued() {
  if (_startingQueued) return; // prevent concurrent calls from racing
  _startingQueued = true;
  try {
    const max = getMaxConcurrent();
    const queued = downloads.filter(d => d.status === 'Queued');
    for (const d of queued) {
      const active = getActiveCount(); // re-check each iteration
      if (active >= max) break;
      d.status = 'Downloading'; // optimistically update so next getActiveCount() sees it
      dbg('info', `Starting queued download: ${d.filename || d.id} (slot ${active + 1}/${max})`);
      await invoke('start_queued_download', { id: d.id });
    }
  } finally {
    _startingQueued = false;
  }
}

// ── Add Download ──
async function addDownload() {
  const url = urlInput.value.trim();
  if (!url) return;
  dbg('info', `Add download requested: ${url}`);

  const hls = isHlsUrl(url);
  if (hls) {
    dbg('info', 'Detected HLS/m3u8 stream - will route to ffmpeg');
    try {
      const hasFf = await invoke('check_ffmpeg');
      if (!hasFf) {
        showToast('error', 'ffmpeg not installed', 'This URL is an HLS/m3u8 stream. Install ffmpeg from https://ffmpeg.org/download.html and add it to PATH, then restart Net Reaper.', 12000);
        return;
      }
    } catch (e) { dbg('warn', `check_ffmpeg failed: ${e}`); }
  }

  // Resolve filename - skip the HEAD request if browser extension provided one, or HLS (synthesize)
  let resolvedFilename = 'download';
  if (hls) {
    resolvedFilename = deriveHlsFilename(url);
    dbg('info', `HLS filename derived: ${resolvedFilename}`);
  } else if (_pendingBrowserDownload?.filename) {
    resolvedFilename = _pendingBrowserDownload.filename;
    dbg('info', `Using filename from browser extension: ${resolvedFilename}`);
  } else if (_pendingBrowserDownload) {
    // Extension provided the URL but the browser had not determined a
    // filename yet (we cancelled fast). Derive from URL instead of doing an
    // unauthenticated HEAD that could trip Cloudflare or burn a one-use token.
    try {
      const u = new URL(url);
      const last = (u.pathname.split('/').pop() || 'download');
      resolvedFilename = decodeURIComponent(last) || 'download';
    } catch (_) {
      resolvedFilename = 'download';
    }
    dbg('info', `Derived filename from URL: ${resolvedFilename}`);
  } else {
    try {
      dbg('info', 'Resolving filename...');
      const [name] = await invoke('resolve_filename', { url });
      resolvedFilename = name || 'download';
      dbg('info', `Resolved filename: ${resolvedFilename}`);
    } catch (e) {
      dbg('warn', `Could not resolve filename: ${e}`);
    }
  }

  // Try matching a per-domain/per-extension rule before deciding whether to prompt
  const matchedRule = findMatchingRule(url, resolvedFilename);
  if (matchedRule) {
    dbg('info', `Rule matched: ${matchedRule.pattern} -> ${matchedRule.folder}`);
  }

  let saveDir, filename;

  if (_pendingBrowserDownload?._reuseDir) {
    saveDir = _pendingBrowserDownload._reuseDir;
    filename = resolvedFilename;
    dbg('info', `Reusing directory from failed 401 download: ${saveDir}, file: ${filename}`);
  } else if (matchedRule) {
    saveDir = matchedRule.folder;
    filename = resolvedFilename;
    dbg('info', `Using rule directory: ${saveDir}, file: ${filename}`);
  } else if (skipAskDir && lastSaveDir) {
    saveDir = lastSaveDir;
    filename = resolvedFilename;
    dbg('info', `Using saved directory (don't ask): ${saveDir}, file: ${filename}`);
  } else {
    const initial = lastSaveDir || saveDirInput.value || defaultSaveDir;
    dbg('info', `Showing save dialog, initial: ${initial}`);
    const result = await showSaveDirDialog(initial, resolvedFilename);
    if (!result) {
      dbg('warn', 'User cancelled save dialog');
      return;
    }
    saveDir = result.dir;
    filename = result.filename;
  }

  // Compute scheduled_at if user set a future time
  let scheduledAt = null;
  if (scheduleInput && scheduleInput.value) {
    const dt = new Date(scheduleInput.value);
    if (!isNaN(dt.getTime()) && dt.getTime() > Date.now() + 1000) {
      scheduledAt = dt.toISOString();
      dbg('info', `Scheduled for: ${scheduledAt}`);
    }
  }

  try {
    urlInput.value = '';
    if (scheduleInput && scheduledAt) { scheduleInput.value = ''; scheduleInput.classList.remove('has-value'); scheduleClearBtn.style.display = 'none'; }
    const max = getMaxConcurrent();
    const active = getActiveCount();
    // Don't auto-start if scheduled in the future
    const autoStart = !scheduledAt && active < max;
    // Always send a filename so the backend can skip its own unauthenticated
    // HEAD probe. Falls back to resolvedFilename if the dialog returned the
    // same name.
    const customFilename = filename || resolvedFilename || null;

    const cookies = _pendingBrowserDownload?.cookies || null;
    const method = _pendingBrowserDownload?.method || null;
    const referer = _pendingBrowserDownload?.referer || null;
    const userAgent = _pendingBrowserDownload?.userAgent || null;
    dbg('info', `Invoking add_download: url=${url}, dir=${saveDir}, file=${filename}, autoStart=${autoStart}${scheduledAt ? ` (scheduled ${scheduledAt})` : ''}${hls ? ' [HLS]' : ''}${userAgent ? ' [browser UA]' : ''}`);
    const id = await invoke('add_download', { url, saveDir, filename: customFilename, autoStart, cookies, method, referer, userAgent, scheduledAt, isHls: hls });
    dbg('event', `Download created with id: ${id}${autoStart ? '' : ' (queued)'}`);
    const allDownloads = await invoke('get_downloads');
    downloads = allDownloads;
    const newDl = downloads.find(d => d.id === id);
    if (newDl) addOrUpdateHistory(newDl);
    render();
  } catch (e) {
    dbg('error', `add_download failed: ${e}`);
    globalStatus.textContent = 'Error: ' + e;
  }
}

addBtn.addEventListener('click', addDownload);
urlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addDownload();
});

// ── Bulk Actions ──
pauseAllBtn.addEventListener('click', async () => {
  dbg('info', 'Pause All clicked');
  for (const d of downloads) {
    if (d.status === 'Downloading') {
      dbg('info', `Pausing download: ${d.id} (${d.filename})`);
      await invoke('pause_download', { id: d.id });
    }
  }
});

resumeAllBtn.addEventListener('click', async () => {
  dbg('info', 'Resume All clicked');
  for (const d of downloads) {
    if (d.status === 'Paused') {
      dbg('info', `Resuming download: ${d.id} (${d.filename})`);
      await invoke('resume_download', { id: d.id });
    }
  }
});

clearCompletedBtn.addEventListener('click', async () => {
  const completed = downloads.filter(d =>
    d.status === 'Completed' || d.status === 'Failed' || d.status === 'Cancelled'
  );
  for (const d of completed) {
    await invoke('remove_download', { id: d.id });
  }
  downloads = downloads.filter(d =>
    d.status !== 'Completed' && d.status !== 'Failed' && d.status !== 'Cancelled'
  );
  render();
});

// ── Browse Directory ──
browseDirBtn.addEventListener('click', async () => {
  try {
    const { open } = window.__TAURI__.dialog;
    const dir = await open({ directory: true, multiple: false, title: 'Choose download folder' });
    if (dir) saveDirInput.value = dir;
  } catch (e) {
    // dialog plugin might need to be available
    console.error('Dialog error:', e);
  }
});

// ── Listen for browser extension downloads ──
let _pendingBrowserDownload = null; // { cookies, filename, filesize, method, referer }

listen('browser-download', async (event) => {
  const req = event.payload;
  dbg('event', `Browser extension intercepted download: ${req.url}${req.cookies ? ' (with cookies)' : ''}`);

  // Switch to downloads panel
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  const dlNav = document.querySelector('[data-panel="downloads"]');
  if (dlNav) dlNav.classList.add('active');
  const dlPanel = document.getElementById('panel-downloads');
  if (dlPanel) dlPanel.classList.add('active');

  // Check if there's a recent 401 failure for the same filename - auto-replace it
  const incomingFilename = req.filename || req.url.split('/').pop()?.split('?')[0] || '';
  const failed401 = downloads.find(d =>
    d.status === 'Failed' &&
    d.error && d.error.includes('401') &&
    d.filename === decodeURIComponent(incomingFilename)
  );
  if (failed401) {
    dbg('info', `Auto-replacing failed 401 download: ${failed401.filename} (Cloudflare retry)`);
    const reuseDir = failed401.save_path.replace(/[\\/][^\\/]+$/, '');
    try {
      await invoke('remove_download', { id: failed401.id });
      downloads = downloads.filter(dl => dl.id !== failed401.id);
      delete _smoothedSpeeds[failed401.id];
    } catch (e) {
      dbg('warn', `Failed to remove old 401 download: ${e}`);
    }
    // Proceed with the new download reusing the same save directory
    _pendingBrowserDownload = {
      cookies: req.cookies || null,
      filename: req.filename || null,
      filesize: req.filesize || null,
      method: req.method || null,
      referer: req.referer || null,
      userAgent: req.userAgent || null,
      _reuseDir: reuseDir,
    };
    urlInput.value = req.url;
    await addDownload();
    _pendingBrowserDownload = null;
    return;
  }

  // Store browser context so addDownload() can use it
  _pendingBrowserDownload = {
    cookies: req.cookies || null,
    filename: req.filename || null,
    filesize: req.filesize || null,
    method: req.method || null,
    referer: req.referer || null,
    userAgent: req.userAgent || null,
  };
  urlInput.value = req.url;
  await addDownload();
  _pendingBrowserDownload = null;
});

// ── Listen for progress events from Rust ──
let _lastLoggedStatus = {};
listen('download-progress', (event) => {
  const updated = event.payload;
  const idx = downloads.findIndex(d => d.id === updated.id);

  // Log status changes (not every progress tick)
  const prev = _lastLoggedStatus[updated.id];
  if (prev !== updated.status) {
    _lastLoggedStatus[updated.id] = updated.status;
    const pct = updated.total_bytes > 0 ? ((updated.downloaded_bytes / updated.total_bytes) * 100).toFixed(1) + '%' : '?%';
    if (updated.status === 'Completed') {
      dbg('event', `Download completed: ${updated.filename} (${formatBytes(updated.downloaded_bytes)})`);
      showToast('success', t('toast.complete'), updated.filename);
    } else if (updated.status === 'Failed') {
      dbg('error', `Download failed: ${updated.filename} - ${updated.error || 'unknown error'}`);
      showToast('error', `${t('toast.failed')}: ${updated.filename}`, updated.error || 'Unknown error', 10000);
    } else if (updated.status === 'Cancelled') {
      dbg('warn', `Download cancelled: ${updated.filename}`);
    } else if (updated.status === 'Paused') {
      dbg('info', `Download paused: ${updated.filename} at ${pct}`);
    } else if (updated.status === 'Downloading' && prev === 'Paused') {
      dbg('info', `Download resumed: ${updated.filename} at ${pct}`);
    } else if (updated.status === 'Downloading') {
      dbg('event', `Download started: ${updated.filename} (${updated.total_bytes > 0 ? formatBytes(updated.total_bytes) : 'unknown size'})`);
    }

    // Update history for any status change
    addOrUpdateHistory(updated);

    // When a download finishes, auto-clear from list if enabled, and start queued downloads
    if (updated.status === 'Completed' || updated.status === 'Failed' || updated.status === 'Cancelled') {
      if (autoClearCompleted && updated.status === 'Completed') {
        setTimeout(async () => {
          dbg('info', `Auto-clearing completed download: ${updated.filename}`);
          await invoke('remove_download', { id: updated.id });
          downloads = downloads.filter(d => d.id !== updated.id);
          delete _smoothedSpeeds[updated.id];
          render();
        }, 500);
      }
      setTimeout(() => tryStartQueued(), 100);
    }
  }

  if (idx >= 0) {
    downloads[idx] = updated;
  } else {
    downloads.push(updated);
  }

  // Update EMA smoothed speed
  if (updated.status === 'Downloading') {
    const prev = _smoothedSpeeds[updated.id];
    _smoothedSpeeds[updated.id] = prev !== undefined
      ? Math.round(SMOOTH_ALPHA * updated.speed_bps + (1 - SMOOTH_ALPHA) * prev)
      : updated.speed_bps;
  } else if (updated.status === 'Completed' || updated.status === 'Cancelled' || updated.status === 'Failed') {
    delete _smoothedSpeeds[updated.id];
  }

  render();
});

// ── Disable browser right-click context menu ──
document.addEventListener('contextmenu', (e) => e.preventDefault());

// ── Init ──
async function init() {
  dbg('info', 'Net Reaper initializing...');
  try {
    defaultSaveDir = await invoke('get_default_download_dir');
    saveDirInput.value = lastSaveDir || defaultSaveDir;
    if (!lastSaveDir) lastSaveDir = defaultSaveDir;
    dbg('info', `Default save dir: ${saveDirInput.value}`);
  } catch (e) {
    dbg('error', `Could not get default download dir: ${e}`);
  }

  // Sync saved segments setting to backend
  try {
    const savedSegments = parseInt(localStorage.getItem('nr_segments') || '8', 10);
    const n = Math.max(1, Math.min(16, savedSegments));
    await invoke('set_segments', { count: n });
    dbg('info', `Synced segments to backend: ${n}`);
  } catch (e) { dbg('warn', `set_segments init failed: ${e}`); }

  try {
    downloads = await invoke('get_downloads');
    dbg('info', `Loaded ${downloads.length} existing download(s)`);
    render();
  } catch (e) {
    dbg('error', `Could not get downloads: ${e}`);
  }

  sanitizeStaleHistoryOnStartup();
  renderHistory();

  dbg('info', 'Init complete');
}

// ── Browser Extension CTA ──
function showExtensionSetupGuide() {
  showToast('info', 'Browser Extension Setup', [
    '1. Install the Net Reaper extension from the Chrome Web Store',
    '2. Make sure Net Reaper is running (it registers automatically)',
    '3. Restart your browser once after the first install',
    '4. Click the Net Reaper icon in the toolbar to verify it says "connected"',
  ].join('\n'), 15000);
}
const EXT_STORE_URL = 'https://chromewebstore.google.com/detail/net-reaper-internet-downl/kdojofdpfemlpcelbdbgcpkmjhememnb';

document.getElementById('extDownloadBtn')?.addEventListener('click', () => {
  window.__TAURI__.shell.open(EXT_STORE_URL);
});
document.getElementById('extSetupBtn')?.addEventListener('click', showExtensionSetupGuide);
document.getElementById('footerExtLink')?.addEventListener('click', (e) => {
  e.preventDefault();
  window.__TAURI__.shell.open(EXT_STORE_URL);
});

// ── Footer Links (open externally) ──
document.getElementById('linkEerie').addEventListener('click', (e) => {
  e.preventDefault();
  window.__TAURI__.shell.open('https://eeriegoesd.com');
});
document.getElementById('linkCoffee').addEventListener('click', (e) => {
  e.preventDefault();
  window.__TAURI__.shell.open('https://buymeacoffee.com/eeriegoesd');
});
document.getElementById('linkIssue').addEventListener('click', (e) => {
  e.preventDefault();
  window.__TAURI__.shell.open('https://github.com/EerieGoesD/net-reaper/issues/new?template=bug-report.md');
});
document.getElementById('linkFeedback').addEventListener('click', (e) => {
  e.preventDefault();
  window.__TAURI__.shell.open('https://github.com/EerieGoesD/net-reaper/discussions/new?category=ideas');
});

// ── Language ──
const langSelect = $('#langSelect');
if (langSelect) {
  langSelect.value = currentLang;
  langSelect.addEventListener('change', () => {
    setLanguage(langSelect.value);
    dbg('info', `Language changed to: ${langSelect.value}`);
  });
}
applyTranslations();

init();
