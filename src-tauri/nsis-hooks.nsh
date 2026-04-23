; NSIS installer hooks for NoobClaw
;
; Problem this solves:
;   Chrome / Edge / Firefox can launch noobclaw-server.exe directly
;   via the Native Messaging Host protocol (used by NoobClaw browser
;   extensions). When users upgrade with the browser open, that NMH
;   process holds an exclusive handle on noobclaw-server.exe and the
;   installer fails with "Error opening file for writing".
;
;   Killing the sidecar alone doesn't help — the browser respawns it
;   immediately. We MUST close the browser. To respect the user, we
;   detect first, then ask permission, then kill. If user refuses, we
;   abort cleanly rather than start a half-broken install.

; ── Bilingual strings (EN + Simplified Chinese) ──
; NSIS picks $LANGUAGE based on Windows display language at install time.

LangString NC_WARN_BROWSER ${LANG_ENGLISH} \
  "Chrome / Edge / Firefox is currently running.$\n$\nThe NoobClaw browser extension uses Native Messaging, which locks installer files and blocks the update.$\n$\nClose the browser(s) and continue?$\n(Tabs will be restored when you reopen the browser, but unsaved form data may be lost.)"
LangString NC_WARN_BROWSER ${LANG_SIMPCHINESE} \
  "检测到 Chrome / Edge / Firefox 正在运行。$\n$\nNoobClaw 浏览器扩展通过 Native Messaging 与桌面端通信,会锁定安装文件,导致升级失败。$\n$\n是否关闭浏览器并继续安装?$\n(标签页下次打开时会自动恢复,但网页中未保存的表单数据可能丢失)"

LangString NC_ABORT_BROWSER ${LANG_ENGLISH} \
  "Installation cancelled. Please close Chrome / Edge / Firefox and run the installer again."
LangString NC_ABORT_BROWSER ${LANG_SIMPCHINESE} \
  "已取消安装。请手动关闭 Chrome / Edge / Firefox 后重新运行安装包。"


; ── Macro: kill noobclaw-server (used in both install and uninstall) ──
!macro NC_KILL_SIDECAR
  nsExec::Exec 'taskkill /F /IM noobclaw-server.exe /T'
  Pop $0  ; discard exit code; non-zero just means process wasn't running
!macroend


; ── Macro: detect if a browser process is running ──
;   Uses tasklist | findstr; findstr's exit code is 0 when match found.
;   Sets $0 to "1" if running, "0" otherwise.
!macro NC_CHECK_PROC ProcName
  nsExec::Exec 'cmd /c tasklist /FI "IMAGENAME eq ${ProcName}" /NH | findstr /I "${ProcName}" >nul 2>&1'
  Pop $1  ; findstr exit code: 0=found, 1=not found
  ${If} $1 == 0
    StrCpy $0 "1"
  ${EndIf}
!macroend


; ── PREINSTALL: runs before any file is extracted ──
!macro NSIS_HOOK_PREINSTALL
  ; Always kill the sidecar first (cheap, no UI cost)
  !insertmacro NC_KILL_SIDECAR

  ; Check whether any of the three supported browsers is running
  StrCpy $0 "0"
  !insertmacro NC_CHECK_PROC "chrome.exe"
  !insertmacro NC_CHECK_PROC "msedge.exe"
  !insertmacro NC_CHECK_PROC "firefox.exe"

  ${If} $0 == "1"
    ; Browser running — ask the user
    MessageBox MB_YESNO|MB_ICONQUESTION "$(NC_WARN_BROWSER)" /SD IDYES IDYES nc_kill_browsers IDNO nc_user_aborted

    nc_user_aborted:
      MessageBox MB_OK|MB_ICONEXCLAMATION "$(NC_ABORT_BROWSER)"
      Abort

    nc_kill_browsers:
      ; /T kills child processes too (Chromium / Firefox content processes)
      nsExec::Exec 'taskkill /F /IM chrome.exe /T'
      Pop $1
      nsExec::Exec 'taskkill /F /IM msedge.exe /T'
      Pop $1
      nsExec::Exec 'taskkill /F /IM firefox.exe /T'
      Pop $1
      Sleep 1500   ; let Windows release file handles
      ; Now the sidecar may have respawned + died; kill once more to be safe
      !insertmacro NC_KILL_SIDECAR
  ${EndIf}
!macroend


; ── PREUNINSTALL: same browser logic, otherwise uninstall blocks too ──
!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro NC_KILL_SIDECAR

  StrCpy $0 "0"
  !insertmacro NC_CHECK_PROC "chrome.exe"
  !insertmacro NC_CHECK_PROC "msedge.exe"
  !insertmacro NC_CHECK_PROC "firefox.exe"

  ${If} $0 == "1"
    MessageBox MB_YESNO|MB_ICONQUESTION "$(NC_WARN_BROWSER)" /SD IDYES IDYES nc_uninst_kill IDNO nc_uninst_abort

    nc_uninst_abort:
      MessageBox MB_OK|MB_ICONEXCLAMATION "$(NC_ABORT_BROWSER)"
      Abort

    nc_uninst_kill:
      nsExec::Exec 'taskkill /F /IM chrome.exe /T'
      Pop $1
      nsExec::Exec 'taskkill /F /IM msedge.exe /T'
      Pop $1
      nsExec::Exec 'taskkill /F /IM firefox.exe /T'
      Pop $1
      Sleep 1500
      !insertmacro NC_KILL_SIDECAR
  ${EndIf}
!macroend
