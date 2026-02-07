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
      
      monitorsList.innerHTML = buildMonitorGroupsHtml(monitors, 45);
      const onUpdate = () => { loadCurrentTab(); loadMonitors(); loadHistory(); };
      attachMonitorListeners(monitorsList, onUpdate);
    });
  }

  // Helper to escape HTML
  // (provided by shared.js)

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
      historyList.innerHTML = buildHistoryHtml(history, 40);
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
      configsList.innerHTML = buildConfigsHtml(configs);
      attachConfigListeners(configsList, loadMonitors, loadSavedConfigs);
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
