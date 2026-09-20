!macro WriteDieyunProgress PERCENT MSG
  InitPluginsDir
  FileOpen $R8 "$TEMP\dieyun-update-progress.json" w
  ; Unicode NSIS FileWrite 输出 UTF-16 LE；先写 BOM 供 PowerShell 正确识别
  FileWriteByte $R8 255
  FileWriteByte $R8 254
  FileWrite $R8 "{$\"percent$\": ${PERCENT}, $\"message$\": $\"${MSG}$\"}"
  FileClose $R8
!macroend

; 仅在相关进程存在时结束，避免首次安装白等 taskkill + Sleep。
!macro KillDieyunAppProcesses
  StrCpy $R9 0
  DetailPrint "正在检查是否有旧版本进程..."
  nsExec::ExecToStack 'cmd.exe /C tasklist /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /NH 2>nul | find /I "${APP_EXECUTABLE_FILENAME}"'
  Pop $0
  Pop $1
  ${If} $1 != ""
    DetailPrint "正在结束叠云 Agent 主进程..."
    nsExec::ExecToStack 'cmd.exe /C taskkill /F /T /IM "${APP_EXECUTABLE_FILENAME}" /FI "USERNAME eq %USERNAME%" 2>nul'
    Pop $0
    Pop $1
    StrCpy $R9 1
  ${EndIf}
  nsExec::ExecToStack 'cmd.exe /C tasklist /FI "IMAGENAME eq dieyun-core.exe" /NH 2>nul | find /I "dieyun-core.exe"'
  Pop $0
  Pop $1
  ${If} $1 != ""
    DetailPrint "正在结束 dieyun-core 进程..."
    nsExec::ExecToStack 'cmd.exe /C taskkill /F /T /IM dieyun-core.exe /FI "USERNAME eq %USERNAME%" 2>nul'
    Pop $0
    Pop $1
    StrCpy $R9 1
  ${EndIf}
  nsExec::ExecToStack 'cmd.exe /C tasklist /FI "IMAGENAME eq 叠云 Agent.exe" /NH 2>nul | find /I "叠云 Agent.exe"'
  Pop $0
  Pop $1
  ${If} $1 != ""
    DetailPrint "正在结束旧版进程..."
    nsExec::ExecToStack 'cmd.exe /C taskkill /F /T /IM "叠云 Agent.exe" /FI "USERNAME eq %USERNAME%" 2>nul'
    Pop $0
    Pop $1
    StrCpy $R9 1
  ${EndIf}
  ${If} $R9 == 1
    Sleep 350
  ${EndIf}
!macroend

; 显示安装详情区（逐文件 Extracting / 写入进度）
!macro customHeader
  ShowInstDetails show
  ShowUninstDetails show
!macroend

; 覆盖 electron-builder 默认「应用正在运行」对话框：直接结束进程后继续。
; 此钩子在解压前执行；electron-builder 在安装节开头 SetDetailsPrint none，
; 会静音整个解压阶段的 Extract 逐文件输出与 DetailPrint（ShowInstDetails show
; 只控制详情框是否展开，不产生内容），这里恢复输出详情区才有内容。
!macro customCheckAppRunning
  ${IfNot} ${Silent}
    SetDetailsPrint both
  ${endif}
  !insertmacro KillDieyunAppProcesses
!macroend

!macro customInit
  ; 引导更新窗口此前已写到 18%，这里若低于该值会让进度条倒退，故从 22 起。
  !insertmacro WriteDieyunProgress 22 "正在启动安装向导"
  DetailPrint "正在启动安装向导..."
  !insertmacro KillDieyunAppProcesses
  !insertmacro WriteDieyunProgress 26 "正在准备安装环境"
  DetailPrint "正在准备安装环境..."
!macroend

!macro customUnInit
  !insertmacro KillDieyunAppProcesses
!macroend

!macro customUnInstall
  !insertmacro KillDieyunAppProcesses
!macroend

!macro customInstall
  !insertmacro WriteDieyunProgress 35 "正在注册组件与快捷方式"
  DetailPrint "正在注册组件与快捷方式..."
  !insertmacro WriteDieyunProgress 55 "正在写入卸载信息"
  DetailPrint "正在写入卸载信息..."
  !insertmacro WriteDieyunProgress 75 "正在完成安装配置"
  DetailPrint "正在完成安装配置..."
  !insertmacro WriteDieyunProgress 88 "即将完成"
  ${if} ${isUpdated}
  ${if} ${isForceRun}
    HideWindow
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "--updated"
  ${endif}
  ${endif}
!macroend

; 更新时沿用已有安装范围，跳过「为谁安装」页
!macro customInstallMode
  ${if} ${isUpdated}
    ${if} $hasPerMachineInstallation == "1"
      StrCpy $isForceMachineInstall "1"
    ${elseIf} $hasPerUserInstallation == "1"
      StrCpy $isForceCurrentInstall "1"
    ${endif}
  ${endif}
!macroend

; 更新时跳过完成页（应用已在 customInstall 中通过 --force-run 启动）
!macro customFinishPage
  !insertmacro skipPageIfUpdated
  !insertmacro MUI_PAGE_FINISH
!macroend
