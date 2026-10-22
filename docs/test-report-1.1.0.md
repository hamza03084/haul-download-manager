# Haul Download Manager 1.1.0: test report

Tested on 22 October 2026 on one PC: Windows 11 Pro (build 26300), x64, home connection of about 1.7 MB/s. The build tools were Node.js 22.14, Electron 44.9.3 and electron-builder 26.15. YouTube tests used yt-dlp 2026.10.21, FFmpeg (yt-dlp build N-127911) and Deno 2.9.8, downloaded from their official GitHub releases and checked against the published SHA-256 sums.

Each result is **PASS**, **FAIL** or **NOT TESTED**. Nothing is marked PASS unless the test ran and produced the evidence quoted.

## Release files

| File | Size (bytes) | SHA-256 |
| --- | --- | --- |
| `Haul-Download-Manager-Setup-1.1.0-x64.exe` | 111,882,431 | `fe8c02bb493f042f1fef79ddedee58ca181151b1058a483e2b326edec5c62692` |
| `Haul-Download-Manager-1.1.0-x64-portable.exe` | 111,660,187 | `ab7acf8ba9cc6292b8f4ba23e8595fcc2d566d7265873aad0c61a862da28e1f2` |

"final" below means these exact files. "1.1.0" means an earlier 1.1.0 build from the same day, which differed only by the fixes listed under "found during development".

Both are **not code-signed** (Windows reports `NotSigned`). The Electron hardening fuses are set: run-as-Node, `NODE_OPTIONS` and inspector arguments disabled, and ASAR integrity validation and load-only-from-ASAR enabled.

## Bugs found and fixed

| # | Problem in 1.0.0 | Evidence | Fix in 1.1.0 |
| --- | --- | --- | --- |
| 1 | A YouTube link "downloaded" its web page as `watch.html` (1,262,677 bytes) and showed **Done 100%**. | Real run against the 1.0.0 build. | YouTube links open a quality picker that downloads the real video through yt-dlp. |
| 2 | Any link that returned a web page (login page, expired link) was saved under the expected name, for example `movie.mp4` containing HTML. | Test server. | The finished download carries a notice explaining it is a web page. |
| 3 | After a power cut, the partial file can end in zeros (data Windows had not written yet). Resuming appended after the zeros and produced a corrupt file. | Simulated: partial file = 1 MB of real data + 700 KB of zeros. | Partial files are flushed to disk every 2 s and the flushed size is recorded; on restart the file is cut back to it. |
| 4 | Windows shutdown, restart or sign-out was not handled. | Code review: `before-quit` does not run on Windows session end. | A `session-end` handler saves progress synchronously. |
| 5 | A damaged `haul.db` stopped the app from starting at all. | Garbage written to the database file. | The damaged file is kept as `haul.db.corrupt-<date>` and a new one is created; the user is told. |
| 6 | HTTPS used only Node's built-in root certificates, so HTTPS fails behind antivirus HTTPS scanning or company proxies. | Code review (121 bundled roots vs 129 in the Windows store on this PC). | Windows certificate store trusted as well, as browsers do. The packaged app logs "HTTPS trusts 190 root certificates (bundled and Windows store)", and all HTTPS downloads after that worked. |
| 7 | Pause and resume existed but were small unlabelled icons. Users thought there was no pause or resume. | Screenshots. | Labelled **Pause / Resume / Retry / Open** buttons, plus a **Resumable / No resume** tag. |
| 8 | Adding the same link again silently created `name (1).ext`, `name (2).ext` and so on. | UI. | Confirmation asked first; batches skip duplicates. |
| 9 | `NUL.tar.gz` and `con.min.js` were not treated as reserved device names. Invisible right-to-left characters could disguise an extension. | Unit tests. | Sanitised. |
| 10 | Deleting a paused download's partial file made it restart without explanation. | Test. | It now says why it restarted. |

Problems found and fixed during development of 1.1.0, before release:

- A regression in progress reporting (a stalled speed froze); a regression test now covers it.
- Invisible bidi characters in the source code.
- A missing disk-space check for video downloads.
- A title such as `100% Real %(title)s test` made the real yt-dlp create a stray folder: its `--print-to-file` name is a template too. The name is now escaped, checked again with the real yt-dlp, and covered by a test.
- The test suite left a temporary folder behind for every test; it now removes them.
- **Two yt-dlp processes writing the same partial file after a Haul crash** (Windows does not stop child processes). A test shows the corruption without the guard and a correct file with it.

