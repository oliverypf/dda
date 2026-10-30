Option Explicit

Dim fileSystem, shell, desktopDirectory, projectDirectory, releaseExe, debugExe, executable, processEnvironment
Set fileSystem = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
desktopDirectory = fileSystem.GetParentFolderName(WScript.ScriptFullName)
projectDirectory = fileSystem.GetParentFolderName(desktopDirectory)
releaseExe = fileSystem.BuildPath(desktopDirectory, "src-tauri\target\x86_64-pc-windows-msvc\release\dda-desktop.exe")
debugExe = fileSystem.BuildPath(desktopDirectory, "src-tauri\target\x86_64-pc-windows-msvc\debug\dda-desktop.exe")

If fileSystem.FileExists(releaseExe) Then
  executable = releaseExe
ElseIf fileSystem.FileExists(debugExe) Then
  executable = debugExe
Else
  MsgBox "The dda desktop application has not been built yet.", vbExclamation, "dda"
  WScript.Quit 1
End If

shell.CurrentDirectory = projectDirectory
Set processEnvironment = shell.Environment("PROCESS")
processEnvironment("DDA_RUNTIME_ENTRY") = fileSystem.BuildPath(projectDirectory, "runtime\src\index.mjs")
processEnvironment("DDA_WORKSPACE_ROOT") = projectDirectory
shell.Run Chr(34) & executable & Chr(34), 1, False
