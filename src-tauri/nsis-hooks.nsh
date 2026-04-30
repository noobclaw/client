; NSIS installer hooks for NoobClaw
;
; Background:
;   Chrome / Edge / Firefox 通过 Native Messaging Host (NMH) 协议拉起
;   noobclaw-server.exe 与浏览器扩展通信。NMH 在跑的时候,Windows 镜像
;   加载器对 noobclaw-server.exe 持独占写锁,安装器覆盖时报
;   "Error opening file for writing"。
;
; 策略:
;   1. taskkill 我们自己的 sidecar(noobclaw-server.exe)——杀自家进程,
;      杀软不会扣分。
;   2. 用 FileOpen(append 模式)探测目标 exe 是否仍被锁。
;   3. 如果浏览器又把 NMH 拉起来了,弹窗让用户自行关浏览器后重试。
;
; ⚠️ 我们 *不再* 静默 taskkill chrome.exe / msedge.exe / firefox.exe。
; 安装器灭用户浏览器是 360 / 腾讯 / 火绒启发式引擎里的高权重恶意特征
; (浏览器劫持类样本的标准前置动作),会直接打成病毒。早期版本因为这段
; 代码命中云查杀。

!macro NC_KILL_SIDECAR
  nsExec::Exec 'taskkill /F /IM noobclaw-server.exe /T'
  Pop $0
  Sleep 800  ; 给 Windows 释放镜像锁的时间
!macroend

; 通用守卫:杀 sidecar -> 探测文件锁 -> 锁住就让用户关浏览器重试。
;
; TAG 参数用来给本宏内部的标签做命名空间——PREINSTALL/PREUNINSTALL
; 都展开到同一个 .nsi 里,裸标签会冲突。
!macro NC_GUARD TAG OPERATION
  !insertmacro NC_KILL_SIDECAR

  ; 全新安装时 sidecar 还不存在,直接放行
  IfFileExists "$INSTDIR\noobclaw-server.exe" 0 nc_guard_done_${TAG}

  nc_guard_check_${TAG}:
    ClearErrors
    FileOpen $0 "$INSTDIR\noobclaw-server.exe" a
    IfErrors nc_guard_locked_${TAG} 0
    FileClose $0
    Goto nc_guard_done_${TAG}

  nc_guard_locked_${TAG}:
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION \
      "检测到 NoobClaw 后台服务正被浏览器占用,无法${OPERATION}。$\r$\n$\r$\n请完全退出 Chrome / Edge / Firefox(包含托盘图标和后台标签页),然后点击「重试」。$\r$\n$\r$\n点击「取消」放弃本次${OPERATION}。" \
      /SD IDCANCEL \
      IDRETRY nc_guard_retry_${TAG}
    Abort "用户取消${OPERATION}"

  nc_guard_retry_${TAG}:
    !insertmacro NC_KILL_SIDECAR
    Goto nc_guard_check_${TAG}

  nc_guard_done_${TAG}:
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro NC_GUARD INSTALL "升级"
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro NC_GUARD UNINSTALL "卸载"
!macroend
