import 'prosemirror-view/style/prosemirror.css'
import 'prosemirror-tables/style/tables.css'
import 'prosemirror-gapcursor/style/gapcursor.css'
import './styles.css'

import { confirmAction, hasBridge, invoke, showError } from './bridge'
import { startThemeWatcher } from './theme'

import { buildExportHtml, serializeDocToHtml } from './export'
import { redo, redoDepth, redoNoScroll, undo, undoDepth, undoNoScroll } from 'prosemirror-history'
import { selectAll } from 'prosemirror-commands'
import {
  dirname,
  fileName,
  imageReference,
  isAbsolutePath,
  isSupportedFile,
  openUrl,
  pickExportPath,
  pickImageImportPath,
  pickImportPath,
  pickOpenPath,
  pickSavePath,
  pickTextImportPath,
  readAnyTextFile,
  readTextFile,
  UNTITLED,
  writeTextFile,
} from './files'
import { parseTableFile, toMarkdownTable } from './import'
import { insertPastedText } from './paste'
import { copyText, writeClipboard } from './clipboard'
import { copyMermaidAsImage, saveMermaidAsImage } from './mermaid'
import { ContextMenu, type ContextMenuEntry, type ContextMenuItem } from './contextmenu'
import { toggleSourceMode } from './blockplugin'
import { commitSourceMode } from './blockview'
import { isMisleadingLink } from './linkSecurity'
import { FormatToolbar } from './formatToolbar'
import { bindMenuCommands } from './menus'
import { createBlockEditor, type BlockEditor } from './editor'
import { findSessionByPath, getActive, getState, isAnyDirty, setActiveDirty, setActivePath, subscribe } from './state'
import { HomeScreen } from './home'
import { addRecentFile, getRecentFiles } from './recents'
import { Tabs } from './tabs'

const IS_SELFTEST = new URLSearchParams(window.location.search).has('selftest')

const WELCOME_DOCUMENT = `# Welcome to Edi

Edi is a fast markdown editor with Mermaid diagrams, in-line spreadsheets, executable code blocks, and more.

## Getting started

- Click the handle on the left of any block or press \`Ctrl+Shift+E\` to toggle that block's source view.
- Use the **File** and **View** menus for document actions.
- Open several documents side by side in tabs (\`Ctrl+N\` for a new tab, \`Ctrl+W\` to close one).
- Insert a spreadsheet, text file, or image with \`Insert → …\`.

## Mermaid diagrams

\`\`\`mermaid
graph TD
    A[Start] --> B{Preview on?}
    B -->|Yes| C[Render diagram]
    B -->|No| D[Show source]
    C --> E[Looks great!]
    D --> E
\`\`\`

## Spreadsheet tables

Start a cell with \`=\` to compute it from other cells:

| Item | Q1 | Q2 | Total |
| --- | --- | --- | --- |
| Widget | 120 | 180 | =SUM(B2:C2) |
| Gadget | 90 | 110 | =B3+C3 |
| **Total** | =SUM(B2:B3) | =SUM(C2:C3) | =SUM(D2:D3) |

Supports \`SUM\`, \`AVERAGE\`, \`MIN\`, \`MAX\`, \`COUNT\`, \`PRODUCT\`, \`ROUND\`, cell references like \`B2\`, and ranges like \`B2:C4\`.

## Executable code blocks

Add a shebang line like a shell script to make a code block runnable:

\`\`\`
#!/usr/bin/env python3
print("Hello from Python!")
\`\`\`

## Tasks

- [x] Fast editing
- [x] Spreadsheet tables
- [x] Executable code blocks
- [x] HTML export
- [x] Multiple tabs
- [x] Spreadsheet import
- [x] Text-file import
- [x] Image insertion
`

const editorContainer = document.querySelector<HTMLElement>('#editor-container')!
const formatBar = document.querySelector<HTMLElement>('#formatbar')!
const statusLeft = document.querySelector<HTMLElement>('#status-left')!
const statusRight = document.querySelector<HTMLElement>('#status-right')!
const tabbar = document.querySelector<HTMLElement>('#tabbar')!

let lastNativeTitle = ''

let blockEditor: BlockEditor | null = null
let formatToolbar: FormatToolbar | null = null
let homeScreen: HomeScreen | null = null
let contextMenu: ContextMenu | null = null

