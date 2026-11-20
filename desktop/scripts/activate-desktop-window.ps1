# Activates an existing healthy dda desktop window if one is running from a
# build under DDA_LAUNCH_BUILD_ROOT. Emits exactly one JSON line on stdout;
# exits nonzero on any error so the caller can refuse to spawn a duplicate.

$ErrorActionPreference = 'Stop'

$root = [System.Environment]::GetEnvironmentVariable('DDA_LAUNCH_BUILD_ROOT')
if ([string]::IsNullOrWhiteSpace($root)) { Write-Output '{"existing":false}'; exit 0 }

$rootFull = ([System.IO.Path]::GetFullPath($root)).TrimEnd('\', '/') + '\'
$rootFullLower = $rootFull.ToLowerInvariant()

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class W32 {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  [DllImport("user32.dll", CharSet = CharSet.Auto)] public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool FlashWindow(IntPtr hWnd, bool bInvert);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
}
'@

$targetExe = [System.Environment]::GetEnvironmentVariable('DDA_LAUNCH_TARGET_EXE')
$targetExeLower = if ([string]::IsNullOrWhiteSpace($targetExe)) { '' } else { ([System.IO.Path]::GetFullPath($targetExe)).ToLowerInvariant() }

# Collect dda-desktop processes whose executable lives under the build root.
$validPids = @{}
$procs = Get-Process -Name 'dda-desktop' -ErrorAction SilentlyContinue
foreach ($p in $procs) {
  try {
    $exe = $p.Path
    if (-not $exe) { continue }
    $exeFull = [System.IO.Path]::GetFullPath($exe)
    if ($exeFull.ToLowerInvariant().StartsWith($rootFullLower, [System.StringComparison]::OrdinalIgnoreCase)) {
      $validPids[$p.Id] = $exeFull
    }
  } catch { continue }
}

if ($validPids.Count -eq 0) { Write-Output '{"existing":false}'; exit 0 }

# Enumerate top-level windows; accept only a VISIBLE 'Tauri Window' class
# owned by a valid pid — #32770 error dialogs and hidden windows are skipped.
$found = @{}
$callback = [W32+EnumWindowsProc]{
  param($hWnd, $lParam)
  $procId = [uint32]0
  [void][W32]::GetWindowThreadProcessId($hWnd, [ref]$procId)
  if ($validPids.ContainsKey([int]$procId) -and [W32]::IsWindowVisible($hWnd)) {
    $sb = New-Object System.Text.StringBuilder 256
    [void][W32]::GetClassName($hWnd, $sb, $sb.Capacity)
    if ($sb.ToString() -eq 'Tauri Window') { $script:found[[int]$procId] = $hWnd }
  }
  return $true
}
[void][W32]::EnumWindows($callback, [IntPtr]::Zero)

if ($found.Count -eq 0) { Write-Output '{"existing":false}'; exit 0 }

$first = $found.GetEnumerator() | Select-Object -First 1
$pid_ = [int]$first.Key
$hWnd = $first.Value

$exePath = $validPids[$pid_]
$buildDir = [System.IO.Path]::GetDirectoryName($exePath)
$isStale = ($targetExeLower.Length -gt 0) -and ($exePath.ToLowerInvariant() -ne $targetExeLower)

if ($isStale) {
  $taskChildren = Get-CimInstance Win32_Process -Filter "ParentProcessId=$pid_ AND Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and ($_.CommandLine -match 'index\.mjs["''\s]+task(\s|$)') }
  if ($null -eq $taskChildren -or @($taskChildren).Count -eq 0) {
    [void][W32]::PostMessage($hWnd, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
    $deadline = [DateTime]::UtcNow.AddMilliseconds(4000)
    $exited = $false
    while ([DateTime]::UtcNow -lt $deadline) {
      if (-not (Get-Process -Id $pid_ -ErrorAction SilentlyContinue)) { $exited = $true; break }
      Start-Sleep -Milliseconds 120
    }
    if ($exited) {
      $wvDeadline = [DateTime]::UtcNow.AddMilliseconds(1200)
      while ([DateTime]::UtcNow -lt $wvDeadline) {
        $wvChildren = Get-CimInstance Win32_Process -Filter "ParentProcessId=$pid_ AND Name='msedgewebview2.exe'" -ErrorAction SilentlyContinue
        if ($null -eq $wvChildren -or @($wvChildren).Count -eq 0) { break }
        Start-Sleep -Milliseconds 100
      }
      Write-Output (ConvertTo-Json -InputObject @{ existing = $false; closedStalePid = $pid_ } -Compress)
      exit 0
    }
  }
  [void][W32]::ShowWindow($hWnd, 9)
  $raised = [W32]::SetForegroundWindow($hWnd)
  if (-not $raised) { [void][W32]::FlashWindow($hWnd, $true) }
  $result = @{ existing = $true; stale = $true; busy = $true; pid = $pid_; executable = $exePath; buildDirectory = $buildDir }
  Write-Output (ConvertTo-Json -InputObject $result -Compress)
  exit 0
}

# Restore + raise; if Windows denies foreground, still report existing so no
# duplicate process is spawned.
[void][W32]::ShowWindow($hWnd, 9)
$raised = [W32]::SetForegroundWindow($hWnd)
if (-not $raised) { [void][W32]::FlashWindow($hWnd, $true) }

$result = @{ existing = $true; stale = $false; pid = $pid_; executable = $exePath; buildDirectory = $buildDir }
Write-Output (ConvertTo-Json -InputObject $result -Compress)
exit 0
