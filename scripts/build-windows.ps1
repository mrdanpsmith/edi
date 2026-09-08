# Builds the Windows Edi binaries: the PyInstaller onefile + an NSIS installer.
#
# PyInstaller cannot cross-compile, so this must run on real Windows (GitLab
# hosted Windows runner, `saas-windows-medium-amd64`, PowerShell shell). The
# frontend `dist/` and `scripts/assets/app-icon.ico` come from the `frontend`
# CI job (byte-identical on every platform), so NO Node/npm is needed here.
# It detects Python >= 3.10 on PATH (installs via Chocolatey only when missing),
# then:
#   1. python venv with PySide6==6.11.1 + pyinstaller==6.22.0 (same pins as Linux)
#   2. pyinstaller - edi.spec  ->  dist-app\Edi.exe
#   3. smoke test it offscreen (EDI_SELFTEST=1, verdict via EDI_SELFTEST_OUT)
#   4. copy to dist-app\Edi-<ver>-win64.exe
#   5. NSIS installer -> dist-app\Edi-<ver>-win64-setup.exe
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

# --- Toolchain: Python only (PySide6 6.11 needs >= 3.10). The frontend and
# icons are consumed from the `frontend` CI job artifacts, so Node is never
# needed on this runner.
if (-not (Test-Path 'dist\index.html')) {
    throw 'dist\index.html missing — the `frontend` CI job artifact was not downloaded; run npm ci && npm run build locally first'
}
if (-not (Test-Path 'scripts\assets\app-icon.ico')) {
    throw 'scripts\assets\app-icon.ico missing — the `frontend` CI job artifact was not downloaded; run node scripts/generate-icon.mjs locally first'
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

# --- Python venv (writes into the checkout like the Linux .venv; not committed)
Write-Host '==> Creating Python venv'
New-Item -ItemType Directory -Force -Path 'build' | Out-Null
Invoke-Py -m venv '.venv-win'
$PyVenv = Join-Path $PWD '.venv-win\Scripts\python.exe'
& $PyVenv -m pip install --upgrade pip --quiet
Assert-ExitCode 'pip upgrade'
& $PyVenv -m pip install 'PySide6==6.11.1' 'pyinstaller==6.22.0' --quiet
Assert-ExitCode 'pip install PySide6/pyinstaller'

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
if (Test-Path $SmokeFile) { Remove-Item $SmokeFile -Force }
$SmokeExe = Join-Path $PWD 'dist-app\Edi.exe'
$proc = Start-Process -FilePath $SmokeExe -WorkingDirectory $PWD -PassThru

# The onefile's first run self-extracts the whole Qt/WebEngine payload, and the
# runner's real-time AV can make that take minutes; the backend only writes a
# verdict once Python reaches _run_selftest. Poll instead of a fixed wait: bail
# the moment a verdict (or the watchdog's post-boot timeout) appears, but allow
# up to 10 min while the boot heartbeat (or nothing yet) shows.
$deadline = (Get-Date).AddMinutes(10)
$line = $null
do {
    Start-Sleep -Seconds 5
    if (-not $line -and (Test-Path $SmokeFile)) {
        try { $line = (Get-Content -Raw $SmokeFile).Trim() } catch { $line = $null }
    }
    $pending = $null -eq $line -or $line -eq 'SELFTEST_BOOTING'
} while (-not $proc.HasExited -and (Get-Date) -lt $deadline -and $pending)

if (-not $proc.HasExited) {
    try { $proc.Kill() } catch { }
}
if (-not $line -or $line -eq 'SELFTEST_BOOTING') {
    # A verdict written right at process exit can lose a race against a stale
    # heartbeat read; give the fsync'd file one last chance before failing.
    Start-Sleep -Milliseconds 250
    try { $line = (Get-Content -Raw $SmokeFile).Trim() } catch { $line = $null }
    if (-not $line) { $line = '' }
}
$proc.Refresh()
$exitNote = ''
if ($proc.HasExited) { $exitNote = " (exit code $($proc.ExitCode))" }
if ($line -eq 'SELFTEST_BOOTING') {
    throw "selftest hung: Python booted but QtWebEngine never produced a verdict in 10 min$exitNote"
}
if ($line -like 'SELFTEST_TIMEOUT*') {
    throw "selftest timed out (backend watchdog fired: page never loaded)$exitNote"
}
if (-not $line.StartsWith('SELFTEST ')) {
    throw "unexpected selftest state: '$line'$exitNote"
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