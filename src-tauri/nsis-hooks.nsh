; NSIS installer hooks for NoobClaw
;
; Chrome / Edge / Firefox can launch noobclaw-server.exe via Native
; Messaging Host whenever the NoobClaw extension talks to the desktop
; app. That NMH process holds an exclusive handle on noobclaw-server.exe
; and blocks the installer with "Error opening file for writing".
;
; We kill the browsers silently before file extraction — no dialog, no
; prompt. Tabs auto-restore on next browser launch; unsaved form data
; is the only casualty, which is acceptable for a one-click upgrade.

!macro NC_KILL_ALL
  nsExec::Exec 'taskkill /F /IM noobclaw-server.exe /T'
  Pop $0
  nsExec::Exec 'taskkill /F /IM chrome.exe /T'
  Pop $0
  nsExec::Exec 'taskkill /F /IM msedge.exe /T'
  Pop $0
  nsExec::Exec 'taskkill /F /IM firefox.exe /T'
  Pop $0
  Sleep 1200  ; let Windows release the file handles
  ; Re-kill sidecar in case a browser respawned it during the sleep
  nsExec::Exec 'taskkill /F /IM noobclaw-server.exe /T'
  Pop $0
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro NC_KILL_ALL
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro NC_KILL_ALL
!macroend
