# Edi

Markdown is becoming the modern format for writing text, diagrams, creating tables, and more.
However, while markdown is becoming an all-encompassing, modern version of office documents, the only existing editors are designed as if it's just a way to make some text look a little better.

Enter Edi. Edi is to be a modern, **exceedingly fast** markdown editor that lets you write up all of the amazing things that modern markdown has become, lets you compose diagrams in mermaid, and allows you to do in-line data processing on tables just like a mini-spreadsheet.

## Status

Implemented: a Python desktop app (PySide6 + QtWebEngine) with a CodeMirror 6 markdown editor and a live, resizable, toggleable preview that renders Mermaid diagrams, computes spreadsheet formulas in tables, runs `#!` code blocks, imports spreadsheets, copies tables to the clipboard, and exports the rendered document as a self-contained HTML file.

| Feature | Status |
| --- | --- |
| Fast, small-footprint editor (Python + QtWebEngine) | Done |
| Markdown editing with syntax highlighting | Done |
| Live preview as you type (debounced, resizable, toggleable) | Done |
| In-line Mermaid diagrams | Done |
| Open / Save / Save As / Revert | Done |
| Multiple documents in tabs | Done |
| Native menus (File / View) | Done |
| In-line spreadsheet capabilities | Done |
| Spreadsheet import (CSV / TSV / ODS / XLSX) | Done |
| Text-file and image insertion | Done |
| Formatting toolbar (bold, italic, headings, lists, links, …) | Done |
| Copy preview tables to the clipboard (Word / email / Excel) | Done |
| Executable code blocks (`#!` kernel syntax) | Done |
| HTML export | Done |

## Architecture

- **Frontend**: CodeMirror 6 + Mermaid + spreadsheet formulas in TypeScript, built with Vite into a single static `dist/`.
- **Backend**: Python 3 + PySide6 (QtWidgets / QtWebEngine). A native `QWebEngineView` hosts the frontend; the page talks to Python through `QWebChannel` (`backend/bridge.py`), which provides file dialogs, file IO, and code-block execution.
- **Distribution**: a portable single-file binary (`PyInstaller` onefile) built on Ubuntu 22.04 (glibc 2.35) so it runs on older desktop Linux too. Windows binaries are built on a hosted Windows runner; macOS has a manual build script (PyInstaller cannot cross-compile — both need their native OS).

## Features

### Spreadsheet tables

Any cell in a markdown table whose content starts with `=` is computed live in the preview:

```markdown
| Item | Q1 | Q2 | Total |
| --- | --- | --- | --- |
| Widget | 120 | 180 | =SUM(B2:C2) |
| Gadget | 90 | 110 | =B3+C3 |
| **Total** | =SUM(B2:B3) | =SUM(C2:C3) | =SUM(D2:D3) |
```

Supported: arithmetic (`+ - * / ^`), cell references (`B2`), ranges (`B2:C4`), and the functions `SUM`, `AVERAGE`/`AVG`, `MIN`, `MAX`, `COUNT`, `PRODUCT`, `ABS`, `SQRT`, `ROUND`. Errors surface in the cell as `#DIV/0!`, `#VALUE!`, `#REF!`, `#NAME?`, `#CYCLE!`, or `#ERROR!`.

### Executable code blocks

A code block gets a **Run** button in the preview when its shebang line is written in the fence info string:

````markdown
```#!sh
echo "Hello from a code block!"
```
````

or as the first line inside the block, exactly like a shell script:

````markdown
```
#!/usr/bin/env python3
print("Hello from Python!")
```
````

The shebang is interpreted like a shell's, so all of these forms work: `#!python3`, `#!/bin/bash -e`, `#!/usr/bin/python3`, `#!/usr/bin/env node`, and `#!node --harmony` (flags are passed through). Supported interpreters: `python`/`python3`/`py`, `sh`/`shell`, `bash`, `node`/`js`/`javascript`, `ruby`/`rb`, and `perl`/`pl`. Code runs locally with a 30-second timeout; stdout, stderr, and the exit code are shown in an output cell after the run. Each block owns its own result cell, and results are never shared — every **Run** executes fresh, and identical-looking blocks in different documents (or later runs of the same block) do not reuse each other's output, since a block may legitimately produce different results each time (random values, current time, changing files, etc.).

