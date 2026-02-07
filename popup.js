document.addEventListener('DOMContentLoaded', () => {
  const addBtn = document.getElementById('addBtn');
  const stopAllBtn = document.getElementById('stopAllBtn');
  const addTermBtn = document.getElementById('addTermBtn');
  const termsBuilder = document.getElementById('termsBuilder');
  const intervalSelect = document.getElementById('interval');
  const monitorsSection = document.getElementById('monitorsSection');
  const monitorsList = document.getElementById('monitorsList');
  const monitorCount = document.getElementById('monitorCount');
  const currentTabInfo = document.getElementById('currentTabInfo');
  const historySection = document.getElementById('historySection');
  const historyList = document.getElementById('historyList');
  const historyCount = document.getElementById('historyCount');
  const clearHistoryBtn = document.getElementById('clearHistoryBtn');
  const savedConfigHint = document.getElementById('savedConfigHint');

  let currentTabId = null;
  let currentTabUrl = '';
  let currentTabTitle = '';
  let updateInterval = null;
  let initialFocusDone = false;

  console.log('Popup loaded');

  // Open full dashboard
  const openDashboardBtn = document.getElementById('openDashboardBtn');
  if (openDashboardBtn) {
    openDashboardBtn.addEventListener('click', () => {
      chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
      window.close();
    });
  }

  // --- Search Terms Builder ---

  // Normalize URL for config storage (origin + pathname, no query/hash)
  function normalizeUrl(url) {
    try {
      const u = new URL(url);
      return u.origin + u.pathname.replace(/\/$/, '');
    } catch (e) {
      return url;
    }
  }

  // Save the current search config for this URL
  function saveSearchConfig(url, searchTerms, interval) {
    const key = normalizeUrl(url);
    chrome.storage.local.get(['urlSearchConfigs'], (result) => {
      const configs = result.urlSearchConfigs || {};
      configs[key] = { searchTerms, interval, savedAt: Date.now() };
      // Keep only the most recent 100 configs
      const keys = Object.keys(configs);
      if (keys.length > 100) {
        const sorted = keys.sort((a, b) => (configs[a].savedAt || 0) - (configs[b].savedAt || 0));
        for (let i = 0; i < sorted.length - 100; i++) {
          delete configs[sorted[i]];
        }
      }
      chrome.storage.local.set({ urlSearchConfigs: configs });
    });
  }

  // Load saved search config for this URL
  function loadSearchConfig(url, callback) {
    const key = normalizeUrl(url);
    chrome.storage.local.get(['urlSearchConfigs'], (result) => {
      const configs = result.urlSearchConfigs || {};
      callback(configs[key] || null);
    });
  }

  // Create a term row element
  function createTermRow(operator, termValue) {
    const row = document.createElement('div');
    row.className = 'term-row';

    const isFirst = termsBuilder.children.length === 0;

    if (!isFirst) {
      const opSelect = document.createElement('select');
      opSelect.className = 'operator-select';
      opSelect.innerHTML = '<option value="AND">AND</option><option value="OR">OR</option>';
      opSelect.value = operator || 'AND';
      row.appendChild(opSelect);
    }

    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = isFirst ? 'Search text (e.g., RTX 5090)' : 'Another term...';
    input.value = termValue || '';
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        startMonitoring();
      }
    });
    row.appendChild(input);

    if (!isFirst) {
      const removeBtn = document.createElement('button');
      removeBtn.className = 'remove-term-btn';
      removeBtn.textContent = '✕';
      removeBtn.title = 'Remove this term';
      removeBtn.addEventListener('click', () => {
        row.remove();
      });
      row.appendChild(removeBtn);
    }

    return row;
  }

  // Add the first empty term row
  function initTermsBuilder() {
    termsBuilder.innerHTML = '';
    termsBuilder.appendChild(createTermRow(null, ''));
  }

  // Populate terms builder from a saved config
  function populateTerms(searchTerms, interval) {
    termsBuilder.innerHTML = '';
    if (!searchTerms || searchTerms.length === 0) {
      initTermsBuilder();
      return;
    }
    for (let i = 0; i < searchTerms.length; i++) {
      const t = searchTerms[i];
      termsBuilder.appendChild(createTermRow(t.operator, t.term));
    }
    if (interval) {
      intervalSelect.value = String(interval);
    }
  }

  // Get current search terms from the UI
  function getSearchTerms() {
    const terms = [];
    const rows = termsBuilder.querySelectorAll('.term-row');
    rows.forEach((row, i) => {
      const input = row.querySelector('input[type="text"]');
      const opSelect = row.querySelector('.operator-select');
      const term = input ? input.value.trim() : '';
      if (term) {
        terms.push({
          term,
          operator: (i === 0) ? null : (opSelect ? opSelect.value : 'AND')
        });
      }
    });
    return terms;
  }

  // Build a display string from searchTerms
  function searchTermsToDisplayText(searchTerms) {
    return searchTerms.map((t, i) => {
      if (i === 0) return t.term;
      return `${t.operator} ${t.term}`;
    }).join(' ');
  }

  addTermBtn.addEventListener('click', () => {
    termsBuilder.appendChild(createTermRow('AND', ''));
    const newInput = termsBuilder.lastElementChild.querySelector('input[type="text"]');
    if (newInput) newInput.focus();
  });

  initTermsBuilder();

  // Get current tab info
  async function loadCurrentTab() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      currentTabId = tab.id;
      currentTabUrl = tab.url || '';
      currentTabTitle = tab.title || '';
      
      // Check how many monitors exist for this tab
      chrome.runtime.sendMessage({ action: 'getAllMonitors' }, (response) => {
        const monitors = response.monitors || {};
        let tabMonitorCount = 0;
        
        for (const monitor of Object.values(monitors)) {
          if (monitor.tabId === currentTabId) {
            tabMonitorCount++;
          }
        }
        
        // Always enable the button - can add multiple monitors per tab
        addBtn.disabled = false;
        addBtn.textContent = tabMonitorCount > 0 ? 'Add Another Monitor' : 'Start Monitoring';
        
        // Only auto-populate on initial load
        if (!initialFocusDone) {
          initialFocusDone = true;
          loadSearchConfig(currentTabUrl, (config) => {
            if (config && config.searchTerms && config.searchTerms.length > 0) {
              populateTerms(config.searchTerms, config.interval);
              savedConfigHint.textContent = '💾 Restored last search config for this URL';
              savedConfigHint.style.display = 'block';
            }
            // Focus the first input
            const firstInput = termsBuilder.querySelector('input[type="text"]');
            if (firstInput) firstInput.focus();
          });
        }
      });
    } catch (err) {
      console.error('Error getting current tab:', err);
    }
  }
  
  loadCurrentTab();

  // Start monitoring function
  async function startMonitoring() {
    const searchTerms = getSearchTerms();
    if (searchTerms.length === 0) {
      alert('Please enter at least one search term!');
      return;
    }
    
    if (!currentTabId) {
      alert('Could not get current tab!');
      return;
    }
    
    const interval = parseInt(intervalSelect.value);
    const displayText = searchTermsToDisplayText(searchTerms);
    
    console.log('Starting monitor for tab:', currentTabId, 'searchTerms:', searchTerms);
    
    // Save config for this URL
    saveSearchConfig(currentTabUrl, searchTerms, interval);
    savedConfigHint.style.display = 'none';
    
    // Start monitoring
    chrome.runtime.sendMessage({
      action: 'startMonitoring',
      tabId: currentTabId,
      searchText: displayText,
      searchTerms: searchTerms,
      refreshInterval: interval,
      url: currentTabUrl,
      title: currentTabTitle
    }, () => {
      // Reload the tab to start checking
      chrome.tabs.reload(currentTabId);
      
      // Update UI
      loadCurrentTab();
      loadMonitors();
      
      // Reset to single empty term for next entry
      initTermsBuilder();
      const firstInput = termsBuilder.querySelector('input[type="text"]');
      if (firstInput) firstInput.focus();
    });
  }

  // Add current tab to monitoring on button click
  addBtn.addEventListener('click', startMonitoring);

  // Stop all monitoring
  stopAllBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'stopAllMonitoring' }, () => {
      loadCurrentTab();
      loadMonitors();
      loadHistory();
    });
  });

  // Clear all history
  clearHistoryBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'clearHistory' }, () => {
      loadHistory();
    });
  });

  // Load and display all monitors
  function loadMonitors() {
    chrome.runtime.sendMessage({ action: 'getAllMonitors' }, (response) => {
      const monitors = response.monitors || {};
      const monitorIds = Object.keys(monitors);
      
      monitorCount.textContent = monitorIds.length;
      
      if (monitorIds.length === 0) {
        monitorsSection.style.display = 'none';
        return;
      }
      
      monitorsSection.style.display = 'block';
      stopAllBtn.style.display = 'block';
      saveConfigBtn.style.display = 'inline-block';
      
      // Group monitors by tab
      const byTab = {};
      for (const [id, monitor] of Object.entries(monitors)) {
        const tabId = monitor.tabId;
        if (!byTab[tabId]) {
          byTab[tabId] = [];
        }
        byTab[tabId].push({ id, ...monitor });
      }
      
      // Build monitor cards
      let html = '';
      for (const [tabId, tabMonitors] of Object.entries(byTab)) {
        const firstMonitor = tabMonitors[0];
        const displayUrl = (firstMonitor.url || 'Unknown URL').length > 45 
          ? (firstMonitor.url || '').substring(0, 45) + '...' 
          : (firstMonitor.url || 'Unknown URL');
        
        // Tab header
        html += `<div class="tab-group">`;
        const faviconUrl = firstMonitor.url ? `https://www.google.com/s2/favicons?domain=${new URL(firstMonitor.url).hostname}&sz=16` : '';
        const faviconImg = faviconUrl ? `<img src="${faviconUrl}" width="16" height="16" style="vertical-align: middle; margin-right: 6px; border-radius: 2px;">` : '🌐 ';
        html += `<div class="tab-header" title="${escapeHtml(firstMonitor.url || '')}">
          ${faviconImg}${escapeHtml(displayUrl)}
        </div>`;
        
        // Individual monitors for this tab
        for (const monitor of tabMonitors) {
          const isFound = monitor.found;
          const isIncognito = monitor.isIncognito;
          
          let countdownText = '';
          if (isFound && monitor.foundAt) {
            const foundDate = new Date(monitor.foundAt);
            countdownText = `📅 ${foundDate.toLocaleString()}`;
          } else if (!isFound && monitor.nextRefreshTime) {
            const remaining = Math.max(0, Math.ceil((monitor.nextRefreshTime - Date.now()) / 1000));
            if (remaining > 0) {
              countdownText = `⏱️ ${remaining}s`;
            } else {
              countdownText = '🔄 Refreshing...';
            }
          }
          
          // InPrivate badge - show when in InPrivate mode
          let inPrivateBadge = '';
          if (isIncognito) {
            inPrivateBadge = `<span class="monitor-status inprivate-badge">🕵️ InPrivate</span>`;
          }
          
          // Found badge - only show when text is found
          const foundBadge = isFound 
            ? `<span class="monitor-status found">🦴 FOUND!</span>`
            : '';
          
          // InPrivate button - only show if not found and not already in InPrivate
          const inPrivateBtn = (!isFound && !isIncognito) 
            ? `<button class="monitor-btn inprivate" data-monitor-id="${monitor.id}">🕵️ InPrivate</button>`
            : '';
          
          // Focus button
          const focusBtn = `<button class="monitor-btn focus tab-focus-btn" data-tab-id="${monitor.tabId}">Focus</button>`;
          
          html += `
            <div class="monitor-card ${isFound ? 'found' : ''}${isIncognito ? ' incognito' : ''}">
              <div class="monitor-header">
                <span class="monitor-search-text">"${escapeHtml(monitor.searchText)}"</span>
                <div class="monitor-badges">
                  ${inPrivateBadge}
                  ${foundBadge}
                </div>
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
      
      // Add event listeners
      monitorsList.querySelectorAll('.monitor-btn.stop').forEach(btn => {
        btn.addEventListener('click', () => {
          const monitorId = btn.dataset.monitorId;
          const isFound = btn.dataset.found === 'true';
          const action = isFound ? 'stopAlarm' : 'stopMonitoring';
          
          chrome.runtime.sendMessage({ action, monitorId }, () => {
            loadCurrentTab();
            loadMonitors();
            loadHistory();
          });
        });
      });
      
      // InPrivate button click handler
      monitorsList.querySelectorAll('.monitor-btn.inprivate:not(.enabled)').forEach(btn => {
        btn.addEventListener('click', () => {
          const monitorId = btn.dataset.monitorId;
          
          chrome.runtime.sendMessage({ action: 'enableInPrivate', monitorId }, () => {
            loadCurrentTab();
            loadMonitors();
          });
        });
      });
      
      monitorsList.querySelectorAll('.tab-focus-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const tabId = parseInt(btn.dataset.tabId);
          // Get the tab to find its window, then focus both window and tab
          chrome.tabs.get(tabId, (tab) => {
            if (tab && tab.windowId) {
              chrome.windows.update(tab.windowId, { focused: true });
            }
            chrome.tabs.update(tabId, { active: true });
          });
        });
      });
    });
  }

  // Helper to escape HTML
  function escapeHtml(text) {
    return String(text).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // Load and display history
  function loadHistory() {
    chrome.runtime.sendMessage({ action: 'getHistory' }, (response) => {
      const history = response.history || [];
      
      historyCount.textContent = history.length;
      
      if (history.length === 0) {
        historySection.style.display = 'none';
        return;
      }
      
      historySection.style.display = 'block';
      
      let html = '';
      for (let i = 0; i < history.length; i++) {
        const item = history[i];
        const foundDate = item.foundAt ? new Date(item.foundAt).toLocaleString() : 'Unknown';
        
        const displayUrl = (item.url || 'Unknown URL').length > 40 
          ? (item.url || '').substring(0, 40) + '...' 
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
      saveConfigBtn.textContent = '💾 Save';
      if (response && response.status === 'saved') {
        saveConfigBtn.style.background = '#4caf50';
        setTimeout(() => { saveConfigBtn.style.background = '#2e7d32'; }, 1000);
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

  // Initial load
  loadMonitors();
  loadHistory();
  loadSavedConfigs();
  
  // Refresh periodically
  updateInterval = setInterval(() => {
    loadMonitors();
    loadHistory();
    loadCurrentTab();
  }, 1000);
});
