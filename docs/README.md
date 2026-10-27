# Edi developer documentation

These documents describe how Edi is built, tested, packaged and released. The
user-facing guide is the repository [README](../README.md); the in-app
`Help → Edi Guide…` is the product tour.

| Document | What it covers |
| --- | --- |
| [architecture.md](architecture.md) | The frontend/backend split, the document model and the repository map. |
| [editor-marks.md](editor-marks.md) | Inline mark behaviour and the `storedMarks` rules. |
| [block-modes.md](block-modes.md) | Visual/source and viewing/editing modes, the block control cluster and the hover band. |
| [find-replace.md](find-replace.md) | The search plugin, matching layer and the find/replace panel. |
| [contract.md](contract.md) | `shared/edi-contract.json` and the Python ↔ TypeScript name contract. |
| [preferences.md](preferences.md) | Why preferences live in `QSettings`, and how they reach the page. |
| [spreadsheets.md](spreadsheets.md) | The formula engine, document-local functions and the shared scanner. |
| [mermaid.md](mermaid.md) | Diagram sessions, label editing and the source-patching rules. |
| [mermaid-kanban.md](mermaid-kanban.md) | Kanban authoring, drag and drop, the bin, composers and label quoting. |
| [development.md](development.md) | Setup, common commands, local CI and testing quirks. |
| [distribution.md](distribution.md) | Platform builds, PyInstaller constraints and Linux packaging. |
| [macos-installer.md](macos-installer.md) | The curl installer, file associations and macOS open-document events. |
| [ci.md](ci.md) | GitHub Actions pipelines, coverage and the release DAG. |
| [releasing.md](releasing.md) | Versioning, tags and the changelog. |

## Working with an agent

The agent workflow is in [AGENTS.md](../AGENTS.md). In particular, changes stay
in the working tree: do not create branches or commit; the user reviews and
commits.