## Automated tests (offline, repeatable)

| Suite | Result | What it covers |
| --- | --- | --- |
| `npm test` | **PASS** 74/74 | Unit tests; HTTP engine against a controllable local server (ranges, redirects, 404/500/503/429, timeouts, truncation, servers that lie about ranges, ETag changes); crash recovery with a killed child process; power-cut simulation; checkpoints never ahead of the disk; Windows session end; damaged and half-written databases; schema 1 → 2 migration; yt-dlp integration against a fake yt-dlp (formats from a real YouTube response, pause, resume, pause while joining, cancel, failures, restart, leftover yt-dlp after a crash, disk space, odd titles, duplicates). |
| Randomised "impatient user" soak, 30 seeds | **PASS** 30/30 | 160 random actions per seed (4,800 in total): add, duplicate add, pause, resume, cancel, retry, remove with or without file, pause all, resume all, setting changes, clear finished, and three buttons pressed at once. Against servers with and without resume support and one that drops connections. Afterwards: every finished file byte-identical, no partial files left, no stuck downloads, only friendly validation errors. |
| UI end-to-end, development build (final source) | **PASS** 31/31 | Real app driven through its UI. Includes the YouTube picker (fake yt-dlp), Windows `session-end` immediately followed by a hard kill, and a damaged database at startup. |
| UI end-to-end, packaged final build | **PASS** 26/26 | The same, minus 5 checks that need the development build: the session-end simulation (3 checks) and the clipboard instrumentation (2). |
| UI end-to-end, final **portable** exe | **PASS** 26/26 | Same checks, run on `Haul-Download-Manager-1.1.0-x64-portable.exe`. |

## Real internet, packaged app

Big files from Blender's download server (their ZIPs have built-in CRCs) and a Creative Commons YouTube video, *Big Buck Bunny* (Blender's official upload).

| Test | Build | Result | Evidence |
| --- | --- | --- | --- |
| 125 MB 1080p video ZIP, app killed (whole process tree) at 35% | 1.1.0 | **PASS** | 44.7 MB partial file. After relaunch it continued from byte 43,843,584: the last 2 s that might not have been on disk were discarded. CRC-32 of the video inside correct. |
| 275 MB 1080p video ZIP, Pause at 20%, Resume | 1.1.0 | **PASS** | Partial file unchanged while paused; resumed with a Range request from byte 54,406,528; CRC-32 correct. |
| YouTube quality lookup | 1.1.0 | **PASS** | 8 qualities listed: 2160p60 (4K), 1440p60, 1080p60, 720p60, 480p, 360p, 240p, 144p; lookup took 25 s. |
| YouTube 720p60 (≈ 154 MB): hard kill at 30%, relaunch, Pause, Resume | 1.1.0 | **PASS** | Continued from 46.5 MB after the kill and from 71.2 MB after the pause. Result 153.7 MB, H.264 1280×720 + AAC, 634.6 s. **Every frame decodes without errors** (full FFmpeg decode). |
| YouTube 1080p60 (≈ 256 MB) | 1.1.0 | **PASS** | 255.9 MB, H.264 1920×1080 + AAC, 634.6 s, full decode without errors. |
| YouTube audio only, MP3 + thumbnail | 1.1.0 | **PASS** | 17.2 MB MP3, 634.6 s, JPG thumbnail. |
| YouTube scenario repeated on the final release files | final | **PASS** 9/9 | Lookup 14 s. 720p60 killed at 30%, then continued from 48.3 MB; paused and continued from 71.4 MB; 153.7 MB, full decode without errors. 1080p60 255.9 MB, decodes cleanly. MP3 17.2 MB + thumbnail. (An earlier 1.1.0 build passed the same 9 checks.) |
| **Large-file streaming: 2 GiB** generated on the fly by a local server | final | **PASS** | 2,147,483,648 bytes in 65 s, SHA-256 identical. Main-process working set 106 MB before and **172 MB at peak**: memory does not grow with file size. |
| Memory during the real downloads above | 1.1.0 | INFO | Main process 111–133 MB (yt-dlp runs as its own process). |
| Wikimedia Commons video | 1.0.0 | INFO | The server answered HTTP 429 (rate limit) to Haul's User-Agent; Haul waited as asked (`Retry-After: 10`), retried 3 times, then failed with "The server is limiting requests (HTTP 429)". Wikimedia requires contact information in the User-Agent; set `homepage` in `package.json` before publishing. |

