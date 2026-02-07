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

function wdLog(...args) {
  const message = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
  const entry = { timestamp: Date.now(), message, source: 'background', level: 'info' };
  logBuffer.push(entry);
  if (logBuffer.length > MAX_LOG_ENTRIES) {
    logBuffer = logBuffer.slice(-MAX_LOG_ENTRIES);
  }
  console.log('[WD:background]', ...args);
}

// Generate unique ID
function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2);
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
    wdLog('Error stopping alarm:', e);
  }
}

// Helper to get monitors object from storage (keyed by monitorId)
async function getMonitors() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['monitors'], (result) => {
      resolve(result.monitors || {});
    });
  });
}

async function saveMonitors(monitors) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ monitors }, resolve);
  });
}

async function getHistory() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['history'], (result) => {
      resolve(result.history || []);
    });
  });
}

async function saveHistory(history) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ history }, resolve);
  });
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

// Get all monitors for a specific tab
async function getMonitorsForTab(tabId) {
  const monitors = await getMonitors();
  const result = {};
  for (const [id, monitor] of Object.entries(monitors)) {
    if (monitor.tabId === tabId) {
      result[id] = monitor;
    }
  }
  return result;
}

// Get active (not found) monitors for a tab
async function getActiveMonitorsForTab(tabId) {
  const monitors = await getMonitorsForTab(tabId);
  const result = {};
  for (const [id, monitor] of Object.entries(monitors)) {
    if (!monitor.found) {
      result[id] = monitor;
    }
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
    for (const info of Object.values(windowInfoMap)) {
      for (const { monitor } of info.monitors) {
        tabsBeingReset.add(monitor.tabId);
        clearTabTimer(monitor.tabId);
      }
    }
    
    // 3) Close ALL InPrivate windows
    for (const winId of windowIds) {
      try {
        await chrome.windows.remove(winId);
        wdLog('Closed InPrivate window:', winId);
      } catch (e) {
        wdLog('Could not close InPrivate window', winId, ':', e);
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
          const newWindow = await chrome.windows.create({
            url: tabInfo.url,
            incognito: true,
            focused: false,
            left: geometry.left,
            top: geometry.top,
            width: geometry.width,
            height: geometry.height
          });
          
          const newTabId = newWindow.tabs[0].id;
          wdLog('Reopened InPrivate window at', JSON.stringify(geometry), 'with tab:', newTabId);
          
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
    wdLog('Cleared timer for tab:', tabId);
  }
}

// Schedule refresh for a tab (uses shortest interval among active monitors)
async function scheduleRefreshForTab(tabId) {
  const activeMonitors = await getActiveMonitorsForTab(tabId);
  const monitorIds = Object.keys(activeMonitors);
  
  if (monitorIds.length === 0) {
    wdLog('No active monitors for tab, not scheduling:', tabId);
    clearTabTimer(tabId);
    return;
  }
  
  // Find shortest interval
  let shortestInterval = Infinity;
  for (const monitor of Object.values(activeMonitors)) {
    if (monitor.interval < shortestInterval) {
      shortestInterval = monitor.interval;
    }
  }
  
  clearTabTimer(tabId);
  
  const intervalMs = shortestInterval * 1000;
  const nextRefreshTime = Date.now() + intervalMs;
  
  // Update next refresh time for all active monitors on this tab
  const allMonitors = await getMonitors();
  for (const id of monitorIds) {
    if (allMonitors[id]) {
      allMonitors[id].nextRefreshTime = nextRefreshTime;
    }
  }
  await saveMonitors(allMonitors);
  
  wdLog('Scheduling refresh for tab', tabId, 'in', shortestInterval, 'seconds');
  
  const timer = setTimeout(async () => {
    const currentActive = await getActiveMonitorsForTab(tabId);
    if (Object.keys(currentActive).length === 0) {
      wdLog('No active monitors, not refreshing:', tabId);
      return;
    }
    
    try {
      await chrome.tabs.get(tabId);
      wdLog('Refreshing tab:', tabId);
      chrome.tabs.reload(tabId);
    } catch (e) {
      wdLog('Tab no longer exists, removing monitors:', tabId);
      const monitors = await getMonitors();
      for (const [id, monitor] of Object.entries(monitors)) {
        if (monitor.tabId === tabId) {
          delete monitors[id];
        }
      }
      await saveMonitors(monitors);
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
    // Only check active (not found) monitors with a nextRefreshTime set
    if (!monitor.found && monitor.nextRefreshTime) {
      const timeSinceExpected = now - monitor.nextRefreshTime;
      
      if (timeSinceExpected > STUCK_THRESHOLD_MS) {
        wdLog('Monitor appears stuck:', id, 'Expected refresh was', Math.round(timeSinceExpected / 1000), 'seconds ago');
        tabsToRefresh.add(monitor.tabId);
      }
    }
  }
  
  // Force refresh stuck tabs
  for (const tabId of tabsToRefresh) {
    try {
      await chrome.tabs.get(tabId);
      wdLog('Force refreshing stuck tab:', tabId);
      
      // Update nextRefreshTime before refreshing to prevent repeated force refreshes
      const currentMonitors = await getMonitors();
      const activeForTab = await getActiveMonitorsForTab(tabId);
      
      // Find shortest interval for this tab
      let shortestInterval = 15;
      for (const monitor of Object.values(activeForTab)) {
        if (monitor.interval < shortestInterval) {
          shortestInterval = monitor.interval;
        }
      }
      
      const newNextRefreshTime = Date.now() + (shortestInterval * 1000) + 5000; // Add 5s buffer
      for (const [id, monitor] of Object.entries(currentMonitors)) {
        if (monitor.tabId === tabId && !monitor.found) {
          currentMonitors[id].nextRefreshTime = newNextRefreshTime;
        }
      }
      await saveMonitors(currentMonitors);
      
      // Reload the tab
      chrome.tabs.reload(tabId);
    } catch (e) {
      wdLog('Stuck tab no longer exists, cleaning up:', tabId);
      const currentMonitors = await getMonitors();
      for (const [id, monitor] of Object.entries(currentMonitors)) {
        if (monitor.tabId === tabId) {
          delete currentMonitors[id];
        }
      }
      await saveMonitors(currentMonitors);
      clearTabTimer(tabId);
    }
  }
}

// Start the watchdog timer
function startStuckWatchdog() {
  if (stuckWatchdogTimer) return; // Already running
  
  wdLog('Starting stuck monitor watchdog');
  stuckWatchdogTimer = setInterval(async () => {
    const monitors = await getMonitors();
    const hasActiveMonitors = Object.values(monitors).some(m => !m.found);
    
    if (!hasActiveMonitors) {
      wdLog('No active monitors, stopping watchdog');
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
    wdLog('Stopped stuck monitor watchdog');
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  wdLog('Background received message:', message.action);
  
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
        // Open InPrivate window
        const newWindow = await chrome.windows.create({
          url: url,
          incognito: true,
          focused: false
        });
        const newTabId = newWindow.tabs[0].id;
        
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
        const remaining = await getActiveMonitorsForTab(tabId);
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
          
          const remaining = await getActiveMonitorsForTab(mTabId);
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
      const tabMonitors = senderTabId ? await getMonitorsForTab(senderTabId) : {};
      const activeMonitors = {};
      
      for (const [id, monitor] of Object.entries(tabMonitors)) {
        if (!monitor.found) {
          activeMonitors[id] = monitor;
        }
      }
      
      const isMonitored = Object.keys(activeMonitors).length > 0;
      
      wdLog('Status check for tab:', senderTabId, 'monitors:', Object.keys(activeMonitors).length);
      
      sendResponse({ 
        isMonitored,
        monitors: activeMonitors
      });
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
    // Content scripts can send their logs here
    const entry = {
      timestamp: message.timestamp || Date.now(),
      message: String(message.message || ''),
      source: message.source || 'content',
      level: message.level || 'info'
    };
    logBuffer.push(entry);
    if (logBuffer.length > MAX_LOG_ENTRIES) {
      logBuffer = logBuffer.slice(-MAX_LOG_ENTRIES);
    }
    sendResponse({ status: 'ok' });
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
  
  for (const [id, monitor] of Object.entries(monitors)) {
    if (monitor.tabId === tabId) {
      delete monitors[id];
      changed = true;
    }
  }
  
  if (changed) {
    await saveMonitors(monitors);
    clearTabTimer(tabId);
    stopAlarmSound();
    wdLog('Tab closed, removed monitors for tab:', tabId);
  }
});

// Restore timers on startup
chrome.runtime.onStartup.addListener(async () => {
  wdLog('Service worker starting up, restoring timers...');
  const monitors = await getMonitors();
  const tabIds = new Set();
  let hasActiveMonitors = false;
  
  for (const monitor of Object.values(monitors)) {
    if (!monitor.found) {
      tabIds.add(monitor.tabId);
      hasActiveMonitors = true;
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
  
  // Start the stuck watchdog if there are active monitors
  if (hasActiveMonitors) {
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
