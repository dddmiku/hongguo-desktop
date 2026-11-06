$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$work = Join-Path $repo '_work\installer-process-cleanup'
$cleanup = Join-Path $repo 'build\close-installation-processes.ps1'
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$compiler = Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$children = @()
$watch = [Diagnostics.Stopwatch]::StartNew()

function Assert-That([bool]$Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Quote-Arg([string]$Value) { return '"' + $Value + '"' }

try {
    [IO.Directory]::CreateDirectory($work) | Out-Null
    # The shared prefix and apostrophe deliberately exercise path-boundary/argument rules.
    $first = Join-Path $work "install 'quoted folder"
    $other = $first + '-other'
    foreach ($folder in @($first, $other)) {
        [IO.Directory]::CreateDirectory((Join-Path $folder 'resources\runtime\jre\bin')) | Out-Null
        [IO.Directory]::CreateDirectory((Join-Path $folder 'resources\runtime\sign')) | Out-Null
        [IO.File]::WriteAllText((Join-Path $folder 'resources\runtime\sign\unidbg-sign.jar'), 'owned test marker')
    }
    $source = Join-Path $work 'Fixture.cs'
    [IO.File]::WriteAllText($source, @'
using System;
using System.IO;
using System.Collections.Generic;
using System.Threading;
class Fixture {
  static void Main(string[] args) {
    var files = new List<FileStream>();
    foreach (var file in args) files.Add(new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.Read));
    Thread.Sleep(600000);
  }
}
'@)
    $fixture = Join-Path $work 'fixture.exe'
    & $compiler /nologo /target:exe "/out:$fixture" $source
    Assert-That ($LASTEXITCODE -eq 0) 'fixture compiler failed'
    $exe1 = Join-Path $first 'resources\runtime\jre\bin\java.exe'
    $exe2 = Join-Path $other 'resources\runtime\jre\bin\java.exe'
    Copy-Item -LiteralPath $fixture -Destination $exe1 -Force
    Copy-Item -LiteralPath $fixture -Destination $exe2 -Force
    $jar1 = Join-Path $first 'resources\runtime\sign\unidbg-sign.jar'
    $jar2 = Join-Path $other 'resources\runtime\sign\unidbg-sign.jar'
    $one = Start-Process -FilePath $exe1 -ArgumentList (Quote-Arg $jar1) -PassThru -WindowStyle Hidden
    $children += $one
    $two = Start-Process -FilePath $exe2 -ArgumentList (Quote-Arg $jar2) -PassThru -WindowStyle Hidden
    $children += $two
    Start-Sleep -Milliseconds 300
    Assert-That ($one.ProcessName -eq $two.ProcessName) 'same-name fixture not established'
    $run = Start-Process -FilePath $powershell -ArgumentList @('-NoProfile', '-NonInteractive',
        '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', (Quote-Arg $cleanup),
        '-InstallDir', (Quote-Arg $first), '-TimeoutSeconds', '10') -WindowStyle Hidden -PassThru
    Assert-That ($run.WaitForExit(15000)) 'preflight exceeded its deadline'
    Assert-That ($run.ExitCode -eq 0) ('preflight returned ' + $run.ExitCode)
    Assert-That ($one.WaitForExit(2000)) 'owned orphan Java was not stopped'
    $two.Refresh(); Assert-That (-not $two.HasExited) 'same-name outside/prefix sibling process was stopped'
    Assert-That ([IO.File]::Exists($jar1)) 'cleanup deleted a runtime file'
    Write-Output 'PASS: orphan stopped; same-name sibling untouched; files retained; apostrophe path literal'

    # An installer/process explicitly excluded by its PID is preserved even inside the root.
    $excluded = Start-Process -FilePath $exe1 -PassThru -WindowStyle Hidden
    $children += $excluded
    $run = Start-Process -FilePath $powershell -ArgumentList @('-NoProfile', '-NonInteractive',
        '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', (Quote-Arg $cleanup),
        '-InstallDir', (Quote-Arg $first), '-InstallerPid', [string]$excluded.Id, '-TimeoutSeconds', '5') -WindowStyle Hidden -PassThru
    Assert-That ($run.WaitForExit(10000)) 'excluded-pid preflight hung'
    Assert-That ($run.ExitCode -eq 0) 'excluded-pid preflight failed'
    $excluded.Refresh(); Assert-That (-not $excluded.HasExited) 'installer PID was stopped'
    Write-Output 'PASS: installer PID exclusion'

    # A file held by a process outside the installation must cause an explicit failure.
    $locked = Start-Process -FilePath $exe2 -ArgumentList (Quote-Arg $jar1) -PassThru -WindowStyle Hidden
    $children += $locked
    Start-Sleep -Milliseconds 200
    $run = Start-Process -FilePath $powershell -ArgumentList @('-NoProfile', '-NonInteractive',
        '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', (Quote-Arg $cleanup),
        '-InstallDir', (Quote-Arg $first), '-InstallerPid', [string]$excluded.Id, '-TimeoutSeconds', '2') -WindowStyle Hidden -PassThru
    Assert-That ($run.WaitForExit(7000)) 'locked-file preflight hung'
    Assert-That ($run.ExitCode -eq 2) 'unresolved runtime lock was not rejected'
    $locked.Refresh(); Assert-That (-not $locked.HasExited) 'outside lock owner was stopped'
    Write-Output 'PASS: unresolved lock exits 2 without stopping unrelated process'
    Write-Output ('elapsed=' + [Math]::Round($watch.Elapsed.TotalSeconds, 3) + 's')
} finally {
    foreach ($child in $children) {
        if (-not $child.HasExited) { Stop-Process -Id $child.Id -Force -ErrorAction SilentlyContinue }
        [void]$child.WaitForExit(3000)
    }
    $resolved = [IO.Path]::GetFullPath($work)
    Assert-That ($resolved.StartsWith($repo + '\', [StringComparison]::OrdinalIgnoreCase) -and
        $resolved.EndsWith('\_work\installer-process-cleanup', [StringComparison]::OrdinalIgnoreCase)) 'test cleanup scope mismatch'
    if (Test-Path -LiteralPath $resolved) { Remove-Item -LiteralPath $resolved -Recurse -Force }
}
