param(
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$InstallDir,
    [int]$InstallerPid = 0,
    [ValidateRange(1, 15)][int]$TimeoutSeconds = 15
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2

# Emit P/Invoke in memory: Windows PowerShell's Add-Type compiler would write TEMP files.
$assembly = [AppDomain]::CurrentDomain.DefineDynamicAssembly(
    [Reflection.AssemblyName]::new('HongguoInstallNative'), [Reflection.Emit.AssemblyBuilderAccess]::Run)
$module = $assembly.DefineDynamicModule('InstallNative')
$type = $module.DefineType('HongguoInstallNative', [Reflection.TypeAttributes]'Public,Abstract,Sealed')
$importCtor = [Runtime.InteropServices.DllImportAttribute].GetConstructor([Type[]]@([string]))
$importFields = [Reflection.FieldInfo[]]@(
    [Runtime.InteropServices.DllImportAttribute].GetField('SetLastError'),
    [Runtime.InteropServices.DllImportAttribute].GetField('ExactSpelling'))
$import = [Reflection.Emit.CustomAttributeBuilder]::new($importCtor, [object[]]@('kernel32.dll'),
    $importFields, [object[]]@($true, $true))
function Add-NativeMethod([string]$Name, [Type]$Returns, [Type[]]$Parameters) {
    $method = $type.DefinePInvokeMethod($Name, 'kernel32.dll', [Reflection.MethodAttributes]'Public,Static,PinvokeImpl',
        [Reflection.CallingConventions]::Standard, $Returns, $Parameters,
        [Runtime.InteropServices.CallingConvention]::Winapi, [Runtime.InteropServices.CharSet]::Unicode)
    $method.SetCustomAttribute($import)
    $method.SetImplementationFlags([Reflection.MethodImplAttributes]::PreserveSig)
}
Add-NativeMethod 'CreateFileW' ([IntPtr]) ([Type[]]@([string], [uint32], [uint32], [IntPtr], [uint32], [uint32], [IntPtr]))
Add-NativeMethod 'GetFinalPathNameByHandleW' ([uint32]) ([Type[]]@([IntPtr], [Text.StringBuilder], [uint32], [uint32]))
Add-NativeMethod 'CloseHandle' ([bool]) ([Type[]]@([IntPtr]))
$native = $type.CreateType()

function Normalize-Path([string]$Path) {
    if ($Path.StartsWith('\\?\UNC\', [StringComparison]::OrdinalIgnoreCase)) { $Path = '\\' + $Path.Substring(8) }
    elseif ($Path.StartsWith('\\?\', [StringComparison]::OrdinalIgnoreCase)) { $Path = $Path.Substring(4) }
    return [IO.Path]::GetFullPath($Path).TrimEnd('\')
}
function Resolve-RealPath([string]$Path, [switch]$Directory) {
    $flags = if ($Directory) { [uint32]0x02000000 } else { [uint32]0 }
    $handle = $native::CreateFileW($Path, [uint32]0, [uint32]7, [IntPtr]::Zero, [uint32]3, $flags, [IntPtr]::Zero)
    if ($handle -eq [IntPtr]::new(-1)) { throw 'Cannot resolve installation path' }
    try {
        $buffer = [Text.StringBuilder]::new(32768)
        $length = $native::GetFinalPathNameByHandleW($handle, $buffer, [uint32]32768, [uint32]0)
        if ($length -eq 0 -or $length -ge 32768) { throw 'Cannot resolve installation path' }
        return Normalize-Path $buffer.ToString()
    } finally { [void]$native::CloseHandle($handle) }
}
function Within-Root([string]$Path) {
    if (-not $Path) { return $false }
    try {
        $normal = Normalize-Path $Path
        if (-not $normal.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase) -and
            -not $normal.StartsWith($logicalPrefix, [StringComparison]::OrdinalIgnoreCase)) { return $false }
        $resolved = Resolve-RealPath $Path
        return $resolved.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)
    } catch { return $false }
}
function Installation-Processes {
    return @(Get-CimInstance -ClassName Win32_Process -OperationTimeoutSec 2 | Where-Object {
        $_.ProcessId -ne $PID -and $_.ProcessId -ne $InstallerPid -and (Within-Root $_.ExecutablePath)
    })
}
function Stop-OwnedProcess($Row, [switch]$Graceful) {
    try {
        $process = Get-Process -Id ([int]$Row.ProcessId) -ErrorAction Stop
        # Resolve the live process again, rather than trusting a stale PID snapshot.
        if (-not (Within-Root $process.Path)) { return }
        [void]$process.Handle
        if ($Graceful) {
            if ($process.MainWindowHandle -ne [IntPtr]::Zero) { [void]$process.CloseMainWindow() }
        } else { Stop-Process -InputObject $process -Force -ErrorAction Stop }
    } catch {
        if (Get-Process -Id ([int]$Row.ProcessId) -ErrorAction SilentlyContinue) { throw 'Cannot stop an installation process' }
    }
}
function Locked-InstallFiles {
    $locked = @()
    $paths = @('红果桌面.exe', 'resources\app.asar')
    foreach ($prefix in @('runtime\', 'resources\runtime\')) {
        $paths += $prefix + 'python\python.exe'
        $paths += $prefix + 'ffmpeg.exe'
        $paths += $prefix + 'jre\bin\java.exe'
        $paths += $prefix + 'jre\lib\modules'
        $paths += $prefix + 'sign\unidbg-sign.jar'
        $paths += $prefix + 'capture\fq_oversea\libc++_shared.so'
        $paths += $prefix + 'capture\fq_oversea\libmetasec_ml.so'
    }
    foreach ($relative in $paths) {
        $file = Join-Path $installRoot $relative
        if (-not [IO.File]::Exists($file)) { continue }
        # Request DELETE permission without deleting; deny-share handles are detected here.
        $handle = $native::CreateFileW($file, [uint32]0x10000, [uint32]7,
            [IntPtr]::Zero, [uint32]3, [uint32]0, [IntPtr]::Zero)
        if ($handle -eq [IntPtr]::new(-1)) { $locked += $relative }
        else { [void]$native::CloseHandle($handle) }
    }
    return $locked
}

try {
    if (-not [IO.Path]::IsPathRooted($InstallDir)) { throw 'Installation path must be absolute' }
    $logicalRoot = Normalize-Path $InstallDir
    if (-not [IO.Directory]::Exists($logicalRoot)) { exit 0 }
    $installRoot = Resolve-RealPath $logicalRoot -Directory
    if ($installRoot -eq [IO.Path]::GetPathRoot($installRoot).TrimEnd('\')) { throw 'Drive roots are not installation directories' }
    $rootPrefix = $installRoot + '\'
    $logicalPrefix = $logicalRoot + '\'
    # Fresh/custom unrelated folders are not prior Hongguo installations. A partly
    # uninstalled app may lack its main exe but still contain the signer jar.
    $markers = @('红果桌面.exe', 'resources\service\gateway.py',
        'resources\runtime\sign\unidbg-sign.jar', 'runtime\sign\unidbg-sign.jar')
    if (-not @($markers | Where-Object { [IO.File]::Exists((Join-Path $installRoot $_)) }).Count) { exit 0 }
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    $initial = @(Installation-Processes)
    $hasWindow = $false
    foreach ($row in $initial) {
        $process = Get-Process -Id ([int]$row.ProcessId) -ErrorAction SilentlyContinue
        if ($process -and $process.MainWindowHandle -ne [IntPtr]::Zero) { $hasWindow = $true; Stop-OwnedProcess $row -Graceful }
    }
    if ($hasWindow) {
        $grace = [DateTime]::UtcNow.AddSeconds(3)
        while ([DateTime]::UtcNow -lt $grace -and @(Installation-Processes).Count) { Start-Sleep -Milliseconds 250 }
    }
    do {
        foreach ($row in @(Installation-Processes)) { Stop-OwnedProcess $row }
        $remaining = @(Installation-Processes)
        $locked = @(Locked-InstallFiles)
        if ($remaining.Count -eq 0 -and $locked.Count -eq 0) { Write-Output 'INSTALLATION_PROCESSES_CLOSED'; exit 0 }
        if ([DateTime]::UtcNow -ge $deadline) { break }
        Start-Sleep -Milliseconds 500
    } while ($true)
    Write-Output 'INSTALLATION_FILES_STILL_LOCKED'; exit 2
} catch { Write-Output 'INSTALLATION_PREFLIGHT_FAILED'; exit 2 }
