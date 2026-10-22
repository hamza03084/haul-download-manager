# Roadmap

Ideas for future versions of Haul, in the order they are planned. None of these are in 1.2.0. Effort: S = small, M = medium, L = large.

## 1. Quick wins

| Feature | Effort | Notes |
| --- | --- | --- |
| Tray icon and **start with Windows** | S | Electron `Tray` and `app.setLoginItemSettings` (per-user, no admin). Downloads interrupted by a shutdown would then continue automatically after the restart. Needed before the scheduler. |
| **Change link** for paused or failed downloads | S | For expired links. Keep the partial file; the existing size/ETag check confirms it is the same file before continuing, otherwise it restarts. |
| **Speed limit** | S | Throttle in the transfer stream (token bucket); pass `--limit-rate` to yt-dlp. |
| **Categories** | S | Video / Music / Programs / Archives subfolders by file type, plus a filter in the list. |
| **Shut down the PC when downloads finish** | S | With a cancellable countdown. |

## 2. Bigger features

| Feature | Effort | Notes |
| --- | --- | --- |
| **Automatic capture from the browser** | M | Upgrade the extension to intercept the browser's own downloads (`chrome.downloads`) and hand them to Haul through native messaging instead of `haul://`. The registry entry is per-user (HKCU), so the installer can register it without admin. Chrome Web Store publishing: one-time $5 fee plus review; Edge Add-ons is free. |
| **More video sites** | S–M | yt-dlp supports over 1,000 sites: offer the quality picker for any link yt-dlp recognises, not just YouTube. Never sites that use DRM (Netflix, Disney+, Spotify…): getting around it is not allowed. |
| **Cookies and logins** | M | The extension sends Haul the cookies for that one download only; they are kept in memory and never logged or saved. Notes: yt-dlp's `--cookies-from-browser` currently cannot read Chrome/Edge cookies on Windows (app-bound encryption); Firefox works. Using a YouTube account with yt-dlp can get the account flagged. |
| **Multiple connections per file** | L | Split into byte ranges (default 4, configurable up to 8–16), each resumed and checkpointed separately; check that every part comes from the same file version (ETag/size). Helps only when the server limits each connection, not when the user's line is the bottleneck. Some servers treat many connections as abuse. For YouTube, pass `-N` to yt-dlp. |
| **Proxy** | M | Use Windows/PAC proxy settings (Electron `session.resolveProxy`) in the engine and pass `--proxy` to yt-dlp. Needs testing behind a real proxy. |
| **Scheduler** | S–M | Start/stop the queue at set times. Needs the tray and start-with-Windows first. |

## 3. After the project is published on GitHub

| Feature | Effort | Notes |
| --- | --- | --- |
| **Auto-update** | M | `electron-updater` with GitHub Releases. |
| **Code signing** | setup | Removes the SmartScreen warning over time. Options: SignPath's free signing for open-source projects (signs CI builds), Microsoft Azure Trusted Signing (cheap monthly, limited by country and identity), or a commercial certificate (about $200–500 a year). Needs money or an account, not code. |

## Not planned

- **FTP**: rarely used today; would need an extra library.
- **DRM-protected streaming services**: getting around copy protection is not allowed.

Every feature should come with the same kind of tests as 1.1.0: engine tests against the local test server or fake yt-dlp, the UI end-to-end test, and a real-world check with `scripts/live-test.mjs`.
