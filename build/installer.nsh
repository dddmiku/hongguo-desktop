!include "LogicLib.nsh"
!include "x64.nsh"

!ifdef BUILD_UNINSTALLER
  !define HG_CLOSE_INSTALLATION_FN "un.HongguoCloseInstallation"
!else
  !define HG_CLOSE_INSTALLATION_FN "HongguoCloseInstallation"
!endif

Function ${HG_CLOSE_INSTALLATION_FN}
  Push $R5
  Push $R6
  Push $R9
  Push $1
  InitPluginsDir
  File /oname=$PLUGINSDIR\hongguo-close-installation.ps1 "${BUILD_RESOURCES_DIR}\close-installation-processes.ps1"
  ; NSIS is 32-bit: use native 64-bit PowerShell for 64-bit Java/Python process paths.
  StrCpy $R5 "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"
  ${If} ${RunningX64}
    StrCpy $R5 "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
  ${EndIf}
  System::Call 'kernel32::GetCurrentProcessId() i .r1'
  nsExec::ExecToStack /TIMEOUT=20000 '"$R5" -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "$PLUGINSDIR\hongguo-close-installation.ps1" -InstallDir "$R7" -InstallerPid $1'
  Pop $R9
  Pop $R6
  ${If} $R9 != "0"
    DetailPrint "安装预检查失败：旧程序仍占用安装文件，已停止覆盖安装。"
    ${IfNot} ${Silent}
      MessageBox MB_OK|MB_ICONSTOP "旧程序仍占用安装文件。请退出红果桌面后重新运行安装包；本次未删除旧程序或用户数据。"
    ${EndIf}
    SetErrorLevel 2
    Quit
  ${EndIf}
  Pop $1
  Pop $R9
  Pop $R6
  Pop $R5
FunctionEnd

!macro customInit
  ; initMultiUser has populated $INSTDIR. Check the installed HKCU path first,
  ; before uninstallOldVersion begins atomically moving any prior files.
  Push $R7
  Push $R8
  StrCpy $R7 "$INSTDIR"
  ReadRegStr $R8 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${If} $R8 != ""
    StrCpy $R7 "$R8"
  ${EndIf}
  Call ${HG_CLOSE_INSTALLATION_FN}
  Pop $R8
  Pop $R7
!macroend

!macro customCheckAppRunning
  ; Reuse the strict path check for later directory selection and uninstall,
  ; instead of the builder's broad prefix / executable-name fallback.
  Push $R7
  StrCpy $R7 "$INSTDIR"
  Call ${HG_CLOSE_INSTALLATION_FN}
  Pop $R7
!macroend

!macro customInstall
  ; 旧用户的常用入口指向新程序。保留一个固定备份槽与旧安装，不删数据。
  SetShellVarContext current
  IfFileExists "$DESKTOP\红果免费短剧.lnk" 0 legacy_desktop_done
    IfFileExists "$DESKTOP\红果免费短剧.lnk.pre-hongguo2" legacy_desktop_replace 0
      CopyFiles /SILENT "$DESKTOP\红果免费短剧.lnk" "$DESKTOP\红果免费短剧.lnk.pre-hongguo2"
    legacy_desktop_replace:
      CreateShortCut "$DESKTOP\红果免费短剧.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0
  legacy_desktop_done:
  IfFileExists "$SMPROGRAMS\红果免费短剧.lnk" 0 legacy_menu_done
    IfFileExists "$SMPROGRAMS\红果免费短剧.lnk.pre-hongguo2" legacy_menu_replace 0
      CopyFiles /SILENT "$SMPROGRAMS\红果免费短剧.lnk" "$SMPROGRAMS\红果免费短剧.lnk.pre-hongguo2"
    legacy_menu_replace:
      CreateShortCut "$SMPROGRAMS\红果免费短剧.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0
  legacy_menu_done:
!macroend
