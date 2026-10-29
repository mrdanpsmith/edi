# Architecture

Edi is a native desktop application made of two halves:

- **Frontend** — the document editor is [ProseMirror](https://prosemirror.net),
  with CodeMirror 6 embedded only inside fenced code blocks, plus Mermaid and
  the spreadsheet formula engine. It is written in TypeScript and built by Vite
  into a single static `dist/` directory.
- **Backend** — Python 3 and PySide6. A native `QWebEngineView` hosts
  `dist/index.html`; the page talks to Python over `QWebChannel`
  (`backend/bridge.py`), which owns file dialogs, file IO, native menus and
  code-block execution.

This is **not a plain web app**. `npm run dev` runs only the Vite server, not
the application. The real entry point is `run_edi.py`, which starts the Python
shell and loads the built frontend.

## The document is the file

A document is plain markdown on disk. Tables, Mermaid diagrams and encrypted
fields are represented in the markdown itself, so none of them needs a sidecar
file. The live editor works on a ProseMirror document and serializes it back to
markdown; a resolved table or diagram is stored in its node's `attrs.value`.

The markdown file remains the source of truth. Undo, save, export and search
all operate on the document, not on a separate model that could drift from it.

Opening and saving a file must not change it. `src/markdown.ts` keeps what the
editor has no model for as the markdown it was written as: HTML blocks, link and
footnote definitions and YAML front matter become a `source_block`, and inline
HTML and footnote references an `inline_source` atom. Reference links are
ordinary links that are written back in reference form while their target is
unchanged. Text is escaped only where a character could start a construct, so a
lone `*` or `snake_case` is written as typed. Table cells are escaped the same
way, except a formula cell, which is written raw because it is the formula's
source. `src/markdown-roundtrip.test.ts` holds the files that must survive a
save byte for byte.

The bytes around the text are the file's too. `backend/files.py` reads with
`utf-8-sig` and universal newlines, so the page only ever sees `\n` and no
byte-order mark, and a write takes the line ending and BOM of the file it
replaces (or, for a rename, the file it moves). A new file gets the platform's
line ending, as it always has.

A tab is dirty when its document is not the one on disk. The editor keeps the
last-saved document as plugin state (`savedPoint` in `src/editor.ts`), so it
travels with each tab's state, and undoing back to it makes the tab clean.

## What a document can make the machine do

A markdown file can come from anywhere, so two features that reach outside the
page have explicit limits:

- **Links.** `http`, `https` and `mailto` open directly. Any other scheme, and any
  local file that is not a document Edi opens itself, is handed to the OS only
  after a confirmation naming the target (`launchConfirmation` in
  `src/linkSecurity.ts`): the OS handler for a `.command`, an `.app` or a
  custom scheme can run a program.
- **Files** (`PathGrants` in `backend/bridge.py`). The bridge writes only files
  the user named outside the page: a native Open, Save, Export or Save Image
  dialog, the command line, the OS opening a document, or a document reopened
  from the backend's own recent list (which in turn only takes paths already
  granted). Reading an arbitrary file needs an import dialog; a document type
  may be read without one, so a link to another note still opens. A rename
  stays in the document's folder. Anything else is refused with the
  `notPermitted` error code, and the page answers a refused save by opening the
  Save dialog on that file — which is how a document opened from a link is
  saved the first time.
- **Runnable code blocks** (`backend/exec.py`). On POSIX each run leads its own
  process group, and Stop, the 30-second timeout and quitting the app
  (`Bridge.shutdown`, on `aboutToQuit`) kill the whole group; Windows uses
  `taskkill /T`. A run that exits normally leaves what it launched alone.
- **Printing** (`backend/printing.py`). `printHtml` takes the page Export
  writes and prints it from a hidden `QWebEngineView` of its own: no bridge,
  JavaScript off, loaded from a temporary file (removed when the print reports
  back) because `setHtml` caps content at 2 MB. The document path the page
  sends is used only as the `<base>` for relative images.

## Data flow

1. `backend/main.py` creates the QApplication and `MainWindow`.
2. `backend/window.py` creates the `QWebEngineView`, loads `dist/index.html`
   and builds the native menubar.
3. `src/entry.ts` resolves the root elements and calls `init` in `src/main.ts`,
   which creates the editor and binds menu commands. Importing `main.ts` has no
   side effects; its controllers receive one `AppContext`.
4. Page → Python calls go through `src/bridge.ts`; Python answers through
   `Bridge._handlers` in `backend/bridge.py`.
5. Python → page notifications go over the bridge's `notify` channel, and
   menu commands are pushed as `window.ediMenuCommand("…")`.

The names on both sides of that boundary are not ad-hoc: menu commands,
bridge methods and preference defaults are declared in
`shared/edi-contract.json` and checked by both test suites. See
[contract.md](contract.md).

## Repository map

| Path | Contents |
| --- | --- |
| `src/` | TypeScript frontend. `entry.ts` is the page entry point; `main.ts` boots from `init(roots)`; `node/` holds node views. |
| `src/appContext.ts` | The shared `AppContext`, roots and app-chrome updates (title, status, menu state). |
| `src/fileController.ts` | File lifecycle: open, save, rename, revert, import and export. |
| `src/editController.ts` | Clipboard, paste, select-all and menu undo/redo. |
| `src/contextMenuController.ts` | Document, input, source-editor and block context menus. |
| `src/zoomController.ts` | Document zoom commands, wheel handling and the status indicator. |
| `src/editor.ts` | Builds the ProseMirror editor. |
| `src/styles.css` | Application stylesheet entry; imports the component sheets in cascade order. |
| `src/styles/` | One stylesheet per component (`tabs`, `toolbar`, `block-controls`, `tables`, `mermaid`, …). |
| `src/docs/` | Markdown used by the in-app Help guide. |
| `backend/` | Python shell: `main.py`, `window.py`, `bridge.py`, file IO, code execution, table import, printing, preferences and theming. |
| `shared/edi-contract.json` | Single source of truth for menu-command, bridge-method and preference names. |
| `tests/` | Python tests, including the real-WebEngine tests in `tests/window/test_window.py` and helpers in `tests/mermaid_render.py`. |
| `scripts/` | Developer, build, packaging and release scripts. |
| `pm/` | Product specification and design history. |
| `docs/` | These developer documents. |

Frontend unit tests live beside their modules as `src/*.test.ts`. Python tests
are `tests/test_*.py`; the real-engine Mermaid tests share the session window
because each `MainWindow` is a full WebEngine page and the suite deliberately
keeps the number of pages small.

## Build outputs

- `dist/` — the compiled frontend (`index.html` plus one JS bundle).
- `dist-app/` — native binaries and installers produced by the build scripts.
- `coverage/`, `coverage-py/` — test coverage reports.

`dist/` must exist before running the Python tests; `npm run build` creates it.
