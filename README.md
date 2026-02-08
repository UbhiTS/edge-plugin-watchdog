# Watchdog 🐕 - Page Monitor Extension

A browser extension that monitors web pages for specific text and alerts you with a dog bark sound when found. Perfect for tracking stock availability, price drops, content updates, or any text changes on websites.

## Features

- 🔍 **Custom Text Monitoring** - Search for any text on any webpage
- � **AND/OR Search Terms** - Build complex queries with multiple terms (e.g., `"RTX 5090" AND "In Stock"`, or `"Add to Cart" OR "Buy Now"`) with proper operator precedence
- 📵 **Block Media Mode** - Optionally block images, video, fonts, and media during monitoring to save bandwidth and speed up refreshes
- 🐕 **Audio Alerts** - Plays a dog bark sound when your text is found (dual playback via offscreen document and content script for reliability)
- ⏱️ **Configurable Refresh** - Choose refresh intervals from 3 seconds to 5 minutes
- 📑 **Multi-Tab Support** - Monitor multiple pages simultaneously
- 🔢 **Multiple Monitors Per Tab** - Watch for different text strings on the same page
- 🕵️ **InPrivate Mode** - Bypass rate limiting by opening monitors in InPrivate windows
- 🔄 **Smart Error Recovery** - Automatic retry with exponential backoff when websites throttle requests; full InPrivate session reset after repeated failures
- 🎨 **Visual Alerts** - Bright full-page overlay notification when text is detected
- 📜 **History Tracking** - See when and where text was found
- ⏳ **Countdown Timer** - See when the next refresh will happen
- 🎯 **Focus Button** - Bring any monitored window to the front instantly
- 💾 **Saved Configurations** - Save, name, restore, and delete sets of monitors (up to 20 configs)
- 🔁 **URL-Specific Config Memory** - Auto-populates your last search terms and settings when revisiting a URL
- 📊 **Full Dashboard** - Dedicated page with active monitors, history, saved configs, and a real-time console log viewer
- 📐 **InPrivate Geometry Persistence** - InPrivate windows reopen at the same position and size after session resets
- 🛡️ **Stuck Monitor Watchdog** - Background timer detects and force-refreshes monitors that are stuck
- 🌐 **URL Redirect Detection** - Detects when a site redirects away from the monitored URL and automatically navigates back
- 🧭 **Navigation Error Recovery** - Catches DNS/network errors before the page loads and schedules automatic retries

## Installation

1. Open Microsoft Edge
2. Go to `edge://extensions/`
3. Enable **Developer mode** (toggle in the left sidebar)
4. Click **Load unpacked**
5. Select the extension folder

## Usage

1. Navigate to the page you want to monitor
2. Click the Watchdog extension icon in the toolbar
3. Enter one or more search terms (use **+ Add another term** for AND/OR queries)
4. Select a refresh interval
5. Optionally check **📵 No Media** to block images/video during monitoring
6. Click **"Start Monitoring"**
7. The page will auto-refresh and scan for your text
8. When found, you'll hear a dog bark and see a green alert overlay

### Tips

- Add multiple monitors to the same tab to watch for different text
- Monitor multiple tabs at once for comprehensive tracking
- Click "Dismiss" on any alert to stop the sound
- Use "Stop All" to stop monitoring everything at once
- Open the **Dashboard** (⛶ button) for a full-page view with console logs

### AND/OR Search Terms

Build powerful search queries by combining multiple terms:

- **AND** - All terms must be present on the page (e.g., `"RTX 5090" AND "Add to Cart"`)
- **OR** - Any group of terms matching is enough (e.g., `"In Stock" OR "Buy Now"`)
- **Precedence** - AND binds tighter than OR: `"A OR B AND C"` is evaluated as `"A OR (B AND C)"`

Click **+ Add another term (AND / OR)** in the popup to add more terms. Each term gets its own input row with an operator dropdown.

### Block Media Mode

When enabled, the extension uses `declarativeNetRequest` to block images, video, fonts, and other media files on monitored tabs. This is useful for:

- **Reducing bandwidth** during high-frequency refreshes
- **Speeding up page loads** — the extension only needs the HTML text, not media
- **Avoiding unnecessary downloads** when monitoring product pages with lots of images

The 📵 badge appears on monitors with media blocking active. The setting is saved per-URL and included in saved configurations.

### InPrivate Mode