const tabs = new Tabs(tabbar, {
  getMarkdown(): string {
    blockEditor?.commitSource()
    return blockEditor?.getMarkdown() ?? ''
  },
  setMarkdown(value: string): void {
    blockEditor?.setMarkdown(value)
  },
  createState(markdown: string): unknown {
    return blockEditor?.createState(markdown)
  },
  getState(): unknown {
    // Same tab boundary as getMarkdown: commit any in-progress source-mode
    // content into the document before capturing the live editor state.
    blockEditor?.commitSource()
    return blockEditor?.getState()
  },
  setState(state: unknown): void {
    blockEditor?.applyState(state as import('prosemirror-state').EditorState)
  },
  getScroll(): number {
    return editorContainer.scrollTop
  },
  setScroll(value: number): void {
    editorContainer.scrollTop = value
  },
}, {
  onNewTab: () => openNewTab(),
  onCloseTab: (id) => void closeTab(id),
  onActivate: () => afterActivate(),
})

function updateView(): void {
  const app = document.querySelector<HTMLElement>('#app')
  if (!app) return
  app.dataset.view = getState().sessions.length === 0 ? 'home' : 'editor'
}

function updateTitle(): void {
  const active = getActive()
  if (!active) {
    document.title = 'Edi'
    if (document.title !== lastNativeTitle) {
      lastNativeTitle = document.title
      void invoke('setTitle', { title: 'Edi' }).catch(() => undefined)
    }
    return
  }
  const name = active.path ? active.path.split('/').pop()! : UNTITLED
  const title = `${active.dirty ? '* ' : ''}${name} — Edi`
  document.title = title
  if (document.title !== lastNativeTitle) {
    lastNativeTitle = document.title
    void invoke('setTitle', { title }).catch(() => undefined)
  }
}

function updateStatus(): void {
  const active = getActive()
  if (!active) {
    statusLeft.textContent = ''
    statusRight.textContent = ''
    return
  }
  statusLeft.textContent = active.path ?? UNTITLED
  const text = blockEditor?.getMarkdown() ?? ''
  const words = text.trim() ? text.trim().split(/\s+/).length : 0
  statusRight.textContent = `${words.toLocaleString()} words · ${text.length.toLocaleString()} characters`
}

function afterActivate(): void {
  updateTitle()
  updateStatus()
  syncDirty()
  syncMenuState()
}

function syncDirty(): void {
  void invoke('setDirty', { dirty: isAnyDirty() }).catch(() => undefined)
}

function syncMenuState(): void {
  const active = getActive()
  void invoke('setMenuState', {
    canRevert: Boolean(active?.path),
    formattingVisible: formatToolbar?.isVisible() ?? true,
  }).catch(() => undefined)
}

function insertMarkdown(markdown: string): void {
  blockEditor?.insertMarkdown(markdown)
}

function insertTable(markdown: string): void {
  insertMarkdown(`\n${markdown}\n`)
}

function flashStatus(message: string): void {
  statusLeft.textContent = message
  window.setTimeout(() => updateStatus(), 3000)
}

async function exportHtml(): Promise<void> {
  if (!getActive()) return
  const base = getActive()!.path ? fileName(getActive()!.path!) : UNTITLED
  const path = await pickExportPath(base)
  if (!path) {
    return
  }
  try {
    const doc = blockEditor?.getView().state.doc
    if (!doc) {
      return
    }
    const bodyHtml = serializeDocToHtml(doc)
    await writeTextFile(path, buildExportHtml(fileName(path), bodyHtml))
    flashStatus(`Exported ${path}`)
  } catch (error) {
    reportError(`Failed to export ${path}`, error)
  }
}

function openNewTab(): void {
  tabs.addSession()
}

function openWelcome(): void {
  tabs.addSession(WELCOME_DOCUMENT)
  afterActivate()
}

function buildHomeScreen(): HomeScreen {
  const root = document.querySelector<HTMLElement>('#home-screen')!
  return new HomeScreen(root, {
    onNew: () => openNewTab(),
    onOpen: () => void openFile(),
    onOpenWelcome: () => openWelcome(),
    onExit: () => requestQuit(),
    onOpenRecent: (path) => void openDocument(path),
  })
}

function refreshRecents(): void {
  getRecentFiles()
    .then((paths) => homeScreen?.setRecents(paths))
    .catch(() => undefined)
}

async function rememberRecent(path: string): Promise<void> {
  try {
    await addRecentFile(path)
  } catch {
    // Recent-files persistence is best-effort (e.g. no native bridge).
  }
  refreshRecents()
}

