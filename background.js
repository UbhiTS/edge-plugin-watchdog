// Background service worker for managing multiple monitors (multiple per tab supported)

let creatingOffscreen = false;

// In-memory timers for each tab (one timer per tab, uses shortest interval)
const refreshTimers = new Map();

// Watchdog timer to detect stuck refreshes
let stuckWatchdogTimer = null;
const STUCK_THRESHOLD_MS = 30000; // Consider stuck if 30 seconds past expected refresh
const WATCHDOG_CHECK_INTERVAL_MS = 10000; // Check every 10 seconds

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
    console.log('Offscreen document may already exist:', e);
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
    console.log('Offscreen document closed');
  } catch (e) {
    console.log('Error stopping alarm:', e);
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

// Calculate exponential backoff delay (in ms)
// Cycle 1: 5s, Cycle 2: 10s, Cycle 3: 20s, Cycle 4: 40s, max 2 minutes
function getBackoffDelay(cycleCount) {
  const baseDelay = 5000; // 5 seconds
  const maxDelay = 120000; // 2 minutes max
  const delay = Math.min(baseDelay * Math.pow(2, cycleCount - 1), maxDelay);
  return delay;
}

// Check if InPrivate fallback is enabled
async function isInPrivateEnabled() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['useInPrivate'], (result) => {
      // Default to true if not set
      resolve(result.useInPrivate !== false);
    });
  });
}

// Handle error page by opening/cycling InPrivate window
// This will close existing InPrivate windows and open fresh ones
async function handleErrorWithInPrivate(tabId, url) {
  // Check if InPrivate fallback is enabled
  const inPrivateEnabled = await isInPrivateEnabled();
  if (!inPrivateEnabled) {
    console.log('InPrivate fallback is disabled, scheduling regular refresh');
    await scheduleRefreshForTab(tabId);
    return { status: 'disabled' };
  }
  
  const activeTabMonitors = await getActiveMonitorsForTab(tabId);
  
  if (Object.keys(activeTabMonitors).length === 0) {
    console.log('No active monitors for tab', tabId, ', skipping InPrivate fallback');
    return { status: 'skipped' };
  }
  
  // Check if the current tab is already an InPrivate tab
  const firstMonitor = Object.values(activeTabMonitors)[0];
  const wasAlreadyIncognito = firstMonitor?.isIncognito || false;
  const cycleCount = (firstMonitor?.incognitoCycleCount || 0) + 1;
  const lastCycleTime = firstMonitor?.lastCycleTime || 0;
  
  // Calculate required delay based on cycle count
  const requiredDelay = getBackoffDelay(cycleCount);
  
  console.log(`InPrivate cycle #${cycleCount} - Previous was incognito: ${wasAlreadyIncognito}, backoff: ${Math.round(requiredDelay/1000)}s`);
  
  // FIRST: Close the error tab/window immediately
  clearTabTimer(tabId);
  try {
    if (wasAlreadyIncognito) {
      const tab = await chrome.tabs.get(tabId);
      await chrome.windows.remove(tab.windowId);
      console.log('Closed old InPrivate window');
    } else {
      await chrome.tabs.remove(tabId);
      console.log('Closed original error tab');
    }
  } catch (e) {
    console.log('Could not close old tab/window:', e);
  }
  
  // Update monitors to indicate they're in backoff state (no tab assigned temporarily)
  const monitors = await getMonitors();
  for (const [id, monitor] of Object.entries(activeTabMonitors)) {
    if (monitors[id]) {
      monitors[id].tabId = -1; // Temporarily no tab
      monitors[id].isIncognito = true;
      monitors[id].incognitoCycleCount = cycleCount;
      monitors[id].lastCycleTime = Date.now();
      monitors[id].nextRefreshTime = Date.now() + requiredDelay;
      monitors[id].inBackoff = true;
    }
  }
  await saveMonitors(monitors);
  
  // THEN: Wait for backoff period before opening new window
  console.log(`Backoff: Waiting ${Math.round(requiredDelay/1000)}s before opening new InPrivate window (cycle #${cycleCount})`);
  
  setTimeout(async () => {
    try {
      // Open a fresh InPrivate window after backoff
      const newWindow = await chrome.windows.create({
        url: url,
        incognito: true,
        focused: false
      });
      
      const newTabId = newWindow.tabs[0].id;
      console.log('Opened fresh InPrivate window with tab:', newTabId, 'after backoff, cycle:', cycleCount);
      
      // Update monitors with new tab
      const currentMonitors = await getMonitors();
      for (const [id, monitor] of Object.entries(activeTabMonitors)) {
        if (currentMonitors[id]) {
          currentMonitors[id].tabId = newTabId;
          currentMonitors[id].url = url;
          currentMonitors[id].inBackoff = false;
          currentMonitors[id].nextRefreshTime = Date.now() + (monitor.interval * 1000) + 3000;
        }
      }
      await saveMonitors(currentMonitors);
      
      // Schedule refresh for new tab
      await scheduleRefreshForTab(newTabId);
      
      console.log(`Successfully opened new InPrivate tab after backoff (cycle #${cycleCount})`);
    } catch (e) {
      console.log('Failed to open InPrivate window after backoff:', e);
    }
  }, requiredDelay);
  
  return { status: 'backoff-cycling', backoffDelay: requiredDelay, cycleCount };
}

