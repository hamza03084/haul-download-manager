# Changelog

All notable changes to Haul Download Manager are listed here. Versions follow [Semantic Versioning](https://semver.org/).

## [1.4.0] - 2026-10-23

### Added
- **Several connections per download** (Settings → Connections per download, 1–16, default 4). Files of 2 MB or more are fetched in parts at the same time, each part over its own connection and written at its place in the single partial file. When a part finishes, the biggest part still running is split so the free connection helps with it. Every part is checkpointed on its own (flushed every 2 seconds, and when Windows shuts down), so pause, resume, closing Haul, crashes and power cuts keep each part's progress. Every part's reply is checked (byte position, size, ETag/Last-Modified) before it is written. Servers that refuse extra connections (HTTP 429/503/403) get fewer, with a note on the download; a server that answers a part request with the whole file gets one connection. Downloads from older versions continue in parts after a pause and resume. The card shows the open connections; the status bar shows the setting.
- **Video sites beyond YouTube.** Links to Vimeo, Dailymotion, Twitch, TikTok, X (Twitter), Facebook, Instagram, Reddit, Streamable, Bilibili, Rumble, Odysee, SoundCloud, Bandcamp, TED, VK, OK.ru and the Internet Archive open the quality picker like YouTube links. Sites that serve picture and sound in one stream (most of them) are handled: one stream is downloaded, nothing is joined, and "Video only" is offered only where the site has a separate picture stream. HLS and DASH streams are accepted (plain files preferred). Pages that do not say how big their video is get a "Best available" choice. The picker names the site.
- **Try as video** on a download that turned out to be a web page: asks yt-dlp whether that page has a video (it knows over a thousand sites) and opens the picker.
- **DRM services are refused** with the reason (Netflix, Disney+, Prime Video, Max, Hulu, Spotify, Peacock, Paramount+, Apple TV, Crunchyroll).
- **Browser extension 2.0: takes over downloads.** When a download starts in Chrome or Edge, the extension pauses it, hands the link, the browser's file name and the page it came from to Haul through native messaging, and removes it from the browser. Haul adds it at once (and notifies from the notification area when its window is hidden), starting by itself if it is not running. If Haul cannot be reached, the browser's download continues. The extension's popup has the file types to take over (defaults: archives, programs, video, music, documents, images, plus any file of 20 MB or more), an "every download" switch and an off switch; it also shows whether Haul is reachable. The right-click menu entry stays. Haul writes the native messaging host (a small PowerShell script, since an Electron program cannot be a host on Windows: Electron prints a newline to stdout at startup, which breaks the browser's message framing) and registers it for Chrome, Edge, Chromium and Brave on every start (per user); the uninstaller removes the entries. The page a captured link came from is sent as the `Referer` header, as the browser would have, which makes many file hosts accept the download.

### Changed
- The database schema is now version 4 (two new columns: the parts of a download and its referrer). Upgrading from 1.0–1.3 is automatic and keeps your history; older versions can still open the database, but finish or remove downloads in progress first: they do not understand parts.
- Settings and the picker say "video sites" instead of "YouTube" where it applies to all of them; yt-dlp's errors for unsupported pages, unavailable formats and sites that need an account are explained.

### Fixed
- A video from a site that serves picture and sound in one stream showed "Downloading video (1 of 2)" and an estimate that counted a sound stream that does not exist.