async function closeTab(id: string): Promise<void> {
  const session = getState().sessions.find((entry) => entry.id === id)
  if (
    session?.dirty &&
    !(await confirmAction('Discard unsaved changes and close this document?'))
  ) {
    return
  }
  tabs.close(id)
}

async function openFile(): Promise<void> {
  const paths = await pickOpenPath()
  if (!paths || paths.length === 0) {
    return
  }
  for (const path of paths) {
    await openDocument(path)
  }
}

async function openDocument(path: string): Promise<void> {
  const existing = findSessionByPath(path)
  if (existing) {
    tabs.activate(existing.id)
    afterActivate()
    return
  }
  try {
    const content = await readTextFile(path)
    // The path is set before the content is rendered so that relative image
    // references in opened documents resolve against the document's directory.
    tabs.addSession(content, path)
    void rememberRecent(path)
    afterActivate()
  } catch (error) {
    reportError(`Failed to open ${path}`, error)
  }
}

function isExternalUrl(href: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href)
}

function resolveInternalPath(href: string): string | null {
  // Strip an in-document fragment (e.g. "#section"); a fragment-only link is
  // an anchor within the same file and has no separate target to open.
  const hashIndex = href.indexOf('#')
  const withoutFragment = hashIndex >= 0 ? href.slice(0, hashIndex) : href
  if (!withoutFragment) return null
  if (isAbsolutePath(withoutFragment)) return withoutFragment
  const active = getActive()
  const baseDir = active?.path ? dirname(active.path) : ''
  return baseDir ? `${baseDir}/${withoutFragment}` : withoutFragment
}

/**
 * Turn a markdown image ``src`` into a URL the QtWebEngine view can load.
 * Remote/data URLs pass through untouched; relative paths are resolved against
 * the active document's directory and served as ``file://`` URLs so images on
 * disk actually render.
 */
function resolveImageFileUrl(src: string): string {
  if (isExternalUrl(src) || src.startsWith('#')) return src
  let path = src
  if (!isAbsolutePath(path)) {
    const active = getActive()
    const baseDir = active?.path ? dirname(active.path) : ''
    path = baseDir ? `${baseDir}/${path}` : path
  }
  if (!path.startsWith('/')) return path
  // Normalize dot segments and percent-encode spaces into a loadable file URL.
  return new URL(`file://${path}`).href
}

async function openLink(href: string, text: string): Promise<void> {
  if (isMisleadingLink(href, text)) {
    const go = await confirmAction(
      `The link text "${text}" does not match its destination (${href}). Open it anyway?`,
    )
    if (!go) return
  }
  if (isExternalUrl(href)) {
    void openUrl(href)
    return
  }
  const target = resolveInternalPath(href)
  if (!target) return
  if (isSupportedFile(target)) {
    void openDocument(target)
  } else {
    void openUrl(target)
  }
}

async function saveFile(): Promise<void> {
  if (!getActive()) return
  const active = getActive()!
  let path = active.path ?? null
  if (!path) {
    path = await pickSavePath(UNTITLED)
    if (!path) {
      return
    }
  }
  await saveTo(path)
}

async function saveFileAs(): Promise<void> {
  if (!getActive()) return
  const defaultName = getActive()!.path?.split('/').pop() ?? UNTITLED
  const path = await pickSavePath(defaultName)
  if (!path) {
    return
  }
  await saveTo(path)
}

async function saveTo(path: string): Promise<void> {
  if (!isSupportedFile(path)) {
    await confirmAction(`"${path}" does not have a supported extension.\n\nContinue anyway?`)
  }
  try {
    const md = blockEditor?.getMarkdown() ?? ''
    await writeTextFile(path, md)
    setActivePath(path)
    setActiveDirty(false)
    updateTitle()
    updateStatus()
    syncDirty()
    syncMenuState()
    void rememberRecent(path)
  } catch (error) {
    reportError(`Failed to save ${path}`, error)
  }
}

async function revertFile(): Promise<void> {
  if (!getActive()) return
  const active = getActive()!
  const path = active.path ?? null
  if (!path) {
    return
  }
  if (
    active?.dirty &&
    !(await confirmAction('Discard unsaved changes and revert to the saved version?'))
  ) {
    return
  }
  try {
    const content = await readTextFile(path)
    tabs.setActiveContent(content)
    setActiveDirty(false)
    tabs.snapshotActive()
    afterActivate()
  } catch (error) {
    reportError(`Failed to revert ${path}`, error)
  }
}

