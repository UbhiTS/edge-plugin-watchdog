// Background service worker for managing multiple monitors (multiple per tab supported)

let creatingOffscreen = false;

// In-memory timers for each tab (one timer per tab, uses shortest interval)
const refreshTimers = new Map();

// Tabs being intentionally closed for InPrivate session reset (don't clean up monitors)
const tabsBeingReset = new Set();

// Watchdog timer to detect stuck refreshes
let stuckWatchdogTimer = null;
const STUCK_THRESHOLD_MS = 30000; // Consider stuck if 30 seconds past expected refresh
const WATCHDOG_CHECK_INTERVAL_MS = 10000; // Check every 10 seconds

// --- Console Log Capture ---
const MAX_LOG_ENTRIES = 500;
let logBuffer = [];
let loggingEnabled = true;

function trimLogBuffer() {
  if (logBuffer.length > MAX_LOG_ENTRIES) {
    logBuffer.splice(0, logBuffer.length - MAX_LOG_ENTRIES);
  }
}

function wdLog(...args) {
  if (!loggingEnabled) return;
  const message = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
  logBuffer.push({ timestamp: Date.now(), message, source: 'background', level: 'info' });
  trimLogBuffer();
  console.log('[WD:background]', ...args);
}

// Generate unique ID
function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

// --- InPrivate Window Geometry Persistence ---
// Maps InPrivate windowId -> normalized URL (for onBoundsChanged lookups)
const incognitoWindowUrls = new Map();

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    return u.origin + u.pathname.replace(/\/$/, '');
  } catch (e) {
    return url;
  }
}

async function saveWindowGeometry(url, geometry) {
  const key = normalizeUrl(url);
  const { windowGeometries = {} } = await chrome.storage.local.get('windowGeometries');
  windowGeometries[key] = { left: geometry.left, top: geometry.top, width: geometry.width, height: geometry.height };
  await chrome.storage.local.set({ windowGeometries });
}

async function getWindowGeometry(url) {
  const key = normalizeUrl(url);
  const { windowGeometries = {} } = await chrome.storage.local.get('windowGeometries');
  return windowGeometries[key] || null;
}

async function ensureOffscreenDocument() {
  const offscreenUrl = chrome.runtime.getURL('offscreen.html');
  
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [offscreenUrl]
  });
  
  if (existingContexts.length > 0) return;
  
  if (creatingOffscreen) {
    await new Promise(resolve => setTimeout(resolve, 100));
    return ensureOffscreenDocument();
  }
  
  creatingOffscreen = true;
  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['AUDIO_PLAYBACK'],
      justification: 'Play alarm sound when search text is found'
    });
  } catch (e) {
    wdLog('Offscreen document may already exist:', e);
  }
  creatingOffscreen = false;
}

async function playAlarmSound() {
  await ensureOffscreenDocument();
  chrome.runtime.sendMessage({ action: 'playAlarm' });
}

async function stopAlarmSound() {
  try {
    chrome.runtime.sendMessage({ action: 'stopAlarm' });
    await chrome.offscreen.closeDocument();
    wdLog('Offscreen document closed');
  } catch (e) {
    // Offscreen doc may not exist if alarm wasn't playing — safe to ignore
    if (e.message && e.message.includes('No current offscreen')) {
      // Expected when no alarm is active
    } else {
      wdLog('Error stopping alarm: offscreen close failed -', e.message || e);
    }
  }
}

// Helper to get monitors object from storage (keyed by monitorId)
async function getMonitors() {
  const { monitors = {} } = await chrome.storage.local.get('monitors');
  return monitors;
}

async function saveMonitors(monitors) {
  await chrome.storage.local.set({ monitors });
}

async function getHistory() {
  const { history = [] } = await chrome.storage.local.get('history');
  return history;
}

async function saveHistory(history) {
  await chrome.storage.local.set({ history });
}

async function addToHistory(monitor) {
  const history = await getHistory();
  history.unshift({
    ...monitor,
    dismissedAt: Date.now()
  });
  if (history.length > 50) history.pop();
  await saveHistory(history);
}

// Get active (not found) monitors for a tab
async function getActiveMonitorsForTab(tabId, monitors) {
  if (!monitors) monitors = await getMonitors();
  const result = {};
  for (const [id, monitor] of Object.entries(monitors)) {
    if (monitor.tabId === tabId && !monitor.found) result[id] = monitor;
  }
  return result;
}

