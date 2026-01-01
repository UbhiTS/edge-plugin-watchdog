// Offscreen document for playing audio (bypasses autoplay restrictions)

let audio = null;
let isPlaying = false;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'playAlarm') {
    console.log('[Offscreen] Playing alarm sound!');
    playAlarm();
    sendResponse({ status: 'playing' });
  } else if (message.action === 'stopAlarm') {
    stopAlarm();
    sendResponse({ status: 'stopped' });
  }
  return true;
});

function playAlarm() {
  if (isPlaying) return;
  isPlaying = true;
  
  try {
    // Play the MP3 file from the extension's directory
    audio = new Audio(chrome.runtime.getURL('bark.mp3'));
    audio.loop = true; // Loop until dismissed
    audio.volume = 1.0;
    
    audio.play().then(() => {
      console.log('[Offscreen] Audio is playing!');
    }).catch(e => {
      console.error('[Offscreen] Audio play failed:', e);
    });
  } catch (e) {
    console.error('[Offscreen] Audio error:', e);
  }
}

function stopAlarm() {
  if (audio) {
    audio.pause();
    audio.currentTime = 0;
    audio = null;
  }
  isPlaying = false;
}