async function importTable(): Promise<void> {
  const path = await pickImportPath()
  if (!path) {
    return
  }
  try {
    const table = await parseTableFile(path)
    insertTable(toMarkdownTable(table.rows))
    flashStatus(`Imported ${table.name}`)
  } catch (error) {
    reportError(`Failed to import ${path}`, error)
  }
}

async function importTextFile(): Promise<void> {
  const path = await pickTextImportPath()
  if (!path) {
    return
  }
  try {
    const content = await readAnyTextFile(path)
    insertMarkdown(`\n${content}\n`)
    flashStatus(`Inserted ${fileName(path)}`)
  } catch (error) {
    reportError(`Failed to insert ${path}`, error)
  }
}

async function insertImage(): Promise<void> {
  const path = await pickImageImportPath()
  if (!path) {
    return
  }
  const reference = imageReference(getActive()?.path ?? null, path)
  const destination = /[ ()]/u.test(reference) ? `<${reference}>` : reference
  insertMarkdown(`\n![${fileName(path)}](${destination})\n`)
  flashStatus(`Inserted ${fileName(path)}`)
}

function reportError(message: string, error: unknown): void {
  const detail = error instanceof Error ? `\n\n${error.message}` : ''
  void showError(`${message}${detail}`)
}

function registerShortcuts(): void {
  window.addEventListener('keydown', (event) => {
    if (!(event.ctrlKey || event.metaKey)) {
      return
    }
    const key = event.key.toLowerCase()
    if (key === 'n') {
      event.preventDefault()
      openNewTab()
    } else if (key === 'w') {
      event.preventDefault()
      void closeTab(tabs.activeId)
    } else if (key === 'o') {
      event.preventDefault()
      void openFile()
    } else if (key === 's' && event.shiftKey) {
      event.preventDefault()
      void saveFileAs()
    } else if (key === 's') {
      event.preventDefault()
      void saveFile()
    } else if (key === 'q') {
      event.preventDefault()
      void requestQuit()
    } else if (key === 'a' && !event.defaultPrevented) {
      // Focus the editor and select all. When the editor already had focus,
      // ProseMirror's own Mod-a keymap handles it (and preventDefault), so
      // this only kicks in when focus is elsewhere (e.g. the formatting bar)
      // where the browser would otherwise select the whole window.
      event.preventDefault()
      editSelectAll()
    }
  })
}

interface CloseRequestEvent {
  preventDefault: () => void
}

function requestQuit(event?: CloseRequestEvent): void {
  if (hasBridge()) {
    void invoke('quit')
    return
  }
  event?.preventDefault()
  window.close()
}

function toggleFormatting(): void {
  formatToolbar?.toggle()
  syncMenuState()
}

function editUndo(): void {
  const view = blockEditor?.getView()
  if (view) {
    view.focus()
    undo(view.state, view.dispatch, view)
  }
}

function editRedo(): void {
  const view = blockEditor?.getView()
  if (view) {
    view.focus()
    redo(view.state, view.dispatch, view)
  }
}

// Menu-triggered undo/redo must not scroll: the transaction is dispatched with
// scrollIntoView=false so the viewport stays put (undoNoScroll/redoNoScroll).
function editUndoNoScroll(): void {
  const view = blockEditor?.getView()
  if (view) {
    view.focus()
    undoNoScroll(view.state, view.dispatch, view)
  }
}

function editRedoNoScroll(): void {
  const view = blockEditor?.getView()
  if (view) {
    view.focus()
    redoNoScroll(view.state, view.dispatch, view)
  }
}

function editCut(): void {
  const view = blockEditor?.getView()
  if (!view || view.state.selection.empty) return
  view.focus()
  const { dom, text } = view.serializeForClipboard(view.state.selection.content())
  void writeClipboard({ html: dom.innerHTML, text })
  view.dispatch(view.state.tr.deleteSelection())
}

function editCopy(): void {
  const view = blockEditor?.getView()
  if (!view || view.state.selection.empty) return
  view.focus()
  const { dom, text } = view.serializeForClipboard(view.state.selection.content())
  void writeClipboard({ html: dom.innerHTML, text })
}

