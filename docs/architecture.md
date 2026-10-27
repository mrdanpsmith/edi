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

## Data flow

1. `backend/main.py` creates the QApplication and `MainWindow`.
2. `backend/window.py` creates the `QWebEngineView`, loads `dist/index.html`
   and builds the native menubar.
3. `src/main.ts` boots the page, creates the editor and binds menu commands.
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
| `src/` | TypeScript frontend. `main.ts` is the page entry point; `node/` holds node views. |
| `src/editor.ts` | Builds the ProseMirror editor. |
| `src/styles.css` | Application stylesheet. |
| `src/docs/` | Markdown used by the in-app Help guide. |
| `backend/` | Python shell: `main.py`, `window.py`, `bridge.py`, file IO, code execution, table import, preferences and theming. |
| `shared/edi-contract.json` | Single source of truth for menu-command, bridge-method and preference names. |
| `tests/` | Python tests, including the real-WebEngine tests at the end of `tests/test_window.py` and helpers in `tests/mermaid_render.py`. |
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
