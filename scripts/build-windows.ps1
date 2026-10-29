# Builds the Windows Edi bundle: the PyInstaller onedir. This is the FULL-SMOKE
# desktop path — the CI job runs on a windows-2025 runner, which is the
# only place the full QtWebEngine smoke can run.
#
# PyInstaller cannot cross-compile, so this must run on real Windows. The
# frontend `dist/` and `scripts/assets/app-icon.ico` come from the `frontend`
# CI job (byte-identical on every platform), so NO Node/npm is needed here.
# It detects a supported Python (3.10–3.14) on PATH (installs 3.12 via Chocolatey
# when none is present),
# then:
#   1. python venv from requirements-build.txt (same pins as Linux)
#   2. pyinstaller - edi.spec  ->  dist-app\Edi\ (Edi.exe + _internal\)
#   3. smoke test it offscreen (EDI_SELFTEST=1, verdict via EDI_SELFTEST_OUT)
#   4. zip the bundle to dist-app\Edi-<ver>-win64.zip (the portable download)
#
# The NSIS installer (packaging/edi.nsi) is built by the CI job now
# (native Windows makensis, `choco install nsis`). It can still produce a
# `-win64-setup.exe` by hand: running makensis from the checkout root with
# ABSOLUTE -D defines (makensis resolves relative File/OutFile paths against
# the SCRIPT's dir, not the CWD, and Linux makensis takes -D, not /D):
#   makensis -DVERSION=0.5.0 -DBUNDLE=C:\path\dist-app\Edi \
#            -DICO=C:\path\app-icon.ico -DOUTEXE=C:\path\Edi-0.5.0-win64-setup.exe
#            packaging\edi.nsi
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

# The runner's real-time AV thrashes every file write in this workspace (pip
# installs into .venv-win, the bundle PyInstaller writes) and the pip+PyInstaller
# phase was the job's dominant cost. The VM is ephemeral and the runner is
# elevated, so exclude the whole checkout to speed it up. Exclusions are
# dropped with the VM at job end.
try {
    Add-MpPreference -ExclusionPath (Resolve-Path '.').Path -ErrorAction Stop | Out-Null
} catch {
    Write-Host "WARN: could not add Defender exclusion: $($_.Exception.Message)"
}

# --- Toolchain: Python only. PySide6 6.11 supports 3.10 through 3.14, so the
# launcher must not simply take the newest `py -3` — a runner whose default is
# 3.15 can only resolve PySide6 6.12. The frontend and icons are consumed from
# the `frontend` CI job artifacts, so Node is never needed on this runner.
if (-not (Test-Path 'dist\index.html')) {
    throw 'dist\index.html missing — the `frontend` CI job artifact was not downloaded; run npm ci && npm run build locally first'
}
if (-not (Test-Path 'scripts\assets\app-icon.ico')) {
    throw 'scripts\assets\app-icon.ico missing — the `frontend` CI job artifact was not downloaded; run node scripts/generate-icon.mjs locally first'
}

$PyLauncherArgs = $null
if (Test-Command py) {
    foreach ($minor in 12, 13, 14, 11, 10) {
        $candidate = "-3.$minor"
        $oldEap = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        $pyVer = (& py $candidate --version 2>&1 | Out-String).Trim()
        $ErrorActionPreference = $oldEap
        if ($LASTEXITCODE -eq 0 -and $pyVer -match "Python 3\.$minor\b") {
            $PyLauncherArgs = $candidate
            break
        }
    }
}
if (-not $PyLauncherArgs) {
    Write-Host 'Installing Python 3.12 via Chocolatey...'
    choco install python --version=3.12.8 -y --no-progress | Out-Null
    Assert-ExitCode 'choco install python'
    Update-Path
    $PyLauncherArgs = '-3.12'
}

function Invoke-Py {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$PyArgs)
    & py $PyLauncherArgs @PyArgs
    Assert-ExitCode "py $PyLauncherArgs $($PyArgs -join ' ')"
}

# --- Python venv (writes into the checkout like the Linux .venv; not committed)
Write-Host '==> Creating Python venv'
New-Item -ItemType Directory -Force -Path 'build' | Out-Null
$env:PIP_CACHE_DIR = Join-Path $PWD 'build\.pip-cache'
Invoke-Py -m venv '.venv-win'
$PyVenv = Join-Path $PWD '.venv-win\Scripts\python.exe'
& $PyVenv -m pip install --upgrade pip --quiet
Assert-ExitCode 'pip upgrade'
& $PyVenv -m pip install -r requirements-build.txt --quiet
Assert-ExitCode 'pip install PySide6/pyinstaller'