// Handle error page by retrying - for InPrivate tabs, close ALL InPrivate windows
// and reopen them to fully reset the session (cookies, cache, connections).
// All InPrivate windows share one session, so they must all be closed to reset.
async function handleErrorPageRetry(tabId, url) {
  const activeTabMonitors = await getActiveMonitorsForTab(tabId);
  
  if (Object.keys(activeTabMonitors).length === 0) {
    wdLog('No active monitors for tab', tabId, ', ignoring error');
    return { status: 'skipped' };
  }
  
  // Get the original URL from monitors
  const firstMonitor = Object.values(activeTabMonitors)[0];
  const originalUrl = firstMonitor?.url || url;
  const isIncognito = firstMonitor?.isIncognito || false;
  
  if (isIncognito) {
    // All InPrivate windows share one session - must close ALL to truly reset.
    // Collect every InPrivate monitor, snapshot each window's size/position, then
    // close all InPrivate windows and reopen them all at the same geometry.
    wdLog('Error in InPrivate tab', tabId, '- resetting ALL InPrivate windows for fresh session');
    
    // 1) Find all InPrivate monitors
    const allMonitors = await getMonitors();
    // Group InPrivate monitors by their window, capturing window geometry
    // Key: windowId, Value: { geometry, monitors: [{id, monitor}] }
    const windowInfoMap = {};
    
    for (const [id, monitor] of Object.entries(allMonitors)) {
      if (!monitor.isIncognito || monitor.found) continue;
      
      let windowId = null;
      let geometry = null;
      try {
        const tab = await chrome.tabs.get(monitor.tabId);
        windowId = tab.windowId;
        const win = await chrome.windows.get(windowId);
        geometry = { left: win.left, top: win.top, width: win.width, height: win.height };
      } catch (e) {
        wdLog('Could not get window info for monitor', id, ':', e);
        continue;
      }
      
      if (!windowInfoMap[windowId]) {
        windowInfoMap[windowId] = { geometry, monitors: [] };
      }
      windowInfoMap[windowId].monitors.push({ id, monitor });
    }
    
    const windowIds = Object.keys(windowInfoMap).map(Number);
    if (windowIds.length === 0) {
      wdLog('No InPrivate windows found to reset');
      await scheduleRefreshForTab(tabId);
      return { status: 'retrying' };
    }
    
    wdLog('Closing', windowIds.length, 'InPrivate window(s) for full session reset');
    
    // 2) Mark all affected tabs so onRemoved won't delete their monitors
    //    Also save current geometry for each window's URL before closing
    for (const [winIdStr, info] of Object.entries(windowInfoMap)) {
      for (const { monitor } of info.monitors) {
        tabsBeingReset.add(monitor.tabId);
        clearTabTimer(monitor.tabId);
      }
      // Persist the current geometry for this URL
      if (info.monitors.length > 0) {
        await saveWindowGeometry(info.monitors[0].monitor.url, info.geometry);
      }
    }
    
    // 3) Close ALL InPrivate windows
    for (const winId of windowIds) {
      try {
        const url = incognitoWindowUrls.get(winId);
        const label = url ? new URL(url).hostname : 'window ' + winId;
        await chrome.windows.remove(winId);
        wdLog('Closed InPrivate window:', label);
      } catch (e) {
        wdLog('Could not close InPrivate window:', e);
      }
    }
    
    // Small delay to let all windows fully close (session destruction)
    await new Promise(resolve => setTimeout(resolve, 1500));
    
    // 4) Reopen each window at its original size/position
    const updatedMonitors = await getMonitors();
    
    for (const [winIdStr, info] of Object.entries(windowInfoMap)) {
      const { geometry, monitors: winMonitors } = info;
      
      // Each original window had one tab with one URL - reopen it
      // (grouped monitors on same tab share the same URL)
      const monitorsByOrigTab = {};
      for (const { id, monitor } of winMonitors) {
        const origTabId = monitor.tabId;
        if (!monitorsByOrigTab[origTabId]) {
          monitorsByOrigTab[origTabId] = { url: monitor.url, monitors: [] };
        }
        monitorsByOrigTab[origTabId].monitors.push({ id, monitor });
      }
      
      // Reopen one window per original tab group
      for (const [origTabIdStr, tabInfo] of Object.entries(monitorsByOrigTab)) {
        try {
          // Use saved geometry if available, otherwise fall back to the geometry captured before close
          const savedGeometry = await getWindowGeometry(tabInfo.url);
          const useGeometry = savedGeometry || geometry;

          const newWindow = await chrome.windows.create({
            url: tabInfo.url,
            incognito: true,
            focused: false,
            left: useGeometry.left,
            top: useGeometry.top,
            width: useGeometry.width,
            height: useGeometry.height
          });
          
          const newTabId = newWindow.tabs[0].id;

          // Track this window for geometry updates
          incognitoWindowUrls.set(newWindow.id, tabInfo.url);

          wdLog('Reopened InPrivate window at', JSON.stringify(useGeometry), 'with tab:', newTabId);
          
          // Update monitors to point to the new tab
          for (const { id, monitor } of tabInfo.monitors) {
            if (updatedMonitors[id]) {
              updatedMonitors[id].tabId = newTabId;
              updatedMonitors[id].nextRefreshTime = Date.now() + (monitor.interval * 1000) + 3000;
            }
          }
          
          await saveMonitors(updatedMonitors);
          await scheduleRefreshForTab(newTabId);
        } catch (e) {
          wdLog('Failed to reopen InPrivate window:', e);
        }
      }
    }
    
    return { status: 'inprivate-full-reset', windowsReset: windowIds.length };
  } else {
    // Normal tab: just navigate back to the original URL
    wdLog('Error page detected on tab', tabId, '- will retry with original URL:', originalUrl);
    
    try {
      await chrome.tabs.update(tabId, { url: originalUrl });
      wdLog('Navigated tab', tabId, 'back to original URL');
    } catch (e) {
      wdLog('Could not navigate tab back to original URL:', e);
    }
    
    // Schedule refresh so monitoring continues
    await scheduleRefreshForTab(tabId);
    
    return { status: 'retrying' };
  }
}

