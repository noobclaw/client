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
  ; ⚠️ 浏览器那三行不能加 /T —— /T 会把整棵进程树灭掉。如果用户是从浏览器
  ; 下载栏直接「打开」装包(不存到桌面再双击),安装器进程就是 chrome.exe 的
  ; 子进程,/T 会顺手把还在跑的安装器自己一起干掉,装到一半窗口消失。
  ; 不加 /T:只灭浏览器主进程本身。NMH(noobclaw-server.exe)是浏览器的子进程,
  ; 父进程死后它会变成孤儿但不会自动退出 —— 所以宏末尾那行单独 /T 灭 sidecar
  ; 仍然必要(也只对 sidecar 用 /T,因为安装器不会是 sidecar 的子进程)。
  nsExec::Exec 'taskkill /F /IM chrome.exe'
  Pop $0
  nsExec::Exec 'taskkill /F /IM msedge.exe'
  Pop $0
  nsExec::Exec 'taskkill /F /IM firefox.exe'
  Pop $0
  Sleep 1200  ; let Windows release the file handles
  ; Re-kill sidecar (孤儿 NMH + 浏览器复活时新 spawn 的 NMH)
  nsExec::Exec 'taskkill /F /IM noobclaw-server.exe /T'
  Pop $0
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro NC_KILL_ALL
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro NC_KILL_ALL
!macroend
