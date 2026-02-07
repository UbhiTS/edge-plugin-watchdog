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

  const resizeHandle = document.getElementById('resizeHandle');

  let updateInterval = null;
  let autoScroll = true;
  let lastLogCount = 0;

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

      // Group by tab
      const byTab = {};
      for (const [id, monitor] of Object.entries(monitors)) {
        const tabId = monitor.tabId;
        if (!byTab[tabId]) byTab[tabId] = [];
        byTab[tabId].push({ id, ...monitor });
      }

      let html = '';
      for (const [tabId, tabMonitors] of Object.entries(byTab)) {
        const firstMonitor = tabMonitors[0];
        const displayUrl = (firstMonitor.url || 'Unknown URL').length > 80
          ? (firstMonitor.url || '').substring(0, 80) + '...'
          : (firstMonitor.url || 'Unknown URL');

        html += `<div class="tab-group">`;
        const faviconUrl = firstMonitor.url ? `https://www.google.com/s2/favicons?domain=${new URL(firstMonitor.url).hostname}&sz=16` : '';
        const faviconImg = faviconUrl ? `<img src="${faviconUrl}" width="16" height="16" style="vertical-align: middle; margin-right: 6px; border-radius: 2px;">` : '🌐 ';
        html += `<div class="tab-header" title="${escapeHtml(firstMonitor.url || '')}">${faviconImg}${escapeHtml(displayUrl)}</div>`;

        for (const monitor of tabMonitors) {
          const isFound = monitor.found;
          const isIncognito = monitor.isIncognito;

          let countdownText = '';
          if (isFound && monitor.foundAt) {
            countdownText = `📅 ${new Date(monitor.foundAt).toLocaleString()}`;
          } else if (!isFound && monitor.nextRefreshTime) {
            const remaining = Math.max(0, Math.ceil((monitor.nextRefreshTime - Date.now()) / 1000));
            countdownText = remaining > 0 ? `⏱️ ${remaining}s` : '🔄 Refreshing...';
          }

          let inPrivateBadge = '';
          if (isIncognito) {
            inPrivateBadge = `<span class="monitor-status inprivate-badge">🕵️ InPrivate</span>`;
          }

          const foundBadge = isFound ? `<span class="monitor-status found">🦴 FOUND!</span>` : '';

          const inPrivateBtn = (!isFound && !isIncognito)
            ? `<button class="monitor-btn inprivate" data-monitor-id="${monitor.id}">🕵️ InPrivate</button>`
            : '';

          const focusBtn = `<button class="monitor-btn focus tab-focus-btn" data-tab-id="${monitor.tabId}">Focus</button>`;

          html += `
            <div class="monitor-card ${isFound ? 'found' : ''}${isIncognito ? ' incognito' : ''}">
              <div class="monitor-header">
                <span class="monitor-search-text">"${escapeHtml(monitor.searchText)}"</span>
                <div class="monitor-badges">${inPrivateBadge}${foundBadge}</div>
              </div>
              <div class="monitor-footer">
                <span class="monitor-countdown">${countdownText}</span>
                <div class="monitor-actions">
                  ${inPrivateBtn}
                  ${focusBtn}
                  <button class="monitor-btn stop" data-monitor-id="${monitor.id}" data-found="${isFound}">${isFound ? 'Dismiss' : 'Stop'}</button>
                </div>
              </div>
            </div>
          `;
        }

        html += `</div>`;
      }

      monitorsList.innerHTML = html;
      attachMonitorListeners();
    });
  }

  function attachMonitorListeners() {
    monitorsList.querySelectorAll('.monitor-btn.stop').forEach(btn => {
      btn.addEventListener('click', () => {
        const monitorId = btn.dataset.monitorId;
        const isFound = btn.dataset.found === 'true';
        chrome.runtime.sendMessage({ action: isFound ? 'stopAlarm' : 'stopMonitoring', monitorId }, () => {
          loadMonitors();
          loadHistory();
        });
      });
    });

    monitorsList.querySelectorAll('.monitor-btn.inprivate:not(.enabled)').forEach(btn => {
      btn.addEventListener('click', () => {
        chrome.runtime.sendMessage({ action: 'enableInPrivate', monitorId: btn.dataset.monitorId }, () => {
          loadMonitors();
        });
      });
    });

    monitorsList.querySelectorAll('.tab-focus-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const tabId = parseInt(btn.dataset.tabId);
        chrome.tabs.get(tabId, (tab) => {
          if (tab && tab.windowId) chrome.windows.update(tab.windowId, { focused: true });
          chrome.tabs.update(tabId, { active: true });
        });
      });
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

      let html = '';
      for (const item of history) {
        const foundDate = item.foundAt ? new Date(item.foundAt).toLocaleString() : 'Unknown';
        const displayUrl = (item.url || 'Unknown URL').length > 60
          ? (item.url || '').substring(0, 60) + '...'
          : (item.url || 'Unknown URL');

        html += `
          <div class="history-card">
            <div class="history-header">
              <span class="history-search-text">"${escapeHtml(item.searchText)}"</span>
            </div>
            <div class="history-time">📅 Found: ${foundDate}</div>
            <div class="history-time" title="${escapeHtml(item.url || '')}">${escapeHtml(displayUrl)}</div>
          </div>
        `;
      }

      historyList.innerHTML = html;
    });
  }

  function escapeHtml(text) {
    return String(text).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

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
      let html = '';
      for (const config of configs.slice().reverse()) {
        const count = config.monitors.length;
        const inPrivate = config.monitors.filter(m => m.isIncognito).length;
        const urls = [...new Set(config.monitors.map(m => {
          try { return new URL(m.url).hostname; } catch { return m.url; }
        }))].join(', ');
        let detail = `${count} monitor${count !== 1 ? 's' : ''}`;
        if (inPrivate > 0) detail += ` (${inPrivate} InPrivate)`;
        detail += ` · ${urls}`;

        html += `
          <div class="config-card">
            <div class="config-name">${escapeHtml(config.name)}</div>
            <div class="config-detail">${escapeHtml(detail)}</div>
            <div class="config-actions">
              <button class="config-btn restore" data-config-id="${config.id}">▶ Restore</button>
              <button class="config-btn delete" data-config-id="${config.id}">✕ Delete</button>
            </div>
          </div>
        `;
      }
      configsList.innerHTML = html;

      configsList.querySelectorAll('.config-btn.restore').forEach(btn => {
        btn.addEventListener('click', () => {
          btn.disabled = true;
          btn.textContent = 'Restoring...';
          chrome.runtime.sendMessage({ action: 'restoreConfig', configId: btn.dataset.configId }, () => {
            btn.disabled = false;
            btn.textContent = '▶ Restore';
            loadMonitors();
          });
        });
      });

      configsList.querySelectorAll('.config-btn.delete').forEach(btn => {
        btn.addEventListener('click', () => {
          chrome.runtime.sendMessage({ action: 'deleteConfig', configId: btn.dataset.configId }, () => {
            loadSavedConfigs();
          });
        });
      });
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
