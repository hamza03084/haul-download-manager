# Changelog

All notable changes to Haul Download Manager are listed here. Versions follow [Semantic Versioning](https://semver.org/).

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

[1.2.0]: https://github.com/hamza03084/haul-download-manager/releases/tag/v1.2.0
[1.1.0]: #110---2026-10-22
[1.0.0]: #100---2026-10-22
