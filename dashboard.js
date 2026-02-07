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
  const toggleConsoleBtn = document.getElementById('toggleConsoleBtn');
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

  toggleConsoleBtn.addEventListener('click', () => {
    const collapsed = consolePanel.classList.toggle('collapsed');
    toggleConsoleBtn.textContent = collapsed ? '▶' : '◀';
    resizeHandle.style.display = collapsed ? 'none' : '';
  });

  consolePanel.querySelector('.console-header').addEventListener('click', (e) => {
    if (consolePanel.classList.contains('collapsed')) {
      consolePanel.classList.remove('collapsed');
      toggleConsoleBtn.textContent = '◀';
      resizeHandle.style.display = '';
    }
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

  function loadLogs() {
    const filter = logFilter.value;
    chrome.runtime.sendMessage({ action: 'getLogs', filter }, (response) => {
      if (chrome.runtime.lastError || !response) return;
      const logs = response.logs || [];

      if (logs.length === 0) {
        if (lastLogCount !== 0) {
          consoleBody.innerHTML = '<div class="no-logs">No logs yet. Logs will appear as the extension runs.</div>';
          lastLogCount = 0;
        }
        return;
      }

      // Only re-render if log count changed
      if (logs.length === lastLogCount) return;
      lastLogCount = logs.length;

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
        return;
      }

      stopAllBtn.style.display = 'block';

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
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // --- Initial load & periodic refresh ---
  loadMonitors();
  loadHistory();
  loadLogs();

  updateInterval = setInterval(() => {
    loadMonitors();
    loadHistory();
    loadLogs();
  }, 1000);
});
