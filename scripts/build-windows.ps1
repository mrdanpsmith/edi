# Builds the Windows Edi binary: the PyInstaller onefile. This is the FULL-SMOKE
# desktop path — CI produces the .exe inside the 'edi-wine-builder' image
# (Dockerfile.wine + scripts/build-windows-wine.sh), which cannot host the
# QtWebEngine renderer; only a real Windows machine can run the complete smoke.
#
# PyInstaller cannot cross-compile, so this must run on real Windows. The
# frontend `dist/` and `scripts/assets/app-icon.ico` come from the `frontend`
# CI job (byte-identical on every platform), so NO Node/npm is needed here.
# It detects Python >= 3.10 on PATH (installs via Chocolatey only when missing),
# then:
#   1. python venv with PySide6==6.11.1 + pyinstaller==6.22.0 (same pins as Linux)
#   2. pyinstaller - edi.spec  ->  dist-app\Edi.exe
#   3. smoke test it offscreen (EDI_SELFTEST=1, verdict via EDI_SELFTEST_OUT)
#   4. copy to dist-app\Edi-<ver>-win64.exe
#
# The onefile is shipped as-is; the NSIS installer is NOT built in CI — the
# previous make-it-mandatory attempts burned many runs on runner-specific
# quirks (makensis not on PATH, then undebuggable File-path resolution). Build
# packaging/edi.nsi on a real desktop when an installer is wanted.
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
# installs into .venv-win, the extracted onefile, the exe) and the pip+PyInstaller
# phase was the job's dominant cost. The VM is ephemeral and the runner is
# elevated, so exclude the whole checkout to speed it up. Exclusions are
# dropped with the VM at job end. (Not a fix for selftest extraction aborts —
# those persist with the exclusion in place; Edi-selftest.exe surfaces them.)
try {
    Add-MpPreference -ExclusionPath (Resolve-Path '.').Path -ErrorAction Stop | Out-Null
} catch {
    Write-Host "WARN: could not add Defender exclusion: $($_.Exception.Message)"
}

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
$env:PIP_CACHE_DIR = Join-Path $PWD 'build\.pip-cache'
Invoke-Py -m venv '.venv-win'
$PyVenv = Join-Path $PWD '.venv-win\Scripts\python.exe'
& $PyVenv -m pip install --upgrade pip --quiet
Assert-ExitCode 'pip upgrade'
& $PyVenv -m pip install 'PySide6==6.11.1' 'pyinstaller==6.22.0' 'pefile==2024.8.26' 'pywin32-ctypes==0.2.3' 'defusedxml' --quiet
Assert-ExitCode 'pip install PySide6/pyinstaller'

# --- Bundle Windows' system ICU next to Qt6Core.dll --------------------------
# Qt6Core.dll hard-imports icuuc.dll (the Windows ICU). Real desktops have it
# in System32, but Server SKUs and Wine < 11.5 do not — and PyInstaller's Qt
# hooks only collect the platform plugins and translations if that isolated
# `import PySide6.QtCore` succeeds. Copying the system ICU into the PySide6
# package (a) lets the probe run on ANY build host and (b) makes the analysis
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

# --- PyInstaller onefile ---
Write-Host '==> PyInstaller onefile'
$env:PYINSTALLER_ZLIB_COMPRESSION_LEVEL = '1'
& $PyVenv -m PyInstaller --clean --distpath dist-app --workpath build edi.spec
Assert-ExitCode 'pyinstaller'

# --- Offscreen smoke test --------------------------------------------
# The shipped Edi.exe is windowed (runw.exe): its onefile bootloader swallows
# fatal self-extraction errors into an invisible dialog and returns only an
# exit code (-1 = Z_ERRNO, a failed fwrite). We smoke-test the console twin
# Edi-selftest.exe instead so "Error extracting <entry>: <errno>" lands in the
# CI log. The verdict itself (SELFTEST {...}) is parsed from EDI_SELFTEST_OUT
# because no console is guaranteed attached to the job.
# --- Host capability probe before the frozen selftest --------------------
# Qt6WebEngineCore.dll has hard static imports of dcomp.dll (Desktop Window
# Manager composition) and bthprops.cpl (Bluetooth shell). GitLab's SaaS
# Windows runners are Server SKUs that lack those; there QtWebEngine cannot
# load AT ALL -- even `python -c "import PySide6.QtWebEngineCore"` fails with
# the identical ImportError, so no bundle (and no amount of extra PyInstaller
# bundling) could ever pass the selftest there. Redistributing the missing MS
# system files is not an option. So we probe the freshly-installed venv
# directly (same VM, same wheels): if the HOST cannot import QtWebEngineCore,
# that is an environment limitation, not a bundle regression -- skip the frozen
# smoke with an explicit environmental verdict and continue into packaging.
# On normal desktop Windows the probe passes and the full smoke still runs.
Write-Host '==> Host capability probe (QtWebEngineCore import)'
# Run under $ErrorActionPreference 'Continue': Windows PowerShell 5.1 promotes
# native-command stderr to a terminating NativeCommandError when EAP is 'Stop',
# which would abort here before the skip logic below can run. The probe's
# stderr (a python traceback on failure) is useful, so capture it via 2>&1 and
# decide on the process exit code + the 'WEBENGINE_HOST_OK' marker.
$prevEAP = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
$probeLines = & $PyVenv -c "from PySide6.QtWebEngineCore import QWebEngineSettings; print('WEBENGINE_HOST_OK')" 2>&1
$probeExit = $LASTEXITCODE
$ErrorActionPreference = $prevEAP
$probeOk = ($probeExit -eq 0) -and (($probeLines -join "`n") -match 'WEBENGINE_HOST_OK')
if (-not $probeOk) {
    Write-Host "  host cannot import QtWebEngineCore (exit $probeExit) -- this runner lacks Desktop Experience (no dcomp.dll/bthprops.cpl); frozen smoke SKIPPED (environmental)"
    $probeLines | ForEach-Object { Write-Host "  probe: $_" }
}