// Clear timer for a specific tab
function clearTabTimer(tabId) {
  const timer = refreshTimers.get(tabId);
  if (timer) {
    clearTimeout(timer);
    refreshTimers.delete(tabId);
  }
}

// Get a short label for a tab (title or hostname, fallback to tabId)
async function getTabLabel(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.title) return tab.title.length > 50 ? tab.title.substring(0, 50) + '…' : tab.title;
    if (tab.url) return new URL(tab.url).hostname;
  } catch (e) {}
  return 'tab ' + tabId;
}

// Schedule refresh for a tab (uses shortest interval among active monitors)
async function scheduleRefreshForTab(tabId) {
  const allMonitors = await getMonitors();
  const monitorIds = [];
  let shortestInterval = Infinity;
  
  for (const [id, monitor] of Object.entries(allMonitors)) {
    if (monitor.tabId === tabId && !monitor.found) {
      monitorIds.push(id);
      if (monitor.interval < shortestInterval) shortestInterval = monitor.interval;
    }
  }
  
  if (monitorIds.length === 0) {
    clearTabTimer(tabId);
    return;
  }
  
  clearTabTimer(tabId);
  
  const intervalMs = shortestInterval * 1000;
  const nextRefreshTime = Date.now() + intervalMs;
  
  for (const id of monitorIds) {
    allMonitors[id].nextRefreshTime = nextRefreshTime;
  }
  await saveMonitors(allMonitors);
  
  const label = await getTabLabel(tabId);
  wdLog('⏱️ Next refresh in', shortestInterval + 's:', label);
  
  const timer = setTimeout(async () => {
    try {
      const monitors = await getMonitors();
      const hasActive = Object.values(monitors).some(m => m.tabId === tabId && !m.found);
      if (!hasActive) return;
      
      const lbl = await getTabLabel(tabId);
      await chrome.tabs.get(tabId);
      wdLog('🔄 Refreshing:', lbl);
      chrome.tabs.reload(tabId);
    } catch (e) {
      wdLog('Tab no longer exists, removing monitors:', tabId);
      const monitors = await getMonitors();
      let changed = false;
      for (const [id, monitor] of Object.entries(monitors)) {
        if (monitor.tabId === tabId) { delete monitors[id]; changed = true; }
      }
      if (changed) await saveMonitors(monitors);
      clearTabTimer(tabId);
    }
  }, intervalMs);
  
  refreshTimers.set(tabId, timer);
  
  // Start the stuck watchdog if not already running
  startStuckWatchdog();
}

