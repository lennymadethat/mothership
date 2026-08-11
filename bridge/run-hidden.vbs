' Launches the bridge with no visible window (used by the scheduled task).
' Supervises node in a loop: if the bridge process dies, respawn after 5s.
' This keeps the scheduled task "Running" so stopping the task kills the bridge,
' and a node crash doesn't leave the machine dark until next logon.
'
' Why the absolute node.exe path below: the AtStartup trigger fires before
' anyone logs on, and a task running there only sees the MACHINE environment.
' A per-user Node install (nvm-windows, fnm, scoop, winget) is on the USER PATH,
' which does not exist yet at boot — so a bare "node" resolves to nothing, cmd
' exits instantly, this loop respawns it forever, and the task keeps reporting
' "Running" while the machine never comes online. Resolve node.exe up front and
' say so in the log instead of trusting PATH and spinning silently.
Dim shell, fso, dir, logPath, nodeExe, Q
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = dir
If Not fso.FolderExists(dir & "\data") Then fso.CreateFolder dir & "\data"
logPath = dir & "\data\bridge.log"
Q = Chr(34)

Const MAX_LOG = 10485760 ' 10 MB — rotate so an always-on box never fills its disk

Do
  RotateLog
  nodeExe = ResolveNode()
  If nodeExe = "" Then
    ' Nothing to launch. Retry slowly and leave a reason in the log, rather
    ' than hammering a command that cannot work every 5 seconds.
    Note "node.exe not found — bridge cannot start. Put its full path in data\node-path.txt, or re-run install.ps1."
    WScript.Sleep 60000
  Else
    Note "starting bridge: " & nodeExe
    ' cmd strips the outermost quote pair, hence the doubled quote before the
    ' exe path — this is the form that survives spaces in "C:\Program Files".
    shell.Run "cmd /c " & Q & Q & nodeExe & Q & " bridge.js >> data\bridge.log 2>&1" & Q, 0, True
    WScript.Sleep 5000
  End If
Loop

' Absolute path to node.exe, or "" if this machine has none we can find.
Function ResolveNode()
  Dim pinned, cands, i, c, parts, p
  ResolveNode = ""

  ' 1) Pinned by install.ps1 — survives PATH edits and per-user installs.
  pinned = ReadFirstLine(dir & "\data\node-path.txt")
  If pinned <> "" Then
    If fso.FileExists(pinned) Then ResolveNode = pinned : Exit Function
  End If

  ' 2) The usual homes, machine-wide ones first.
  cands = Array( _
    "%ProgramFiles%\nodejs\node.exe", _
    "%ProgramW6432%\nodejs\node.exe", _
    "%ProgramFiles(x86)%\nodejs\node.exe", _
    "%LOCALAPPDATA%\Programs\nodejs\node.exe", _
    "%USERPROFILE%\scoop\apps\nodejs\current\node.exe")
  For i = 0 To UBound(cands)
    c = shell.ExpandEnvironmentStrings(cands(i))
    If InStr(c, "%") = 0 Then
      If fso.FileExists(c) Then ResolveNode = c : Exit Function
    End If
  Next

  ' 3) Walk both PATHs out of the registry. The user PATH is not in our
  '    environment at boot, so read it directly instead of via %PATH%.
  parts = Split(RegRead("HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment\Path") _
                & ";" & RegRead("HKCU\Environment\Path"), ";")
  For i = 0 To UBound(parts)
    p = Trim(parts(i))
    If p <> "" Then
      p = shell.ExpandEnvironmentStrings(p)
      If Right(p, 1) = "\" Then p = Left(p, Len(p) - 1)
      If InStr(p, "%") = 0 Then
        If fso.FileExists(p & "\node.exe") Then ResolveNode = p & "\node.exe" : Exit Function
      End If
    End If
  Next
End Function

Function ReadFirstLine(p)
  Dim ts
  ReadFirstLine = ""
  On Error Resume Next
  If fso.FileExists(p) Then
    Set ts = fso.OpenTextFile(p, 1)
    If Not ts.AtEndOfStream Then ReadFirstLine = Trim(ts.ReadLine)
    ts.Close
  End If
  On Error Goto 0
End Function

Function RegRead(k)
  RegRead = ""
  On Error Resume Next
  RegRead = shell.RegRead(k)   ' missing key -> stays ""
  On Error Goto 0
End Function

Sub Note(msg)
  Dim ts
  On Error Resume Next
  Set ts = fso.OpenTextFile(logPath, 8, True)
  ts.WriteLine "[" & Now & "] [supervisor] " & msg
  ts.Close
  On Error Goto 0
End Sub

Sub RotateLog
  On Error Resume Next
  If fso.FileExists(logPath) Then
    If fso.GetFile(logPath).Size > MAX_LOG Then
      If fso.FileExists(logPath & ".1") Then fso.DeleteFile logPath & ".1", True
      fso.MoveFile logPath, logPath & ".1"
    End If
  End If
  On Error Goto 0
End Sub
