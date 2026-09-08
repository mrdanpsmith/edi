# Builds the Windows Edi binaries: the PyInstaller onefile + an NSIS installer.
#
# PyInstaller cannot cross-compile, so this must run on real Windows (GitLab
# hosted Windows runner, `saas-windows-medium-amd64`, PowerShell shell). It
# detects Node >= 20 and Python >= 3.10 on PATH and installs them via Chocolatey
# only when missing, then:
#   1. npm ci + npm run build (frontend dist/)
#   2. python venv with PySide6==6.11.1 + pyinstaller==6.22.0 (same pins as Linux)
#   3. node scripts/generate-icon.mjs  (scripts/assets/app-icon.ico/.icns)
#   4. pyinstaller - edi.spec  ->  dist-app\Edi.exe
#   5. smoke test it offscreen (EDI_SELFTEST=1, verdict via EDI_SELFTEST_OUT)
#   6. copy to dist-app\Edi-<ver>-win64.exe
#   7. NSIS installer -> dist-app\Edi-<ver>-win64-setup.exe
#
# Usage:  powershell -ExecutionPolicy Bypass -File scripts/build-windows.ps1 -Version 0.5.0

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$Version
)

$ErrorActionPreference = 'Stop'

function Assert-ExitCode([string]$What) {
    if ($LASTEXITCODE -ne 0) {
        throw "$What failed with exit code $LASTEXITCODE"
    }
}

function Update-Path {
    $env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
                [System.Environment]::GetEnvironmentVariable('Path', 'User')
}

function Test-Command([string]$Name) {
    return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

$Version = $Version.TrimStart('v')
if ($Version -notmatch '^\d+\.\d+\.\d+$') {
    throw "invalid version '$Version' (expected x.y.z)"
}

Write-Host "==> Building Edi $Version for Windows"
if (-not (Test-Path 'package.json')) { throw 'run this from the repository root' }

# --- Toolchain: prefer what's already on PATH, install via Chocolatey when out
# of range (the GitLab Windows runner preinstalls Node and Python, but the
# frontend needs Node ^20.19.0 || >=22.12.0 — the runner's preinstalled Node
# 21, for example, misses every gate — and PySide6 6.11 needs Python >= 3.10).
function Test-NodeSupported {
    if (-not (Test-Command node)) {
        return $false
    }
    $v = (& node --version).Trim()
    if ($v -notmatch '^v(\d+)\.(\d+)') {
        return $false
    }
    $nMaj = [int]$Matches[1]
    $nMin = [int]$Matches[2]
    return ($nMaj -eq 20 -and $nMin -ge 19) -or ($nMaj -eq 22 -and $nMin -ge 12) -or $nMaj -gt 22
}

if (-not (Test-NodeSupported)) {
    Write-Host 'Installing Node.js LTS via Chocolatey...'
    choco install nodejs-lts -y --no-progress | Out-Null
    Assert-ExitCode 'choco install nodejs-lts'
    Update-Path
    if (-not (Test-NodeSupported)) {
        # The preinstalled node may still shadow the LTS install on PATH.
        $ltsNode = 'C:\Program Files\nodejs\node.exe'
        if (Test-Path $ltsNode) {
            $env:PATH = (Split-Path $ltsNode) + ';' + $env:PATH
        }
        if (-not (Test-NodeSupported)) {
            throw 'no supported Node found (need ^20.19.0 || >=22.12.0); install via Chocolatey or nvm'
        }
    }
}

$pyOk = $false
if (Test-Command py) {
    $pyVer = (& py -3 --version).Trim()
    if ($pyVer -match '^Python 3\.(\d+)') {
        $pyOk = [int]$Matches[1] -ge 10
    }
}
if (-not $pyOk) {
    Write-Host 'Installing Python 3.12 via Chocolatey...'
    choco install python --version=3.12.8 -y --no-progress | Out-Null
    Assert-ExitCode 'choco install python'
    Update-Path
}

function Invoke-Py {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$PyArgs)
    & py -3 @PyArgs
    Assert-ExitCode "py -3 $($PyArgs -join ' ')"
}

