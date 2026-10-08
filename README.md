# Edi

[![CI](https://github.com/mrdanpsmith/edi/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/mrdanpsmith/edi/actions/workflows/ci.yml)
[![TypeScript coverage](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Fmrdanpsmith%2Fedi%2Fbadges%2Fcoverage-ts.json)](https://github.com/mrdanpsmith/edi/actions/workflows/ci.yml)
[![Python coverage](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Fmrdanpsmith%2Fedi%2Fbadges%2Fcoverage-py.json)](https://github.com/mrdanpsmith/edi/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/mrdanpsmith/edi)](https://github.com/mrdanpsmith/edi/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/mrdanpsmith/edi/total)](https://github.com/mrdanpsmith/edi/releases)
[![License GPL-3.0-or-later](https://img.shields.io/badge/license-GPL--3.0--or--later-blue)](./LICENSE)
[![Platforms](https://img.shields.io/badge/platforms-Linux%20%7C%20Windows%20%7C%20macOS-lightgrey)](#installing-a-release)
[![Runtime](https://img.shields.io/badge/runtime-Python%203.10%2B%20%C2%B7%20Node%2020.19%2B-blue)](#building-from-source)

Markdown has grown into a format for writing text, drawing diagrams and holding
tables — but the editors for it still treat it as a way to make some words look
a little nicer.

Edi is a fast native desktop markdown editor that takes that further. The
document stays plain markdown (that is still the source of truth), while the
live preview turns three block types into real tools: tables become a
spreadsheet that computes as you type, Mermaid diagrams are edited by clicking
the labels *in* the picture, and fenced code blocks can be run from the document
and show their output next to themselves.

Available for Linux, Windows and macOS.

## Contents

- [Features](#features)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Installing a release](#installing-a-release)
- [Upgrading](#upgrading)
- [Building from source](#building-from-source)
- [Packaging](#packaging)
- [Checks and tests](#checks-and-tests)
- [Versioning](#versioning)
- [License](#license)

## Features

**Everything in the app is documented in-app**: `Help → Edi Guide…` is the
tour, and `Help → Formula Reference…` lists every spreadsheet function with a
signature and an example. This section is the short version.

### Live markdown editing

- The preview renders as you write, and every block carries one row of controls
  at its right edge: **Source** shows that block's markdown and **Visual** brings
  the rendering back, so the rendered document and the markdown behind it are
  never more than a hover apart. `Ctrl+Shift+E` does the same for the block the
  caret is in.
- `Alt+click` a diagram to edit it in place — labels, cards and columns — or a
  table to swap it between plain text and a spreadsheet; `Esc` leaves whatever
  is open.
- Click a link to open it, right-click one to edit its address — clearing the
  address leaves the text behind, unlinked. A link whose text and destination
  disagree is underlined, and opening it asks first.
- A home screen opens on launch with new/open/recent documents, and a light and
  dark appearance that follows the system.
- Documents open in tabs, each with its own undo history and scroll position.

### Spreadsheet tables

A markdown table renders as a grid you can actually work in — click and drag to
select cells, add or remove rows and columns, paste TSV from a spreadsheet.
Any cell starting with `=` is computed live, with a formula bar that autocompletes
function names:

```markdown
| Item | Q1 | Q2 | Total |
| --- | --- | --- | --- |
| Widget | 120 | 180 | =SUM(B2:C2) |
| Gadget | 90 | 110 | =B3+C3 |
| **Total** | =SUM(B2:B3) | =SUM(C2:C3) | =SUM(D2:D3) |
```

- Built-in functions span aggregates, math, logic, text, date/time, lookups
  (`VLOOKUP`, `XLOOKUP`, `INDEX`/`MATCH`, …) and utilities — every one of them
  listed with a signature and an example by `Help → Formula Reference…`.
- **Use values** freezes the selected cells to their computed results (handy for
  volatile ones like `RAND` or `UUID`), and **Resolve formulas?** does the same
  for the whole table, keeping the formulas in a comment for when it reopens.
- Your own functions live in the document, in a fenced block tagged
  `edi-formula` — one `NAME(params) = expression` per line, callable like any
  built-in.

### Mermaid you edit in place

Fenced blocks tagged `mermaid` render as diagrams you can edit without touching
the source: press **Edit** on the diagram, double-click it, or right-click →
**Edit diagram**, then click a label to retype it. Renaming a name the diagram
uses in more than one place (an ER entity, a state, a class, a git branch, a
requirement…) renames the references with it.

**Kanban boards** are the one diagram you build from the board itself: every
column is drawn with an empty **+ Add a card**, and an empty **+ Add a column**
stands at the right where the next one goes. Cards and whole columns are
dragged with a drop line marking the exact slot, and a **✕** / **⋯** on a card
or column deletes it (after asking, naming what goes with it) — one edit, so
undo brings the whole thing back.

Only labels that can genuinely be rewritten are clickable: a value Mermaid
computed rather than read (a treemap total, an axis tick, a bit range) stays
put. A diagram that stops parsing keeps its last good rendering with a short
note, so a half-typed label never leaves a blank block behind.

### Runnable code blocks

A code block with a shebang line — in the fence info or as its first line —
gets a **Run** button, and its output, stderr and exit code land in a result
cell under it (**Stop** cancels a hung run, and a run is killed after 30
seconds). `#!python3`, `#!/bin/bash -e`, `#!/usr/bin/env node`, … all work, with
the same shell-style argument parsing.

### Encrypted fields

The toolbar's **Encrypted field** stores a value as ciphertext: the markdown
holds only `!masked[…]{label="…"}` and renders a masked pill. Click one to
reveal, copy or edit it (one password prompt per session) — the plaintext never
enters the document.

### Emoji

Type `:` in body text, a table cell or the block source editor to search
Unicode emoji by name (`:smile`, `:+1`, `:tada`); Enter/Tab accepts, Esc
dismisses and leaves what you typed.

### Find and replace

`Ctrl+F` / `Ctrl+H` search the document's own text, including the markup of
tables and diagrams, with whole-document matches highlighted in the preview. Enter
and Shift+Enter step through them, and replacing keeps the formatting around the
match.

### Import and export

- `Insert → Spreadsheet…` reads CSV, TSV, ODS and XLSX files as a table.
- `Insert → Text File…` and `Insert → Image…` insert a file at the cursor;
  a local image is referenced relatively, so the document stays portable.
- Every table has a **Copy** button that puts HTML *and* tab-separated text on
  the clipboard, for Word, Excel and email.
- Right-click a rendered diagram for **Copy image** / **Save image…**.
- `File → Export HTML…` exports the whole rendered document — diagrams,
  computed values and code output included — as one self-contained HTML file.
  It carries no keyboard shortcut, so `Ctrl+Shift+E` stays the block-source
  toggle.

### Menus and toolbar

Document actions live in the native menu bar, with the four most common ones
(New, Open, Save, Save As) also as toolbar buttons; the rest of the toolbar
toggles markdown formatting on the selection. Hide the row with
`View → Toolbar`.

| Menu | Items |
| --- | --- |
| **File** | New, Open, Open Recent, Save, Save As, Rename…, Revert, Copy File Path, Export HTML…, Quit |
| **Edit** | Undo, Redo, Cut, Copy, Copy as Markdown, Paste, Paste as Markdown, Select All, Find…, Replace… |
| **Insert** | Table…, Kanban Board…, Spreadsheet…, Text File…, Image… |
| **View** | Toolbar, Zoom In, Zoom Out, Reset Zoom, Zoom ▸ |
| **Help** | Edi Guide…, Formula Reference…, About Edi… |

`Revert` and `Rename…` need a document that has been saved somewhere; renaming
asks for a new name in the same folder, writes the document under it and deletes
the old file in one step, so it is never left under both names.

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl+N` | New tab |
| `Ctrl+W` | Close tab |
| `Ctrl+O` | Open file (in a new tab) |
| `Ctrl+S` | Save |
| `Ctrl+Shift+S` | Save As |
| `Ctrl+Shift+C` | Copy selection as Markdown |
| `Ctrl+Alt+Shift+C` | Copy file path |
| `Ctrl+Shift+V` | Paste as Markdown |
| `Ctrl+Shift+E` | Toggle a block's source / visual view |
| `Ctrl+B` / `Ctrl+I` | Bold / italic |
| `Ctrl+Z` / `Ctrl+Shift+Z` | Undo / redo |
| `Ctrl+X` / `Ctrl+C` / `Ctrl+V` | Cut / copy / paste |
| `Ctrl+A` | Select all |
| `Ctrl+=` / `Ctrl+-` / `Ctrl+0` | Zoom document in / out / reset |
| `Ctrl+Shift+Up` / `Ctrl+Shift+Down` | Extend / shrink selection across blocks |
| `Ctrl+F` | Find in current document |
| `Ctrl+H` | Find & replace in current document |
| `Ctrl+Q` | Quit |

## Installing a release

Each `vX.Y.Z` tag publishes the artifacts below.

**Linux** — the `package-linux` job wraps the onefile binary (it never rebuilds it, so
the portability guarantee is inherited):

| Artifact | Install |
| --- | --- |
| `edi_X.Y.Z_amd64.deb` | `sudo apt install ./edi_X.Y.Z_amd64.deb` |
| `edi-X.Y.Z-1.x86_64.rpm` | `sudo dnf install ./edi-X.Y.Z-1.x86_64.rpm` |
| `Edi-X.Y.Z-x86_64.AppImage` | `chmod +x && ./Edi-X.Y.Z-x86_64.AppImage` |
| `edi-X.Y.Z-linux-x86_64.tar.gz` | extract; run `./edi` or `./install.sh` |

They install the binary, the desktop entry and the icon set system-wide. Running
the bare binary instead? The dock/taskbar icon on Linux comes from a
`.desktop` file rather than the window icon, so install one for the current user:

```sh
./scripts/install-desktop.sh [path/to/edi]   # defaults to ./dist-app/edi
```

That writes `edi.png` into `~/.local/share/icons/hicolor` and an `edi.desktop`
entry into `~/.local/share/applications` (respecting `XDG_DATA_HOME`); log out
and back in if the gear icon persists.

**Windows** — a real Windows Python + PyInstaller runs under WineHQ-staging in
CI, so no Windows host is needed to cut a release:

| Artifact | Install |
| --- | --- |
| `Edi-X.Y.Z-win64-setup.exe` | run it; installs to `%ProgramFiles%\Edi` with Start Menu / desktop shortcuts and a Settings → Apps uninstall entry |
| `Edi-X.Y.Z-win64.exe` | run directly; nothing is installed (settings are still shared via the registry) |

**macOS** — `Edi-X.Y.Z-macos-arm64.dmg` (Apple Silicon), drag-to-Applications.
The app is ad-hoc code-signed (arm64 will not launch unsigned) but not
notarized, so the first open on another Mac warns: right-click → Open, or clear
it with `xattr -dr com.apple.quarantine Edi.app`.

## Upgrading

There is no in-app updater — install the newest release artifact. Your settings
and documents are never touched.

- **Windows (installer):** run the new setup over the existing install. It
  replaces the app in `%ProgramFiles%\Edi`, refreshes the shortcuts and the
  Settings → Apps entry, and needs no uninstall first.
- **Windows (portable):** replace your copy of the `.exe`. Each launch unpacks
  to a temp directory, so there is nothing to uninstall.
- **Linux:** upgrade through your package manager with the new `.deb`/`.rpm`;
  AppImage and tar.gz users just download the new archive.
- **macOS:** drag the new `Edi.app` over the old one in Applications.

Nothing enforces version order — installing an older artifact over a newer
install downgrades it.

## Building from source

Requirements: Python 3.10+ (with `venv`), Node.js 20.19+/22.12+, and a Linux
desktop with X11 or Wayland.

```sh
./scripts/install-deps.sh
```

This creates the virtualenv (`.venv/`, with PySide6), installs the npm
dependencies and generates the app icon. Then build the frontend and run the
Python shell — `npm run dev` on its own is only the Vite server, not the app:

```sh
npm run build
.venv/bin/python run_edi.py
```

### How it fits together

- **Frontend** — the document editor is [ProseMirror](https://prosemirror.net)
  (with CodeMirror 6 inside fenced code blocks), plus Mermaid and the spreadsheet
  formula engine, in TypeScript. Vite builds it into a single static `dist/`.
- **Backend** — Python 3 + PySide6. A native `QWebEngineView` hosts
  `dist/index.html`; the page talks to Python over `QWebChannel`
  (`backend/bridge.py`), which owns the file dialogs, file IO and code-block
  execution.
- **The document is the file** — plain markdown on disk. Nothing about the
  spreadsheet, the diagrams or the encrypted fields needs a sidecar file.

## Packaging

```sh
./scripts/build-pyzip.sh            # single-file binary -> ./dist-app/edi
./scripts/package-linux.sh [path/to/edi] [version]   # .deb / .rpm / .AppImage / tar.gz
```

`build-pyzip.sh` builds the frontend and bundles the app into one executable
inside an Ubuntu 22.04 container (glibc 2.35), so the result also runs on older
desktop Linux systems; the host's Node and Python versions do not matter, and
the binary is smoke-tested offscreen before it reports success. `package-linux.sh`
wraps an existing binary (never rebuilds it) and needs `dpkg-deb`, `rpmbuild`
(`sudo apt-get install rpm`) and `curl`.

```sh
./scripts/build-windows-wine.sh [VERSION]   # Windows onefile + NSIS installer, on Linux
./scripts/build-macos.sh [x.y.z]            # Edi.app + .dmg, on a Mac
```

Windows binaries are built in a WineHQ-staging container that carries a real
Windows Python and PyInstaller (PyInstaller cannot cross-compile, but Wine
provides the Windows runtime that makes `edi.spec` take its `win32` branch);
`scripts/build-windows.ps1` is the same build on a real Windows desktop. macOS
must be built on a Mac, for the same reason.

## Checks and tests

```sh
npm run check               # typecheck + eslint + frontend unit tests + duplicate scan
npm run coverage            # frontend tests with a coverage report
.venv/bin/pytest tests/     # backend tests (PySide6, offscreen)
```

Both halves are required to be green before a change lands, and CI runs the same
commands: `npm run check` is the local gate, the `Release` pipeline adds the
platform builds, and pushing a `vX.Y.Z` tag publishes the artifacts above.

## Versioning

The version is tracked in `package.json`, `package-lock.json` and
`backend/__init__.py`, and `scripts/version.sh` keeps them in step:

```sh
./scripts/version.sh current      # print the current version
./scripts/version.sh set 0.2.0    # set an explicit version
./scripts/version.sh bump patch   # or minor / major, to auto-increment
./scripts/version.sh check        # verify all declarations agree
./scripts/version.sh tag          # create annotated git tag v<current-version>
```

`set`/`bump` update all three files and print the git commands to commit and
push; pushing the `vX.Y.Z` tag starts the release, whose `release` job refuses to
run if the tag does not match the declared version.

## License

Edi is GPLv3 (or later) licensed.
