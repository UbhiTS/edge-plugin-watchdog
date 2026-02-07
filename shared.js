// shared.js - Common utilities for popup and dashboard

function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function truncateUrl(url, maxLen) {
  const u = url || 'Unknown URL';
  return u.length > maxLen ? u.substring(0, maxLen) + '...' : u;
}

function buildMonitorGroupsHtml(monitors, urlMaxLen) {
  const byTab = {};
  for (const [id, monitor] of Object.entries(monitors)) {
    const tabId = monitor.tabId;
    if (!byTab[tabId]) byTab[tabId] = [];
    byTab[tabId].push({ id, ...monitor });
  }

  let html = '';
  for (const tabMonitors of Object.values(byTab)) {
    const first = tabMonitors[0];
    const displayUrl = truncateUrl(first.url, urlMaxLen);
    let faviconImg = '🌐 ';
    try {
      const hostname = new URL(first.url).hostname;
      faviconImg = `<img src="https://www.google.com/s2/favicons?domain=${hostname}&sz=16" width="16" height="16" style="vertical-align:middle;margin-right:6px;border-radius:2px;">`;
    } catch (e) {}

    html += `<div class="tab-group"><div class="tab-header" title="${escapeHtml(first.url || '')}">${faviconImg}${escapeHtml(displayUrl)}</div>`;

    for (const monitor of tabMonitors) {
      const isFound = monitor.found;
      const isIncognito = monitor.isIncognito;

      let countdown = '';
      if (isFound && monitor.foundAt) {
        countdown = `📅 ${new Date(monitor.foundAt).toLocaleString()}`;
      } else if (!isFound && monitor.nextRefreshTime) {
        const rem = Math.max(0, Math.ceil((monitor.nextRefreshTime - Date.now()) / 1000));
        countdown = rem > 0 ? `⏱️ ${rem}s` : '🔄 Refreshing...';
      }

      html += `
        <div class="monitor-card${isFound ? ' found' : ''}${isIncognito ? ' incognito' : ''}">
          <div class="monitor-header">
            <span class="monitor-search-text">"${escapeHtml(monitor.searchText)}"</span>
            <div class="monitor-badges">
              ${isIncognito ? '<span class="monitor-status inprivate-badge">🕵️ InPrivate</span>' : ''}
              ${isFound ? '<span class="monitor-status found">🦴 FOUND!</span>' : ''}
            </div>
          </div>
          <div class="monitor-footer">
            <span class="monitor-countdown">${countdown}</span>
            <div class="monitor-actions">
              ${!isFound && !isIncognito ? `<button class="monitor-btn inprivate" data-monitor-id="${monitor.id}">🕵️ InPrivate</button>` : ''}
              <button class="monitor-btn focus tab-focus-btn" data-tab-id="${monitor.tabId}">Focus</button>
              <button class="monitor-btn stop" data-monitor-id="${monitor.id}" data-found="${isFound}">${isFound ? 'Dismiss' : 'Stop'}</button>
            </div>
          </div>
        </div>`;
    }

    html += `</div>`;
  }
  return html;
}

function buildHistoryHtml(history, urlMaxLen) {
  let html = '';
  for (const item of history) {
    const foundDate = item.foundAt ? new Date(item.foundAt).toLocaleString() : 'Unknown';
    const displayUrl = truncateUrl(item.url, urlMaxLen);
    html += `
      <div class="history-card">
        <div class="history-header"><span class="history-search-text">"${escapeHtml(item.searchText)}"</span></div>
        <div class="history-time">📅 Found: ${foundDate}</div>
        <div class="history-time" title="${escapeHtml(item.url || '')}">${escapeHtml(displayUrl)}</div>
      </div>`;
  }
  return html;
}

function buildConfigsHtml(configs) {
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
      </div>`;
  }
  return html;
}

function attachMonitorListeners(container, onUpdate) {
  container.querySelectorAll('.monitor-btn.stop').forEach(btn => {
    btn.addEventListener('click', () => {
      const isFound = btn.dataset.found === 'true';
      chrome.runtime.sendMessage({ action: isFound ? 'stopAlarm' : 'stopMonitoring', monitorId: btn.dataset.monitorId }, onUpdate);
    });
  });

  container.querySelectorAll('.monitor-btn.inprivate:not(.enabled)').forEach(btn => {
    btn.addEventListener('click', () => {
      chrome.runtime.sendMessage({ action: 'enableInPrivate', monitorId: btn.dataset.monitorId }, onUpdate);
    });
  });

  container.querySelectorAll('.tab-focus-btn').forEach(btn => {
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

function attachConfigListeners(container, onRestore, onDelete) {
  container.querySelectorAll('.config-btn.restore').forEach(btn => {
    btn.addEventListener('click', () => {
      btn.disabled = true;
      btn.textContent = 'Restoring...';
      chrome.runtime.sendMessage({ action: 'restoreConfig', configId: btn.dataset.configId }, () => {
        btn.disabled = false;
        btn.textContent = '▶ Restore';
        if (onRestore) onRestore();
      });
    });
  });

  container.querySelectorAll('.config-btn.delete').forEach(btn => {
    btn.addEventListener('click', () => {
      chrome.runtime.sendMessage({ action: 'deleteConfig', configId: btn.dataset.configId }, () => {
        if (onDelete) onDelete();
      });
    });
  });
}