// Check for stuck monitors and force refresh if needed
async function checkForStuckMonitors() {
  const monitors = await getMonitors();
  const now = Date.now();
  const tabsToRefresh = new Set();
  
  for (const [id, monitor] of Object.entries(monitors)) {
    if (!monitor.found && monitor.nextRefreshTime && (now - monitor.nextRefreshTime) > STUCK_THRESHOLD_MS) {
      wdLog('Monitor appears stuck:', id, Math.round((now - monitor.nextRefreshTime) / 1000), 's overdue');
      tabsToRefresh.add(monitor.tabId);
    }
  }
  
  if (tabsToRefresh.size === 0) return;
  
  let changed = false;
  
  for (const tabId of tabsToRefresh) {
    try {
      await chrome.tabs.get(tabId);
      wdLog('Force refreshing stuck tab:', tabId);
      
      // Find shortest interval & update nextRefreshTime in one pass
      let shortestInterval = 15;
      for (const m of Object.values(monitors)) {
        if (m.tabId === tabId && !m.found && m.interval < shortestInterval) shortestInterval = m.interval;
      }
      const newTime = Date.now() + (shortestInterval * 1000) + 5000;
      for (const [id, m] of Object.entries(monitors)) {
        if (m.tabId === tabId && !m.found) { monitors[id].nextRefreshTime = newTime; changed = true; }
      }
      
      chrome.tabs.reload(tabId);
    } catch (e) {
      wdLog('Stuck tab no longer exists, cleaning up:', tabId);
      for (const [id, m] of Object.entries(monitors)) {
        if (m.tabId === tabId) { delete monitors[id]; changed = true; }
      }
      clearTabTimer(tabId);
    }
  }
  
  if (changed) await saveMonitors(monitors);
}

// Start the watchdog timer
function startStuckWatchdog() {
  if (stuckWatchdogTimer) return; // Already running
  
  stuckWatchdogTimer = setInterval(async () => {
    const monitors = await getMonitors();
    const hasActiveMonitors = Object.values(monitors).some(m => !m.found);
    
    if (!hasActiveMonitors) {
      stopStuckWatchdog();
      return;
    }
    
    await checkForStuckMonitors();
  }, WATCHDOG_CHECK_INTERVAL_MS);
}

