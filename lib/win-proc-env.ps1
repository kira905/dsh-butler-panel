param(
  [int]$Port = 3080,
  [int]$TargetPid = 0
)
# win-proc-env.ps1 -- read a live process environment block (x64 Windows) and print
# the telemetry-relevant variables in a machine-readable form.
#
# Why this exists: 判据 3 of the telemetry guard needs the PRODUCTION dsh process's
# real environment (DSH_TELEMETRY_MODE / _OTLP_URL / _DISABLED). Windows has no
# /proc, so the environment block is read through NtQueryInformationProcess(PEB) +
# ReadProcessMemory. The probe only runs when DSH is running (port 3080 listener).
#
# Output (one per line, ASCII keys):
#   PID=<pid>
#   SENTINEL=<0|1>         1 = DSH_HOME or DSH_PERMISSION_MODE present (block read looks sane)
#   TRUNCATED=<0|1>        env block size read was capped by our own buffer
#   DSH_TELEMETRY_MODE=<value|<UNSET>>
#   DSH_TELEMETRY_DISABLED=<value|<UNSET>>
#   DSH_TELEMETRY_OTLP_URL=<value|<UNSET>>
# Exit codes: 0 = printed (including NO_PROCESS), 3 = read error, 4 = no pwsh target
# NOTE: keep this file pure ASCII (cmd/PowerShell encoding safety).
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch { }

$cs = @'
using System;
using System.Runtime.InteropServices;

public static class PebEnvReader
{
    [DllImport("ntdll.dll")]
    private static extern int NtQueryInformationProcess(IntPtr h, int cls, byte[] buf, int len, out int ret);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(int access, bool inherit, int pid);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool ReadProcessMemory(IntPtr h, IntPtr addr, byte[] buf, int size, out IntPtr read);

    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr h);

    // Returns the raw environment strings, or null with error set.
    public static string[] Read(int pid, out string error, out bool truncated)
    {
        error = null;
        truncated = false;
        IntPtr h = OpenProcess(0x0410, false, pid); // QUERY_INFORMATION | VM_READ
        if (h == IntPtr.Zero) { error = "OpenProcess failed: " + Marshal.GetLastWin32Error(); return null; }
        try
        {
            byte[] pbi = new byte[48];
            int ret;
            int st = NtQueryInformationProcess(h, 0, pbi, pbi.Length, out ret);
            if (st != 0) { error = "NtQueryInformationProcess failed: 0x" + st.ToString("X8"); return null; }
            long peb = BitConverter.ToInt64(pbi, 8);
            IntPtr read;
            byte[] ppBuf = new byte[8];
            if (!ReadProcessMemory(h, (IntPtr)(peb + 0x20), ppBuf, 8, out read)) { error = "read PEB.ProcessParameters failed: " + Marshal.GetLastWin32Error(); return null; }
            long pp = BitConverter.ToInt64(ppBuf, 0);
            byte[] envPtrBuf = new byte[8];
            if (!ReadProcessMemory(h, (IntPtr)(pp + 0x80), envPtrBuf, 8, out read)) { error = "read Environment ptr failed: " + Marshal.GetLastWin32Error(); return null; }
            long envPtr = BitConverter.ToInt64(envPtrBuf, 0);
            byte[] sizeBuf = new byte[8];
            long envSize = 0;
            if (ReadProcessMemory(h, (IntPtr)(pp + 0x3F0), sizeBuf, 8, out read)) envSize = BitConverter.ToInt64(sizeBuf, 0);
            long cap = 1024 * 1024;
            if (envSize <= 0 || envSize > cap) { envSize = cap; truncated = true; }
            byte[] envBuf = new byte[envSize];
            if (!ReadProcessMemory(h, (IntPtr)envPtr, envBuf, (int)envSize, out read)) { error = "read env block failed: " + Marshal.GetLastWin32Error(); return null; }
            if (read.ToInt64() < envSize) truncated = true;
            string s = System.Text.Encoding.Unicode.GetString(envBuf, 0, (int)read.ToInt64());
            return s.Split('\0');
        }
        finally { CloseHandle(h); }
    }
}
'@

Add-Type -TypeDefinition $cs -Language CSharp

function Get-PortListenerPid([int]$p) {
  try {
    $c = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction Stop | Select-Object -First 1
    if ($c) { return [int]$c.OwningProcess }
  } catch { }
  return 0
}

$pid_ = if ($TargetPid -gt 0) { $TargetPid } else { Get-PortListenerPid $Port }
if ($pid_ -le 0) { Write-Output 'NO_PROCESS'; exit 0 }

$err = $null
$trunc = $false
$vars = [PebEnvReader]::Read($pid_, [ref]$err, [ref]$trunc)
if ($err) { Write-Output ('READ_ERROR: ' + $err); exit 3 }

$map = @{}
foreach ($v in $vars) {
  if ([string]::IsNullOrEmpty($v)) { continue }
  $i = $v.IndexOf('=')
  if ($i -le 0) { continue }
  $map[$v.Substring(0, $i)] = $v.Substring($i + 1)
}

Write-Output ('PID=' + $pid_)
$sentinel = 0
if ($map.ContainsKey('DSH_HOME') -or $map.ContainsKey('DSH_PERMISSION_MODE')) { $sentinel = 1 }
Write-Output ('SENTINEL=' + $sentinel)
Write-Output ('VARCOUNT=' + $map.Count)
Write-Output ('TRUNCATED=' + $(if ($trunc) { 1 } else { 0 }))
foreach ($n in @('DSH_TELEMETRY_MODE', 'DSH_TELEMETRY_DISABLED', 'DSH_TELEMETRY_OTLP_URL')) {
  if ($map.ContainsKey($n)) { Write-Output ($n + '=' + $map[$n]) } else { Write-Output ($n + '=<UNSET>') }
}
exit 0
