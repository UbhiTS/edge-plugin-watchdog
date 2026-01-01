// Content script that checks for multiple search texts on a page

let activeMonitors = {}; // { monitorId: { searchText, ... } }
let foundMonitors = new Set(); // Track which monitors have already found their text

function checkAllMonitors() {
  if (Object.keys(activeMonitors).length === 0) {
    console.log('[WatchDog] No active monitors for this tab');
    return;
  }
  
  const pageText = document.body ? (document.body.innerText || document.body.textContent || '') : '';
  
  if (!pageText) {
    console.log('[WatchDog] No page text found');
    chrome.runtime.sendMessage({ action: 'scheduleRefresh' });
    return;
  }
  
  const pageTextLower = pageText.toLowerCase();
  let anyFound = false;
  let allChecked = true;
  
  for (const [monitorId, monitor] of Object.entries(activeMonitors)) {
    if (foundMonitors.has(monitorId)) continue;
    
    const searchText = monitor.searchText;
    console.log('[WatchDog] Checking for:', searchText);
    
    if (pageTextLower.includes(searchText.toLowerCase())) {
      console.log('[WatchDog] 🎉 FOUND:', searchText);
      foundMonitors.add(monitorId);
      anyFound = true;
      
      // Notify background
      chrome.runtime.sendMessage({ 
        action: 'found', 
        monitorId: monitorId,
        searchText: searchText 
      });
      
      // Show visual alert for this find
      showVisualAlert(searchText, monitorId);
      
      // Play local sound
      playLocalSound();
    }
  }
  
  // Check if there are still unfound monitors
  const remainingMonitors = Object.keys(activeMonitors).filter(id => !foundMonitors.has(id));
  
  if (remainingMonitors.length > 0) {
    console.log('[WatchDog] Still looking for', remainingMonitors.length, 'items, scheduling refresh...');
    chrome.runtime.sendMessage({ action: 'scheduleRefresh' });
  } else {
    console.log('[WatchDog] All monitors found or none active');
  }
}

// Audio tracking
let localAudio = null;

function playLocalSound() {
  if (localAudio) return; // Already playing
  
  try {
    // Play the MP3 file from the extension's directory
    localAudio = new Audio(chrome.runtime.getURL('bark.mp3'));
    localAudio.loop = true; // Loop until dismissed
    localAudio.volume = 1.0;
    
    localAudio.play().then(() => {
      console.log('[WatchDog] Local audio is playing!');
    }).catch(e => {
      console.log('[WatchDog] Local audio play failed:', e);
    });
  } catch (e) {
    console.log('[WatchDog] Local sound failed:', e);
  }
}

function stopLocalSound() {
  if (localAudio) {
    localAudio.pause();
    localAudio.currentTime = 0;
    localAudio = null;
  }
}

function dismissAlert() {
  console.log('[WatchDog] Dismissing alert...');
  stopLocalSound();
  chrome.runtime.sendMessage({ action: 'stopAlarm' });
  
  // Remove all overlays
  document.querySelectorAll('.watchdog-alert-overlay').forEach(el => el.remove());
  document.querySelectorAll('.watchdog-alert-style').forEach(el => el.remove());
  
  console.log('[WatchDog] Alert dismissed');
}

