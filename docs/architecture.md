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
file; [format.md](format.md) specifies each construct. The live editor works on a ProseMirror document and serializes it back to
markdown; a resolved table or diagram is stored in its node's `attrs.value`.

The markdown file remains the source of truth. Undo, save, export and search
all operate on the document, not on a separate model that could drift from it.

Opening and saving a file must not change it. The editor models the document,
not the file's layout, so a parse also records each top-level block's exact
source text and the text between blocks (`MarkdownSource`, kept per tab as the
editor's `markdownSource` plugin state, never in the document). A save writes a
block as it was read whenever Edi would still write it exactly as it would have
written the original, and keeps the gap between two such blocks that are still
neighbours; only blocks that were edited, inserted or moved are written in
Edi's own style. A block edited in place (the same kind of block, where an edit
replaced as many blocks as it removed) keeps the blank lines around it, so a
rewritten link definition stays next to its neighbours. A table with formulas is always written fresh, so its computed
values cannot go stale. `replaceMarkdown` (a change on disk, a restored version)
adopts the new text's record even when it parses to the same document.
`src/markdown-source.test.ts` covers this. Within an edited block, `src/markdown.ts` keeps what the
editor has no model for as the markdown it was written as: HTML blocks, link and
footnote definitions and YAML front matter become a raw `code_block` (`raw: true`,
written back as its text with no fences; see [code-blocks.md](code-blocks.md)). Inline
HTML becomes raw inline code (a `code` mark with `raw: true`, one run from an opening tag
to its closing tag, written back with no backticks), and a footnote reference an
`inline_source` atom. Reference links and
reference images are ordinary links and images that are written back in
reference form while their target is unchanged. Text is escaped only where a character could start a construct, so a
lone `*` or `snake_case` is written as typed. Table cells are escaped the same
way, except a formula cell, which is written raw because it is the formula's
source. `src/markdown-roundtrip.test.ts` holds the files that must survive a
save byte for byte.

A Mermaid file (`.mmd`, `.mermaid`) is the exception to "plain markdown": it
holds bare diagram source, and the editor sees it as a single fenced diagram.
`src/documentFormat.ts` does that conversion at every load and save; see
[mermaid.md](mermaid.md), "Mermaid files".

The bytes around the text are the file's too. `backend/files.py` reads with
`utf-8-sig` and universal newlines, so the page only ever sees `\n` and no
byte-order mark, and a write takes the line ending and BOM of the file it
replaces (or, for a rename, the file it moves). A new file gets the platform's
line ending, as it always has.

A document's saved versions are kept out of its folder too: each save is
committed into a git repository for that document in Edi's app-data folder
(`backend/history.py`, [history.md](history.md)), never into a sidecar beside it.

A tab is dirty when its document is not the one on disk. The editor keeps the
last-saved document as plugin state (`savedPoint` in `src/editor.ts`), so it
travels with each tab's state, and undoing back to it makes the tab clean.

Tabs reorder by dragging them along the strip (Escape cancels a drag), or with
Alt+Shift+Left/Right on a focused tab. The drag uses pointer events, not HTML5
drag and drop, so it never meets the window's file drops. Nothing in the DOM
moves mid-drag: the dragged tab follows the pointer by transform and its
neighbours slide aside (a transition on `.tab`), measured against the layout at
drag start. `moveSession` in `src/state.ts` changes the order only on release,
and the re-rendered tab glides from the release point into its slot. A reorder
never touches the editor or switches tabs.

### The launcher and launcher tabs

The launcher (`src/home.ts`, `#home-screen` in `index.html`) shows in two places:

- **The home screen** (`#app[data-view='home']`), when no tab is open. It has an
  Exit button and no tab strip.
- **A launcher tab** (`data-view='launcher'`), titled "New Tab" in the strip and
  opened by the tab strip's `+`, `Ctrl+T` and Window › New Tab. The tab strip
  stays; the toolbar, the editor and Exit are hidden. `Ctrl+N`, File › New and
  the toolbar's New still open a blank document straight away.

A launcher tab is a session with `launcher: true` (`src/state.ts`). It has no path
and never becomes dirty, so it is left out of the reopened session and closes
without asking. The shared editor still holds an empty state for it, so the tab
machinery treats it like any other tab. `getActiveDocument()` returns no session
while it is in view, which is what turns off save, print, export, find and the
context menu there.

Anything that opens a document while a launcher tab is active opens it **in** that
tab (`Tabs.addSession`), as a browser's new-tab page becomes the page you go to.
Otherwise every pick from the launcher would leave a stray launcher behind. If
the file is already open in another tab, Edi switches to that tab and closes the
launcher tab (`openDocument` in `src/fileController.ts`).

## What a document can make the machine do

A markdown file can come from anywhere, so the page and everything in it that
reaches outside it have explicit limits:

- **Script in the page.** The bridge trusts the page: `runCodeBlock` runs what
  it is sent, and the page may read local files (`LocalContentCanAccessFileUrls`).
  So script that a document smuggles into the DOM would have the machine.
  `index.html` carries a Content-Security-Policy that allows only the app's own
  bundle (`script-src 'self'`, no inline script, handlers or string evaluation)
  and no plugins, frames, `<base>` or form posts. It is the backstop behind every
  place the page builds HTML; `tests/window/test_window.py`
  (`test_page_refuses_injected_script`) checks it in the real WebEngine. Test
  probes go through `runJavaScript`, which the policy does not cover, never
  through an `eval` in the page.
