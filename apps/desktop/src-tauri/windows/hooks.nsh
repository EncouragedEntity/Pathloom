; Pathloom NSIS installer hooks (wired in tauri.conf.json -> bundle.windows.nsis.installerHooks).
;
; The bundled CLI `pathloom.exe` also runs as an MCP server for AI clients (Claude Code, Codex, ...).
; Those processes live as long as the client session, and Windows refuses to overwrite a running exe.
; A running exe CAN be renamed, so before copying the new CLI we move the old one aside:
; running sessions keep working on the old file, new sessions start the new one. Leftovers are
; deleted by the next install (or at reboot after uninstall) once nothing uses them.

!macro PATHLOOM_MOVE_CLI_ASIDE
  ; Old copies that are no longer running: plain delete (files still in use just stay).
  Delete "$INSTDIR\pathloom.*.old"
  ${If} ${FileExists} "$INSTDIR\pathloom.exe"
    Delete "$INSTDIR\pathloom.exe"
    ${If} ${FileExists} "$INSTDIR\pathloom.exe"
      ; In use: find a free name and rename ($R9 is saved: the Tauri template may use it).
      Push $R9
      StrCpy $R9 0
      pathloom_next_name:
        IntOp $R9 $R9 + 1
        IfFileExists "$INSTDIR\pathloom.$R9.old" pathloom_next_name
      Rename "$INSTDIR\pathloom.exe" "$INSTDIR\pathloom.$R9.old"
      DetailPrint "pathloom.exe is in use (AI agent session): kept running as pathloom.$R9.old"
      Pop $R9
    ${EndIf}
  ${EndIf}
!macroend

; AI clients start the MCP server as plain `pathloom` (the Claude Code plugin's .mcp.json, README snippets),
; so the install folder goes on the user's PATH (HKCU\Environment, kept REG_EXPAND_SZ so %VARS% in it survive).
; The final SetEnvironmentVariable only broadcasts the change: new terminals and agent sessions see it. The folder is passed through an
; environment variable of the installer process, so no path is ever quoted into the command line.
; ACTION = add | remove. $R8 is saved: the Tauri template may use it.
!macro PATHLOOM_USER_PATH ACTION
  System::Call 'Kernel32::SetEnvironmentVariable(t "PATHLOOM_DIR", t "$INSTDIR")i'
  Push $R8
  nsExec::Exec `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$d = $$env:PATHLOOM_DIR.TrimEnd('\'); $$k = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment'); $$p = $$k.GetValue('Path', '', 'DoNotExpandEnvironmentNames'); $$parts = @($$p -split ';' | Where-Object { $$_ -and $$_.TrimEnd('\') -ne $$d }); if ('${ACTION}' -eq 'add') { $$parts += $$d }; $$k.SetValue('Path', ($$parts -join ';'), 'ExpandString'); [Environment]::SetEnvironmentVariable('PATHLOOM_DIR', $$null, 'User')"`
  Pop $R8 ; exit code (best effort: a failure only means `pathloom` is not on PATH)
  Pop $R8
!macroend

!macro NSIS_HOOK_POSTINSTALL
  !insertmacro PATHLOOM_USER_PATH add
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro PATHLOOM_MOVE_CLI_ASIDE
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro PATHLOOM_MOVE_CLI_ASIDE
  !insertmacro PATHLOOM_USER_PATH remove
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; Copies still used by an agent session go away at the next reboot.
  Delete /REBOOTOK "$INSTDIR\pathloom.*.old"
  RMDir /REBOOTOK "$INSTDIR"
!macroend
