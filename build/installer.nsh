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