### Tabs

Open documents live in tabs (`Ctrl+N` for a new tab, `Ctrl+W` to close one). Each tab keeps its own undo history and scroll position. `File → Open` always opens the file in a new tab, and closing a tab with unsaved changes asks for confirmation first.

### Menus

Document actions live in a native menu bar instead of toolbar buttons:

- **File**: New, Open, Save, Save As, Revert (enabled once the document has a path), Export HTML, Quit.
- **Insert**: Spreadsheet, Text File, Image.
- **View**: Preview (toggle, default on), Formatting Toolbar (toggle, default on).

### Spreadsheet import

`Insert → Spreadsheet` reads a CSV, TSV, ODS, or XLSX file and inserts it at the cursor as a markdown table. Cell contents, shared strings, repeated rows/columns, and formula results are preserved.

### Text-file and image insertion

`Insert → Text File` reads any text file and inserts it at the cursor. `Insert → Image` picks an image and inserts a markdown image reference: relative to the document when the image lives inside its folder (so the document stays portable), otherwise absolute. The preview resolves relative image paths against the active document's directory so images always display.

### Formatting toolbar

The toolbar above the editor toggles markdown formatting on the selection: **bold**, *italic*, strikethrough, H1/H2, blockquote, inline code, fenced code blocks, task/bullet/numbered lists, horizontal rules, and links. `Ctrl+B` / `Ctrl+I` / `Ctrl+Shift+X` trigger bold, italic, and strikethrough. Hide it anytime via `View → Formatting Toolbar`.

### Copy tables

Every table in the preview has a **Copy** button. Pressing it puts both an HTML and a plain-text (tab-separated) version of the table on the clipboard, so it pastes correctly into Word documents, emails, and Excel spreadsheets.

### HTML export

`Ctrl+Shift+E` exports the currently rendered preview — including rendered Mermaid SVGs, computed spreadsheet values, and code block output — as a single self-contained HTML file with all styling inlined.

## Building from source

Requirements: Python 3.10+ (with `venv`), Node.js 20+, and a Linux desktop with X11/Wayland and OpenGL.

The easiest path is the dependency script (Ubuntu/Debian):

```sh
./scripts/install-deps.sh
```

This sets up the Python virtualenv (`.venv/`, including PySide6), installs npm dependencies, and generates the app icon.

### Development

Build the frontend, then run the Python shell:

```sh
npm run build
.venv/bin/python run_edi.py
```

### Portable single-file binary

`scripts/build-pyzip.sh` builds the frontend and bundles the app into a single
executable inside an Ubuntu 22.04 container (glibc 2.35), so the result also
runs on older desktop Linux systems. The host Node/Python versions do not
matter — everything is pinned inside Docker.

```sh
./scripts/build-pyzip.sh
```

Output: `./dist-app/edi` (smoke-tested offscreen before reporting success).

#### Desktop integration (icon in dock/taskbar)

On Linux (especially Wayland) the dock icon comes from a `.desktop` file, not
the window icon — running the bare binary alone can therefore show a generic
gear. Install the icon and desktop entry for the current user:

```sh
./scripts/install-desktop.sh [path/to/edi]   # defaults to ./dist-app/edi
```

This installs `edi.png` into `~/.local/share/icons/hicolor` and an
`edi.desktop` entry into `~/.local/share/applications` (respecting
`XDG_DATA_HOME`). Log out and back in if the gear persists.

### Linux packages (.deb / .rpm / .AppImage / .tar.gz)

Each `vX.Y.Z` release publishes four versioned artifacts (the CI `package` job
wraps the onefile binary — it never rebuilds it, so the glibc 2.35 portability
guarantee is inherited):

| Artifact | Format | Install |
| --- | --- | --- |
| `edi_X.Y.Z_amd64.deb` | Debian/Ubuntu | `sudo apt install ./edi_X.Y.Z_amd64.deb` |
| `edi-X.Y.Z-1.x86_64.rpm` | Fedora/RHEL/openSUSE | `sudo dnf install ./edi-X.Y.Z-1.x86_64.rpm` |
| `Edi-X.Y.Z-x86_64.AppImage` | self-contained desktop app | `chmod +x && ./Edi-X.Y.Z-x86_64.AppImage` |
| `edi-X.Y.Z-linux-x86_64.tar.gz` | portable archive | extract; run `./edi` or `./install.sh` |