### Tests
- Full results, including five bugs found and fixed before release, are in [docs/test-report-1.4.0.md](docs/test-report-1.4.0.md).
- 35 new engine tests: planning and validating parts; several connections in flight; small files, no-range servers and the 1-connection setting staying single; ranges tried on servers that do not advertise them and the fallback when they ignore them; pause and resume of every part with If-Range; parts surviving a close and a simulated power cut (zeros past each checkpoint); checkpoints never ahead of the disk; `checkpointNow`; an older single-connection download continuing in parts; HTTP 429 back-off; a dropped part reconnecting; a changed file restarting; cancel and change link with parts; the shared speed limit; a damaged parts record; the Referer header; the crash test with 1 and 4 connections; the chaos test now alternates 1 and 2–4 connections; site detection and DRM refusal; Vimeo-style and generic-page probes; "best available"; the native messaging host itself (run for real through its .cmd, with Node standing in for Haul: ping, a captured download arriving as a haul:// link, the context-menu form, refused links and a refused extension), its framing, manifest and registry entries (under a test key). The end-to-end UI test covers the connections setting and card, a Vimeo link through the picker, "Try as video", and the native messaging host receiving a download from a (simulated) browser.

## [1.3.0] - 2026-10-23

### Added
- **Notification area icon.** Haul now has an icon in the Windows notification area (tray) with Open, Resume all, Pause all, Shut down the PC when downloads finish, and Quit. Its tooltip shows how many downloads are running and their total speed.
- **Start Haul when I sign in to Windows** (Settings, off by default). Haul then starts hidden in the notification area and continues unfinished downloads by itself, so a download interrupted by a restart no longer waits for you to open Haul. Registered for the current user only (no administrator rights); the uninstaller removes it.
- **Keep running in the background when the window is closed** (Settings, off by default). Closing the window hides Haul in the notification area and downloads continue; quit from the icon's menu.
- **Change link** for paused, failed and cancelled downloads, for links that expired while a download was stopped (common with links copied from a website's player or a cloud drive). The data downloaded so far is kept, and Haul continues from it when the new link serves the same file (same size and version), otherwise it starts over and says so.
- **Speed limit** (Settings): one limit in KB/s shared by all downloads together, applied immediately to running downloads. YouTube downloads get the same limit through yt-dlp when they start.
- **Sort downloads into folders by type** (Settings, off by default): downloads go into a `Video`, `Music`, `Images`, `Documents`, `Programs` or `Archives` subfolder of the download folder according to their file type; other files stay in the download folder. Downloads for which you pick a folder yourself are not sorted. The list has a matching **type filter** next to the search box (it works whether or not sorting is on).
- **Shut down the PC when downloads finish** (button above the list, and in the notification area menu). When every download has finished, a 60-second countdown with a Cancel button appears, then Windows shuts down the way it does from the Start menu (programs with unsaved work can still stop it). Adding or resuming a download during the countdown postpones it.

### Changed
- The database schema is now version 3 (one new column). Upgrading from 1.0–1.2 is automatic and keeps your history; older versions can still open the database.
- The status bar shows the speed limit and whether sorting by type is on.

### Tests
- Full results, including two bugs found and fixed before release, are in [docs/test-report-1.3.0.md](docs/test-report-1.3.0.md).
- 17 new engine and unit tests (speed limit pacing, shared limit, yt-dlp limit, change link with resume, restart and expired links, categories at add time and at server naming, pause/resume/restart inside a category folder, shutdown-when-done state machine, settings validation, schema 3 upgrade). The end-to-end UI test now also covers the speed limit, sorting and the type filter, changing an expired link, the shutdown countdown and its cancellation, closing to the notification area and restoring from it, starting hidden, and (on packaged builds) the Windows startup entry.

## [1.2.0] - 2026-10-22

### Added
- **YouTube works without installing anything yourself.** Haul now downloads yt-dlp, FFmpeg and Deno from their official GitHub release pages into `%APPDATA%\Haul Download Manager\tools` (a 150 MB download, no administrator rights). This starts a few seconds after Haul opens; a YouTube link pasted earlier waits for it, with progress in the quality picker. Every file is checked against the SHA-256 checksum its project publishes before it is used.
- **yt-dlp stays up to date.** Haul checks once a day for a newer yt-dlp and replaces its copy, even while a video is downloading. **Settings → YouTube downloads → Update now** checks right away.
- **Settings → YouTube downloads → Get these tools automatically** (on by default). Turned off, Haul never contacts GitHub. Tools you installed yourself (winget, or a folder chosen in Settings) are used as before, and Haul then downloads nothing.

### Changed
- Haul now connects to GitHub for the tools above (see [Your data and privacy](README.md#your-data-and-privacy)). It still sends no telemetry.
- The source code is now public at [github.com/hamza03084/haul-download-manager](https://github.com/hamza03084/haul-download-manager), and the User-Agent includes that address as contact information.

## [1.1.0] - 2026-10-22

### Added
- **YouTube downloads with a quality picker.** Paste a YouTube link and Haul lists every available version: **Video + sound** at each resolution (2160p/4K, 1440p, 1080p, 720p… with frame rate, codec and estimated size), **Video only**, or **Audio only** (M4A original quality or MP3). It can also save the thumbnail and subtitles. Video downloads join the normal list with progress, pause, resume, cancel, crash recovery and the queue. This uses the free tools [yt-dlp](https://github.com/yt-dlp/yt-dlp), FFmpeg and Deno, which you install yourself; Haul does not include them. See [YouTube downloads](README.md#youtube-downloads).
- **Settings → YouTube downloads** shows which tools were found, with install instructions, and lets you choose where yt-dlp.exe is.
- Tests: a fake yt-dlp for offline tests of the whole video flow, including pause during joining and a leftover yt-dlp after a crash. Also tests for power-cut simulation, checkpoint durability, Windows session end, web-page detection, damaged databases, user-deleted partial files, and a randomised "impatient user" test.
- `scripts/live-test.mjs`: an optional real-internet test of a packaged build. It downloads large HD videos from Blender's server and from YouTube (with `--ytdlp`), kills the app mid-download, and checks every file with CRC checksums or a full FFmpeg decode.

### Fixed
- **YouTube links were "downloaded" as a web page.** Haul 1.0 saved the page's HTML as `watch.html` and showed it as **Done**. YouTube links now open the quality picker.
- **Web pages served instead of files are flagged.** When a link returns a web page (a login page, an expired link, a "your download will start" page), the finished download says so instead of looking like the expected file.
- **Power cuts can no longer corrupt a resumed download.** During a download, Haul now flushes the partial file to disk every 2 seconds and records how much is safely stored. After a crash, power cut or forced shutdown, it cuts off anything past that point before continuing. Previously, data Windows had not yet written to disk could be read back as zeros and end up inside the finished file.
- **Windows shutdown, restart and sign-out** now save download progress immediately. Windows does not give apps a normal close in this case.
- **A damaged history database no longer stops Haul from starting.** The damaged file is kept as `haul.db.corrupt-<date>` and Haul starts with an empty list. Downloaded files are not affected.
- **HTTPS works behind antivirus HTTPS scanning and company proxies.** Haul now trusts the Windows certificate store, as browsers do.
- File names such as `NUL.tar.gz` or `con.min.js` (Windows device names, which Explorer cannot open or delete) are prefixed with `_`. Invisible right-to-left and zero-width characters, which can disguise an extension (`invoice[U+202E]fdp.exe`), are removed.
- A partial file deleted while a download was paused made it restart silently; it now says why.
- The taskbar progress update no longer checks every finished file in the history twice a second.

### Changed
- Each download's main action (**Pause**, **Resume**, **Retry**, **Open**) is now a labelled button instead of a small icon.
- Downloads show **Resumable** or **No resume**, so you know before pausing whether progress will be kept.
- Adding a link that is already queued, downloading or paused asks for confirmation instead of silently making a second copy. Pasting a batch skips such links (and YouTube links, which need a quality choice each).
- The database schema is now version 2 (two new columns). Upgrading from 1.0 is automatic and keeps your history. If you go back to 1.0, it can still open the database, but finish or remove unfinished YouTube downloads first: 1.0 does not understand them.
- The User-Agent now includes the app version (`HaulDownloadManager/1.1.0 (Windows)`). If `homepage` is set in `package.json`, it is included as contact information, which some sites (for example Wikimedia) require.

## [1.0.0] - 2026-10-22

First release: HTTP/HTTPS downloads with a queue, pause and resume (validated byte ranges), automatic retries, crash recovery, persistent history and settings (SQLite), Mark of the Web on finished files, an optional Chrome/Edge extension, and a per-user Windows installer plus a portable build.

[1.4.0]: https://github.com/hamza03084/haul-download-manager/releases/tag/v1.4.0
[1.3.0]: https://github.com/hamza03084/haul-download-manager/releases/tag/v1.3.0
[1.2.0]: https://github.com/hamza03084/haul-download-manager/releases/tag/v1.2.0
[1.1.0]: #110---2026-10-22
[1.0.0]: #100---2026-10-22
