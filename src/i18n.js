const TRANSLATIONS = {
  en: {
    // Sidebar
    'nav.downloads': 'Downloads',
    'nav.history': 'History',
    'nav.settings': 'Settings',
    'nav.debug': 'Debug',

    // Downloads panel
    'dl.urlPlaceholder': 'Paste download URL here\u2026',
    'dl.download': 'Download',
    'dl.pauseAll': 'Pause All',
    'dl.resumeAll': 'Resume All',
    'dl.clearCompleted': 'Clear Completed',
    'dl.autoClear': 'Auto-clear completed',
    'dl.emptyTitle': 'Paste a URL above and hit <strong>Download</strong> to begin',
    'dl.remaining': 'remaining',

    // Download dialog
    'dlg.title': 'Choose download location',
    'dlg.filename': 'File Name',
    'dlg.saveTo': 'Save to',
    'dlg.dontAsk': "Don't ask again",
    'dlg.cancel': 'Cancel',
    'dlg.download': 'Download',
    'dlg.browse': 'Browse',

    // History
    'history.search': 'Search history...',
    'history.clear': 'Clear History',
    'history.empty': 'No download history yet',
    'history.noMatch': 'No matches found',
    'history.redownload': 'Redownload',
    'history.newestFirst': 'Newest first',
    'history.oldestFirst': 'Oldest first',
    'history.largestFirst': 'Largest first',
    'history.smallestFirst': 'Smallest first',
    'history.nameAZ': 'Name A\u2013Z',
    'history.nameZA': 'Name Z\u2013A',

    // Statuses
    'status.Completed': 'Completed',
    'status.Downloading': 'Downloading',
    'status.Paused': 'Paused',
    'status.Failed': 'Failed',
    'status.Cancelled': 'Cancelled',
    'status.Queued': 'Queued',

    // Settings
    'settings.language': 'Language',
    'settings.saveLocation': 'Default Save Location',
    'settings.downloadPrompt': 'Download Prompt',
    'settings.alwaysAsk': 'Always ask where to save',
    'settings.afterDownload': 'After Download',
    'settings.autoClear': 'Auto-clear completed downloads from list',
    'settings.display': 'Display',
    'settings.showGraph': 'Show download speed graph',
    'settings.maxConcurrent': 'Max Concurrent Downloads',
    'settings.speedLimit': 'Speed Limit (KB/s, 0 = unlimited)',
    'settings.developer': 'Developer',
    'settings.debugMode': 'Enable Debug Mode',

    // Debug
    'debug.searchPlaceholder': 'Search logs...',
    'debug.export': 'Export',
    'debug.exportCSV': 'Export as CSV',
    'debug.exportTXT': 'Export as TXT',
    'debug.clear': 'Clear',
    'debug.emptyMsg': 'Debug mode enabled. Logs will appear here in real-time.',

    // Footer
    'footer.madeBy': 'Made by',
    'footer.coffee': 'Buy Me a Coffee',
    'footer.issue': 'Report Issue',
    'footer.feedback': 'Feedback',
    'footer.active': 'active',
    'footer.completed': 'completed',

    // Toast
    'toast.complete': 'Download complete',
    'toast.failed': 'Download failed',

    // Overall progress
    'overall.downloading': 'downloading',
    'overall.queued': 'queued',
    'overall.paused': 'paused',
    'overall.remaining': 'remaining',

    // Time
    'time.s': 's',
    'time.m': 'm',
    'time.h': 'h',
  },

  pt: {
    // Sidebar
    'nav.downloads': 'Transferências',
    'nav.history': 'Histórico',
    'nav.settings': 'Definições',
    'nav.debug': 'Depuração',

    // Downloads panel
    'dl.urlPlaceholder': 'Cole o URL de transferência aqui\u2026',
    'dl.download': 'Transferir',
    'dl.pauseAll': 'Pausar Tudo',
    'dl.resumeAll': 'Retomar Tudo',
    'dl.clearCompleted': 'Limpar Concluídos',
    'dl.autoClear': 'Limpar concluídos automaticamente',
    'dl.emptyTitle': 'Cole um URL acima e clique em <strong>Transferir</strong> para começar',
    'dl.remaining': 'restante',

    // Download dialog
    'dlg.title': 'Escolher local de transferência',
    'dlg.filename': 'Nome do Ficheiro',
    'dlg.saveTo': 'Guardar em',
    'dlg.dontAsk': 'Não perguntar novamente',
    'dlg.cancel': 'Cancelar',
    'dlg.download': 'Transferir',
    'dlg.browse': 'Procurar',

    // History
    'history.search': 'Pesquisar histórico...',
    'history.clear': 'Limpar Histórico',
    'history.empty': 'Sem histórico de transferências',
    'history.noMatch': 'Nenhum resultado encontrado',
    'history.redownload': 'Retransferir',
    'history.newestFirst': 'Mais recentes',
    'history.oldestFirst': 'Mais antigos',
    'history.largestFirst': 'Maiores primeiro',
    'history.smallestFirst': 'Menores primeiro',
    'history.nameAZ': 'Nome A\u2013Z',
    'history.nameZA': 'Nome Z\u2013A',

    // Statuses
    'status.Completed': 'Concluído',
    'status.Downloading': 'A transferir',
    'status.Paused': 'Pausado',
    'status.Failed': 'Falhou',
    'status.Cancelled': 'Cancelado',
    'status.Queued': 'Em fila',

    // Settings
    'settings.language': 'Idioma',
    'settings.saveLocation': 'Local de Transferência Predefinido',
    'settings.downloadPrompt': 'Confirmação de Transferência',
    'settings.alwaysAsk': 'Perguntar sempre onde guardar',
    'settings.afterDownload': 'Após Transferência',
    'settings.autoClear': 'Limpar transferências concluídas automaticamente',
    'settings.display': 'Apresentação',
    'settings.showGraph': 'Mostrar gráfico de velocidade',
    'settings.maxConcurrent': 'Transferências Simultâneas Máximas',
    'settings.speedLimit': 'Limite de Velocidade (KB/s, 0 = ilimitado)',
    'settings.developer': 'Programador',
    'settings.debugMode': 'Ativar Modo de Depuração',

    // Debug
    'debug.searchPlaceholder': 'Pesquisar registos...',
    'debug.export': 'Exportar',
    'debug.exportCSV': 'Exportar como CSV',
    'debug.exportTXT': 'Exportar como TXT',
    'debug.clear': 'Limpar',
    'debug.emptyMsg': 'Modo de depuração ativado. Os registos aparecem aqui em tempo real.',

    // Footer
    'footer.madeBy': 'Feito por',
    'footer.coffee': 'Ofereça-me um Café',
    'footer.issue': 'Reportar Problema',
    'footer.feedback': 'Feedback',
    'footer.active': 'ativas',
    'footer.completed': 'concluídas',

    // Toast
    'toast.complete': 'Transferência concluída',
    'toast.failed': 'Transferência falhou',

    // Overall progress
    'overall.downloading': 'a transferir',
    'overall.queued': 'em fila',
    'overall.paused': 'pausadas',
    'overall.remaining': 'restante',

    // Time
    'time.s': 's',
    'time.m': 'm',
    'time.h': 'h',
  }
};