# --- Bundle Windows' system ICU next to Qt6Core.dll --------------------------
# Qt6Core.dll hard-imports icuuc.dll (the Windows ICU). Real desktops have it
# in System32, but Server SKUs do not — and PyInstaller's Qt hooks only collect
# the platform plugins and translations if that isolated `import PySide6.QtCore`
# succeeds. Copying the system ICU into the PySide6
# package (a) lets the probe run on the build host and (b) makes the analysis
# resolve icuuc.dll from an app path so it is shipped IN the bundle — the exe
# then boots even on no-ICU Windows. ICU went unversioned-icuuc/icuin-first
# (1703+) and gains the combined icu.dll from 1903+; copy whichever exist.
$PySideDir = Join-Path $PWD '.venv-win\Lib\site-packages\PySide6'
$System32 = Join-Path $env:WinDir 'System32'
$copiedIcu = @()
foreach ($icu in 'icu.dll', 'icuuc.dll', 'icuin.dll') {
    $src = Join-Path $System32 $icu
    if (Test-Path $src) {
        Copy-Item -Force $src (Join-Path $PySideDir $icu)
        $copiedIcu += $icu
    }
}
if ($copiedIcu.Count -eq 0) {
    throw "no system ICU found in $System32 (icuuc.dll is required by Qt6Core.dll)"
}
Write-Host "==> Bundled system ICU into PySide6 dir: $($copiedIcu -join ', ')"

# --- PyInstaller onedir ---
Write-Host '==> PyInstaller onedir'
& $PyVenv -m PyInstaller --clean --distpath dist-app --workpath build edi.spec
Assert-ExitCode 'pyinstaller'
$BundleDir = Join-Path $PWD 'dist-app\Edi'

# --- Offscreen smoke test --------------------------------------------
# The shipped Edi.exe is windowed (runw.exe): a fatal startup error becomes a
# modal dialog nobody can see, and the run hangs until the budget. We
# smoke-test the console twin Edi-selftest.exe (same _internal) instead, so
# the error lands in the CI log. The verdict itself (SELFTEST {...}) is parsed
# from EDI_SELFTEST_OUT because no console is guaranteed attached to the job.
# --- Host capability probe before the frozen selftest --------------------
# Qt6WebEngineCore.dll has hard static imports of dcomp.dll (Desktop Window
# Manager composition) and bthprops.cpl (Bluetooth shell). GitLab's SaaS
# Windows runners are Server SKUs that lack those; there QtWebEngine cannot
# load AT ALL -- even `python -c "import PySide6.QtWebEngineCore"` fails with
# the identical ImportError, so no bundle (and no amount of extra PyInstaller
# bundling) could ever pass the selftest there. Redistributing the missing MS
# system files is not an option. GitHub's windows-2025 image (Desktop
# Experience) has both, so the smoke must run: a host that cannot import
# QtWebEngineCore FAILS the build rather than skipping the smoke, so an image
# change can never silently turn the gate off. We probe the freshly-installed
# venv first (same VM, same wheels) so that failure names the host, not the
# bundle.
Write-Host '==> Host capability probe (QtWebEngineCore import)'
# Run under $ErrorActionPreference 'Continue': Windows PowerShell 5.1 promotes
# native-command stderr to a terminating NativeCommandError when EAP is 'Stop',
# which would abort here before the failure report below can run. The probe's
# stderr (a python traceback on failure) is useful, so capture it via 2>&1 and
# decide on the process exit code + the 'WEBENGINE_HOST_OK' marker.
$prevEAP = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
$probeLines = & $PyVenv -c "from PySide6.QtWebEngineCore import QWebEngineSettings; print('WEBENGINE_HOST_OK')" 2>&1
$probeExit = $LASTEXITCODE
$ErrorActionPreference = $prevEAP
$probeOk = ($probeExit -eq 0) -and (($probeLines -join "`n") -match 'WEBENGINE_HOST_OK')
if (-not $probeOk) {
    $probeLines | ForEach-Object { Write-Host "  probe: $_" }
    throw "host cannot import QtWebEngineCore (exit $probeExit): this runner likely lacks Desktop Experience (no dcomp.dll/bthprops.cpl), so the smoke cannot run"
}

