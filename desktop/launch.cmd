@echo off
set WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9345
set DDA_RUNTIME_ENTRY=C:\Users\User\hmCodex-local\runtime\src\index.mjs
set DDA_WORKSPACE_ROOT=C:\Users\User\hmCodex-local
set EXE=C:\Users\User\hmCodex-local\desktop\src-tauri\target\x86_64-pc-windows-msvc\release\dda-desktop.exe
if not exist "%EXE%" set EXE=C:\Users\User\hmCodex-local\desktop\src-tauri\target\x86_64-pc-windows-msvc\debug\dda-desktop.exe
if not exist "%EXE%" (
  echo dda-desktop.exe not built yet.
  exit /b 1
)
start "" /b "%EXE%"