function showVisualAlert(searchText, monitorId) {
  const foundText = searchText || 'Search text';
  const now = new Date();
  const foundTime = now.toLocaleString();
  const iconUrl = chrome.runtime.getURL('icon128.png');
  
  // Check if overlay already exists
  if (document.getElementById('watchdog-alert-overlay')) {
    // Add to existing overlay
    const container = document.getElementById('watchdog-found-container');
    if (container) {
      const item = document.createElement('div');
      item.className = 'watchdog-found-item';
      item.innerHTML = `
        <div class="watchdog-found-text">🐕 "${foundText}"</div>
        <div class="watchdog-found-time">Found at: ${foundTime}</div>
      `;
      container.appendChild(item);
    }
    return;
  }
  
  // Create new overlay
  const overlay = document.createElement('div');
  overlay.id = 'watchdog-alert-overlay';
  overlay.className = 'watchdog-alert-overlay';
  overlay.innerHTML = `
    <div class="watchdog-overlay-bg">
      <div class="watchdog-close-btn">✕</div>
      <div class="watchdog-card">
        <div class="watchdog-header">
          <img src="${iconUrl}" class="watchdog-icon"> 
          <span class="watchdog-title">FOUND!</span>
        </div>
        <div id="watchdog-found-container">
          <div class="watchdog-found-item">
            <div class="watchdog-found-text">🐕 "${foundText}"</div>
            <div class="watchdog-found-time">Found at: ${foundTime}</div>
          </div>
        </div>
        <div class="watchdog-footer">Woof! Your watch is over! 🦴</div>
      </div>
    </div>
  `;
  
  const style = document.createElement('style');
  style.className = 'watchdog-alert-style';
  style.textContent = `
    @keyframes watchdog-pulse {
      0%, 100% { transform: scale(1); }
      50% { transform: scale(1.02); }
    }
    @keyframes watchdog-glow {
      0%, 100% { box-shadow: 0 0 40px rgba(118, 185, 0, 0.6), 0 20px 60px rgba(0, 0, 0, 0.3); }
      50% { box-shadow: 0 0 60px rgba(118, 185, 0, 0.8), 0 20px 60px rgba(0, 0, 0, 0.3); }
    }
    @keyframes watchdog-bounce {
      0%, 100% { transform: translateY(0); }
      50% { transform: translateY(-5px); }
    }
    .watchdog-overlay-bg {
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: linear-gradient(135deg, rgba(118, 185, 0, 0.85) 0%, rgba(76, 175, 80, 0.9) 100%);
      backdrop-filter: blur(8px);
      z-index: 2147483647;
      display: flex;
      justify-content: center;
      align-items: center;
      cursor: pointer;
    }
    .watchdog-close-btn {
      position: absolute;
      top: 24px;
      right: 32px;
      font-size: 24px;
      color: rgba(0, 0, 0, 0.6);
      background: rgba(255, 255, 255, 0.9);
      width: 44px;
      height: 44px;
      border-radius: 50%;
      display: flex;
      justify-content: center;
      align-items: center;
      font-weight: 300;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
      transition: all 0.2s ease;
    }
    .watchdog-close-btn:hover {
      background: #fff;
      color: #000;
      transform: scale(1.1);
    }
    .watchdog-card {
      background: linear-gradient(180deg, #ffffff 0%, #f8f9fa 100%);
      border-radius: 24px;
      padding: 48px 56px;
      text-align: center;
      max-width: 500px;
      min-width: 380px;
      animation: watchdog-pulse 2s ease-in-out infinite, watchdog-glow 2s ease-in-out infinite;
      box-shadow: 0 0 40px rgba(118, 185, 0, 0.6), 0 20px 60px rgba(0, 0, 0, 0.3);
    }
    .watchdog-header {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 16px;
      margin-bottom: 28px;
    }
    .watchdog-icon {
      width: 56px;
      height: 56px;
      filter: drop-shadow(0 4px 8px rgba(0, 0, 0, 0.2));
      animation: watchdog-bounce 1s ease-in-out infinite;
    }
    .watchdog-title {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 42px;
      font-weight: 800;
      color: #2d5016;
      letter-spacing: -1px;
      text-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
    }
    #watchdog-found-container {
      margin: 24px 0;
    }
    .watchdog-found-item {
      background: linear-gradient(135deg, #e8f5e9 0%, #c8e6c9 100%);
      border: 2px solid rgba(118, 185, 0, 0.3);
      border-radius: 16px;
      padding: 20px 28px;
      margin-top: 12px;
    }
    .watchdog-found-item:first-child {
      margin-top: 0;
    }
    .watchdog-found-text {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 22px;
      font-weight: 600;
      color: #1b5e20;
    }
    .watchdog-found-time {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 13px;
      color: #558b2f;
      margin-top: 8px;
      font-weight: 500;
    }
    .watchdog-footer {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 18px;
      font-weight: 600;
      color: #33691e;
      margin-top: 24px;
      padding-top: 20px;
      border-top: 2px solid rgba(118, 185, 0, 0.2);
    }
  `;
  document.head.appendChild(style);
  document.body.appendChild(overlay);
  
  overlay.addEventListener('click', () => dismissAlert());
}

function init() {
  chrome.runtime.sendMessage({ action: 'getStatus' }, (response) => {
    if (chrome.runtime.lastError) {
      console.log('[WatchDog] Could not get status:', chrome.runtime.lastError.message);
      return;
    }
    
    if (!response) {
      console.log('[WatchDog] No response from background');
      return;
    }
    
    console.log('[WatchDog] Got status:', response);
    
    if (!response.isMonitored || !response.monitors) {
      console.log('[WatchDog] This tab is not being monitored');
      return;
    }
    
    activeMonitors = response.monitors;
    foundMonitors = new Set();
    
    console.log('[WatchDog] Monitoring for', Object.keys(activeMonitors).length, 'search terms');
    
    // Wait for page to fully load, then check
    if (document.readyState === 'complete') {
      setTimeout(() => checkAllMonitors(), 1500);
    } else {
      window.addEventListener('load', () => {
        setTimeout(() => checkAllMonitors(), 1500);
      }, { once: true });
    }
  });
}

// Initialize
if (chrome.runtime && chrome.runtime.id) {
  init();
  
  // Listen for dismiss commands from background
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'dismissOverlay') {
      console.log('[WatchDog] Received dismissOverlay command');
      stopLocalSound();
      
      document.querySelectorAll('.watchdog-alert-overlay').forEach(el => el.remove());
      document.querySelectorAll('.watchdog-alert-style').forEach(el => el.remove());
      
      sendResponse({ status: 'dismissed' });
    }
    return true;
  });
}
