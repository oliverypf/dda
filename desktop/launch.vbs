Option Explicit

Dim fileSystem, shell, desktopDirectory, launcher, exitCode
Set fileSystem = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
desktopDirectory = fileSystem.GetParentFolderName(WScript.ScriptFullName)
launcher = fileSystem.BuildPath(desktopDirectory, "scripts\launch-desktop.mjs")

shell.CurrentDirectory = desktopDirectory
exitCode = shell.Run("node """ & launcher & """", 0, True)
If exitCode = 2 Then
  MsgBox "已有旧版 dda 窗口正在执行任务，未强制中断。请等当前任务结束后关闭窗口，再双击此入口启用最新构建。", vbInformation, "dda"
  WScript.Quit 0
ElseIf exitCode <> 0 Then
  MsgBox "dda could not start a staged desktop build. Run desktop\launch.cmd for details, or build with: node desktop\scripts\build-controlled.mjs --fast", vbExclamation, "dda"
  WScript.Quit exitCode
End If
