"""Exercise the real NSIS customInit without installing or touching the real app.

Run from a non-elevated Windows shell. A Windows UAC prompt is expected.
The fixture preflight returns 77 if its required privilege level is wrong.
Use --current-user to check that per-user installs stay unelevated, or
--locked to check that a failed elevated preflight still blocks installation.
"""
import argparse
import ctypes
import json
import os
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]
WORK = ROOT / '_work' / 'installer-elevation'
CACHE = Path(os.environ['LOCALAPPDATA']) / 'electron-builder' / 'Cache'

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--current-user', action='store_true')
    parser.add_argument('--locked', action='store_true')
    args = parser.parse_args()
    if ctypes.windll.shell32.IsUserAnAdmin():
        raise SystemExit('Run this check from a non-elevated shell to test the UAC transition')
    compilers = sorted(CACHE.glob('nsis-*/*/makensis.exe'))
    plugins = sorted(CACHE.glob('nsis-resources-*/*/plugins/x86-unicode/UAC.dll'))
    if not compilers or not plugins:
        raise SystemExit('Build the Windows installer once to populate the NSIS tool cache')
    WORK.mkdir(parents=True, exist_ok=True)
    expected_admin = '$false' if args.current_user else '$true'
    preflight_exit = 2 if args.locked else 0
    (WORK / 'close-installation-processes.ps1').write_text(
        "param([string]$InstallDir, [int]$InstallerPid)\n"
        "$admin=[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)\n"
        f"if ($admin -ne {expected_admin}) {{ exit 77 }}; Write-Output 'PREFLIGHT_PRIVILEGES_CONFIRMED'; exit {preflight_exit}\n", encoding='utf-8-sig')
    executable = WORK / 'elevation-fixture.exe'
    source = WORK / 'elevation-fixture.nsi'
    source.write_text(f'''
Unicode true
!addincludedir "{ROOT / 'node_modules/app-builder-lib/templates/nsis/include'}"
!addplugindir /x86-unicode "{plugins[-1].parent}"
!include "UAC.nsh"
!define BUILD_RESOURCES_DIR "{WORK}"
!define INSTALL_REGISTRY_KEY "Software\\HongguoInstallerElevationFixture"
!include "{ROOT / 'build/installer.nsh'}"
Name "Hongguo installer elevation check"
OutFile "{executable}"
RequestExecutionLevel user
SilentInstall silent
Var installMode
Function .onInit
  StrCpy $installMode "{'CurrentUser' if args.current_user else 'all'}"
  StrCpy $INSTDIR "{WORK}"
  !insertmacro customInit
FunctionEnd
Section
  SetErrorLevel 0
SectionEnd
''', encoding='utf-8-sig')
    built = subprocess.run([str(compilers[-1]), '/V2', str(source)], cwd=ROOT,
                           capture_output=True, text=True, encoding='utf-8', errors='replace')
    if built.returncode:
        print(built.stdout + built.stderr)
        raise SystemExit(built.returncode)
    checked = subprocess.run([str(executable)], cwd=ROOT, timeout=180)
    passed = checked.returncode == preflight_exit
    result = {'passed': passed, 'required_admin': not args.current_user,
              'exit_code': checked.returncode, 'real_installation_touched': False}
    print(json.dumps(result))
    (WORK / 'result.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
    raise SystemExit(0 if passed else 1)

if __name__ == '__main__':
    main()
