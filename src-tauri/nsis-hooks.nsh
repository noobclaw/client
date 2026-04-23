; NSIS installer hooks for NoobClaw
;
; Why this file exists:
;   The sidecar process `noobclaw-server.exe` is independent of the
;   main `NoobClaw.exe` process. When users upgrade, the sidecar is
;   often still alive (tray-close, hard-kill, or a crashed main
;   process can orphan it). The NSIS installer then fails with
;   "Error opening file for writing: noobclaw-server.exe" because
;   Windows won't let us overwrite a file that's mapped by a running
;   process.
;
; Fix: taskkill both processes before extraction (install) and
; before removal (uninstall). `/F` forces, `/T` also kills children.
; Exit code is ignored — if the process wasn't running, taskkill
; returns non-zero and that's fine.

!macro NSIS_HOOK_PREINSTALL
  DetailPrint "Stopping NoobClaw processes before install..."
  nsExec::Exec 'taskkill /F /IM noobclaw-server.exe /T'
  nsExec::Exec 'taskkill /F /IM NoobClaw.exe /T'
  Sleep 800
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  DetailPrint "Stopping NoobClaw processes before uninstall..."
  nsExec::Exec 'taskkill /F /IM noobclaw-server.exe /T'
  nsExec::Exec 'taskkill /F /IM NoobClaw.exe /T'
  Sleep 800
!macroend
