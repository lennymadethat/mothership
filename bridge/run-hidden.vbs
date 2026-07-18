' Launches the bridge with no visible window (used by the scheduled task).
' Supervises node in a loop: if the bridge process dies, respawn after 5s.
' This keeps the scheduled task "Running" so stopping the task kills the bridge,
' and a node crash doesn't leave the machine dark until next logon.
Dim shell, fso, dir
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = dir
Const MAX_LOG = 10485760 ' 10 MB — rotate so an always-on box never fills its disk
Do
  On Error Resume Next
  If fso.FileExists(dir & "\data\bridge.log") Then
    If fso.GetFile(dir & "\data\bridge.log").Size > MAX_LOG Then
      If fso.FileExists(dir & "\data\bridge.log.1") Then fso.DeleteFile dir & "\data\bridge.log.1", True
      fso.MoveFile dir & "\data\bridge.log", dir & "\data\bridge.log.1"
    End If
  End If
  On Error Goto 0
  shell.Run "cmd /c node bridge.js >> data\bridge.log 2>&1", 0, True
  WScript.Sleep 5000
Loop
