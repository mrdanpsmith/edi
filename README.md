# Edi

Markdown is becoming the modern format for writing text, diagrams, creating tables, and more.
However, while markdown is becoming an all-encompassing, modern version of office documents, the only existing editors are designed as if it's just a way to make some text look a little better.

Enter Edi. Edi is to be a modern, **exceedingly fast** markdown editor that lets you write up all of the amazing things that modern markdown has become, lets you compose diagrams in mermaid, and allows you to do in-line data processing on tables just like a mini-spreadsheet.

## Status

Implemented: a Python desktop app (PySide6 + QtWebEngine) with a CodeMirror 6 markdown editor and a live, resizable, toggleable preview that renders Mermaid diagrams, computes spreadsheet formulas in tables, runs `#!` code blocks, saves and inserts text fragments, and exports the rendered document as a self-contained HTML file.

| Feature | Status |
| --- | --- |
| Fast, small-footprint editor (Python + QtWebEngine) | Done |
| Markdown editing with syntax highlighting | Done |
| Live preview as you type (debounced, resizable, toggleable) | Done |
| In-line Mermaid diagrams | Done |
| Open / Save / Save As | Done |
| In-line spreadsheet capabilities | Done |
| Executable code blocks (`#!` kernel syntax) | Done |
| Copy/paste fragments | Done |
| HTML export | Done |

## Architecture

- **Frontend**: CodeMirror 6 + Mermaid + spreadsheet formulas in TypeScript, built with Vite into a single static `dist/`.
- **Backend**: Python 3 + PySide6 (QtWidgets / QtWebEngine). A native `QWebEngineView` hosts the frontend; the page talks to Python through `QWebChannel` (`backend/bridge.py`), which provides file dialogs, file IO, and code-block execution.
- **Distribution**: a portable single-file binary (`PyInstaller` onefile) built on Ubuntu 22.04 (glibc 2.35) so it runs on older desktop Linux too.

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

The shebang is interpreted like a shell's, so all of these forms work: `#!python3`, `#!/bin/bash -e`, `#!/usr/bin/python3`, `#!/usr/bin/env node`, and `#!node --harmony` (flags are passed through). Supported interpreters: `python`/`python3`/`py`, `sh`/`shell`, `bash`, `node`/`js`/`javascript`, `ruby`/`rb`, and `perl`/`pl`. Code runs locally with a 30-second timeout; stdout, stderr, and the exit code are shown in an output cell. Output is cached per block content, so re-rendering the preview does not re-execute it.

### Fragments

Select any text (or a whole line) and press `Ctrl+Shift+F` / `Ctrl+Shift+K` to save it as a named fragment, then re-insert it anywhere. Fragments persist between sessions and are managed in the *Fragments* dialog.

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

## Checks and tests

```sh
npm run check          # typecheck + eslint + frontend unit tests
.venv/bin/pytest tests/   # backend tests (PySide6, offscreen)
npm run coverage       # frontend tests with coverage report
```

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl+O` | Open file |
| `Ctrl+S` | Save |
| `Ctrl+Shift+S` | Save As |
| `Ctrl+Shift+P` | Toggle preview |
| `Ctrl+Shift+E` | Export preview as HTML |
| `Ctrl+Shift+F` / `Ctrl+Shift+K` | Save a fragment / open fragments |

## Development process

1. All features are thoroughly tested using automated tests (Vitest for the frontend, `pytest` for the backend).
2. Code is checked for duplication and poor quality using free, open static code analysis tools (ESLint and `tsc`).
3. Versioning and tagging automatically results in releases being created by the GitLab CI pipeline (using the new `glab` tools, not the deprecated `release-cli`). See `.gitlab-ci.yml`; the `release` job requires a `GITLAB_TOKEN` CI/CD variable with `api` scope and Maintainer role.
4. All unnecessary files are `.gitignore`d.
5. All files necessary for building the project can be installed via a simple script (`scripts/install-deps.sh`) so that a new developer or user can easily build the project from source.
6. Linting is part of the standard checks.
7. Coverage metrics are available as part of the build and check process (`npm run coverage` and the `test` CI job).

## License

Edi is GPLv3 (or later) licensed.
