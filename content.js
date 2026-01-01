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
      item.style.cssText = 'margin-top: 15px; padding: 15px 30px; background: #00dd00; border-radius: 10px;';
      item.innerHTML = `
        <div style="font-size: 24px;">🐕 "${foundText}"</div>
        <div style="font-size: 14px; margin-top: 5px;">Found at: ${foundTime}</div>
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
    <div style="
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0, 255, 0, 0.3);
      z-index: 2147483647;
      display: flex;
      justify-content: center;
      align-items: center;
      flex-direction: column;
      animation: watchdog-flash 0.5s infinite alternate;
      cursor: pointer;
    ">
      <div style="
        position: absolute;
        top: 20px;
        right: 30px;
        font-size: 36px;
        color: #000;
        background: rgba(255,255,255,0.8);
        width: 50px;
        height: 50px;
        border-radius: 50%;
        display: flex;
        justify-content: center;
        align-items: center;
        font-weight: bold;
      ">✕</div>
      <div style="
        background: #00ff00;
        color: #000;
        padding: 40px 60px;
        border-radius: 20px;
        font-size: 36px;
        font-weight: bold;
        text-align: center;
        box-shadow: 0 0 50px #00ff00;
        max-width: 80%;
      ">
        <img src="${iconUrl}" style="width: 48px; height: 48px; vertical-align: middle;"> FOUND!
        <div id="watchdog-found-container" style="margin-top: 20px;">
          <div style="padding: 15px 30px; background: #00dd00; border-radius: 10px;">
            <div style="font-size: 24px;">🐕 "${foundText}"</div>
            <div style="font-size: 14px; margin-top: 5px;">Found at: ${foundTime}</div>
          </div>
        </div>
        <div style="font-size: 24px; margin-top: 20px;">Woof! Your watch is over! 🦴</div>
      </div>
    </div>
  `;
  
  const style = document.createElement('style');
  style.className = 'watchdog-alert-style';
  style.textContent = `
    @keyframes watchdog-flash {
      from { background: rgba(0, 255, 0, 0.3); }
      to { background: rgba(255, 255, 0, 0.5); }
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