// Stop the watchdog timer
function stopStuckWatchdog() {
  if (stuckWatchdogTimer) {
    clearInterval(stuckWatchdogTimer);
    stuckWatchdogTimer = null;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  
  if (message.action === 'startMonitoring') {
    (async () => {
      const monitors = await getMonitors();
      const monitorId = generateId();
      
      monitors[monitorId] = {
        id: monitorId,
        tabId: message.tabId,
        searchText: message.searchText,
        searchTerms: message.searchTerms || [{ term: message.searchText, operator: null }],
        interval: message.refreshInterval || 15,
        url: message.url || '',
        title: message.title || '',
        found: false,
        foundAt: null,
        isIncognito: false,
        incognitoCycleCount: 0,
        nextRefreshTime: Date.now() + ((message.refreshInterval || 15) * 1000) + 2000
      };
      
      await saveMonitors(monitors);
      wdLog('Started monitoring:', monitorId, monitors[monitorId]);
      sendResponse({ status: 'started', monitorId });
    })();
    return true;
  
  } else if (message.action === 'enableInPrivate') {
    // Enable InPrivate for a specific monitor
    (async () => {
      const monitorId = message.monitorId;
      const monitors = await getMonitors();
      
      if (!monitors[monitorId]) {
        sendResponse({ status: 'error', message: 'Monitor not found' });
        return;
      }
      
      const monitor = monitors[monitorId];
      
      // Already in InPrivate
      if (monitor.isIncognito) {
        sendResponse({ status: 'already_enabled' });
        return;
      }
      
      const oldTabId = monitor.tabId;
      const url = monitor.url;
      
      try {
        // Look up saved geometry for this URL
        const savedGeometry = await getWindowGeometry(url);
        const createOpts = {
          url: url,
          incognito: true,
          focused: false
        };
        if (savedGeometry) {
          createOpts.left = savedGeometry.left;
          createOpts.top = savedGeometry.top;
          createOpts.width = savedGeometry.width;
          createOpts.height = savedGeometry.height;
          wdLog('Restoring saved geometry for InPrivate window:', JSON.stringify(savedGeometry));
        }

        // Open InPrivate window
        const newWindow = await chrome.windows.create(createOpts);
        const newTabId = newWindow.tabs[0].id;

        // Track this window for geometry updates
        incognitoWindowUrls.set(newWindow.id, url);

        // Save current geometry (in case it's brand new or defaults changed)
        if (!savedGeometry) {
          await saveWindowGeometry(url, { left: newWindow.left, top: newWindow.top, width: newWindow.width, height: newWindow.height });
        }
        
        // Update monitor
        monitors[monitorId].tabId = newTabId;
        monitors[monitorId].isIncognito = true;
        monitors[monitorId].incognitoCycleCount = 1;
        monitors[monitorId].nextRefreshTime = Date.now() + (monitor.interval * 1000) + 2000;
        
        await saveMonitors(monitors);
        
        // Clear timer for old tab
        clearTabTimer(oldTabId);
        
        // Schedule refresh for new tab
        await scheduleRefreshForTab(newTabId);
        
        // Close the original tab
        try {
          await chrome.tabs.remove(oldTabId);
        } catch (e) {
          wdLog('Could not close original tab:', e);
        }
        
        wdLog('Enabled InPrivate for monitor:', monitorId, 'new tab:', newTabId);
        sendResponse({ status: 'enabled', newTabId });
      } catch (e) {
        wdLog('Failed to enable InPrivate:', e);
        sendResponse({ status: 'error', message: e.message });
      }
    })();
    return true;
    
  } else if (message.action === 'stopMonitoring') {
    (async () => {
      const monitorId = message.monitorId;
      const monitors = await getMonitors();
      
      if (monitors[monitorId]) {
        const tabId = monitors[monitorId].tabId;
        if (monitors[monitorId].found) {
          await addToHistory(monitors[monitorId]);
        }
        delete monitors[monitorId];
        await saveMonitors(monitors);
        
        // Reschedule or clear timer for this tab
        const remaining = await getActiveMonitorsForTab(tabId, monitors);
        if (Object.keys(remaining).length === 0) {
          clearTabTimer(tabId);
        } else {
          await scheduleRefreshForTab(tabId);
        }
        wdLog('Stopped monitor:', monitorId);
      }
      
      sendResponse({ status: 'stopped' });
    })();
    return true;
  
  } else if (message.action === 'stopAllMonitoring') {
    (async () => {
      const monitors = await getMonitors();
      stopAlarmSound();
      
      // Collect unique tabs and dismiss overlays
      const tabIds = new Set();
      for (const monitor of Object.values(monitors)) {
        tabIds.add(monitor.tabId);
        if (monitor.found) {
          await addToHistory(monitor);
        }
      }
      
      for (const tabId of tabIds) {
        clearTabTimer(tabId);
        try {
          await chrome.tabs.sendMessage(tabId, { action: 'dismissOverlay' });
        } catch (e) {}
      }
      
      // Stop the stuck watchdog
      stopStuckWatchdog();
      
      await saveMonitors({});
      wdLog('All monitoring stopped');
      sendResponse({ status: 'all stopped' });
    })();
    return true;
    
  } else if (message.action === 'stopAlarm') {
    wdLog('Stopping alarm sound...');
    stopAlarmSound();
    
    (async () => {
      const monitorId = message.monitorId;
      const tabId = (sender.tab ? sender.tab.id : null) || message.tabId;
      
      if (monitorId) {
        // Stop specific monitor
        const monitors = await getMonitors();
        if (monitors[monitorId]) {
          const mTabId = monitors[monitorId].tabId;
          if (monitors[monitorId].found) {
            await addToHistory(monitors[monitorId]);
          }
          delete monitors[monitorId];
          await saveMonitors(monitors);
          
          try {
            await chrome.tabs.sendMessage(mTabId, { action: 'dismissOverlay', monitorId });
          } catch (e) {}
          
          const remaining = await getActiveMonitorsForTab(mTabId, monitors);
          if (Object.keys(remaining).length === 0) {
            clearTabTimer(mTabId);
          }
        }
      } else if (tabId) {
        // Stop all monitors for this tab that are found
        const monitors = await getMonitors();
        for (const [id, monitor] of Object.entries(monitors)) {
          if (monitor.tabId === tabId && monitor.found) {
            await addToHistory(monitor);
            delete monitors[id];
          }
        }
        await saveMonitors(monitors);
        
        try {
          await chrome.tabs.sendMessage(tabId, { action: 'dismissOverlay' });
        } catch (e) {}
      }
      
      sendResponse({ status: 'alarm stopped' });
    })();
    return true;
    
  } else if (message.action === 'getStatus') {
    (async () => {
      const senderTabId = sender.tab ? sender.tab.id : null;
      const activeMonitors = senderTabId ? await getActiveMonitorsForTab(senderTabId) : {};
      sendResponse({ isMonitored: Object.keys(activeMonitors).length > 0, monitors: activeMonitors });
    })();
    return true;
    
  } else if (message.action === 'getAllMonitors') {
    (async () => {
      const monitors = await getMonitors();
      sendResponse({ monitors });
    })();
    return true;
    
  } else if (message.action === 'getHistory') {
    (async () => {
      const history = await getHistory();
      sendResponse({ history });
    })();
    return true;
    
  } else if (message.action === 'removeFromHistory') {
    (async () => {
      const index = message.index;
      const history = await getHistory();
      if (index >= 0 && index < history.length) {
        history.splice(index, 1);
        await saveHistory(history);
      }
      sendResponse({ status: 'removed' });
    })();
    return true;
    
  } else if (message.action === 'clearHistory') {
    (async () => {
      await saveHistory([]);
      sendResponse({ status: 'cleared' });
    })();
    return true;
    
  } else if (message.action === 'getLogs') {
    const filter = message.filter || 'all';
    let logs = logBuffer;
    if (filter !== 'all') {
      logs = logBuffer.filter(e => e.source === filter);
    }
    sendResponse({ logs });
    return true;
    
  } else if (message.action === 'clearLogs') {
    logBuffer = [];
    sendResponse({ status: 'cleared' });
    return true;
    
  } else if (message.action === 'appendLog') {
    if (loggingEnabled) {
      logBuffer.push({
        timestamp: message.timestamp || Date.now(),
        message: String(message.message || ''),
        source: message.source || 'content',
        level: message.level || 'info'
      });
      trimLogBuffer();
    }
    sendResponse({ status: 'ok' });
    return true;

  } else if (message.action === 'getLoggingEnabled') {
    sendResponse({ enabled: loggingEnabled });
    return true;

  } else if (message.action === 'setLoggingEnabled') {
    loggingEnabled = !!message.enabled;
    sendResponse({ status: 'ok', enabled: loggingEnabled });
    return true;
    
  } else if (message.action === 'saveConfig') {
    (async () => {
      const monitors = await getMonitors();
      const activeMonitors = Object.values(monitors).filter(m => !m.found);
      if (activeMonitors.length === 0) {
        sendResponse({ status: 'empty', message: 'No active monitors to save' });
        return;
      }
      const config = {
        id: generateId(),
        name: message.name || new Date().toLocaleString(),
        savedAt: Date.now(),
        monitors: activeMonitors.map(m => ({
          searchText: m.searchText,
          searchTerms: m.searchTerms,
          interval: m.interval,
          url: m.url,
          title: m.title,
          isIncognito: m.isIncognito || false
        }))
      };
      const { savedConfigs = [] } = await chrome.storage.local.get('savedConfigs');
      savedConfigs.push(config);
      // Keep max 20 configs
      if (savedConfigs.length > 20) savedConfigs.splice(0, savedConfigs.length - 20);
      await chrome.storage.local.set({ savedConfigs });
      wdLog('Saved config "' + config.name + '" with', config.monitors.length, 'monitor(s)');
      sendResponse({ status: 'saved', config });
    })();
    return true;

  } else if (message.action === 'getSavedConfigs') {
    (async () => {
      const { savedConfigs = [] } = await chrome.storage.local.get('savedConfigs');
      sendResponse({ configs: savedConfigs });
    })();
    return true;

  } else if (message.action === 'deleteConfig') {
    (async () => {
      const { savedConfigs = [] } = await chrome.storage.local.get('savedConfigs');
      const updated = savedConfigs.filter(c => c.id !== message.configId);
      await chrome.storage.local.set({ savedConfigs: updated });
      wdLog('Deleted config:', message.configId);
      sendResponse({ status: 'deleted' });
    })();
    return true;

  } else if (message.action === 'restoreConfig') {
    (async () => {
      const { savedConfigs = [] } = await chrome.storage.local.get('savedConfigs');
      const config = savedConfigs.find(c => c.id === message.configId);
      if (!config) {
        sendResponse({ status: 'not_found' });
        return;
      }

      const monitors = await getMonitors();
      let restoredCount = 0;

      for (const saved of config.monitors) {
        try {
          let newTabId;

          if (saved.isIncognito) {
            const savedGeometry = await getWindowGeometry(saved.url);
            const createOpts = { url: saved.url, incognito: true, focused: false };
            if (savedGeometry) Object.assign(createOpts, savedGeometry);
            const newWindow = await chrome.windows.create(createOpts);
            newTabId = newWindow.tabs[0].id;
            incognitoWindowUrls.set(newWindow.id, saved.url);
            if (!savedGeometry) {
              await saveWindowGeometry(saved.url, {
                left: newWindow.left, top: newWindow.top,
                width: newWindow.width, height: newWindow.height
              });
            }
          } else {
            const tab = await chrome.tabs.create({ url: saved.url, active: false });
            newTabId = tab.id;
          }

          const monitorId = generateId();
          monitors[monitorId] = {
            id: monitorId,
            tabId: newTabId,
            searchText: saved.searchText,
            searchTerms: saved.searchTerms || [{ term: saved.searchText, operator: null }],
            interval: saved.interval,
            url: saved.url,
            title: saved.title || '',
            found: false,
            foundAt: null,
            isIncognito: saved.isIncognito || false,
            incognitoCycleCount: saved.isIncognito ? 1 : 0,
            nextRefreshTime: Date.now() + (saved.interval * 1000) + 2000
          };

          restoredCount++;
          wdLog('Restored monitor for', saved.url, '→ tab', newTabId, saved.isIncognito ? '(InPrivate)' : '');
        } catch (e) {
          wdLog('Failed to restore monitor for', saved.url, ':', e.message);
        }
      }

      await saveMonitors(monitors);

      const tabIds = new Set(Object.values(monitors).filter(m => !m.found).map(m => m.tabId));
      for (const tabId of tabIds) {
        await scheduleRefreshForTab(tabId);
      }

      wdLog('Config "' + config.name + '" restored:', restoredCount, 'monitor(s)');
      sendResponse({ status: 'restored', count: restoredCount });
    })();
    return true;

  } else if (message.action === 'found') {
    // Content found - includes monitorId and searchText
    wdLog('Content FOUND! Playing alarm...');
    playAlarmSound();
    
    const foundAt = Date.now();
    
    (async () => {
      const monitorId = message.monitorId;
      const monitors = await getMonitors();
      
      if (monitors[monitorId]) {
        monitors[monitorId].found = true;
        monitors[monitorId].foundAt = foundAt;
        monitors[monitorId].nextRefreshTime = null;
        await saveMonitors(monitors);
        
        const tabId = monitors[monitorId].tabId;
        
        // Focus the tab and bring window to front
        try {
          const tab = await chrome.tabs.get(tabId);
          // Bring the window to the front and focus it
          await chrome.windows.update(tab.windowId, { focused: true });
          // Focus the specific tab
          await chrome.tabs.update(tabId, { active: true });
          wdLog('Focused tab and window for found content');
        } catch (e) {
          wdLog('Could not focus tab/window:', e);
        }
        
        // Reschedule for remaining active monitors
        await scheduleRefreshForTab(tabId);
      }
      
      wdLog('Content FOUND - State saved for monitor:', monitorId);
      sendResponse({ status: 'found', foundAt });
    })();
    return true;
    
  } else if (message.action === 'scheduleRefresh') {
    (async () => {
      const senderTabId = sender.tab ? sender.tab.id : null;
      if (senderTabId) {
        await scheduleRefreshForTab(senderTabId);
      }
      sendResponse({ status: 'scheduled' });
    })();
    return true;
    
  } else if (message.action === 'urlRedirected') {
    // URL was redirected (e.g., to error page with different URL)
    // Navigate back to original URL instead of triggering error fallback
    wdLog('URL redirected, navigating back to original URL...');
    (async () => {
      const senderTabId = sender.tab ? sender.tab.id : null;
      const originalUrl = message.originalUrl;
      
      if (!senderTabId || !originalUrl) {
        wdLog('Missing tabId or originalUrl for redirect recovery');
        sendResponse({ status: 'error', message: 'Missing tabId or originalUrl' });
        return;
      }
      
      try {
        // Navigate the tab back to the original URL
        await chrome.tabs.update(senderTabId, { url: originalUrl });
        wdLog('Navigated tab', senderTabId, 'back to original URL:', originalUrl);
        
        // Schedule refresh after navigation
        // Note: The content script will re-initialize after navigation
        sendResponse({ status: 'redirected', url: originalUrl });
      } catch (e) {
        wdLog('Failed to navigate to original URL:', e);
        sendResponse({ status: 'error', message: e.message });
      }
    })();
    return true;
    
  } else if (message.action === 'errorPageDetected') {
    wdLog('Error page detected, scheduling retry...');
    (async () => {
      const senderTabId = sender.tab ? sender.tab.id : null;
      const url = message.url;
      
      if (!senderTabId || !url) {
        wdLog('Missing tabId or URL for error retry');
        sendResponse({ status: 'error', message: 'Missing tabId or URL' });
        return;
      }
      
      const result = await handleErrorPageRetry(senderTabId, url);
      sendResponse(result);
    })();
    return true;
  }
  
  return true;
});

