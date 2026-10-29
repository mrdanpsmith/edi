# AGENTS.md

## Agent workflow (read first)

**Do not create branches, and do not commit.** Leave all changes in the working
tree uncommitted and unbranched; the user reviews and commits them. Do not run
`git commit`, `git checkout -b`, `git branch`, or push. If a task asks for a
branch, implement the changes on the current branch and stop.

Keep the docs honest. When behaviour changes, update the topic document in
`docs/` rather than growing this file; `AGENTS.md` is the entry point, not the
manual.

## What Edi is

Edi is a markdown editor. The frontend is ProseMirror (the document editor),
CodeMirror 6 (embedded code blocks only), Mermaid and spreadsheet formulas,
written in TypeScript and built by Vite into a static `dist/`. The backend is
Python 3 with PySide6/QtWebEngine: a native `QWebEngineView` hosts
`dist/index.html`, and the page talks to Python over `QWebChannel`
(`backend/bridge.py`).

This is **not a plain web app**. `npm run dev` runs only the Vite server; the
real application is `run_edi.py`.

## Documentation map

| Document | Read before changing… |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | Anything structural. Frontend/backend split, document model, repository map. |
| [docs/editor-marks.md](docs/editor-marks.md) | Inline mark input rules, arrow exit, `storedMarks`. |
| [docs/block-modes.md](docs/block-modes.md) | Visual/source and editing modes, block controls, hover band. |
| [docs/find-replace.md](docs/find-replace.md) | Search matching, decorations or the find panel. |
| [docs/contract.md](docs/contract.md) | Menu commands, bridge methods or preference names. |
| [docs/preferences.md](docs/preferences.md) | Persisted app state or the preferences bridge. |
| [docs/spreadsheets.md](docs/spreadsheets.md) | Formulas, the evaluator, document-local functions. |
| [docs/mermaid.md](docs/mermaid.md) | Diagram rendering, label editing, `DiagramSession`. |
| [docs/mermaid-kanban.md](docs/mermaid-kanban.md) | Kanban authoring, drag/drop, the bin, composers. |
| [docs/development.md](docs/development.md) | Setup, commands, local CI, testing quirks. |
| [docs/distribution.md](docs/distribution.md) | PyInstaller builds, packaging and platform constraints. |
| [docs/macos-installer.md](docs/macos-installer.md) | The curl installer, file associations, open-document events. |
| [docs/ci.md](docs/ci.md) | GitHub Actions, coverage, builder images, release DAG. |
| [docs/releasing.md](docs/releasing.md) | Version bumps, tags and changelogs. |

## Non-negotiable rules

### Block modes

- A mode is **plugin state, never document content**. No node carries
  `_source` or `_edit`; a flip must not dirty the file or enter undo.
- The decoration class must carry the mode (`…-visual`, `…-source`,
  `…-editing`); a decoration that only says "a mode exists" is byte-identical
  across modes and ProseMirror will not redraw.
- Every mode change goes through `enterBlockMode` / `exitBlockMode` /
  `toggleBlockMode`. Commit the outgoing block before moving the record.
- Details: [docs/block-modes.md](docs/block-modes.md).

### Mermaid and kanban

- A block has exactly one `DiagramSession`. No module-level state, per-render
  closures, DOM classes or source snapshots for diagram editing state.
- Every visual edit is one `setNodeMarkup`; `session.patch` reads the drawn
  source at patch time.
- Leaving edit mode must accept/resolve an open field **before** dispatching
  the mode change.
- Kanban drags move the real elements and never re-render mid-drag; the drop
  line is svg-native and under the held elements.
- Details: [docs/mermaid.md](docs/mermaid.md),
  [docs/mermaid-kanban.md](docs/mermaid-kanban.md).

### Frontend bundle

- The frontend must remain **one JS bundle** with no runtime `import()`.
  QtWebEngine intermittently fails dynamic module fetches under `file://`.
  Do not re-enable code splitting.
- Details: [docs/distribution.md](docs/distribution.md).

### Cross-language names and preferences

- Menu commands, bridge methods and preference defaults come from
  `shared/edi-contract.json`. Both sides check themselves against it.
- The name sections are objects keyed by name, not arrays: the object keys
  survive JSON import as a literal union, arrays widen to `string[]`.
- Preferences live in `QSettings`, never `localStorage`. The default
  `QWebEngineProfile` is off-the-record and discards web storage on exit.
- Details: [docs/contract.md](docs/contract.md),
  [docs/preferences.md](docs/preferences.md).

### Distribution

- The shipped Linux binary **must** be built on Ubuntu 22.04 (glibc 2.35).
- Never bundle `libstdc++.so.6` or `libgbm.so.1`; they break newer hosts.
- PyInstaller cannot cross-compile: Linux in the jammy container, Windows on
  Windows, macOS on macOS.
- Icons come from `scripts/generate-icon.mjs`; do not add a second logo.
- Details: [docs/distribution.md](docs/distribution.md).

### Tests

- `npm run check` is the local frontend gate. Run it before backend work.
- `pytest tests/` needs `dist/`; build it with `npm run build` first.
- Python tests must run from the repository root (`pythonpath=["."]`).
- Qt runs offscreen, and PySide6 must not be imported before the environment
  variables in `tests/conftest.py` are set.
- Details: [docs/development.md](docs/development.md).

## Common commands

```sh
./scripts/install-deps.sh                      # one-time setup
npm run build                                  # build dist/
.venv/bin/python run_edi.py                    # run the real app

npm run check                                  # frontend gate
npm run coverage                               # frontend coverage
.venv/bin/pytest tests/                        # backend tests (needs dist/)
./scripts/simulate-ci-test.sh                  # local CI test job
```

Bandit and pip-audit commands, the pre-push hook, the packaged-build smoke test and
the container-specific quirks are in [docs/development.md](docs/development.md).

## Repository map

| Path | Contents |
| --- | --- |
| `src/` | TypeScript frontend; `entry.ts` is the page entry point and `main.ts` owns `init` plus the app shell. |
| `backend/` | Python shell, bridge, menus, file IO, execution and preferences. |
| `shared/edi-contract.json` | Cross-language names and preference defaults. |
| `tests/` | Python tests, including real-WebEngine tests in `test_window.py`. |
| `scripts/` | Setup, build, packaging and release scripts. |
| `pm/` | Product specification and design history. |
| `docs/` | Detailed developer documentation. |