Write-Host '==> Smoke test (console bootloader twin)'
$SmokeFile = Join-Path (Resolve-Path 'build') 'selftest-win.json'
$SmokeExe = Join-Path $BundleDir 'Edi-selftest.exe'
# The post-boot phase is already bounded by the backend's 45s watchdog, so a
# smoke run left waiting here can only be a pre-boot hang. 3 min is a
# generous ceiling, override via EDI_SMOKE_BUDGET_MIN.
$SmokeBudgetMin = 3
if ($env:EDI_SMOKE_BUDGET_MIN -match '^\d+$') {
    $SmokeBudgetMin = [int]$env:EDI_SMOKE_BUDGET_MIN
}
$env:EDI_SELFTEST = '1'
$env:EDI_SELFTEST_OUT = $SmokeFile
$env:QT_QPA_PLATFORM = 'offscreen'
$env:QTWEBENGINE_DISABLE_SANDBOX = '1'
$env:QTWEBENGINE_CHROMIUM_FLAGS = '--disable-dev-shm-usage --disable-gpu'

function Invoke-SmokeRun {
    if (Test-Path $SmokeFile) { Remove-Item $SmokeFile -Force }
    $BootOut = Join-Path (Resolve-Path 'build') 'selftest-boot.out'
    $BootErr = Join-Path (Resolve-Path 'build') 'selftest-boot.err'
    Remove-Item $BootOut, $BootErr -Force -ErrorAction SilentlyContinue
    # Redirect so the console bootloader's FATALERROR and the selftest's stdout
    # are captured, then dumped into the job log — runw.exe keeps them invisible.
    $p = Start-Process -FilePath $SmokeExe -WorkingDirectory $PWD -PassThru `
        -RedirectStandardOutput $BootOut -RedirectStandardError $BootErr
    # Poll instead of a fixed wait: succeed the moment a verdict (or the
    # watchdog's post-boot timeout) appears, but allow the budget while the
    # boot heartbeat (or nothing yet) shows. Print a progress line every ~30s
    # so the log shows life.
    $deadline = (Get-Date).AddMinutes($SmokeBudgetMin)
    $ln = $null
    $progressAt = $null
    do {
        Start-Sleep -Seconds 5
        if (-not $ln -and (Test-Path $SmokeFile)) {
            try { $ln = (Get-Content -Raw $SmokeFile).Trim() } catch { $ln = $null }
        }
        if (($null -eq $ln) -and ($null -eq $progressAt -or (Get-Date) -ge $progressAt) -and -not $p.HasExited) {
            $msg = "still running, no verdict (budget $SmokeBudgetMin min)"
            if (Test-Path $SmokeFile) { $msg += " [heartbeat read]" }
            Write-Host "  $msg"
            $progressAt = (Get-Date).AddSeconds(30)
        }
        $pending = $null -eq $ln -or $ln -eq 'SELFTEST_BOOTING'
    } while (-not $p.HasExited -and (Get-Date) -lt $deadline -and $pending)

    if (-not $p.HasExited) {
        try { $p.Kill() } catch { }
    }
    if (-not $ln -or $ln -eq 'SELFTEST_BOOTING') {
        # A verdict written right at process exit can lose a race against a
        # stale heartbeat read; give the fsync'd file one last chance.
        Start-Sleep -Milliseconds 250
        try { $ln = (Get-Content -Raw $SmokeFile).Trim() } catch { $ln = $null }
    }
    $p.Refresh()
    Write-Host '--- bootloader stdout ---'
    Get-Content $BootOut -ErrorAction SilentlyContinue | ForEach-Object { Write-Host $_ }
    Write-Host '--- bootloader stderr ---'
    Get-Content $BootErr -ErrorAction SilentlyContinue | ForEach-Object { Write-Host $_ }
    return @($p, $ln)
}

$proc, $line = Invoke-SmokeRun

$exitNote = ''
if ($proc -and $proc.HasExited) {
    $exitNote = " (exit code $($proc.ExitCode))"
} elseif (-not $line) {
    $exitNote = ' (killed after the smoke budget)'
}
if (-not $line) {
    throw "selftest produced no verdict: Python never booted$exitNote"
}
if ($line -eq 'SELFTEST_BOOTING') {
    throw "selftest hung: Python booted but QtWebEngine never produced a verdict in $SmokeBudgetMin min$exitNote"
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
# Edi-selftest.exe is a CI diagnostic (console bootloader, not shipped); drop it
# so neither the zip nor the installer carries it.
Remove-Item (Join-Path $BundleDir 'Edi-selftest.exe') -Force
# The portable download: the bundle under a top-level Edi\ folder.
$Zip = Join-Path $PWD ("dist-app\Edi-$Version-win64.zip")
Remove-Item $Zip -Force -ErrorAction SilentlyContinue
Compress-Archive -Path $BundleDir -DestinationPath $Zip

Write-Host "==> Done: $BundleDir (bundle), $Zip"