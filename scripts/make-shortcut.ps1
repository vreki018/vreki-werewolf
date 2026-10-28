# make-shortcut.ps1 - puts a "หมู่บ้านหมาป่า" shortcut on the desktop that runs start.bat
$root = Split-Path -Parent $PSScriptRoot
$desktop = [Environment]::GetFolderPath('Desktop')
$link = Join-Path $desktop 'หมู่บ้านหมาป่า.lnk'
$shell = New-Object -ComObject WScript.Shell
$sc = $shell.CreateShortcut($link)
$sc.TargetPath = Join-Path $root 'start.bat'
$sc.WorkingDirectory = $root
$sc.Description = 'หมู่บ้านหมาป่า - AI เล่นเกม WereWolf'
$sc.IconLocation = "$env:SystemRoot\System32\imageres.dll,76"
$sc.Save()
Write-Output "shortcut: $link"
