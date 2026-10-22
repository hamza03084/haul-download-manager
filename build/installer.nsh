; Extra uninstall steps: remove the per-user haul:// link handler the app registers on first run, and
; the "start with Windows" entry if the user turned that on in Settings.
; Download history and settings in %APPDATA%\Haul Download Manager are intentionally kept.
!macro customUnInstall
  ; Native messaging host entries for the browser extension (Chrome, Edge, Chromium, Brave).
  DeleteRegKey HKCU "Software\Google\Chrome\NativeMessagingHosts\io.github.hauldm.app"
  DeleteRegKey HKCU "Software\Microsoft\Edge\NativeMessagingHosts\io.github.hauldm.app"
  DeleteRegKey HKCU "Software\Chromium\NativeMessagingHosts\io.github.hauldm.app"
  DeleteRegKey HKCU "Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\io.github.hauldm.app"
  DeleteRegKey HKCU "Software\Classes\haul"
  ; Electron names the value "electron.app.<app name>" (checked in the packaged end-to-end test).
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "electron.app.Haul Download Manager"
!macroend
