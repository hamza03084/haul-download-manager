# Roadmap

Ideas for future versions of Haul, in the order they are planned. Effort: S = small, M = medium, L = large.

## Done in 1.3.0 (the "quick wins")

| Feature | Notes |
| --- | --- |
| **Tray icon and start with Windows** | Notification area icon with Open, Resume all, Pause all, shut down when done, Quit. "Start Haul when I sign in to Windows" (per-user Run entry, no admin) starts it hidden so downloads interrupted by a restart continue by themselves. "Keep running in the background when the window is closed" is a separate, optional setting. |
| **Change link** for paused, failed or cancelled downloads | For expired links. The partial file is kept; the existing size/ETag checks confirm it is the same file before continuing, otherwise it restarts. |
| **Speed limit** | Token bucket shared by all transfers (total limit, applied immediately); `--limit-rate` for yt-dlp. |
| **Categories** | Video / Music / Images / Documents / Programs / Archives subfolders by file type (optional), plus a type filter in the list. |
| **Shut down the PC when downloads finish** | 60-second cancellable countdown, then `shutdown /s /t 0` (no `/f`, so other programs can still object). |

## 1. Bigger features

| Feature | Effort | Notes |
| --- | --- | --- |
| **Scheduler** | S–M | Start/stop the queue at set times. The tray and start-with-Windows it needs are in place since 1.3.0. |
| **Automatic capture from the browser** | M | Upgrade the extension to intercept the browser's own downloads (`chrome.downloads`) and hand them to Haul through native messaging instead of `haul://`. The registry entry is per-user (HKCU), so the installer can register it without admin. Chrome Web Store publishing: one-time $5 fee plus review; Edge Add-ons is free. |
| **More video sites** | S–M | yt-dlp supports over 1,000 sites: offer the quality picker for any link yt-dlp recognises, not just YouTube. Never sites that use DRM (Netflix, Disney+, Spotify…): getting around it is not allowed. |
| **Cookies and logins** | M | The extension sends Haul the cookies for that one download only; they are kept in memory and never logged or saved. Notes: yt-dlp's `--cookies-from-browser` currently cannot read Chrome/Edge cookies on Windows (app-bound encryption); Firefox works. Using a YouTube account with yt-dlp can get the account flagged. |
| **Multiple connections per file** | L | Split into byte ranges (default 4, configurable up to 8–16), each resumed and checkpointed separately; check that every part comes from the same file version (ETag/size). Helps only when the server limits each connection, not when the user's line is the bottleneck. Some servers treat many connections as abuse. For YouTube, pass `-N` to yt-dlp. |
| **Proxy** | M | Use Windows/PAC proxy settings (Electron `session.resolveProxy`) in the engine and pass `--proxy` to yt-dlp. Needs testing behind a real proxy. |
| **Per-download speed limit for YouTube that changes while running** | S | The shared limit applies to yt-dlp only when a video download starts; changing it mid-video would need restarting yt-dlp (it resumes its partial streams, so this is cheap). |

## 2. After the project is published on GitHub

| Feature | Effort | Notes |
| --- | --- | --- |
| **Auto-update** | M | `electron-updater` with GitHub Releases. |
| **Code signing** | setup | Removes the SmartScreen warning over time. Options: SignPath's free signing for open-source projects (signs CI builds), Microsoft Azure Trusted Signing (cheap monthly, limited by country and identity), or a commercial certificate (about $200–500 a year). Needs money or an account, not code. |

## Not planned

- **FTP**: rarely used today; would need an extra library.
- **DRM-protected streaming services**: getting around copy protection is not allowed.

Every feature should come with the same kind of tests as 1.1.0: engine tests against the local test server or fake yt-dlp, the UI end-to-end test, and a real-world check with `scripts/live-test.mjs`.
