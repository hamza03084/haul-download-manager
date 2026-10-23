# Haul Download Manager 1.4.0: test report

Tested on 23 October 2026 on one PC: Windows 11 Pro (build 26300), x64. Build tools: Node.js 22.14, Electron 44.9.3, electron-builder 26.15. Offline tests use the local test server and the fake yt-dlp; the real yt-dlp 2026.10 (Haul's own copy in `%APPDATA%\Haul Download Manager\tools`) was used for the live test.

Each result is **PASS**, **FAIL** or **NOT TESTED**. Nothing is marked PASS unless the test ran and produced the evidence quoted.

## What 1.4.0 adds

Several connections per download (parts with per-part checkpoints, dynamic splitting, back-off, fallback); video sites beyond YouTube through yt-dlp (combined streams, HLS/DASH, "Best available", "Try as video", DRM refusal); browser extension 2.0 that takes over the browser's downloads through a native messaging host (a PowerShell script host, see below) with the referrer passed on. Database schema 3 → 4 (`segments`, `referrer`).

## Release files

| File | Size (bytes) | SHA-256 |
| --- | --- | --- |
| `Haul-Download-Manager-Setup-1.4.0-x64.exe` | 111,907,757 | `bd8ea429810e83e214e988ed55cf6a35e77bcbb9c0ba0f4b9c86642f86fe074d` |
| `Haul-Download-Manager-1.4.0-x64-portable.exe` | 111,685,392 | `eb7f87367e03dd8eb676d92dca4d92780921b34d225b29bdd4209d591c211dc0` |

Both are **not code-signed**.

## Bugs found and fixed during testing

| # | Problem | Found by | Fix |
| --- | --- | --- | --- |
| 1 | A video from a site that serves picture and sound in one stream (Vimeo and most sites other than YouTube) showed "Downloading video (1 of 2)" and an estimate that counted a sound stream that does not exist. | New engine test for a Vimeo-style probe and download. | The two-stream progress is used only when a separate sound stream was chosen. |
| 2 | **An Electron program cannot be a native messaging host on Windows.** Electron's main process writes a newline to stdout at startup (`ElectronMainDelegate::BasicStartupComplete`, "so the prompt is not on the same line"), which breaks the browser's length-prefixed framing, and `process.stdin` ends at once in the main process. The first design (Haul's exe as the host) answered every browser message with "Message too large". | UI end-to-end test, check "the native messaging host answers a ping". | The host is now a small PowerShell script (started through a `.cmd`, as browsers allow) that Haul writes and registers; it hands the request to Haul as a `haul://add` link. Tested for real through its `.cmd`. |
| 3 | In the PowerShell host, `$origin` (the caller) silently overwrote `$Origin` (the allowed extension): variable names are case-insensitive, so any extension was accepted. | Engine test "another extension is refused by the host". | Distinct names; the test proves the refusal. |
| 4 | After the first (Electron-based) host failed, the module-level request queue was read before it was initialised (temporal dead zone), so the app did not start at all. | Dev e2e (no window within 30 s) and a direct launch. | Arguments are parsed after `app.whenReady()`. |
| 6 | Sites that report only a file's container, not its codecs (the Internet Archive, plain files found by the generic extractor): an `.ogv` was treated as picture without sound and an `.avi` was not listed at all. | Live test against archive.org (the picker listed 360p and 300p, "video only" offered). | A video container counts as picture with sound unless the site says "none"; AVI, WMV and MPEG containers are recognised. Fixture test added. |
| 7 | Haul asked yt-dlp to remux every video into MP4; for an Ogg Theora file FFmpeg's remux failed ("Postprocessing: Conversion failed!") and the download ended as failed although the file had been fetched. | Live test against archive.org. | Only containers whose codecs fit MP4 (MOV, M4V, 3GP, TS, FLV, MKV, WebM) are remuxed; others are kept as they are. |
| 8 | On sites whose streams have no IDs of their own, yt-dlp numbers them in sort order, so the `-S` codec preference Haul passed made ID "1" mean the OGV during the download although it meant the MP4 during the probe. | Live test against archive.org (44.8 MB downloaded for a 59 MB choice); confirmed with `yt-dlp -s --print` by hand. | The codec sort is passed for YouTube only, where it matters and where IDs are the extractor's own. Tests assert its absence elsewhere. |
| 9 | The speed meter merged samples arriving within 100 ms into its very first sample, so a download that arrived in one burst (a fast server; GitHub's runner with fine-grained timers) never showed a speed and the card said "—". Harmless for real downloads over the internet, but wrong. | CI: "speed was reported" and the stalled-transfer test failed on the GitHub runner while passing locally. | The first sample is never merged; unit test with a burst added. The stalled-transfer test also got wider timing margins. |
| 5 | Three test problems: a stepper button lookup matched both "Fewer" and "Fewer connections"; the 4-connection crash test killed the child before its first checkpoint existed (600 KB arrive in under 100 ms with four connections); and the "Windows is ending the session" log line (written asynchronously) raced the simulated kill. | e2e and the full suite. | Exact lookup; the crash test waits for a stored checkpoint; the e2e waits for the log line before killing. Test-only changes. |

## Automated tests (offline, repeatable)

| Suite | Result | What it covers |
| --- | --- | --- |
| `npm run typecheck` | **PASS** | Main process, engine, native host module, tests and renderer under TypeScript strict mode. |
| `npm test` (`HAUL_CHAOS_SEEDS=10`, run three times in all; the final run on the released code) | **PASS** 142/142 | Everything from 1.3.0 (102 tests, the single-connection path unchanged: the harness keeps one connection unless a test asks for more) plus the new suites: parts planning and validation; a 3 MB file over 4 connections (4 responses in flight, byte-identical, progress monotonic); small files, `Accept-Ranges: none` and the 1-connection setting staying single; a server that honours ranges without advertising them downloaded in parts; a server that ignores Range requests making the download fall back to one connection (file intact, `resumable: false` learned); pause with four half-done parts, each resumed from its own position with If-Range; parts surviving a close plus a simulated power cut (zeros past each checkpoint, file byte-identical); checkpoints of every part never ahead of the disk; `checkpointNow`; a 1.3 single-connection download continuing in parts after the upgrade; HTTP 429 for extra connections (never more than 2 in flight, notice shown); a dropped part reconnecting; a changed file (ETag) restarting; cancel and change link with parts; the shared speed limit across connections; a damaged parts record starting over; the Referer header; the crash test with 1 and 4 connections (each part resumed from its checkpoint); the chaos soak with 1 and 2–4 connections; site detection for 19 sites, direct files on them, look-alike hosts; DRM refusal; Vimeo-style and generic-page probes; `-f` for combined streams and `ba/b`; "Best available"; yt-dlp error wording; a Vimeo download through the fake yt-dlp; the native messaging host run for real (ping, captured download → `haul://` link with name, referrer and `auto`, context-menu form, refused links, refused extension), framing, manifest files and registry entries under a test key; settings validation; schema 3 → 4 upgrade. |
| UI end-to-end, development build | **PASS** 78/78 | Everything from 1.3.0 plus: the connections stepper (default 4) and the status bar; an 8 MB download over 4 connections with "4 connections" on the card, paused (partial kept, details show the parts), resumed byte-identical with 4 responses in flight; the expired-link check continuing from the partial data; a Vimeo link opening the picker named "Vimeo", listing 1080p…240p with "+ sound", "Video only" unavailable, downloaded as one stream into `Video\`; a web page flagged, **Try as video** opening the picker with "Best available" and downloading the page's video; the host answering a ping, delivering a captured download to the running Haul (added at once under the browser's name, card shows the page it came from), refusing an ftp link and another extension; with Haul closed, the host starting Haul with the captured download, which downloads it. |
| UI end-to-end, packaged build (`release\win-unpacked`) | **PASS** 71/71 | The same minus the checks that need the development build, plus the Windows startup entry. Run twice: before and after the fixes found by the live test. |
| Real browser: `node scripts/browser-capture-test.mjs --exe … --browser msedge` | **PASS** 9/9 | A real Microsoft Edge with the extension loaded unpacked; the host registered under Edge's real registry key (saved and restored). Clicking a download link on a local page: Edge started its own download, the extension handed it to the running packaged Haul, Haul completed it byte-identical (3 MB) and logged it as captured, Edge's download ended as "canceled", and no copy was left in Edge's download folder. |
| Real browser: the same with `--browser chrome` | **NOT TESTED** | Chrome 137 and later ignore `--load-extension` for the branded build, so the extension cannot be loaded by automation. The extension and host are the same for both browsers; a manual check in Chrome is described below. |

## Live test (real internet, packaged build, real yt-dlp)

`node scripts/live-test.mjs --exe "release\win-unpacked\Haul Download Manager.exe" --ytdlp "%APPDATA%\Haul Download Manager\tools\yt-dlp.exe"`

| Check | Result | Evidence |
| --- | --- | --- |
| parts: the Blender server serves the file in parts over several connections | **PASS** | 4 connections shown on the card at 35 % |
| crash: partial file survives a hard kill of the app | **PASS** | killed at 35 % after 25 s; `.haulpart` 104.6 MB |
| crash: download continued after relaunch instead of starting over | **PASS** | Range request from byte 13,060,352; card after relaunch "46.0 MB of 120 MB · 2.26 MB/s · 4 connections"; log: 4 part(s) with up to 4 connections |
| crash: resumed 125 MB 1080p video archive is intact (CRC-32) | **PASS** | 125,632,282/125,632,282 bytes; caminandes_gran_dillama.mp4 CRC 4d5030db OK |
| crash: main-process peak memory | INFO | 126.3 MB |
| pause: transfer stops and the partial file is kept | **PASS** | 209.8 MB on disk, unchanged after 4 s |
| pause: resume continued from the paused data (Range) instead of starting over | **PASS** | from byte 13,060,352 and 11,743,488; 4 parts / 4 connections on every start |
| pause: resumed 275 MB 1080p video archive is intact (CRC-32) | **PASS** | 275,524,128/275,524,128 bytes; bbb_sunflower_1080p_30fps_normal.mp4 CRC 1430636f OK |
| site: the picker opens for an Internet Archive link and lists its sizes | **PASS** | "Internet Archive", lookup took 8 s |
| site: the 720p AVI (preselected on the first run) is downloaded complete under its real name | **PASS** | `Big Buck Bunny.avi`, 332,243,668 bytes (the file's full size on archive.org); the card was renamed from the provisional `.mp4` to `.avi`, which the first version of the live script did not follow (script fixed) |
| site: the 360p MP4 is a complete file with picture and sound that decodes cleanly | **PASS** | `Big Buck Bunny.mp4` 59.0 MB; H.264 640×360, AAC, 596.5 s; every frame decoded in 7 s, no errors |
| youtube: quality picker lists the real formats | **PASS** | 2160p60 (4K), 1440p60 (2K), 1080p60, 720p60, 480p, 360p, 240p, 144p; lookup took 20 s (run later in the session, once YouTube's "not a bot" check had lifted) |
| youtube: partial video survives a hard kill of the app | **PASS** | killed at 31 %, 59.0 MB in `.part` files |
| youtube: pause stops yt-dlp (partial files stop growing) | **PASS** | 70.9 MB on disk, unchanged after 4 s |
| youtube: continued from partial data after the kill and after pause (not restarted) | **PASS** | resumed at 59.0 MB and 70.9 MB |
| youtube: 720p60 video is a valid H.264 + AAC MP4 of the full length | **PASS** | 153.7 MB; H.264 1280×720, AAC, 634.6 s |
| youtube: every frame of the resumed 720p video decodes without errors | **PASS** | decoded in 41 s, no errors |
| youtube: 1080p60 video (~256 MB) is complete and decodes cleanly | **PASS** | 255.9 MB; H.264 1920×1080, AAC, 634.6 s; decoded in 107 s, no errors |
| youtube: audio-only MP3 + thumbnail | **PASS** | 17.2 MB MP3, 634.6 s, thumbnail 0.1 MB |
| youtube: main-process peak memory | INFO | 112.9 MB |

## Not tested

- **YouTube's "not a bot" check**: for about an hour of this session YouTube refused every lookup from this network (also when running yt-dlp by hand); Haul showed the explained message in the picker. The live YouTube scenario was run once the check had lifted and passed in full (table above). Nothing can be done about the check itself.
- **Vimeo with the real yt-dlp**: Vimeo's web player now requires a signed-in account for yt-dlp ("The web client only works when logged-in"), so a Vimeo download could not be verified live; Haul reports it as needing a signed-in account. The Internet Archive was used instead for the live "other site" scenario.
- The extension inside **Chrome** (it was driven for real in Edge, see above). To check by hand: open `chrome://extensions`, turn on Developer mode, **Load unpacked** → the `browser-extension` folder; start Haul once (it registers the host); click any download link of a type on the extension's list (for example a `.zip`) and watch it appear in Haul while it disappears from Chrome's download list.
- The extension's **popup** (file-type list, size threshold, "every download", off switch) was reviewed but not driven by a test; the capture itself used the default list.
- PCs where group policy forbids PowerShell scripts (`-ExecutionPolicy Bypass` is overridden by an AllSigned policy): capture would fail there; the right-click menu still works through `haul://`.
- Servers that use HTTP/2 or that serve parts from different mirrors with different ETags (the parts check ETag/Last-Modified and size against the first response; a mismatch restarts the download).
- The uninstaller removing the native messaging registry keys (the installer was built but not installed on this PC).
- Other machines. The packaged build was tested on this one PC only.
