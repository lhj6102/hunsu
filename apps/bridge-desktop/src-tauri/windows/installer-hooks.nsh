; Tauri includes this file in the generated NSIS installer and uninstaller.
; The PowerShell helper is embedded into $PLUGINSDIR so it exists before the
; first application file is copied and is not retained in the installation.
; Capture __FILEDIR__ while this include is parsed; PREINSTALL expands later
; from Tauri's generated installer template directory.
!define HUNSU_STOP_EXISTING_BRIDGE_SOURCE "${__FILEDIR__}\stop-existing-bridge.ps1"

!macro NSIS_HOOK_PREINSTALL
  Push $0
  Push $1
  InitPluginsDir
  File "/oname=$PLUGINSDIR\hunsu-stop-existing-bridge.ps1" "${HUNSU_STOP_EXISTING_BRIDGE_SOURCE}"
  DetailPrint "Checking the existing Hunsu Bridge installation..."
  nsExec::ExecToStack /TIMEOUT=45000 '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\hunsu-stop-existing-bridge.ps1" -InstallDirectory "$INSTDIR"'
  Pop $0
  Pop $1
  DetailPrint "$1"
  StrCmp $0 "0" hunsu_preinstall_stopped
  StrCmp $0 "10" hunsu_preinstall_timeout_recovered
  ; nsExec also returns textual failures such as "timeout". Always leave a
  ; nonzero installer status while retaining the helper's stable code in the UI.
  SetErrorLevel 1
  MessageBox MB_OK|MB_ICONSTOP "Hunsu Bridge is still running in the background.$\r$\n$\r$\nClose Hunsu Bridge and retry the installation.$\r$\nNo files were replaced.$\r$\n$\r$\nShutdown check code: $0" /SD IDOK
  Abort

hunsu_preinstall_timeout_recovered:
  DetailPrint "Graceful shutdown timed out; verified fallback shutdown succeeded."
hunsu_preinstall_stopped:
  Pop $1
  Pop $0
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  Push $0
  Push $1
  InitPluginsDir
  File "/oname=$PLUGINSDIR\hunsu-stop-existing-bridge.ps1" "${HUNSU_STOP_EXISTING_BRIDGE_SOURCE}"
  DetailPrint "Stopping Hunsu Bridge before uninstall..."
  nsExec::ExecToStack /TIMEOUT=45000 '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\hunsu-stop-existing-bridge.ps1" -InstallDirectory "$INSTDIR"'
  Pop $0
  Pop $1
  DetailPrint "$1"
  StrCmp $0 "0" hunsu_preuninstall_stopped
  StrCmp $0 "10" hunsu_preuninstall_timeout_recovered
  SetErrorLevel 1
  MessageBox MB_OK|MB_ICONSTOP "Hunsu Bridge is still running in the background.$\r$\n$\r$\nClose Hunsu Bridge and retry the uninstall.$\r$\nNo files were removed.$\r$\n$\r$\nShutdown check code: $0" /SD IDOK
  Abort

hunsu_preuninstall_timeout_recovered:
  DetailPrint "Graceful shutdown timed out; verified fallback shutdown succeeded."
hunsu_preuninstall_stopped:
  Pop $1
  Pop $0
!macroend
