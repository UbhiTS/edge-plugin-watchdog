document.addEventListener('DOMContentLoaded', () => {
  const stopAllBtn = document.getElementById('stopAllBtn');
  const monitorsSection = document.getElementById('monitorsSection');
  const monitorsList = document.getElementById('monitorsList');
  const monitorCount = document.getElementById('monitorCount');
  const historySection = document.getElementById('historySection');
  const historyList = document.getElementById('historyList');
  const historyCount = document.getElementById('historyCount');
  const clearHistoryBtn = document.getElementById('clearHistoryBtn');
  const consoleBody = document.getElementById('consoleBody');
  const consolePanel = document.getElementById('consolePanel');
  const logFilter = document.getElementById('logFilter');
  const clearLogsBtn = document.getElementById('clearLogsBtn');
  const autoScrollToggle = document.getElementById('autoScrollToggle');
  const loggingToggle = document.getElementById('loggingToggle');
  const consoleCollapseBtn = document.getElementById('consoleCollapseBtn');

  const resizeHandle = document.getElementById('resizeHandle');

  let updateInterval = null;
  let autoScroll = true;
  let lastLogCount = 0;
  let loggingEnabled = true;
  let consoleCollapsed = false;

  // --- Resize Handle ---
  let isResizing = false;

  resizeHandle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    isResizing = true;
    resizeHandle.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });

  document.addEventListener('mousemove', (e) => {
    if (!isResizing) return;
    const containerRect = document.querySelector('.dashboard-layout').getBoundingClientRect();
    const newWidth = containerRect.right - e.clientX;
    const minW = 200;
    const maxW = containerRect.width * 0.8;
    const clamped = Math.max(minW, Math.min(maxW, newWidth));
    consolePanel.style.width = clamped + 'px';
  });

  document.addEventListener('mouseup', () => {
    if (!isResizing) return;
    isResizing = false;
    resizeHandle.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });

  // --- Console Panel ---

  // Collapse / Expand
  let preCollapseLoggingState = true;

  consoleCollapseBtn.addEventListener('click', () => {
    consoleCollapsed = !consoleCollapsed;
    consolePanel.classList.toggle('collapsed', consoleCollapsed);
    resizeHandle.classList.toggle('hidden', consoleCollapsed);
    consoleCollapseBtn.textContent = consoleCollapsed ? '\u25C0' : '\u25B6';
    consoleCollapseBtn.title = consoleCollapsed ? 'Expand console' : 'Collapse console';

    if (consoleCollapsed) {
      // Save current logging state and disable
      preCollapseLoggingState = loggingEnabled;
      if (loggingEnabled) {
        loggingEnabled = false;
        updateLoggingToggleUI();
        chrome.runtime.sendMessage({ action: 'setLoggingEnabled', enabled: false });
      }
    } else {
      // Restore previous logging state
      if (preCollapseLoggingState && !loggingEnabled) {
        loggingEnabled = true;
        updateLoggingToggleUI();
        chrome.runtime.sendMessage({ action: 'setLoggingEnabled', enabled: true });
      }
    }
  });

  // Logging toggle
  chrome.runtime.sendMessage({ action: 'getLoggingEnabled' }, (response) => {
    if (response) {
      loggingEnabled = response.enabled;
      updateLoggingToggleUI();
    }
  });

  function updateLoggingToggleUI() {
    loggingToggle.classList.toggle('active', loggingEnabled);
    loggingToggle.classList.toggle('inactive', !loggingEnabled);
    loggingToggle.textContent = loggingEnabled ? '\uD83D\uDCDD On' : '\uD83D\uDCDD Off';
    loggingToggle.title = loggingEnabled ? 'Logging enabled — click to disable' : 'Logging disabled — click to enable';
  }

  loggingToggle.addEventListener('click', () => {
    loggingEnabled = !loggingEnabled;
    updateLoggingToggleUI();
    chrome.runtime.sendMessage({ action: 'setLoggingEnabled', enabled: loggingEnabled });
  });

  autoScrollToggle.addEventListener('click', () => {
    autoScroll = !autoScroll;
    autoScrollToggle.classList.toggle('active', autoScroll);
    autoScrollToggle.classList.toggle('inactive', !autoScroll);
    autoScrollToggle.textContent = autoScroll ? '⬇ Auto' : '⬇ Off';
    if (autoScroll) {
      consoleBody.scrollTop = consoleBody.scrollHeight;
    }
  });

  clearLogsBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'clearLogs' }, () => {
      consoleBody.innerHTML = '<div class="no-logs">Logs cleared.</div>';
      lastLogCount = 0;
    });
  });

  const MAX_DISPLAY_LOGS = 200;

  function loadLogs() {
    const filter = logFilter.value;
    chrome.runtime.sendMessage({ action: 'getLogs', filter }, (response) => {
      if (chrome.runtime.lastError || !response) return;
      const allLogs = response.logs || [];

      // Only keep the most recent entries to avoid DOM bloat
      const logs = allLogs.length > MAX_DISPLAY_LOGS ? allLogs.slice(-MAX_DISPLAY_LOGS) : allLogs;

      if (logs.length === 0) {
        if (lastLogCount !== 0) {
          consoleBody.innerHTML = '<div class="no-logs">No logs yet. Logs will appear as the extension runs.</div>';
          lastLogCount = 0;
        }
        return;
      }

      // Only re-render if log count changed
      if (allLogs.length === lastLogCount) return;
      lastLogCount = allLogs.length;

      let html = '';
      for (const entry of logs) {
        const time = new Date(entry.timestamp).toLocaleTimeString();
        const levelClass = entry.level === 'error' ? 'log-error' : entry.level === 'warn' ? 'log-warn' : 'log-info';
        const source = entry.source || 'bg';
        html += `<div class="log-entry ${levelClass}"><span class="log-time">${time}</span><span class="log-source">[${escapeHtml(source)}]</span>${escapeHtml(entry.message)}</div>`;
      }
      consoleBody.innerHTML = html;

      if (autoScroll) {
        consoleBody.scrollTop = consoleBody.scrollHeight;
      }
    });
  }

  logFilter.addEventListener('change', () => {
    lastLogCount = 0; // Force re-render
    loadLogs();
  });

  // --- Monitors ---

  stopAllBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'stopAllMonitoring' }, () => {
      loadMonitors();
      loadHistory();
    });
  });

  clearHistoryBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'clearHistory' }, () => {
      loadHistory();
    });
  });

  function loadMonitors() {
    chrome.runtime.sendMessage({ action: 'getAllMonitors' }, (response) => {
      if (chrome.runtime.lastError || !response) return;
      const monitors = response.monitors || {};
      const monitorIds = Object.keys(monitors);

      monitorCount.textContent = monitorIds.length;

      if (monitorIds.length === 0) {
        monitorsList.innerHTML = '<div class="no-monitors">No active monitors. Use the popup to start monitoring a page.</div>';
        stopAllBtn.style.display = 'none';
        saveConfigBtn.style.display = 'none';
        return;
      }

      stopAllBtn.style.display = 'block';
      saveConfigBtn.style.display = 'block';

      monitorsList.innerHTML = buildMonitorGroupsHtml(monitors, 80);
      const onUpdate = () => { loadMonitors(); loadHistory(); };
      attachMonitorListeners(monitorsList, onUpdate);
    });
  }

  // --- History ---

  function loadHistory() {
    chrome.runtime.sendMessage({ action: 'getHistory' }, (response) => {
      if (chrome.runtime.lastError || !response) return;
      const history = response.history || [];

      historyCount.textContent = history.length;

      if (history.length === 0) {
        historySection.style.display = 'none';
        return;
      }

      historySection.style.display = 'block';
      historyList.innerHTML = buildHistoryHtml(history, 60);
    });
  }

  // escapeHtml provided by shared.js

  // --- Saved Configurations ---
  const saveConfigBtn = document.getElementById('saveConfigBtn');
  const savedConfigsSection = document.getElementById('savedConfigsSection');
  const configsList = document.getElementById('configsList');
  const configCount = document.getElementById('configCount');

  saveConfigBtn.addEventListener('click', () => {
    const name = prompt('Name this configuration:', new Date().toLocaleString());
    if (name === null) return;
    saveConfigBtn.disabled = true;
    saveConfigBtn.textContent = 'Saving...';
    chrome.runtime.sendMessage({ action: 'saveConfig', name: name.trim() || new Date().toLocaleString() }, (response) => {
      saveConfigBtn.disabled = false;
      saveConfigBtn.textContent = '💾 Save Config';
      if (response && response.status === 'saved') {
        saveConfigBtn.style.background = '#4caf50';
        setTimeout(() => { saveConfigBtn.style.background = ''; }, 1000);
        loadSavedConfigs();
      }
    });
  });

  function loadSavedConfigs() {
    chrome.runtime.sendMessage({ action: 'getSavedConfigs' }, (response) => {
      if (chrome.runtime.lastError || !response) return;
      const configs = response.configs || [];
      configCount.textContent = configs.length;

      if (configs.length === 0) {
        savedConfigsSection.style.display = 'none';
        return;
      }

      savedConfigsSection.style.display = 'block';
      configsList.innerHTML = buildConfigsHtml(configs);
      attachConfigListeners(configsList, loadMonitors, loadSavedConfigs);
    });
  }

  // --- Initial load & periodic refresh ---
  loadMonitors();
  loadHistory();
  loadSavedConfigs();
  loadLogs();

  updateInterval = setInterval(() => {
    loadMonitors();
    loadHistory();
    loadLogs();
  }, 2000);
});
