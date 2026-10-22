# Haul Download Manager 1.3.0: test report

Tested on 23 October 2026 on one PC: Windows 11 Pro (build 26300), x64. Build tools: Node.js 22.14, Electron 44.9.3, electron-builder 26.15. All tests are offline (local test server and the fake yt-dlp); the real yt-dlp was not exercised for this release because 1.3.0 changes nothing in the video pipeline except passing `--limit-rate`.

Each result is **PASS**, **FAIL** or **NOT TESTED**. Nothing is marked PASS unless the test ran and produced the evidence quoted.

## What 1.3.0 adds (Phase 1 of the roadmap)

Notification area icon; start with Windows (`--hidden`); keep running in the background when the window is closed; Change link; speed limit; sorting into category folders plus a type filter; shut down the PC when downloads finish. Database schema 2 → 3 (one new column, `auto_category`).

## Release files

| File | Size (bytes) | SHA-256 |
| --- | --- | --- |
| `Haul-Download-Manager-Setup-1.3.0-x64.exe` | 111,895,171 | `c4098f1b4fec34cf7ac6b56f3ea021f3a2a929b593af1fe0c76054042584fe2b` |
| `Haul-Download-Manager-1.3.0-x64-portable.exe` | 111,672,909 | `e223eacbac6bcedd8dc93653e6b2ebb68a7734be750a43d91af0296bd6a3cfec` |

Both are **not code-signed**.

## Bugs found and fixed during testing

| # | Problem | Found by | Fix |
| --- | --- | --- | --- |
| 1 | During quit, the main process cleared its reference to the download engine before the engine's shutdown had finished. The engine's "changed" event handler then threw (`Cannot read properties of null (reading 'isIdle')`) and the download that was being stopped was marked **Failed** instead of being re-queued, so it did not continue after the restart. | UI end-to-end test (development build), check "interrupted download continues after restart". | Event handlers hold their own reference to the engine; the quit path no longer clears it. |
| 2 | Electron names the "start with Windows" registry value `electron.app.Haul Download Manager`, not `Haul Download Manager`. The uninstaller and the test's safety cleanup would have left the entry behind. | UI end-to-end test (packaged build), which reads the real `HKCU\...\Run` key. | Uninstaller (`build/installer.nsh`) and test cleanup use the real value name; the test now asserts it. |
| 3 | A never-shown Electron window reports `document.visibilityState === "visible"`, so the first version of the "started hidden" check could not tell hidden from shown. | Development e2e. | The check counts visible top-level windows titled "Haul Download Manager" through the Windows API (`EnumWindows`/`IsWindowVisible`). Test-only change. |

## Automated tests (offline, repeatable)

| Suite | Result | What it covers |
| --- | --- | --- |
| `npm run typecheck` | **PASS** | Main process, engine, tests and renderer under TypeScript strict mode. |
| `npm test` | **PASS** 102/102 | Everything from 1.1.0/1.2.0 (85 tests) plus 17 new: categories by extension and no duplicate extensions; sorting at add time (user-chosen name), at server naming (`Content-Disposition`), unknown types staying in the main folder, custom folders never sorted, sorting off; pause/resume/restart of a download inside its category folder (Range request from the subfolder's partial file); YouTube downloads into Video/Music; the rate limiter's pacing (640 KB at 200 KB/s took ≥ 2.5 s), release when the limit is removed, and abort; a 1 MB download held to 256 KB/s (≥ 3 s, reported speed never above 2× the limit) and finishing quickly once the limit is lifted; three downloads sharing one 512 KB/s limit; `--limit-rate` passed to yt-dlp and honoured by the fake; Change link continuing from the partial file (Range + If-Range on the new link, byte-identical result, file name kept), for an expired link (403 on resume), restarting for a different file with a notice, from the cancelled state, and refusing invalid links, YouTube pages, running downloads and YouTube downloads; the shutdown-when-done state machine (countdown on idle, postponed by new work, cancelled by disarming, failed command disarms with the reason, unavailable builds never arm); `isIdle()`; settings validation for the new values and old settings rows; schema 2 → 3 upgrade keeping history. |
| Randomised "impatient user" soak, 30 seeds (`HAUL_CHAOS_SEEDS=30`) | **PASS** 39/39 | 160 random actions per seed through the new transfer path (every chunk now passes the rate limiter). Every finished file byte-identical, no partial files left, no stuck downloads. |
| UI end-to-end, development build | **PASS** 55/55 | Everything from 1.2.0 plus: speed limit validation and the status bar; a 1.5 MB download held to 200 KB/s (7.7 s); an `.mp4` saved into `Video\`, shown in the card details, and found by the type filter (Video → 1 card, Archives → 2); an expired link (403) with the partial file kept, an invalid new link refused in the dialog, the new link continuing from byte 917,504 of 917,504 and a byte-identical file; shut down when done armed during a download, the countdown after the last download, cancelling it, re-arming when idle, and the simulated shutdown call; closing the window with "keep running in the background" hiding it, the tray icon existing, a download finishing while hidden, the tray click restoring the window; starting with `--hidden` (0 visible Haul windows) and the tray click showing it; YouTube video and MP3 sorted into `Video\` and `Music\`. |
| UI end-to-end, packaged build (`release\win-unpacked`) | **PASS** 48/48 | The same minus the checks that need the development build (clipboard instrumentation, Windows session-end simulation, tray access), plus: turning on "Start Haul when I sign in to Windows" writes `electron.app.Haul Download Manager = "…\Haul Download Manager.exe" --hidden` to the user's Run key and turning it off removes it (the key was verified empty afterwards); starting the exe with `--hidden` keeps the window hidden and starting it a second time brings it to the front. |

## Not tested

- A real shutdown of this PC (the end-to-end test uses `HAUL_FAKE_SHUTDOWN=1`, which logs instead of calling `shutdown.exe`). The command line used is Windows' own `shutdown.exe /s /t 0`.
- Signing in to Windows with the startup entry in place (the entry's content and the `--hidden` start it performs were tested separately).
- The uninstaller removing the Run value (the installer was built but not installed on this PC).
- The real yt-dlp with `--limit-rate` (the fake honours it; the option name and unit, bytes per second, are from yt-dlp's documentation).
- Other machines. The packaged build was tested on this one PC only.