// Listen for tab removal
chrome.tabs.onRemoved.addListener(async (tabId) => {
  // Skip cleanup if this tab is being intentionally reset (InPrivate session reset)
  if (tabsBeingReset.has(tabId)) {
    tabsBeingReset.delete(tabId);
    wdLog('Tab', tabId, 'closed for InPrivate reset, keeping monitors');
    return;
  }
  
  const monitors = await getMonitors();
  let changed = false;
  const removedUrls = [];
  
  for (const [id, monitor] of Object.entries(monitors)) {
    if (monitor.tabId === tabId) {
      removedUrls.push(monitor.url ? new URL(monitor.url).hostname : monitor.searchText);
      delete monitors[id];
      changed = true;
    }
  }
  
  if (changed) {
    await saveMonitors(monitors);
    clearTabTimer(tabId);
    stopAlarmSound();
    wdLog('Tab closed, removed', removedUrls.length, 'monitor(s):', removedUrls.join(', '));
  }
});

// Restore timers on startup
chrome.runtime.onStartup.addListener(async () => {
  wdLog('Service worker starting up, restoring timers...');
  const monitors = await getMonitors();
  const tabIds = new Set();
  
  for (const monitor of Object.values(monitors)) {
    if (!monitor.found) {
      tabIds.add(monitor.tabId);
    }
  }
  
  for (const tabId of tabIds) {
    try {
      await chrome.tabs.get(tabId);
      await scheduleRefreshForTab(tabId);
    } catch (e) {
      // Tab doesn't exist, clean up
      for (const [id, monitor] of Object.entries(monitors)) {
        if (monitor.tabId === tabId) {
          delete monitors[id];
        }
      }
    }
  }
  
  await saveMonitors(monitors);
  
  const hasActive = Object.values(monitors).some(m => !m.found);
  if (hasActive) {
    startStuckWatchdog();
  }
});

