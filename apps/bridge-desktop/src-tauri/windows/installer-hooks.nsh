!macro HUNSU_BRIDGE_STOP_RUNNING_PROCESSES
  !insertmacro CheckIfAppIsRunning "${MAINBINARYNAME}.exe" "${PRODUCTNAME}"
  !insertmacro CheckIfAppIsRunning "hunsu-bridge-sidecar.exe" "Hunsu Bridge background service"
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro HUNSU_BRIDGE_STOP_RUNNING_PROCESSES
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro HUNSU_BRIDGE_STOP_RUNNING_PROCESSES
!macroend