The packages install the binary, the desktop entry, and the hicolor icon set
system-wide, so the dock/taskbar icon works out of the box (see above for the
bare-binary alternative).

Build all four from an existing binary locally:

```sh
./scripts/package-linux.sh [path/to/edi] [version]
```

Requires `dpkg-deb`, `rpmbuild` (`sudo apt-get install rpm`), and `curl`; the
tarball's `install.sh` and the .deb are also what `install-desktop.sh` covers
for the bare binary.

### Windows and macOS binaries

Windows and macOS bundles must be built on those OSes — PyInstaller cannot
cross-compile.

Each `vX.Y.Z` release also publishes the **Windows** onefile (built by the CI
`build-windows` job on a hosted Windows runner):

| Artifact | Format | Install |
| --- | --- | --- |
| `Edi-X.Y.Z-win64.exe` | portable onefile | run directly |

No Windows installer is shipped from CI (the `build-windows` job builds only
the onefile); an NSIS installer can be produced manually on a Windows desktop
with `packaging/edi.nsi` if one is wanted.

Build Windows binaries locally on a Windows box:

```sh
powershell -ExecutionPolicy Bypass -File scripts/build-windows.ps1 -Version 0.5.0
```

(Requires Node 20+ and Python 3.10+; missing toolchains are installed via
Chocolatey.)

**macOS** has no CI job — GitLab's hosted macOS runners are Premium/Ultimate-only.
`scripts/build-macos.sh` builds `Edi-X.Y.Z-macos-arm64.dmg` (drag-to-Applications;
Apple Silicon only) on any Mac; attach it to a release manually to publish it:

```sh
./scripts/build-macos.sh [x.y.z]   # version defaults to scripts/version.sh
```

The macOS app is ad-hoc code-signed (arm64 requires it) but not notarized (no
Apple Developer account in CI), so the first open on another Mac shows a
Gatekeeper warning — open via right-click → Open, or clear the quarantine flag:
`xattr -dr com.apple.quarantine Edi.app`.

## Checks and tests

```sh
npm run check          # typecheck + eslint + frontend unit tests
.venv/bin/pytest tests/   # backend tests (PySide6, offscreen)
npm run coverage       # frontend tests with coverage report
```

## Versioning

Manage the version tracked in `package.json`, `package-lock.json`, and `backend/__init__.py`:

```sh
./scripts/version.sh current   # print the current version
./scripts/version.sh set 0.2.0 # set an explicit version
./scripts/version.sh bump patch   # or minor / major to auto-increment
./scripts/version.sh check     # verify all declarations agree
./scripts/version.sh tag       # create annotated git tag v<current-version>
```

`set`/`bump` update all three files and print the git commands to commit and push; pushing the `vX.Y.Z` tag triggers the GitLab CI `release` job.

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl+N` | New tab |
| `Ctrl+W` | Close tab |
| `Ctrl+O` | Open file (in a new tab) |
| `Ctrl+S` | Save |
| `Ctrl+Shift+S` | Save As |
| `Ctrl+Shift+P` | Toggle preview |
| `Ctrl+Shift+E` | Export preview as HTML |
| `Ctrl+Q` | Quit |

## Development process

1. All features are thoroughly tested using automated tests (Vitest for the frontend, `pytest` for the backend).
2. Code is checked for duplication and poor quality using free, open static code analysis tools (ESLint and `tsc`).
3. Versioning and tagging automatically results in releases being created by the GitLab CI pipeline (using the new `glab` tools, not the deprecated `release-cli`). See `.gitlab-ci.yml`; the `release` job authenticates with the built-in `CI_JOB_TOKEN` via glab CI auto-login (no `GITLAB_TOKEN` variable needed) and requires the project setting "Allow CI job token to create releases".
4. All unnecessary files are `.gitignore`d.
5. All files necessary for building the project can be installed via a simple script (`scripts/install-deps.sh`) so that a new developer or user can easily build the project from source.
6. Linting is part of the standard checks.
7. Coverage metrics are available as part of the build and check process (`npm run coverage` and the `test` CI job).

## License

Edi is GPLv3 (or later) licensed.