let currentLang = localStorage.getItem('nr_lang') || 'en';

function t(key) {
  return (TRANSLATIONS[currentLang] && TRANSLATIONS[currentLang][key])
    || (TRANSLATIONS.en[key])
    || key;
}

function setLanguage(lang) {
  currentLang = lang;
  localStorage.setItem('nr_lang', lang);
  applyTranslations();
}

function applyTranslations() {
  // Sidebar nav items
  document.querySelector('[data-panel="downloads"]').lastChild.textContent = '\n        ' + t('nav.downloads') + '\n      ';
  document.querySelector('[data-panel="history"]').lastChild.textContent = '\n        ' + t('nav.history') + '\n      ';
  document.querySelector('[data-panel="settings"]').lastChild.textContent = '\n        ' + t('nav.settings') + '\n      ';
  document.querySelector('[data-panel="debug"]').lastChild.textContent = '\n        ' + t('nav.debug') + '\n      ';

  // Downloads
  const urlInput = document.getElementById('urlInput');
  if (urlInput) urlInput.placeholder = t('dl.urlPlaceholder');
  const addBtn = document.getElementById('addBtn');
  if (addBtn) addBtn.textContent = t('dl.download');
  const pauseAllBtn = document.getElementById('pauseAllBtn');
  if (pauseAllBtn) pauseAllBtn.textContent = t('dl.pauseAll');
  const resumeAllBtn = document.getElementById('resumeAllBtn');
  if (resumeAllBtn) resumeAllBtn.textContent = t('dl.resumeAll');
  const clearCompletedBtn = document.getElementById('clearCompletedBtn');
  if (clearCompletedBtn) clearCompletedBtn.textContent = t('dl.clearCompleted');
  const autoClearSpanDl = document.querySelector('#autoClearToggleDl span');
  if (autoClearSpanDl) autoClearSpanDl.textContent = t('dl.autoClear');
  const emptyP = document.querySelector('#emptyState p');
  if (emptyP) emptyP.innerHTML = t('dl.emptyTitle');

  // History
  const histSearch = document.getElementById('historySearch');
  if (histSearch) histSearch.placeholder = t('history.search');
  const histClear = document.getElementById('historyClearBtn');
  if (histClear) histClear.textContent = t('history.clear');
  const histSort = document.getElementById('historySort');
  if (histSort) {
    histSort.options[0].textContent = t('history.newestFirst');
    histSort.options[1].textContent = t('history.oldestFirst');
    histSort.options[2].textContent = t('history.largestFirst');
    histSort.options[3].textContent = t('history.smallestFirst');
    histSort.options[4].textContent = t('history.nameAZ');
    histSort.options[5].textContent = t('history.nameZA');
  }
  document.querySelectorAll('.history-filter-btn').forEach(btn => {
    btn.textContent = t('status.' + btn.dataset.status);
  });

  // Settings labels
  document.querySelectorAll('[data-i18n]').forEach(el => {
    el.textContent = t(el.dataset.i18n);
  });
  const askDirSpan = document.querySelector('#askDirToggleWrap span');
  if (askDirSpan) askDirSpan.textContent = t('settings.alwaysAsk');
  const autoClearSpanSettings = document.querySelector('#autoClearToggleSettings span');
  if (autoClearSpanSettings) autoClearSpanSettings.textContent = t('settings.autoClear');
  const graphSpan = document.querySelector('#speedGraphToggleSettings span');
  if (graphSpan) graphSpan.textContent = t('settings.showGraph');
  const debugSpan = document.querySelector('#debugToggleWrap span');
  if (debugSpan) debugSpan.textContent = t('settings.debugMode');

  // Settings labels without data-i18n
  const labels = document.querySelectorAll('#panel-settings .setting-group label');
  const labelKeys = ['settings.language', 'settings.saveLocation', 'settings.downloadPrompt', 'settings.afterDownload', 'settings.display', 'settings.maxConcurrent', 'settings.speedLimit', 'settings.developer'];
  labels.forEach((label, i) => {
    if (labelKeys[i]) label.textContent = t(labelKeys[i]);
  });

  // Debug
  const debugSearch = document.getElementById('debugSearch');
  if (debugSearch) debugSearch.placeholder = t('debug.searchPlaceholder');
  const debugExportBtn = document.getElementById('debugExportBtn');
  if (debugExportBtn) debugExportBtn.textContent = t('debug.export');
  const debugClearBtn = document.getElementById('debugClearBtn');
  if (debugClearBtn) debugClearBtn.textContent = t('debug.clear');

  // Footer
  const footerLinks = document.querySelector('.footer-links');
  if (footerLinks) {
    footerLinks.querySelector('span:first-child').textContent = t('footer.madeBy');
    document.getElementById('linkCoffee').textContent = t('footer.coffee');
    document.getElementById('linkIssue').textContent = t('footer.issue');
    document.getElementById('linkFeedback').textContent = t('footer.feedback');
  }

  document.documentElement.lang = currentLang;
}
