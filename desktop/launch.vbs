Option Explicit

' A stable launcher prevents pinned shortcuts from tracking an executable
' renamed to a running-build backup during local compilation.
Dim fileSystem, shell, desktopDirectory, projectDirectory, executable, processEnvironment
Set fileSystem = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
desktopDirectory = fileSystem.GetParentFolderName(WScript.ScriptFullName)
projectDirectory = fileSystem.GetParentFolderName(desktopDirectory)
executable = fileSystem.BuildPath(desktopDirectory, "src-tauri\target\x86_64-pc-windows-msvc\debug\dda-desktop.exe")

If Not fileSystem.FileExists(executable) Then
  MsgBox "The dda desktop application has not been built yet.", vbExclamation, "dda"
  WScript.Quit 1
End If

shell.CurrentDirectory = projectDirectory
Set processEnvironment = shell.Environment("PROCESS")
processEnvironment("HMCODEX_RUNTIME_ENTRY") = fileSystem.BuildPath(projectDirectory, "runtime\src\index.mjs")
processEnvironment("HMCODEX_WORKSPACE_ROOT") = projectDirectory
shell.Run Chr(34) & executable & Chr(34), 1, False