The same Blender crash and pause tests passed against 1.0.0 before any change: the resume engine itself was sound.

## Installer

| Test | Result | Evidence |
| --- | --- | --- |
| Silent per-user upgrade 1.0.0 → 1.1.0, no administrator rights | **PASS** (three runs, the last with the final installer) | 45–56 s; installed version 1.1.0. |
| History, settings and desktop shortcut kept after upgrade | **PASS** | 2 downloads, "5 at a time", shortcut present. |
| Download paused in 1.0.0 resumed in 1.1.0 | **PASS** | Range request from the same byte; byte-identical result. |
| Database migrated in place (schema 1 → 2) | **PASS** | `user_version` 2; both records kept. |
| Uninstall | **PASS** | Program, desktop shortcut and Apps entry removed. `%APPDATA%\Haul Download Manager` and downloaded files kept. |
| Reinstall | **PASS** | |
| Installed app launches outside the project folder | **PASS** | All of the above ran the installed copy in `%LOCALAPPDATA%\Programs\Haul Download Manager`. |
| The tester's own Haul history was never touched | **PASS** | SHA-256 of the real `%APPDATA%\Haul Download Manager\data\haul.db` was identical before and after all tests; every test used a separate profile. |

## NOT TESTED

| What | Why | How it was covered instead |
| --- | --- | --- |
| A second PC, a clean virtual machine, or a second Windows account | Not available here | Install, upgrade and uninstall on this PC with isolated profiles; see the procedure for a friend's PC in the README and below. |
| Windows 10 | Only Windows 11 available | |
| A real power cut or blue screen | Not reproducible safely | Simulated: a partial file with a zero-filled tail, and process-tree kills. |
| A real Windows shutdown or sign-out | Would end this session | Simulated: the `session-end` event followed immediately by a hard kill. |
| A really full disk while downloading | Needs a small drive (administrator rights) | Free-space checks before downloading (HTTP and YouTube) tested with a simulated free-space value. |
| Antivirus HTTPS scanning or a company proxy | Not available | Code review; the packaged app confirms in its log that it loaded the Windows certificate store. |
| Installing yt-dlp, FFmpeg and Deno with **winget** | Not run without the owner's approval; portable copies were used instead | Detection of winget's `Links` folder is unit-tested with a simulated folder. Whether Haul sees freshly installed tools without signing out and back in is unverified. |
| Node.js instead of Deno as yt-dlp's JavaScript runtime | Only Deno was tested with the real yt-dlp | Detection unit-tested. |
| YouTube videos that are private, members-only or age-restricted | Need a signed-in account | Error messages unit-tested with yt-dlp's real error texts. |
| Browser extension | Not changed in this release | |
| Code signing | No certificate | Builds are unsigned; Windows SmartScreen will warn. |

## Checking it on another PC

The clean-machine check is still outstanding. On a second Windows 10/11 x64 PC (or a fresh Windows account):

1. Copy `Haul-Download-Manager-Setup-1.1.0-x64.exe` and check it in PowerShell: `Get-FileHash .\Haul-Download-Manager-Setup-1.1.0-x64.exe -Algorithm SHA256`. The hash must match the table above.
2. Run it. SmartScreen will say "Windows protected your PC": click **More info → Run anyway**. Install with the defaults (no administrator prompt should appear) and start Haul.
3. Paste `https://download.blender.org/demo/movies/caminandes_gran_dillama.mp4.zip` (125 MB). Let it reach about 30%, then close Haul from Task Manager (**End task**). Reopen Haul: the download must continue from about the same percentage, not 0%. When it is done, open the ZIP and play the video.
4. Start another download, press **Pause**, wait, press **Resume**. Close Haul normally while something downloads and reopen it.
5. YouTube: run `winget install yt-dlp.yt-dlp`, `winget install yt-dlp.FFmpeg` and `winget install DenoLand.Deno`. Restart Haul and check that **Settings → YouTube downloads** shows three ticks. Paste `https://www.youtube.com/watch?v=aqz-KE-bpKQ`, choose 720p60, and play the result.
6. Uninstall from **Settings → Apps**. The downloaded files must still be there.

If anything fails, the log is in `%APPDATA%\Haul Download Manager\logs\haul.log` (links are redacted, but read it before sharing).
