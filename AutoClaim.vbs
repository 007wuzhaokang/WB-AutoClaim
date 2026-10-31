' AutoClaim silent launcher. Place in the Startup folder to run at logon with no visible window.
Dim fso, sh, base, bat
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

base = fso.GetParentFolderName(WScript.ScriptFullName)
bat = base & "\start.bat"

' Fall back to the install directory if this script was copied elsewhere.
If Not fso.FileExists(bat) Then bat = "D:\WB-AutoClaim\start.bat"
If Not fso.FileExists(bat) Then WScript.Quit

sh.CurrentDirectory = "D:\WB-AutoClaim"
sh.Run """" & bat & """ /silent", 0, False