async function editPaste(): Promise<void> {
  const view = blockEditor?.getView()
  if (!view) return
  let html: string | null = null
  let text: string | null = null
  if (hasBridge()) {
    const data = await invoke<{ text: string; html: string }>('readClipboardText')
    html = data?.html || null
    text = data?.text || null
  } else {
    try {
      const items = await navigator.clipboard.read()
      for (const item of items) {
        if (item.types.includes('text/html')) {
          html = await item.getType('text/html').then((b) => b.text())
        }
        if (item.types.includes('text/plain')) {
          text = await item.getType('text/plain').then((b) => b.text())
        }
      }
    } catch {
      return
    }
  }
  view.focus()
  // Rich media first: pasteHTML runs ProseMirror's full clipboard parser, which
  // preserves formatting (bold, links, code) and turns block HTML (our own
  // serializeForClipboard output) into real paragraphs. Only fall back to plain
  // text when no HTML is available (insertPastedText handles line breaks and
  // linkifies bare URLs).
  if (html && html.trim() !== '') {
    view.pasteHTML(html, pasteEvent())
  } else if (text && text.trim() !== '') {
    insertPastedText(view, text)
  }
}

function pasteEvent(): ClipboardEvent {
  return typeof ClipboardEvent === 'function'
    ? new ClipboardEvent('paste')
    : ({ clipboardData: null } as unknown as ClipboardEvent)
}

function editSelectAll(): void {
  const view = blockEditor?.getView()
  if (view) {
    const scrollTop = editorContainer.scrollTop
    view.focus()
    selectAll(view.state, view.dispatch)
    // selectAll scrolls the full-document selection into view (the bottom),
    // which jump-scrolls the editor. Restore the prior scroll position on the
    // next frame once ProseMirror has performed its scrollIntoView.
    requestAnimationFrame(() => {
      editorContainer.scrollTop = scrollTop
    })
  }
}

function hasEditorSelection(): boolean {
  const selection = blockEditor?.getView().state.selection
  return !!selection && !selection.empty
}

/**
 * Build the right-click menu for a point in the document. Always starts with
 * the standard editing commands, then appends block-specific actions for the
 * element under the pointer: Run/Stop + Copy source for runnable code blocks,
 * commit back to visual mode for source-mode blocks, and Edit source for
 * visual-mode blocks with a known position (e.g. Mermaid diagrams).
 */
function buildContextMenu(event: MouseEvent): ContextMenuEntry[] {
  const view = blockEditor?.getView()
  // Only offer undo/redo when there is actually history to traverse; a
  // enabled-but-no-op Redo just looks broken.
  const undoable = !!view && undoDepth(view.state) > 0
  const redoable = !!view && redoDepth(view.state) > 0
  const entries: ContextMenuEntry[] = [
    { type: 'item', label: 'Undo', disabled: !undoable, onSelect: () => editUndoNoScroll() },
    { type: 'item', label: 'Redo', disabled: !redoable, onSelect: () => editRedoNoScroll() },
    { type: 'separator' },
    {
      type: 'item',
      label: 'Cut',
      disabled: !hasEditorSelection(),
      onSelect: () => editCut(),
    },
    {
      type: 'item',
      label: 'Copy',
      disabled: !hasEditorSelection(),
      onSelect: () => editCopy(),
    },
    { type: 'item', label: 'Paste', onSelect: () => void editPaste() },
    { type: 'item', label: 'Select all', onSelect: () => editSelectAll() },
  ]
  if (event.target instanceof Element) {
    const blockEntries = buildBlockMenuItems(event.target)
    if (blockEntries.length > 0) {
      entries.push({ type: 'separator' })
      entries.push(...blockEntries)
    }
  }
  return entries
}

