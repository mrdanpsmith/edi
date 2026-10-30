# Distribution and packaging

## Hard constraints

### Linux portability

The shipped Linux binary **must be built on Ubuntu 22.04 (glibc 2.35)** so it
runs on older desktop distributions. `scripts/build-pyzip.sh` pins the build
inside Docker for this reason. A host-built binary is not portable and must not
be shipped.

### Never bundle host graphics libraries

`edi.spec` filters out `libstdc++.so.6` and `libgbm.so.1` (`GL_HOST_DEPS`).
Bundling the Ubuntu 22.04 copies breaks newer hosts:

- `libstdc++` crashes with `GLIBCXX_3.4.32 not found`;
- `libgbm` (Mesa's buffer manager) makes QtWebEngine's GPU process print
  `did not find extension DRI_Mesa version 1` / `EGL: Failed to initialize GBM
  device`, then fall back to software rendering on any host whose Mesa is newer
  than 22.04's.

### Qt bundle pruning

Edi uses only the QtWebEngine *widgets* API. `edi.spec` sets
`excludes=['PySide6.QtQml', 'PySide6.QtQuick']` so `hook-PySide6.QtQml` does
not fire. Without the exclude, PyInstaller drags in the whole `qml/` tree
(about 4,850 plugin files) and every Qt library those plugins reference
(Qt3D, QtQuick3D, QtCharts, QtGraphs, QtVirtualKeyboard, ...).

The `libQt6Qml`/`libQt6Quick` shared libraries that WebEngineCore really links
against are still collected by binary dependency analysis. That is why the
exclude is safe.

`QT_DEAD_PREFIXES` additionally removes the on-screen-virtual-keyboard
input-context plugin and its libraries. Match both the `PySide6/Qt/lib/...`
dest and the top-level `libQt6...` soname-form entries PyInstaller emits.
Verify with:

```sh
rg -c 'libQt6' build/edi/PKG-00.toc   # expect about 100, not 468
```

and with the smoke test.

### Onedir on every platform

Every platform ships a PyInstaller **onedir** bundle: the executable plus an
`_internal/` directory beside it. Never switch a platform back to onefile.

A onefile unpacks the whole ~430 MB bundle into a fresh temp directory on
every launch, and the OS then re-checks the new files at their new path, so
nothing is ever cached: macOS re-validates the dylibs and Windows Defender
scans the DLLs. Measured before any Python ran: 8–12 s on macOS, ~1.3 s on
Linux (against ~0.15 s onedir). On a RAM-backed `/tmp` each running instance
also held its own copy.

| Platform | Build output | Shipped as |
| --- | --- | --- |
| Linux | `dist-app/edi/` (`edi`) | `.deb`/`.rpm`/`.tar.gz`/AppImage, see [Linux packaging](#linux-packaging) |
| Windows | `dist-app/Edi/` (`Edi.exe`) | NSIS installer and a portable `.zip` |
| macOS | `dist-app/Edi.app` | `.dmg` and the curl installer's `.zip` |

With no archive inside the executable there is nothing to compress, so no
build sets `PYINSTALLER_ZLIB_COMPRESSION_LEVEL` any more.

### One JS bundle, no runtime imports

The frontend must be a **single** JS bundle. The app ships to QtWebEngine as
`dist/index.html` under `file://`, and QtWebEngine intermittently fails runtime
dynamic module fetches under load:

```text
Uncaught (in promise) TypeError: Failed to fetch dynamically imported module
```

That was the root cause of the historically flaky
`tests/test_mermaid_templates.py` (mermaid's split `mermaid.core.js` chunk) and
can reach users as "Mermaid render error".

`vite.config.ts` therefore sets
`build.rolldownOptions.output.codeSplitting: false`: one minified bundle of
about 5.4 MB, no async chunks. The remaining `import(` in the minified output
is ESLint-mode regex text or an `import.meta.resolve` feature-detect, not a
runtime module fetch.

Do not re-enable code splitting for perceived performance. The depot is local
disk, and the lazy loading it buys has cost intermittent renderer errors.

### Icons

`scripts/generate-icon.mjs` produces the single source artwork,
`scripts/assets/app-icon.png`, which `edi.spec` bundles. It also generates
`app-icon.ico` (16–256, for the Windows EXE resource and installer) and
`app-icon.icns` (16–1024, for the macOS bundle). Both are gitignored build
artifacts regenerated before each native PyInstaller run.

`backend/window.py`'s `load_app_icon()` guards `sys._MEIPASS` so the same code
works in a source run and a frozen build. Keep that guard. The About dialog
reuses the same artwork through `load_about_logo()`. Do not reintroduce a
separate logo file.

## Build commands

```sh
./scripts/build-pyzip.sh                  # Linux onedir -> dist-app/edi/ (run dist-app/edi/edi)
./scripts/package-linux.sh [bundle] [ver] # .deb / .rpm / .tar.gz / .AppImage

pwsh -File scripts/build-windows.ps1 -Version <ver>  # on Windows
./scripts/build-macos.sh [x.y.z]                     # on macOS
```

PyInstaller cannot cross-compile. Windows is built natively on a Windows
2025 GitHub runner; macOS must be built on macOS. The Linux build runs inside
the Ubuntu 22.04 container.

## PyInstaller specification

`edi.spec` shares one `Analysis` (the datas and the QtQml/QtQuick excludes
are platform-independent) and one onedir `EXE` + `COLLECT` across platforms.
The per-platform branches only adjust the inputs:

- **Linux** applies `GL_HOST_DEPS` and `QT_DEAD_PREFIXES` and keeps the
  lowercase `edi` executable name.
- **Windows** adds the WebEngine companion DLLs and ICU (see below), names the
  executable `Edi`, attaches `app-icon.ico` and a `VSVersionInfo` whose
  version is parsed from `backend/__init__.py` at spec time so it cannot
  drift from the tag, and adds the console twin to the same `COLLECT`.
- **macOS** wraps the collected folder in `BUNDLE`: `Edi.app` with an
  Info.plist declaring the icon,
  `bundle_identifier=com.mrdanpsmith.edi`, `CFBundleDocumentTypes` (Markdown
  `Default`, plain text `Alternate`) and an imported
  `net.daringfireball.markdown` UTI.

File association on macOS is a build fact, not an installed-app patch.
`scripts/build-macos.sh` asserts the Markdown document type is in the signed
bundle's Info.plist before shipping. See [macos-installer.md](macos-installer.md)
for the installer and association behaviour.

## Windows build

`scripts/build-windows.ps1` is **the** Windows build. CI's `build-windows` job
runs it on a GitHub-hosted `windows-2025` runner; the same script works on a
desktop Windows machine. It requires `dist/index.html` and
`scripts/assets/app-icon.ico` first.

The script:

1. creates a venv and installs `requirements-build.txt` (runtime, PyInstaller
   and the marker-gated Windows wheels);
2. probes that `QtWebEngineCore` can be imported;
3. builds the bundle `dist-app/Edi/` holding the windowed `Edi.exe`, a console
   twin `Edi-selftest.exe` and the shared `_internal\`;
4. runs the frozen smoke test of the console twin;
5. deletes the twin and zips the bundle to `dist-app/Edi-<v>-win64.zip`.

The CI job then runs the structural bundle check on `dist-app/Edi` and builds
`dist-app/Edi-<v>-win64-setup.exe` (the NSIS installer) from the same folder.
The zip is the portable download: extract it and run `Edi\Edi.exe`.

### Why the console twin exists

The shipped `Edi.exe` uses `runw.exe`/`console=False`. A fatal startup error
therefore becomes a modal dialog nobody can see, and the job hangs until the
smoke budget runs out. The console twin is a second small launcher in the
same `COLLECT`, sharing `_internal\`, and lets
`Start-Process -RedirectStandardOutput/-RedirectStandardError` capture the
real error in the job log.

The twin is deleted from the bundle before it is zipped or packaged, so
neither the zip nor the installer carries it.

The verdict is parsed from `EDI_SELFTEST_OUT` because no console is attached to
the job. `EDI_SELFTEST_BOOTING` is a heartbeat, so a hang can be distinguished
from a slow boot. A host that cannot import `QtWebEngineCore` fails the build;
the smoke is never skipped. GitHub's `windows-2025` runner (Server 2025 with
Desktop Experience) runs it in full.

### The DLL and ICU history

This is why the Windows bundle looks the way it does. Do not undo these steps
without reproducing the checks.

On GitLab's former Server-SKU `saas-windows-medium-amd64` runners, the bundled
app failed with:

```text
ImportError: DLL load failed while importing QtWebEngineCore:
The specified module could not be found.
```

All 20 Qt6 DLLs, including every WebEngineCore companion and
`Qt6WebEngineCore.dll`, were present in the bundle. The load still failed
because `Qt6WebEngineCore.dll` has hard static imports of `dcomp.dll` (DWM
compositor) and `bthprops.cpl` (Bluetooth shell), which Server-SKU runners do
not have. This was proven by parsing the win_amd64 wheel's import table with
`pefile`; normal Windows 10/11 desktops do have both.

That was necessary but not sufficient. PyInstaller's Qt hooks discover the Qt
install by importing `PySide6.QtCore` in an isolated subprocess, and that probe
fails when `Qt6Core.dll` cannot resolve its hard-imported ICU DLLs. The
win_amd64 wheels carry only `resources/icudtl.dat`; `icuuc.dll` and `icuin.dll`
are Windows system DLLs. The native Windows build therefore stages System32's
copies into `site-packages/PySide6/` so the hook probe succeeds and the plugins
are collected canonically. `edi.spec`'s win32 branch force-appends those ICU
DLLs to the bundle (deduped, like the WebEngine companions) so the executable
is self-contained even on a Windows install without ICU.

The build probes that the venv's `QtWebEngineCore` import works **before** the
frozen smoke. If that probe fails, the build fails with the probe's traceback
in the log, so the error names the host rather than the bundle. It used to
skip the smoke as environmental (for GitLab's Server Core runners); that let a
runner image change switch the gate off silently, so it was removed.

The probe must run under `$ErrorActionPreference='Continue'` with `2>&1`
capture, then restore EAP. Windows PowerShell 5.1 promotes native-command
stderr to a terminating `NativeCommandError` when EAP is `Stop`, which aborts
the job before the probe's traceback can be printed.

`edi.spec`'s win32 branch also explicitly appends the WebEngine companion set
(`Qt6WebEngineCore`, `Qt6WebEngineWidgets`, `Qt6Qml`, `Qt6Quick`,
`Qt6QuickWidgets`, `Qt6QmlModels`, `Qt6QmlWorkerscript`, `Qt6Positioning`,
`Qt6WebChannel`, `Qt6Network`, `Qt6PrintSupport`) to `a.binaries` as
`(dest, src, 'BINARY')`, deduped against destinations already collected.

`_internal\` holds no Qt DLLs at its top level: they sit in its `PySide6/`
subdirectory. System and Python DLLs sit at the top of `_internal\`. The msvcp140 family is
never collected because PyInstaller excludes everything resolved under
`C:\Windows`, which is fine because System32's copy loads.

`run_edi.py` dumps the bundle inventory and, on import failure, a PE
import-table lint of the failing Qt module under `EDI_SELFTEST`:

```text
[selftest] OK <name> -> bundle|System32
MISSING <name>
```

### NSIS installer

The NSIS installer is built by the same Windows job with native Windows
`makensis` (`choco install nsis`). `makensis` resolves relative
`File`/`OutFile` paths against the **script's** directory, not the current
working directory. The build therefore passes `-DBUNDLE` (the `dist-app/Edi`
folder), `-DICO` and `-DOUTEXE` as **absolute** paths. `edi.nsi` exposes an
optional `OUTEXE` define so the output lands in the checkout root, not
`packaging/`. `packaging/edi.nsi` stays desktop-compatible.

The installer copies `Edi.exe` and `_internal\` into `%ProgramFiles%\Edi`.
It removes any existing `_internal\` first, so an upgrade never leaves the
previous version's libraries beside the new ones; installing over a
pre-onedir release just overwrites its single `Edi.exe`. The uninstaller
removes exactly `Edi.exe`, `_internal\`, the icon and itself, never the
whole install directory, which the user may have chosen.

## Structural bundle check

`scripts/check_bundle_contents.py` is the load-bearing regression gate. It
asserts that `qwindows.dll`, `qoffscreen.dll`, `qjpeg.dll`, `icuuc.dll` and
`icuin.dll` are all in the bundle's `_internal\`. It only lists files (pure
standard library), so it runs with no render, X display or GPU.

This catches the pluginless-bundle defect: the Qt hooks stop collecting,
PyInstaller still reports success and still produces a bundle, and the only
symptom is a crash on a machine that lacks the DLLs.

It has to be separate from the smoke because the smoke runs offscreen and never
loads `qwindows.dll`, the platform plugin users actually get. The native
Windows job calls this same file as its structural gate.

## macOS build

`scripts/build-macos.sh` is Darwin-only. It builds with the newest Python on
`PATH` that the PySide6 pin has wheels for (3.10–3.14 for 6.11.x; the bound is
in the script) rather than whatever `python3` the runner image defaults to,
and brew-installs Python 3.12 if there is none. Widen that bound when the
PySide6 pin moves. It mirrors the Linux steps into `dist-app/Edi.app`, ad-hoc code-signs
the bundle (`codesign --force --deep -s -`; arm64 will not launch unsigned),
asserts the Markdown document type is in the sealed Info.plist, smoke-tests
a throwaway copy of the bundle (the verdict comes from `EDI_SELFTEST_OUT`; the
captured app log and verdict are printed when it fails), re-verifies the
signature, then produces:

- `dist-app/Edi-<ver>-macos-arm64.dmg` with an `Applications` symlink;
- `dist-app/Edi-<ver>-arm64.zip` and `.sha256`.

The `.app` is the onedir `COLLECT` wrapped by `BUNDLE` (see
[Onedir on every platform](#onedir-on-every-platform)).

The smoke test must not run the shipped bundle. With the sandbox disabled
(`QTWEBENGINE_DISABLE_SANDBOX=1`, which the selftest sets) QtWebEngine creates
an empty `QtWebEngineCore.framework/Versions/Resources` inside the bundle,
and that fails the `codesign --verify --deep --strict` in `install.sh`.
Normal launches leave the bundle alone.

The zip is made with `ditto -c -k --sequesterRsrc --keepParent`, never
`zip -r`, which can break the signature.

Apple Silicon only. The app is ad-hoc signed but not notarized (there is no
Apple Developer account), so a browser-downloaded `.dmg` warns on first open.
That is an accepted, documented tradeoff; do not add signing stubs that imply
Developer-ID signing works.

The CI macOS job consumes the `edi-web` artifact like the Linux and Windows
jobs and **asserts** `dist/index.html` and both generated icon variants rather
than building them. There is deliberately no rebuild fallback: a script that
regenerates what it was told to consume turns a broken artifact download into
a green build of something else. The frontend and icons are built once, in the
`frontend` job.

## Linux packaging

`scripts/package-linux.sh` wraps the already-built onedir bundle
(`dist-app/edi/`: the `edi` executable plus `_internal/`). It never
recompiles, so it inherits the glibc 2.35 build. It needs `dpkg-deb`,
`rpmbuild` and `curl`.

It produces:

- `edi_<v>_amd64.deb` and `edi-<v>-1.x86_64.rpm`: the bundle at
  `/usr/lib/edi`, with `/usr/bin/edi` a relative symlink to
  `/usr/lib/edi/edi`. The bootloader resolves the symlink to find
  `_internal/`, so the link must stay a symlink, never a copy.
- `edi-<v>-linux-x86_64.tar.gz`: the bundle at the archive root, so the
  extracted `edi` executable runs in place. Its `install.sh` copies the bundle to `~/.local/lib/edi`
  (replacing only a directory that holds an Edi bundle) and links
  `$XDG_DATA_HOME/bin/edi` to it, replacing an older single-file install.
- `Edi-<v>-x86_64.AppImage`: the bundle at `usr/lib/edi` in the AppDir;
  `packaging/AppDir/AppRun` executes it.

The bundle is a few hundred files, and modes and symlinks matter, so CI moves
it between jobs as `edi-linux.tar` (see [ci.md](ci.md)).

Runtime dependency names differ between Debian and RPM and live in
`scripts/package-linux.sh` as `DEB_DEPENDS` and `RPM_REQUIRES`. Examples:
`libnss3` → `nss`, `libasound2` → `alsa-lib`, `libpulse0` → `pulseaudio-libs`,
`libgssapi-krb5-2` merges into `krb5-libs`.

The `.deb` is validated on a clean `ubuntu:22.04` container: apt resolves the
dependencies and `EDI_SELFTEST=1` runs. A full `.rpm` dependency-resolution
test needs a Fedora/Rocky host; the development sandbox cannot reach
`mirrors.fedoraproject.org`.

`packaging/edi.spec.in` sets `%global _debug_package 0` so rpmbuild's
find-debuginfo does not choke on the prebuilt binary, and disables
`__os_install_post` (no stripping or other post-processing of the bundle).
It also sets `AutoReqProv: no`: automatic requires would turn every bundled
Qt/PySide6 soname into a dependency no repository provides, so `RPM_REQUIRES`
is the whole dependency list. `rpmbuild` needs
`--define "_dbpath <dir>"` when building as a non-root user.

`packaging/control.in` forces `dpkg-deb -Zxz` output so old apt can read it.
The hicolor icon set (16–512) is scaled from the 1024 source with a PySide6
`QImage` snippet, which needs no QApplication.

The AppImage uses `appimagetool` pinned to `1.9.1` (falling back to
`continuous`) with `APPIMAGE_EXTRACT_AND_RUN=1` because CI has no FUSE. It
runs from the stage directory so the output lands there. Its squashfs zstd
level is lowered to 1 with `--mksquashfs-opt -Xcompression-level 1`;
mksquashfs's default level 15 is slow on the ~430 MB payload for a few percent
less size.

`rpm` and `file` are baked into the builder image because appimagetool and
rpm's brp scripts need them.

## Linux desktop icon

The dock/taskbar icon comes from a `.desktop` file, not the window icon, so a
bare binary shows a generic gear without one. `scripts/install-desktop.sh`
installs:

- `~/.local/share/icons/hicolor/512x512/apps/edi.png`
- `~/.local/share/applications/edi.desktop` (from
  `scripts/assets/edi.desktop`, with `Exec` substituted)

`app.setDesktopFileName("edi")` in `backend/main.py` hints the window manager to
match it.

## Version pins

Python pins live in exactly three files:

- `requirements.txt` — runtime dependencies of the application;
- `requirements-dev.txt` — pytest, coverage, bandit, pip-audit and pyright
  (it starts with `-r requirements.txt`);
- `requirements-build.txt` — PyInstaller plus the Windows-only wheels, marked
  with `sys_platform == "win32"` so Linux and macOS skip them (it also starts
  with `-r requirements.txt`).

Keep PySide6 pinned; Qt releases break the WebEngine hooks. The Dockerfiles
and platform build scripts install these files instead of repeating versions,
and `./scripts/version.sh check` fails if a PySide6 or PyInstaller pin appears
outside `requirements*.txt`.

`backend/tables.py` parses ODS/XLSX XML with **`defusedxml`** as a drop-in for
`xml.etree.ElementTree`. Plain ElementTree is XML-bomb vulnerable on
user-opened files, and bandit flags it. For the same reason, everything a file
can use to make the importer allocate is capped: ODS repeat counts and space
runs at 1000, and XLSX cell positions at 1000 columns and 10000 rows. `defusedxml` is a runtime import, so
every PyInstaller build venv gets it through `requirements-build.txt`:
`Dockerfile.pyzip`, `scripts/build-windows.ps1` and
`scripts/build-macos.sh` all install that file.
