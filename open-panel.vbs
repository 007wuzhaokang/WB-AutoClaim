' AutoClaim panel launcher - no console window.
' Ensures the local service is up, then opens the panel in the default browser.
Dim sh, fso, bat, http, i, ok
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

bat = fso.GetParentFolderName(WScript.ScriptFullName) & "\start.bat"
If Not fso.FileExists(bat) Then bat = "D:\WB-AutoClaim\start.bat"

If fso.FileExists(bat) Then
  sh.CurrentDirectory = fso.GetParentFolderName(bat)
  sh.Run """" & bat & """ /silent", 0, False
End If

' Wait until the panel answers (max ~12s) so the browser never shows a connection error.
ok = False
For i = 1 To 24
  On Error Resume Next
  Set http = CreateObject("MSXML2.XMLHTTP")
  http.Open "GET", "http://127.0.0.1:8788/", False
  http.Send
  If Err.Number = 0 Then
    If http.Status = 200 Then ok = True
  End If
  Err.Clear
  On Error GoTo 0
  If ok Then Exit For
  WScript.Sleep 500
Next

sh.Run "http://127.0.0.1:8788", 1, False