function buildBlockMenuItems(target: Element): ContextMenuEntry[] {
  const view = blockEditor?.getView()
  if (!view) return []
  const entries: ContextMenuEntry[] = []
  const addItem = (
    label: string,
    onSelect: () => void,
    extra: Partial<Pick<ContextMenuItem, 'disabled' | 'danger'>> = {},
  ): void => {
    entries.push({ type: 'item', label, onSelect, ...extra })
  }

  const runnable = target.closest('.runnable-block')
  if (runnable) {
    const runButton = runnable.querySelector<HTMLButtonElement>('.exec-run')
    if (runButton) {
      const running = runButton.classList.contains('exec-stop')
      addItem(running ? 'Stop' : 'Run', () => runButton.click())
    }
    const source = runnable.querySelector<HTMLElement>('.runnable-source')
    if (source?.textContent !== null && source?.textContent !== undefined) {
      const text = source.textContent
      addItem('Copy source', () => {
        void copyText(text)
      })
    }
    return entries
  }

  if (target.closest('.block-source-mode')) {
    // Source/visual (Mermaid) mode: commit the edited source back to the
    // document and leave source mode, exactly like the toolbar exit button.
    addItem('Visual mode', () => {
      const tr = commitSourceMode(view)
      if (tr) view.dispatch(tr)
    })
    return entries
  }

  const visual = target.closest('.mermaid, .block-visual-mode')
  if (visual) {
    const img = visual.querySelector<HTMLImageElement>('.mermaid-img')
    const svg = visual.querySelector<SVGSVGElement>('.mermaid svg[id]')
    if (img ?? svg) {
      addItem('Copy image', () => {
        void copyMermaidAsImage(img ?? (svg as SVGSVGElement)).then((result) => {
          if (!result.ok) showError(result.error ?? 'Could not copy image')
        })
      })
      addItem('Save image…', () => {
        const active = getActive()
        const base = active?.path ? fileName(active.path) : UNTITLED
        void saveMermaidAsImage(img ?? (svg as SVGSVGElement), base).then((result) => {
          if (!result.ok) {
            showError(result.error ?? 'Could not save image')
          } else if (result.path) {
            flashStatus(`Saved ${result.path}`)
          }
        })
      })
    }
    const handle = visual.querySelector<HTMLElement>('.block-handle[data-block-pos]')
    const pos = handle ? Number(handle.dataset.blockPos) : NaN
    if (Number.isInteger(pos) && pos >= 0 && pos < view.state.doc.content.size) {
      addItem('Edit source', () => {
        view.dispatch(toggleSourceMode(view.state, pos))
      })
    }
  }
  return entries
}

function init(): void {
  blockEditor = createBlockEditor(editorContainer, '', {
    onOpenLink: openLink,
    onChange: () => setActiveDirty(true),
    resolveImageSrc: resolveImageFileUrl,
  })
  formatToolbar = new FormatToolbar(formatBar, {
    getView: () => blockEditor!.getView(),
  })
  homeScreen = buildHomeScreen()
  registerShortcuts()
  // Right-click opens a custom menu (the browser's native one is suppressed by
  // the desktop shell). On the home screen there is no document to act on.
  editorContainer.addEventListener('contextmenu', (event) => {
    if (getState().sessions.length === 0) return
    event.preventDefault()
    contextMenu ??= new ContextMenu()
    contextMenu.show(buildContextMenu(event), event.clientX, event.clientY)
  })
  // Drive content from the native shell (QWebChannel): the desktop shell loads
  // documents and the smoke/selftest harness drives headless runs via this hook.
  window.ediSetContent = (markdown: string) => {
    if (getState().sessions.length === 0) {
      // A document arrived on the home screen: create a tab for it.
      tabs.addSession(markdown)
    } else {
      // Loads the document into the current tab: reset its scroll to top and
      // record that the view now holds this session's content.
      tabs.setActiveContent(markdown)
      editorContainer.scrollTop = 0
    }
    tabs.snapshotActive()
    afterActivate()
  }
  bindMenuCommands({
    new: () => openNewTab(),
    open: () => void openFile(),
    save: () => void saveFile(),
    saveAs: () => void saveFileAs(),
    revert: () => void revertFile(),
    importTable: () => void importTable(),
    importText: () => void importTextFile(),
    insertImage: () => void insertImage(),
    export: () => void exportHtml(),
    toggleFormatting: () => toggleFormatting(),
    undo: () => editUndo(),
    redo: () => editRedo(),
    cut: () => editCut(),
    copy: () => editCopy(),
    paste: () => void editPaste(),
    selectAll: () => editSelectAll(),
  })
  startThemeWatcher()
  subscribe(() => {
    updateView()
    updateTitle()
    updateStatus()
    syncDirty()
    syncMenuState()
  })
  // Re-resolve relative image references when the active document's path
  // changes (e.g. Save As into a different directory) so they keep pointing at
  // the current document's directory.
  let lastImagePath: string | null = getActive()?.path ?? null
  subscribe(() => {
    const path = getActive()?.path ?? null
    if (path !== lastImagePath) {
      lastImagePath = path
      blockEditor?.resolveImages()
    }
  })
  if (IS_SELFTEST) {
    // The packaged smoke test probes the rendered editor + mermaid diagram, so
    // boot the welcome document into a tab instead of the home screen.
    openWelcome()
  }
  refreshRecents()
  // The subscribe() below only runs on state transitions; boot has none, so
  // render the initial view (home) explicitly.
  updateView()
  syncDirty()
  afterActivate()
}

init()