Some websites (like NVIDIA's store, Best Buy, Amazon, and other high-demand retailers) implement aggressive rate limiting and bot detection that can block or throttle frequent page refreshes. This is especially common during product launches when many users are refreshing simultaneously.

**Why websites block you:**
- Repeated requests from the same session/cookies trigger anti-bot systems
- Your IP + session combination gets flagged as suspicious
- Sites may show "Access Denied", CAPTCHA pages, or simply stop loading

**How InPrivate Mode helps:**
- Each InPrivate window starts with a completely fresh session
- No cookies, cache, or browsing history is shared with your main browser
- The site sees you as a "new visitor" each time
- Helps bypass session-based rate limiting (though IP-based limits may still apply)

**To use InPrivate Mode:**
1. Click the **🕵️ InPrivate** button on any active monitor
2. The monitor will close the current tab and reopen in an InPrivate window
3. InPrivate windows don't share cookies/sessions, helping avoid rate limits
4. The InPrivate badge shows next to the monitor status

**InPrivate Geometry Persistence:**
- InPrivate windows remember their position and size per URL
- When a window is moved or resized, the geometry is saved automatically
- On session resets or config restores, windows reopen at the same location

**Pro Tips:**
- Start with InPrivate mode from the beginning for high-demand sites
- If you get blocked in your main browser, switch to InPrivate immediately
- Consider using a VPN alongside InPrivate for IP-based restrictions
- Some sites may still detect automation patterns - the Smart Backoff feature helps with this

### Smart Error Recovery

When a website returns an error page (throttling, "Access Denied", etc.), Watchdog handles it automatically at multiple levels:

**Content-side error detection** — A compiled regex detects common error patterns:
- "Access Denied", "Too Many Requests", "rate limit"
- HTTP 403/429/500/502/503/504 error pages
- "Can't reach this page", `ERR_CONNECTION_*`, `ERR_TIMED_OUT`, etc.
- CAPTCHA challenges and minimal error pages (<200 characters with error keywords)

**Navigation error recovery** — The `webNavigation.onErrorOccurred` listener catches DNS and network errors before the content script even runs, automatically scheduling retries.

**URL redirect detection** — If a site redirects to an error page with a different URL, the extension detects the mismatch and navigates back to the original URL.

**InPrivate full session reset** — After 3+ consecutive errors in InPrivate mode:
1. ALL InPrivate windows are closed simultaneously (they share one session)
2. The extension waits 1.5 seconds for full session destruction
3. Each window is reopened at its saved geometry with fresh sessions
4. A 60-second cooldown prevents rapid close/reopen loops

**Stuck monitor watchdog** — A background timer checks every 10 seconds for monitors that are 30+ seconds overdue for a refresh. Stuck monitors are force-refreshed automatically.

**Backoff timing:**
| Attempt | Wait Time |
|---------|-----------|
| 1st     | 5 seconds |
| 2nd     | 10 seconds |
| 3rd     | 20 seconds |
| 4th     | 40 seconds |
| 5th+    | 2 minutes (max) |

The backoff counter resets after a successful page load, so occasional errors won't permanently slow down your monitoring.

### Saved Configurations

Save your current set of active monitors as a named configuration:

1. Click **💾 Save** in the popup or dashboard when you have active monitors
2. Enter a name for the configuration
3. Restore it later to recreate all tabs/windows and restart monitoring

Saved configs preserve:
- Search terms and operators
- Refresh interval
- InPrivate mode state
- Block media setting
- URLs and tab titles

Up to 20 configurations can be stored. Available from both the popup and the dashboard.

### Dashboard

Open the full dashboard by clicking the **⛶** button in the popup. The dashboard provides:

- **Left panel** — Active monitors, saved configurations, and history with the same controls as the popup
- **Right panel** — Real-time console log viewer with:
  - Source filter (All / Background / Content)
  - Auto-scroll toggle
  - Logging enable/disable toggle (disabling stops log collection entirely)
  - Clear logs button
- **Resizable** panels via drag handle
- **Collapsible** console panel

The logging system captures events from both the background service worker and content scripts, with timestamps and source labels. Up to 500 log entries are kept in memory.

## Adding a Custom Sound

The extension plays `bark.mp3` when text is found. You can replace this file with any MP3 sound you prefer - just name it `bark.mp3` and place it in the extension folder.

## Files

- `manifest.json` - Extension configuration (Manifest V3)
- `background.js` - Service worker for refresh timing, monitor management, media blocking, and error recovery
- `content.js` - Page scanning, error/redirect detection, and alert display
- `popup.html/js` - Extension popup UI with search term builder
- `dashboard.html/js` - Full-page dashboard with console log viewer
- `shared.js` - Common utilities for building monitor/history/config UI
- `offscreen.html/js` - Offscreen document for reliable audio playback
- `bark.mp3` - Alert sound file (add your own)

## Permissions

| Permission | Purpose |
|------------|---------|
| `storage` | Persist monitors, history, configs, and settings |
| `tabs` | Access tab URLs and manage monitored tabs |
| `activeTab` | Read the current tab when adding a monitor |
| `scripting` | Inject content script for page scanning |
| `offscreen` | Play alarm sound from background via offscreen document |
| `webNavigation` | Detect navigation errors for automatic retry |
| `declarativeNetRequest` | Block media resources when "No Media" mode is enabled |
| `<all_urls>` | Monitor any website |

## Use Cases

- 🛒 **Stock Alerts** - Monitor product pages for "In Stock" or "Add to Cart"
- 💰 **Price Tracking** - Watch for specific prices or "Sale" text
- 📰 **Content Updates** - Get notified when articles or posts are updated
- 🎫 **Ticket Availability** - Monitor event pages for ticket releases
- 📦 **Shipping Updates** - Watch tracking pages for status changes

## Notes

- Keep Edge open for monitoring to work
- The extension will continue alerting until you dismiss it
- Make sure your volume is turned up!
- Monitors survive service worker restarts — timers and media blocking rules are restored automatically

Happy monitoring! 🐕