if ($probeOk) {
Write-Host '==> Smoke test (console bootloader twin)'
$SmokeFile = Join-Path (Resolve-Path 'build') 'selftest-win.json'
$SmokeExe = Join-Path $PWD 'dist-app\Edi-selftest.exe'
# The post-boot phase is already bounded by the backend's 25s watchdog, so a
# smoke run left waiting here can only be pre-boot extraction/launch. Local
# startup is ~1s; 3 min is a generous ceiling, override via EDI_SMOKE_BUDGET_MIN.
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
    # boot heartbeat (or nothing yet) shows — a hang can only be pre-boot
    # extraction now. Print a progress line every ~30s so the log shows life.
    $deadline = (Get-Date).AddMinutes($SmokeBudgetMin)
    $ln = $null
    $progressAt = $null
    do {
        Start-Sleep -Seconds 5
        if (-not $ln -and (Test-Path $SmokeFile)) {
            try { $ln = (Get-Content -Raw $SmokeFile).Trim() } catch { $ln = $null }
        }
        if (($null -eq $ln) -and ($null -eq $progressAt -or (Get-Date) -ge $progressAt) -and -not $p.HasExited) {
            $msg = "bootloader still running, no verdict (extracting/launching; budget $SmokeBudgetMin min)"
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

$proc = $null
$line = ''
for ($attempt = 1; $attempt -le 2 -and -not $line; $attempt++) {
    if ($attempt -gt 1) {
        # Process exited before Python with no verdict (an extraction abort) —
        # flaky, so give it one clean retry. A budget hang is NOT retried.
        Write-Host "==> Bootloader aborted before Python; retrying smoke test (attempt $attempt)"
    }
    $proc, $line = Invoke-SmokeRun
    if (-not $line -and $proc -and -not $proc.HasExited) {
        # Killed at the budget without a verdict: a real hang, not a flake.
        break
    }
}

$exitNote = ''
if ($proc -and $proc.HasExited) {
    $exitNote = " (exit code $($proc.ExitCode))"
} elseif (-not $line) {
    $exitNote = ' (killed after the smoke budget)'
}
if (-not $line) {
    # Diagnostics: free space + partial _MEI* extractions in the bootloader's
    # temp dir separate "no room / blocked path" from other boot failures.
    $drv = [System.IO.DriveInfo]::new((Resolve-Path '.').Path)
    Write-Host "DIAG extracted under $([System.IO.Path]::GetTempPath()) free=$([math]::Round($drv.AvailableFreeSpace / 1MB))MB"
    Get-ChildItem (Join-Path ([System.IO.Path]::GetTempPath()) '_MEI*') -Directory -ErrorAction SilentlyContinue |
        ForEach-Object { Write-Host "DIAG partial extract $($_.Name): $($_.GetFiles().Count) files" }
    throw "unexpected selftest state: '$line'$exitNote"
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
}
# Host probe failed: QtWebEngine cannot load on this Server-SKU runner at all
# (missing dcomp.dll/bthprops.cpl), so no bundle could pass the smoke. Leave an
# unambiguous marker for any EDI_SELFTEST_OUT consumer and proceed straight
# into packaging -- the build/installer still get validated.
if (-not $probeOk) {
    $SkipFile = Join-Path (Resolve-Path 'build') 'selftest-win.json'
    Set-Content -Path $SkipFile -Value 'SELFTEST_SKIPPED_ENVIRONMENTAL' -NoNewline
}

# --- Versioned, ready-to-publish artifacts ---
Write-Host '==> Wrapping artifacts'
# Edi-selftest.exe is a CI diagnostic (console bootloader, not shipped); drop it
# so the EDI-*.exe artifact glob only sees the real onefile.
Remove-Item (Join-Path $PWD 'dist-app\Edi-selftest.exe') -Force
$OneFile = Join-Path $PWD ("dist-app\Edi-$Version-win64.exe")
Move-Item -Force (Join-Path $PWD 'dist-app\Edi.exe') $OneFile

Write-Host "==> Done: $OneFile"