// Track tabs that recently had navigation errors to avoid duplicate handling
const recentNavErrors = new Map();

// Listen for navigation errors (catches errors before content script runs)
chrome.webNavigation.onErrorOccurred.addListener(async (details) => {
  // Only handle main frame errors
  if (details.frameId !== 0) return;
  
  const tabId = details.tabId;
  const url = details.url;
  const error = details.error;
  
  wdLog('Navigation error detected:', error, 'for tab:', tabId, 'URL:', url);
  
  // Check if this tab has active monitors
  const tabMonitors = await getActiveMonitorsForTab(tabId);
  if (Object.keys(tabMonitors).length === 0) {
    wdLog('No active monitors for this tab, ignoring navigation error');
    return;
  }
  
  // Avoid duplicate handling (within 10 seconds)
  const lastError = recentNavErrors.get(tabId);
  if (lastError && Date.now() - lastError < 10000) {
    wdLog('Ignoring duplicate navigation error for tab:', tabId);
    return;
  }
  recentNavErrors.set(tabId, Date.now());
  
  // Clean up old entries
  for (const [tid, time] of recentNavErrors.entries()) {
    if (Date.now() - time > 60000) {
      recentNavErrors.delete(tid);
    }
  }
  
  wdLog('Scheduling retry for navigation error...');
  
  // Get the URL from one of the monitors if not available
  let targetUrl = url;
  if (!targetUrl || targetUrl === 'about:blank') {
    const firstMonitor = Object.values(tabMonitors)[0];
    targetUrl = firstMonitor?.url;
  }
  
  if (!targetUrl) {
    wdLog('No URL available for retry');
    return;
  }
  
  const result = await handleErrorPageRetry(tabId, targetUrl);
  wdLog('Navigation error retry result:', result);
});

