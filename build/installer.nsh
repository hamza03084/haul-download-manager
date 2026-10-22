; Extra uninstall step: remove the per-user haul:// link handler the app registers on first run.
; Download history and settings in %APPDATA%\Haul Download Manager are intentionally kept.
!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\haul"
!macroend