# --- Frontend ---
Write-Host '==> Building frontend'
npm ci --no-audit --no-fund
Assert-ExitCode 'npm ci'
npm run build
Assert-ExitCode 'npm run build'

# --- Python venv (writes into the checkout like the Linux .venv; not committed)
Write-Host '==> Creating Python venv'
New-Item -ItemType Directory -Force -Path 'build' | Out-Null
Invoke-Py -m venv '.venv-win'
$PyVenv = Join-Path $PWD '.venv-win\Scripts\python.exe'
& $PyVenv -m pip install --upgrade pip --quiet
Assert-ExitCode 'pip upgrade'
& $PyVenv -m pip install 'PySide6==6.11.1' 'pyinstaller==6.22.0' --quiet
Assert-ExitCode 'pip install PySide6/pyinstaller'

# --- Icons (ico + icns from the 1024 master, pure Node) ---
Write-Host '==> Generating icons'
node scripts/generate-icon.mjs
Assert-ExitCode 'generate-icon'

# --- PyInstaller onefile ---
Write-Host '==> PyInstaller onefile'
$env:PYINSTALLER_ZLIB_COMPRESSION_LEVEL = '1'
& $PyVenv -m PyInstaller --clean --distpath dist-app --workpath build edi.spec
Assert-ExitCode 'pyinstaller'

# --- Offscreen smoke test --------------------------------------------
# The windowed onefile has no attached console, so stdout is not observable
# (Python's sys.stdout is None). EDI_SELFTEST_OUT makes the backend write the
# same verdict line to a file we can parse.
Write-Host '==> Smoke test'
$SmokeFile = Join-Path (Resolve-Path 'build') 'selftest-win.json'
$env:EDI_SELFTEST = '1'
$env:EDI_SELFTEST_OUT = $SmokeFile
$env:QT_QPA_PLATFORM = 'offscreen'
$env:QTWEBENGINE_DISABLE_SANDBOX = '1'
$env:QTWEBENGINE_CHROMIUM_FLAGS = '--disable-dev-shm-usage --disable-gpu'
$SmokeExe = Join-Path $PWD 'dist-app\Edi.exe'
$proc = Start-Process -FilePath $SmokeExe -WorkingDirectory $PWD -PassThru
if (-not $proc.WaitForExit(120000)) {
    $proc.Kill()
    throw 'selftest timed out after 120 s'
}
if ($proc.ExitCode -ne 0) {
    throw "selftest exited with code $($proc.ExitCode)"
}
$line = (Get-Content -Raw $SmokeFile).Trim()
if ($line -like 'SELFTEST_TIMEOUT*') {
    throw 'selftest timed out (backend watchdog fired)'
}
if (-not $line.StartsWith('SELFTEST ')) {
    throw "unexpected selftest line: $line"
}
$data = $line.Substring(9) | ConvertFrom-Json
if (-not ($data.editor -and $data.mermaid -and $data.icon)) {
    throw "selftest probes missing: $line"
}

# --- Versioned, ready-to-publish artifacts ---
Write-Host '==> Wrapping artifacts'
$OneFile = Join-Path $PWD ("dist-app\Edi-$Version-win64.exe")
Move-Item -Force (Join-Path $PWD 'dist-app\Edi.exe') $OneFile

if (-not (Test-Command makensis)) {
    Write-Host 'Installing NSIS via Chocolatey...'
    choco install nsis -y --no-progress | Out-Null
    Assert-ExitCode 'choco install nsis'
    Update-Path
}
$Ico = (Resolve-Path 'scripts\assets\app-icon.ico').Path
# Forward slashes avoid backslash-escape ambiguity on the makensis command line.
& makensis "/DVERSION=$Version" "/DSETUPEXE=$($OneFile.Replace('\', '/'))" "/DICO=$($Ico.Replace('\', '/'))" 'packaging\edi.nsi'
Assert-ExitCode 'makensis'

$Setup = Join-Path $PWD "dist-app\Edi-$Version-win64-setup.exe"
if (-not (Test-Path $Setup)) {
    throw "installer was not produced: $Setup"
}

Write-Host "==> Done:
  $OneFile
  $Setup"