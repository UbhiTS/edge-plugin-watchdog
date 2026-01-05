# Watch Dog 🐕 - Page Monitor Extension

A browser extension that monitors web pages for specific text and alerts you with a dog bark sound when found. Perfect for tracking stock availability, price drops, content updates, or any text changes on websites.

## Features

- 🔍 **Custom Text Monitoring** - Search for any text on any webpage
- 🐕 **Audio Alerts** - Plays a dog bark sound when your text is found
- ⏱️ **Configurable Refresh** - Choose refresh intervals from 3 seconds to 5 minutes
- 📑 **Multi-Tab Support** - Monitor multiple pages simultaneously
- 🔢 **Multiple Monitors Per Tab** - Watch for different text strings on the same page
- 🕵️ **InPrivate Mode** - Bypass rate limiting by opening monitors in InPrivate windows
- 🔄 **Smart Backoff** - Automatic exponential backoff when websites throttle requests
- 🎨 **Visual Alerts** - Bright overlay notification when text is detected
- 📜 **History Tracking** - See when and where text was found
- ⏳ **Countdown Timer** - See when the next refresh will happen
- 🎯 **Focus Button** - Bring any monitored window to the front instantly

## Installation

1. Open Microsoft Edge
2. Go to `edge://extensions/`
3. Enable **Developer mode** (toggle in the left sidebar)
4. Click **Load unpacked**
5. Select the extension folder

## Usage

1. Navigate to the page you want to monitor
2. Click the Watch Dog extension icon in the toolbar
3. Enter the text you want to search for
4. Select a refresh interval
5. Click **"Add Monitor"**
6. The page will auto-refresh and scan for your text
7. When found, you'll hear a dog bark and see a green alert overlay

### Tips

- Add multiple monitors to the same tab to watch for different text
- Monitor multiple tabs at once for comprehensive tracking
- Click "Dismiss" on any alert to stop the sound
- Use "Stop All" to stop monitoring everything at once

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

**Pro Tips:**
- Start with InPrivate mode from the beginning for high-demand sites
- If you get blocked in your main browser, switch to InPrivate immediately
- Consider using a VPN alongside InPrivate for IP-based restrictions
- Some sites may still detect automation patterns - the Smart Backoff feature helps with this

### Smart Backoff

When a website returns an error page (throttling, "Access Denied", etc.), Watch Dog automatically:

1. Detects the error using common error patterns
2. Closes the current InPrivate window
3. Waits with exponential backoff (5s → 10s → 20s → 40s, up to 2 minutes max)
4. Opens a fresh InPrivate window and continues monitoring
5. Shows the backoff countdown in the popup (e.g., "⏳ Backoff #3")

This prevents aggressive retries that could get you temporarily banned.

**Error patterns detected:**
- "Access Denied" messages
- HTTP 403/429 error pages
- CAPTCHA challenges
- "Too Many Requests" responses
- Generic error pages with minimal content

**Backoff timing:**
| Attempt | Wait Time |
|---------|-----------|
| 1st     | 5 seconds |
| 2nd     | 10 seconds |
| 3rd     | 20 seconds |
| 4th     | 40 seconds |
| 5th+    | 2 minutes (max) |

The backoff counter resets after a successful page load, so occasional errors won't permanently slow down your monitoring.

## Adding a Custom Sound

The extension plays `bark.mp3` when text is found. You can replace this file with any MP3 sound you prefer - just name it `bark.mp3` and place it in the extension folder.

## Files

- `manifest.json` - Extension configuration
- `background.js` - Service worker for refresh timing and monitor management
- `content.js` - Page scanning and alert display
- `popup.html/js` - Extension popup UI
- `offscreen.html/js` - Audio playback handler
- `bark.mp3` - Alert sound file (add your own)

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

Happy monitoring! 🐕