- **Remote requests** (`backend/remote.py`). A request to a server tells it the
  document was opened, so the web engine requests nothing over `http`, `https`
  or `ws` from a host the reader has not allowed. A `QWebEngineUrlRequestInterceptor`
  on the default profile enforces it for every view on that profile (the app's
  page and the print view) and every kind of request: an image, a CSS `url()`,
  an image inside a diagram. The page shows what is held back and asks
  (`src/remoteImages.ts`): a remote image resolves to a local placeholder, and a
  bar offers the sites. The bridge's `allowImageHosts` only adds sites, and
  only the app's own code can call it, since the policy above runs nothing a
  document brings; Settings › Forget Allowed Image Sites… takes them back in a
  native prompt. The interceptor and its sites are one per process, parented to
  the application, because the profile does not own its interceptor and would
  otherwise outlive it. `test_remote_images_load_only_from_a_site_the_reader_allows`
  checks this against a local server. The one request Edi makes on its own
  account is the update check (`backend/updates.py`): from Python, not the
  page, only when the reader asks or has turned it on, and reading nothing from
  the answer but release versions (the latest release's, or on a release
  candidate the recent releases', see [releasing.md](releasing.md)). Its TLS is verified against the OS
  trust store (`truststore`), never a CA list shipped with Edi or the CA paths
  the build machine's OpenSSL was compiled with.

- **Links.** `http`, `https` and `mailto` open directly. Any other scheme, and any
  local file that is not a document Edi opens itself, is handed to the OS only
  after a confirmation naming the target (`launchConfirmation` in
  `src/linkSecurity.ts`): the OS handler for a `.command`, an `.app` or a
  custom scheme can run a program. A `javascript:`, `vbscript:` or `data:`
  destination never becomes an `href` (`isScriptUrl`): the link mark's `toDOM`
  and a table cell's HTML leave it out, so an exported file or copied HTML
  opened in a browser has nothing to run. The markdown keeps the destination
  as written.
- **Files** (`PathGrants` in `backend/bridge.py`). The bridge writes only files
  the user named outside the page: a native Open, Save, Export or Save Image
  dialog, the shell's Open Path prompt (`pickTypedOpenPath`: the page sends
  only the folder a relative path resolves against, never the path), the
  command line, the OS opening a document, or a document reopened
  from the backend's own recent list or last session (which in turn only take
  paths already granted). Reading an arbitrary file needs an import dialog; a document type
  may be read without one, so a link to another note still opens. A rename or
  move goes only to a destination typed into the shell's Rename or Move prompt
  (`pickRenamePath`: the page sends the document's path, and the shell grants
  the answer). Before a move the page may ask which of the document's
  reference targets exist (`pathsExist`), so it rebases only references that
  name something; the shell answers with booleans and nothing else, only for a
  document the page may write, and answers `false` for a relative path. Anything else is refused with the
  `notPermitted` error code. The page answers a refused save with
  `confirmWritePath`: the shell asks "Save changes to …?" in its own prompt,
  naming the file, and a yes grants it — which is how a document opened from a
  link is saved the first time. The shell only asks about a document it opened
  through `readTextFile`, so the page cannot put an arbitrary path in front of
  the user. Move to Trash works the same way: `trashDocument` carries only
  the document's path, the shell asks in its own prompt naming the file, and
  only a yes there moves it, to the system Trash and never a permanent delete.
  It is refused before the prompt for a file the page may not write and Edi
  never opened.
- **Running code** (`backend/approvals.py`). A block runs only after the reader
  has seen its command and code in the shell's own prompt
  (`backend/rundialog.py`), which the page can neither draw nor answer; Cancel
  is the default. The bridge asks before it spawns anything, for
  `streamCodeBlock` and `runCodeBlock` alike, and a no answers with the
  `runDeclined` error code. What is approved is the code: a SHA-256 of the
  shebang and the source, kept in `QSettings`. So an unchanged block runs again
  freely, and any change to it, from an edit or from another tool, asks again.
  "Don't ask again for this document until Edi quits" trusts the page's name
  for the document (its path, or `untitled:<tab>`) for this run of Edi. A
  shebang Edi cannot run asks nothing, since the run only reports why.
  Settings › Forget Approved Code… takes every answer back.
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
| `src/fileController.ts` | File lifecycle: open, save, rename or move, move to Trash, revert, version history, import and export. |
| `src/relink.ts` | Rebases a moved document's relative images, links and link definitions so they still name the same files. A reference that names nothing at the old location is left as written. |
| `src/editController.ts` | Clipboard, paste, select-all and menu undo/redo. |
| `src/contextMenuController.ts` | Document, input, source-editor and block context menus. |
| `src/zoomController.ts` | Document zoom commands, wheel handling and the status indicator. |
| `src/editor.ts` | Builds the ProseMirror editor. |
| `src/codeBlockDelete.ts`, `src/codeBlockMouse.ts` | Selecting and deleting code blocks from the keyboard, and the frame press and drags across them; see [code-blocks.md](code-blocks.md). |
| `src/styles.css` | Application stylesheet entry; imports the component sheets in cascade order. |
| `src/styles/` | One stylesheet per component (`tabs`, `toolbar`, `block-controls`, `tables`, `mermaid`, …). |
| `src/docs/` | Markdown used by the in-app Help guide. |
| `backend/` | Python shell: `main.py`, `window.py`, `bridge.py`, file IO, version history (`history.py`, recovering deleted documents in `recovery.py`, and a tracked document's git commits in `githistory.py`), code execution, table import, printing, preferences (and the Settings dialog in `settingsdialog.py`), recent documents (`recents.py`, and the Manage dialog in `recentsmanager.py`) and theming. |
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

`dist/` must exist before running the Python tests, with the window-test
harness in it; `npm run build:test` creates both (`npm run build` alone is the
app bundle that ships).
