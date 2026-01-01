// Background service worker for managing multiple monitors (multiple per tab supported)

let creatingOffscreen = false;

// In-memory timers for each tab (one timer per tab, uses shortest interval)
const refreshTimers = new Map();

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
        nextRefreshTime: Date.now() + ((message.refreshInterval || 15) * 1000) + 2000
      };
      
      await saveMonitors(monitors);
      console.log('Started monitoring:', monitorId, monitors[monitorId]);
      sendResponse({ status: 'started', monitorId });
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
});
