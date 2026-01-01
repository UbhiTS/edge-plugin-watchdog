document.addEventListener('DOMContentLoaded', () => {
  const addBtn = document.getElementById('addBtn');
  const stopAllBtn = document.getElementById('stopAllBtn');
  const searchTextInput = document.getElementById('searchText');
  const intervalSelect = document.getElementById('interval');
  const monitorsSection = document.getElementById('monitorsSection');
  const monitorsList = document.getElementById('monitorsList');
  const monitorCount = document.getElementById('monitorCount');
  const currentTabInfo = document.getElementById('currentTabInfo');
  const historySection = document.getElementById('historySection');
  const historyList = document.getElementById('historyList');
  const historyCount = document.getElementById('historyCount');
  const clearHistoryBtn = document.getElementById('clearHistoryBtn');
  
  let currentTabId = null;
  let currentTabUrl = '';
  let currentTabTitle = '';
  let updateInterval = null;
  let initialFocusDone = false;

  console.log('Popup loaded');

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
        
        const displayUrl = currentTabUrl.length > 50 
          ? currentTabUrl.substring(0, 50) + '...' 
          : currentTabUrl;
        
        if (tabMonitorCount > 0) {
          currentTabInfo.textContent = `✓ ${tabMonitorCount} monitor(s) on this tab`;
          currentTabInfo.className = 'current-tab-info monitoring';
        } else {
          currentTabInfo.textContent = 'Current: ' + displayUrl;
          currentTabInfo.className = 'current-tab-info';
        }
        
        // Always enable the button - can add multiple monitors per tab
        addBtn.disabled = false;
        addBtn.textContent = tabMonitorCount > 0 ? 'Add Another Monitor' : 'Start Monitoring';
        
        // Only focus on initial load, not on subsequent updates
        if (!initialFocusDone && !searchTextInput.value) {
          searchTextInput.focus();
          initialFocusDone = true;
        }
      });
    } catch (err) {
      console.error('Error getting current tab:', err);
      currentTabInfo.textContent = 'Could not get tab info';
    }
  }
  
  loadCurrentTab();

  // Start monitoring function
  async function startMonitoring() {
    const searchText = searchTextInput.value.trim();
    if (!searchText) {
      alert('Please enter a search text!');
      return;
    }
    
    if (!currentTabId) {
      alert('Could not get current tab!');
      return;
    }
    
    const interval = parseInt(intervalSelect.value);
    
    console.log('Starting monitor for tab:', currentTabId, 'searchText:', searchText);
    
    // Start monitoring
    chrome.runtime.sendMessage({
      action: 'startMonitoring',
      tabId: currentTabId,
      searchText: searchText,
      refreshInterval: interval,
      url: currentTabUrl,
      title: currentTabTitle
    }, () => {
      // Reload the tab to start checking
      chrome.tabs.reload(currentTabId);
      
      // Update UI
      loadCurrentTab();
      loadMonitors();
      
      // Clear input for next entry
      searchTextInput.value = '';
      searchTextInput.focus();
    });
  }

  // Add current tab to monitoring on button click
  addBtn.addEventListener('click', startMonitoring);

  // Start monitoring on Enter key in search text input
  searchTextInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      startMonitoring();
    }
  });

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
        html += `<div class="tab-header" title="${escapeHtml(firstMonitor.url || '')}">
          🌐 ${escapeHtml(displayUrl)}
          <button class="monitor-btn focus tab-focus-btn" data-tab-id="${tabId}">Focus</button>
        </div>`;
        
        // Individual monitors for this tab
        for (const monitor of tabMonitors) {
          const isFound = monitor.found;
          
          let countdownText = '';
          if (isFound && monitor.foundAt) {
            const foundDate = new Date(monitor.foundAt);
            countdownText = `📅 ${foundDate.toLocaleString()}`;
          } else if (!isFound && monitor.nextRefreshTime) {
            const remaining = Math.max(0, Math.ceil((monitor.nextRefreshTime - Date.now()) / 1000));
            countdownText = remaining > 0 ? `⏱️ ${remaining}s` : '🔄 Refreshing...';
          }
          
          html += `
            <div class="monitor-card ${isFound ? 'found' : ''}">
              <div class="monitor-header">
                <span class="monitor-search-text">"${escapeHtml(monitor.searchText)}"</span>
                <span class="monitor-status ${isFound ? 'found' : 'active'}">
                  ${isFound ? '🦴 FOUND!' : '🔄 Active'}
                </span>
              </div>
              <div class="monitor-footer">
                <span class="monitor-countdown">${countdownText}</span>
                <div class="monitor-actions">
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
      
      monitorsList.querySelectorAll('.tab-focus-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const tabId = parseInt(btn.dataset.tabId);
          chrome.tabs.update(tabId, { active: true });
        });
      });
    });
  }

  // Helper to escape HTML
  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
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
            <div class="history-footer">
              <button class="monitor-btn close" data-index="${i}">✕ Close</button>
            </div>
          </div>
        `;
      }
      
      historyList.innerHTML = html;
      
      historyList.querySelectorAll('.monitor-btn.close').forEach(btn => {
        btn.addEventListener('click', () => {
          const index = parseInt(btn.dataset.index);
          chrome.runtime.sendMessage({ action: 'removeFromHistory', index }, () => {
            loadHistory();
          });
        });
      });
    });
  }

  // Initial load
  loadMonitors();
  loadHistory();
  
  // Refresh periodically
  updateInterval = setInterval(() => {
    loadMonitors();
    loadHistory();
    loadCurrentTab();
  }, 1000);
});