// --- InPrivate Window Geometry Tracking ---

// When an InPrivate window is moved or resized, persist the new geometry (debounced)
let geometrySaveTimer = null;
chrome.windows.onBoundsChanged.addListener((window) => {
  const url = incognitoWindowUrls.get(window.id);
  if (!url) return;

  // Debounce: only save after user stops resizing/moving for 500ms
  clearTimeout(geometrySaveTimer);
  geometrySaveTimer = setTimeout(async () => {
    const geometry = { left: window.left, top: window.top, width: window.width, height: window.height };
    await saveWindowGeometry(url, geometry);
    wdLog('Saved geometry for window', window.id);
  }, 500);
});

// Clean up tracking map when an InPrivate window is closed
chrome.windows.onRemoved.addListener((windowId) => {
  if (incognitoWindowUrls.has(windowId)) {
    incognitoWindowUrls.delete(windowId);
  }
});

// Rebuild incognitoWindowUrls map on service worker startup
async function rebuildIncognitoWindowMap() {
  const monitors = await getMonitors();
  const incognitoMonitors = Object.values(monitors).filter(m => m.isIncognito && !m.found);
  
  await Promise.allSettled(incognitoMonitors.map(async (monitor) => {
    try {
      const tab = await chrome.tabs.get(monitor.tabId);
      if (tab.windowId && !incognitoWindowUrls.has(tab.windowId)) {
        incognitoWindowUrls.set(tab.windowId, monitor.url);
      }
    } catch (e) {
      // Tab no longer exists
    }
  }));
  
  if (incognitoWindowUrls.size > 0) {
    wdLog('Rebuilt InPrivate window map:', incognitoWindowUrls.size, 'window(s)');
  }
}

// Run on service worker script evaluation (covers both startup and wake-up)
rebuildIncognitoWindowMap();
