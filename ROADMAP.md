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

## Done in 1.4.0

| Feature | Notes |
| --- | --- |
| **Multiple connections per file** | Up to 16 parts (default 4), each checkpointed separately and validated against the same file version; dynamic splitting when a part finishes; back-off when the server refuses extra connections; fallback to one connection when the server ignores ranges. Not yet: `-N` for yt-dlp. |
| **More video sites** | The picker opens for 19 known sites; any other page can be tried through "Try as video". Combined (video + sound) streams, HLS/DASH and "best available" are handled. DRM services are refused. |
| **Automatic capture from the browser** | Extension 2.0 intercepts `chrome.downloads`, hands them to Haul through a native messaging host (registered per user for Chrome, Edge, Chromium, Brave) and passes the referrer. Not yet published on the Chrome Web Store / Edge Add-ons (load unpacked). |

## 1. Bigger features

| Feature | Effort | Notes |
| --- | --- | --- |
| **Scheduler** | S–M | Start/stop the queue at set times. The tray and start-with-Windows it needs are in place since 1.3.0. |
| **Publish the extension** | setup | Chrome Web Store: one-time $5 fee plus review; Edge Add-ons is free. Firefox would need a separate native messaging registration (`HKCU\Software\Mozilla\NativeMessagingHosts`) and `allowed_extensions`. |
| **Cookies and logins** | M | The extension sends Haul the cookies for that one download only; they are kept in memory and never logged or saved. Notes: yt-dlp's `--cookies-from-browser` currently cannot read Chrome/Edge cookies on Windows (app-bound encryption); Firefox works. Using a YouTube account with yt-dlp can get the account flagged. |
| **Several connections for yt-dlp** | S | Pass `-N` to yt-dlp for sites that serve plain files or DASH fragments. |
| **Proxy** | M | Use Windows/PAC proxy settings (Electron `session.resolveProxy`) in the engine and pass `--proxy` to yt-dlp. Needs testing behind a real proxy. |
| **Per-download speed limit for video pages that changes while running** | S | The shared limit applies to yt-dlp only when a video download starts; changing it mid-video would need restarting yt-dlp (it resumes its partial streams, so this is cheap). |

## 2. After the project is published on GitHub

| Feature | Effort | Notes |
| --- | --- | --- |
| **Auto-update** | M | `electron-updater` with GitHub Releases. |
| **Code signing** | setup | Removes the SmartScreen warning over time. Options: SignPath's free signing for open-source projects (signs CI builds), Microsoft Azure Trusted Signing (cheap monthly, limited by country and identity), or a commercial certificate (about $200–500 a year). Needs money or an account, not code. |

## Not planned

- **FTP**: rarely used today; would need an extra library.
- **DRM-protected streaming services**: getting around copy protection is not allowed.

Every feature should come with the same kind of tests as 1.1.0: engine tests against the local test server or fake yt-dlp, the UI end-to-end test, and a real-world check with `scripts/live-test.mjs`.