// Clear timer for a specific tab
function clearTabTimer(tabId) {
  const timer = refreshTimers.get(tabId);
  if (timer) {
    clearTimeout(timer);
    refreshTimers.delete(tabId);
    console.log('Cleared timer for tab:', tabId);
  }
}

// Schedule refresh for a tab (uses shortest interval among active monitors)
async function scheduleRefreshForTab(tabId) {
  const activeMonitors = await getActiveMonitorsForTab(tabId);
  const monitorIds = Object.keys(activeMonitors);
  
  if (monitorIds.length === 0) {
    console.log('No active monitors for tab, not scheduling:', tabId);
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
  
  console.log('Scheduling refresh for tab', tabId, 'in', shortestInterval, 'seconds');
  
  const timer = setTimeout(async () => {
    const currentActive = await getActiveMonitorsForTab(tabId);
    if (Object.keys(currentActive).length === 0) {
      console.log('No active monitors, not refreshing:', tabId);
      return;
    }
    
    try {
      await chrome.tabs.get(tabId);
      console.log('Refreshing tab:', tabId);
      chrome.tabs.reload(tabId);
    } catch (e) {
      console.log('Tab no longer exists, removing monitors:', tabId);
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
        console.log('Monitor appears stuck:', id, 'Expected refresh was', Math.round(timeSinceExpected / 1000), 'seconds ago');
        tabsToRefresh.add(monitor.tabId);
      }
    }
  }
  
  // Force refresh stuck tabs
  for (const tabId of tabsToRefresh) {
    try {
      await chrome.tabs.get(tabId);
      console.log('Force refreshing stuck tab:', tabId);
      
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
      console.log('Stuck tab no longer exists, cleaning up:', tabId);
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
  
  console.log('Starting stuck monitor watchdog');
  stuckWatchdogTimer = setInterval(async () => {
    const monitors = await getMonitors();
    const hasActiveMonitors = Object.values(monitors).some(m => !m.found);
    
    if (!hasActiveMonitors) {
      console.log('No active monitors, stopping watchdog');
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
    console.log('Stopped stuck monitor watchdog');
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('Background received message:', message);
  
  if (message.action === 'startMonitoring') {
    (async () => {
      const monitors = await getMonitors();
      const monitorId = generateId();
      
      monitors[monitorId] = {
        id: monitorId,
        tabId: message.tabId,
        searchText: message.searchText,
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
      console.log('Started monitoring:', monitorId, monitors[monitorId]);
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
          console.log('Could not close original tab:', e);
        }
        
        console.log('Enabled InPrivate for monitor:', monitorId, 'new tab:', newTabId);
        sendResponse({ status: 'enabled', newTabId });
      } catch (e) {
        console.log('Failed to enable InPrivate:', e);
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
        console.log('Stopped monitor:', monitorId);
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
      console.log('All monitoring stopped');
      sendResponse({ status: 'all stopped' });
    })();
    return true;
    
  } else if (message.action === 'stopAlarm') {
    console.log('Stopping alarm sound...');
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
      
      console.log('Status check for tab:', senderTabId, 'monitors:', Object.keys(activeMonitors).length);
      
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
    
  } else if (message.action === 'found') {
    // Content found - includes monitorId and searchText
    console.log('Content FOUND! Playing alarm...');
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
          console.log('Focused tab and window for found content');
        } catch (e) {
          console.log('Could not focus tab/window:', e);
        }
        
        // Reschedule for remaining active monitors
        await scheduleRefreshForTab(tabId);
      }
      
      console.log('Content FOUND - State saved for monitor:', monitorId);
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
    console.log('URL redirected, navigating back to original URL...');
    (async () => {
      const senderTabId = sender.tab ? sender.tab.id : null;
      const originalUrl = message.originalUrl;
      
      if (!senderTabId || !originalUrl) {
        console.log('Missing tabId or originalUrl for redirect recovery');
        sendResponse({ status: 'error', message: 'Missing tabId or originalUrl' });
        return;
      }
      
      try {
        // Navigate the tab back to the original URL
        await chrome.tabs.update(senderTabId, { url: originalUrl });
        console.log('Navigated tab', senderTabId, 'back to original URL:', originalUrl);
        
        // Schedule refresh after navigation
        // Note: The content script will re-initialize after navigation
        sendResponse({ status: 'redirected', url: originalUrl });
      } catch (e) {
        console.log('Failed to navigate to original URL:', e);
        sendResponse({ status: 'error', message: e.message });
      }
    })();
    return true;
    
  } else if (message.action === 'errorPageDetected') {
    console.log('Error page detected, attempting InPrivate fallback/cycle...');
    (async () => {
      const senderTabId = sender.tab ? sender.tab.id : null;
      const url = message.url;
      
      if (!senderTabId || !url) {
        console.log('Missing tabId or URL for InPrivate fallback');
        sendResponse({ status: 'error', message: 'Missing tabId or URL' });
        return;
      }
      
      const result = await handleErrorWithInPrivate(senderTabId, url);
      sendResponse(result);
    })();
    return true;
  }
  
  return true;
});

// Listen for tab removal
chrome.tabs.onRemoved.addListener(async (tabId) => {
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
    console.log('Tab closed, removed monitors for tab:', tabId);
  }
});

// Restore timers on startup
chrome.runtime.onStartup.addListener(async () => {
  console.log('Service worker starting up, restoring timers...');
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
  
  console.log('Navigation error detected:', error, 'for tab:', tabId, 'URL:', url);
  
  // Check if this tab has active monitors
  const tabMonitors = await getActiveMonitorsForTab(tabId);
  if (Object.keys(tabMonitors).length === 0) {
    console.log('No active monitors for this tab, ignoring navigation error');
    return;
  }
  
  // Avoid duplicate handling (within 10 seconds)
  const lastError = recentNavErrors.get(tabId);
  if (lastError && Date.now() - lastError < 10000) {
    console.log('Ignoring duplicate navigation error for tab:', tabId);
    return;
  }
  recentNavErrors.set(tabId, Date.now());
  
  // Clean up old entries
  for (const [tid, time] of recentNavErrors.entries()) {
    if (Date.now() - time > 60000) {
      recentNavErrors.delete(tid);
    }
  }
  
  console.log('Attempting InPrivate fallback/cycle for navigation error...');
  
  // Get the URL from one of the monitors if not available
  let targetUrl = url;
  if (!targetUrl || targetUrl === 'about:blank') {
    const firstMonitor = Object.values(tabMonitors)[0];
    targetUrl = firstMonitor?.url;
  }
  
  if (!targetUrl) {
    console.log('No URL available for InPrivate fallback');
    return;
  }
  
  const result = await handleErrorWithInPrivate(tabId, targetUrl);
  console.log('Navigation error InPrivate result:', result);
});
