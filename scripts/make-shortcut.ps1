# make-shortcut.ps1 - puts a "หมู่บ้านหมาป่า" shortcut on the desktop that runs start.bat.
# Uses the Windows IShellLinkW API directly: WScript.Shell cannot save Thai file names,
# a Thai desktop folder (OneDrive\เดสก์ท็อป) or a Thai game folder on a non-Thai system locale.
param([string]$Desktop = [Environment]::GetFolderPath('Desktop'))
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices; using System.Text;
[ComImport, Guid("00021401-0000-0000-C000-000000000046")] class CShellLink {}
[ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("000214F9-0000-0000-C000-000000000046")]
interface IShellLinkW {
  void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder f, int c, IntPtr fd, int fl);
  void GetIDList(out IntPtr p); void SetIDList(IntPtr p);
  void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder n, int c);
  void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string n);
  void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder d, int c);
  void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string d);
  void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder a, int c);
  void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string a);
  void GetHotkey(out short h); void SetHotkey(short h);
  void GetShowCmd(out int s); void SetShowCmd(int s);
  void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder p, int c, out int i);
  void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string p, int i);
  void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string p, int r);
  void Resolve(IntPtr h, int f);
  void SetPath([MarshalAs(UnmanagedType.LPWStr)] string f);
}
[ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("0000010b-0000-0000-C000-000000000046")]
interface IPersistFile {
  void GetClassID(out Guid c); [PreserveSig] int IsDirty();
  void Load([MarshalAs(UnmanagedType.LPWStr)] string f, uint m);
  void Save([MarshalAs(UnmanagedType.LPWStr)] string f, bool r);
  void SaveCompleted([MarshalAs(UnmanagedType.LPWStr)] string f);
  void GetCurFile([MarshalAs(UnmanagedType.LPWStr)] out string f);
}
public static class VreKiLink {
  public static void Make(string lnk, string target, string dir, string desc, string icon, int idx) {
    var l = (IShellLinkW)new CShellLink();
    l.SetPath(target); l.SetWorkingDirectory(dir); l.SetDescription(desc); l.SetIconLocation(icon, idx);
    ((IPersistFile)l).Save(lnk, true);
  }
}
"@

$final = Join-Path $Desktop 'หมู่บ้านหมาป่า.lnk'
[VreKiLink]::Make($final, (Join-Path $root 'start.bat'), $root, 'หมู่บ้านหมาป่า - AI เล่นเกม WereWolf', (Join-Path $env:SystemRoot 'System32\imageres.dll'), 76)
Write-Output "shortcut: $final"
