# Edi

Markdown is becoming the modern format for writing text, diagrams, creating tables, and more.
However, while markdown is becoming an all-encompassing, modern version of office documents, the only existing editors are designed as if it's just a way to make some text look a little better.

Enter Edi. Edi is to be a modern, **exceedingly fast** markdown editor that lets you write up all of the amazing things that modern markdown has become, lets you compose diagrams in mermaid, and allows you to do in-line data processing on tables just like a mini-spreadsheet.

## Status

Implemented: a Tauri 2 desktop app with a CodeMirror 6 markdown editor and a live, resizable, toggleable preview that renders Mermaid diagrams, computes spreadsheet formulas in tables, runs `#!` code blocks, saves and inserts text fragments, and exports the rendered document as a self-contained HTML file.

| Feature | Status |
| --- | --- |
| Fast, small-footprint editor (Tauri 2 + OS webview) | Done |
| Markdown editing with syntax highlighting | Done |
| Live preview as you type (debounced, resizable, toggleable) | Done |
| In-line Mermaid diagrams | Done |
| Open / Save / Save As | Done |
| In-line spreadsheet capabilities | Done |
| Executable code blocks (`#!` kernel syntax) | Done |
| Copy/paste fragments | Done |
| HTML export | Done |

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

Requirements: a Linux desktop (Tauri builds against WebKitGTK), Node.js 20+, and a Rust toolchain.

The easiest path is the dependency script (Ubuntu/Debian):

```sh
./scripts/install-deps.sh
```

This installs the Rust toolchain, system libraries (`libwebkit2gtk-4.1-dev`, GTK3, libsoup, librsvg), and npm dependencies.

### Development

```sh
npm run tauri dev
```

### Production build

```sh
npm run tauri build
```

Bundles are written to `src-tauri/target/release/bundle/`.

> **Portable AppImage:** an AppImage built on a modern distro bundles libraries
> that require that distro's glibc, so it will not run on older systems. Use
> `scripts/build-appimage.sh` to build the AppImage inside an Ubuntu 22.04
> (glibc 2.35) container — this is also what the CI pipeline does:

```sh
./scripts/build-appimage.sh
```

## Checks and tests

```sh
npm run check        # typecheck + eslint + unit tests
npm run coverage     # unit tests with coverage report
cargo test           # Rust backend tests (run in src-tauri/)
cargo clippy -- -D warnings
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

1. All features are thoroughly tested using automated tests (Vitest for the frontend, `cargo test` for the backend).
2. Code is checked for duplication and poor quality using free, open static code analysis tools (ESLint, `tsc`, and `cargo clippy`).
3. Versioning and tagging automatically results in releases being created by the GitLab CI pipeline (using the new `glab` tools, not the deprecated `release-cli`). See `.gitlab-ci.yml`; the `release` job requires a `GITLAB_TOKEN` CI/CD variable with `api` scope and Maintainer role.
4. All unnecessary files are `.gitignore`d.
5. All files necessary for building the project can be installed via a simple script (`scripts/install-deps.sh`) so that a new developer or user can easily build the project from source.
6. Linting is part of the standard checks.
7. Coverage metrics are available as part of the build and check process (`npm run coverage` and the `test` CI job).

## License

Edi is GPLv3 (or later) licensed.
