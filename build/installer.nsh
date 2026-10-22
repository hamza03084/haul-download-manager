; Extra uninstall steps: remove the per-user haul:// link handler the app registers on first run, and
; the "start with Windows" entry if the user turned that on in Settings.
; Download history and settings in %APPDATA%\Haul Download Manager are intentionally kept.
!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\haul"
  ; Electron names the value "electron.app.<app name>" (checked in the packaged end-to-end test).
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "electron.app.Haul Download Manager"
!macroend
