# RTX 5090 Stock Alert - Edge Extension

A Microsoft Edge extension that monitors a page for "RTX 5090 Founders Edition" and plays a loud siren alert when found.

## Features

- 🔄 Auto-refreshes the page every 10 seconds
- 🔊 Plays a loud siren when "RTX 5090 Founders Edition" is detected
- 🎨 Shows a bright visual overlay alert
- 💚 NVIDIA-themed UI

## Installation

1. Open Microsoft Edge
2. Go to `edge://extensions/`
3. Enable **Developer mode** (toggle in the left sidebar)
4. Click **Load unpacked**
5. Select the `edge-plugin-nvidia` folder

## Usage

1. Navigate to the page you want to monitor (e.g., NVIDIA store, Best Buy, etc.)
2. Click the extension icon in the toolbar
3. Click **"Start Monitoring This Page"**
4. The page will refresh every 10 seconds
5. When "RTX 5090 Founders Edition" is found, a siren will play and a green overlay will appear

## Adding a Custom Siren Sound

For the siren to work, add a file named `siren.mp3` to this folder. You can:
- Download any loud alarm/siren MP3 from the internet
- The extension includes a fallback generated alarm sound if no MP3 is found

## Files

- `manifest.json` - Extension configuration
- `background.js` - Service worker for refresh timing
- `content.js` - Page scanning and alert logic
- `popup.html/js` - Extension popup UI
- `siren.mp3` - Your alarm sound file (you need to add this)

## Notes

- Keep Edge open and the tab active for best results
- The extension will stop monitoring once the product is found
- Make sure your volume is turned up!

Good luck getting that RTX 5090! 🎮
