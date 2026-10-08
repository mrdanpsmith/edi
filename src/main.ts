import 'prosemirror-view/style/prosemirror.css'
import 'prosemirror-gapcursor/style/gapcursor.css'
import './styles.css'

import { confirmAction, hasBridge, invoke, showError } from './bridge'
import { startThemeWatcher } from './theme'

import { buildExportHtml, serializeDocToHtml } from './export'
import { redoDepth, redoNoScroll, undoDepth, undoNoScroll } from 'prosemirror-history'
import { selectAll } from 'prosemirror-commands'
import { TextSelection } from 'prosemirror-state'
import {
  dirname,
  fileName,
  getPendingFiles,
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
  renameTextFile,
  UNTITLED,
  writeTextFile,
} from './files'
import { parseTableFile, toMarkdownTable } from './import'
import { insertPastedText, pasteAsMarkdown } from './paste'
import { EditorView } from '@codemirror/view'
import type { Node as ProseNode } from 'prosemirror-model'
import type { EditorView as ProseEditorView } from 'prosemirror-view'
import { EditorSelection } from '@codemirror/state'
import { undo as cmUndo, redo as cmRedo } from '@codemirror/commands'
import { copyText, readText, writeClipboard } from './clipboard'
import { copyMermaidAsImage, saveMermaidAsImage } from './mermaid'
import { ContextMenu, type ContextMenuEntry, type ContextMenuItem } from './contextmenu'
import {
  blockModeFor,
  blockPosForElement,
  modeFor,
  toggleBlockMode,
  type BlockMode,
} from './block-modes'
import { isMisleadingLink } from './linkSecurity'
import { applyLink, NEW_ICON, OPEN_ICON, SAVE_AS_ICON, SAVE_ICON, Toolbar } from './toolbar'
import { bindMenuCommands } from './menus'
import {
  applyZoom,
  canZoomIn,
  canZoomOut,
  clampZoom,
  DEFAULT_ZOOM,
  formatZoom,
  isDefaultZoom,
  loadZoom,
  saveZoom,
  zoomIn,
  zoomOut,
} from './zoom'
import { BUILTIN_FORMULAS } from './formulas'
import { documentFunctionsFor, formulaEnvFor } from './formulaDefs'
import { serializeBlock } from './markdown'
import { promptForEncryptedBlockLabel, promptForNewPassword } from './crypto-dialog'
import { encryptFieldVerified } from './crypto'
import { buildFunctionReferenceMarkdown } from './formulaReference'
import { buildHelpGuideMarkdown } from './helpGuide'
import welcomeMarkdown from './docs/welcome.md?raw'
import { createBlockEditor, type BlockEditor, linkRangeAt, type LinkRange } from './editor'
import { setEncryptedBlockImageResolver, primeEncryptedBlockShow, getActiveEncryptedBlockView } from './node/encryptedblock'
import { SearchPanel } from './searchPanel'
import { insertTable as insertSpreadsheetTable, setTableForm, spreadsheetMenuEntries, tableFormOf } from './node/table'
import { insertKanbanBoard } from './node/mermaid'
import { findSessionByPath, getActive, getState, isAnyDirty, setActiveDirty, setActivePath, subscribe } from './state'
import { headingSlug } from './schema'
import { HomeScreen } from './home'
import { addRecentFile, getRecentFiles } from './recents'
import { promptForLink, promptForRename } from './urlDialog'
import { Tabs } from './tabs'

const IS_SELFTEST = new URLSearchParams(window.location.search).has('selftest')

/** Comma-separated builtin names for the Welcome document, generated from the
 * registry so the list can never drift from what the evaluator supports. */
const WELCOME_FUNCTIONS = BUILTIN_FORMULAS.map((fn) => `\`${fn.name}\``).join(', ')

const WELCOME_DOCUMENT = welcomeMarkdown.replace('{{BUILTIN_FUNCTIONS}}', WELCOME_FUNCTIONS)

const editorContainer = document.querySelector<HTMLElement>('#editor-container')!
const toolbarEl = document.querySelector<HTMLElement>('#toolbar')!
const statusLeft = document.querySelector<HTMLElement>('#status-left')!
const statusMode = document.querySelector<HTMLElement>('#status-mode')!
const statusRight = document.querySelector<HTMLElement>('#status-right')!
const statusZoom = document.querySelector<HTMLButtonElement>('#status-zoom')!
const tabbar = document.querySelector<HTMLElement>('#tabbar')!

let lastNativeTitle = ''

/** The current document zoom (see `src/zoom.ts`). */
let documentZoom = DEFAULT_ZOOM

let blockEditor: BlockEditor | null = null
let toolbar: Toolbar | null = null
let homeScreen: HomeScreen | null = null
let contextMenu: ContextMenu | null = null
let searchPanel: SearchPanel | null = null

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

/**
 * The status chip: which block is in a mode, and what that mode is called.
 *
 * It needs an element of its own because `#status-left` is the transient flash
 * slot — `flashStatus` overwrites it and `updateStatus` clears it after three
 * seconds — so a chip living there would flash away. It is written only from the
 * plugin's own state changes (`onModeChange`), never from a flash, and it says
 * *what* is in a mode; the accent rule on the block itself is the in-document
 * half that says *where* (§7.2).
 */
function renderModeChip(mode: BlockMode | null): void {
  if (!statusMode) return
  const view = mode !== null ? blockEditor?.getView() : undefined
  const node = mode !== null && view !== undefined ? view.state.doc.nodeAt(mode.pos) : null
  if (mode === null || node === null || node === undefined) {
    statusMode.textContent = ''
    statusMode.hidden = true
    return
  }
  const source = mode.representation === 'source'
  const words = modeChipWords(node)
  statusMode.hidden = false
  const name = source ? 'Source' : 'Edit'
  statusMode.textContent = words === ''
    ? name
    : `${name} — “${words}”${source ? ' · Esc for visual' : ''}`
}

/** A few words of the block itself, so the chip names *which* block it is about. */
function modeChipWords(node: ProseNode): string {
  const text = node.type.name === 'mermaid_block'
    ? String(node.attrs.value ?? '').split('\n', 1)[0] ?? ''
    : node.textContent
  const trimmed = text.replace(/\s+/g, ' ').trim()
  if (trimmed === '') return ''
  return trimmed.length > 40 ? `${trimmed.slice(0, 39)}…` : trimmed
}

function updateZoomIndicator(): void {
  statusZoom.textContent = formatZoom(documentZoom)
  statusZoom.hidden = isDefaultZoom(documentZoom)
}

function setZoom(factor: number): void {
  documentZoom = clampZoom(factor)
  applyZoom(documentZoom)
  saveZoom(documentZoom)
  updateZoomIndicator()
  syncMenuState()
}

function zoomTo(level?: string): void {
  const factor = Number(level)
  if (Number.isFinite(factor)) setZoom(factor)
}

let lastZoomWheel = 0

/**
 * Ctrl+wheel / trackpad pinch zooms the document. It is throttled so a single
 * gesture is a step, not a burst, and `preventDefault` keeps Chromium's
 * whole-page zoom (which would scale the tab bar too) from firing.
 */
function onZoomWheel(event: WheelEvent): void {
  if (!(event.ctrlKey || event.metaKey)) return
  event.preventDefault()
  const now = Date.now()
  if (now - lastZoomWheel < 100) return
  lastZoomWheel = now
  if (event.deltaY < 0) setZoom(zoomIn(documentZoom))
  else if (event.deltaY > 0) setZoom(zoomOut(documentZoom))
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
    canCopyPath: Boolean(active?.path),
    canRename: Boolean(active?.path),
    toolbarVisible: toolbar?.isVisible() ?? true,
    zoomFactor: documentZoom,
    canZoomIn: canZoomIn(documentZoom),
    canZoomOut: canZoomOut(documentZoom),
  }).catch(() => undefined)
}

function insertMarkdown(markdown: string): void {
  blockEditor?.insertMarkdown(markdown)
}

function insertTable(markdown: string): void {
  insertMarkdown(`\n${markdown}\n`)
}

function insertTableDefault(): void {
  const view = blockEditor?.getView()
  if (!view) return
  insertSpreadsheetTable(view, 3, 3)
  setActiveDirty(true)
}

async function insertKanban(): Promise<void> {
  const view = blockEditor?.getView()
  if (!view) return
  if (await insertKanbanBoard(view)) setActiveDirty(true)
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
    const bodyHtml = serializeDocToHtml(doc, formulaEnvFor(blockEditor!.getView().state))
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

function openFunctionReference(): void {
  const state = blockEditor?.getState()
  tabs.addSession(buildFunctionReferenceMarkdown(state ? documentFunctionsFor(state) : []))
  afterActivate()
}

function openHelpGuide(): void {
  tabs.addSession(buildHelpGuideMarkdown())
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

/**
 * Open files Edi was launched with (e.g. a .md double-clicked in the file
 * manager, delivered as command-line arguments and surfaced via the bridge).
 * Runs after the bridge is up; unsupported extensions are ignored so a stray
 * argument never pops an error dialog on an otherwise clean launch.
 */
async function openPendingFiles(): Promise<void> {
  const paths = await getPendingFiles().catch(() => undefined)
  if (!paths || paths.length === 0) return
  for (const path of paths) {
    if (isSupportedFile(path)) {
      await openDocument(path)
    }
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

function scrollToFragment(fragment: string): void {
  let decoded: string
  try {
    decoded = decodeURIComponent(fragment)
  } catch {
    decoded = fragment
  }
  const candidates = [decoded]
  const slugged = headingSlug(decoded)
  if (slugged && slugged !== decoded) candidates.push(slugged)
  for (const id of candidates) {
    const el = document.getElementById(id)
    if (el) {
      el.scrollIntoView({ block: 'start' })
      return
    }
  }
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
  const hashIndex = href.indexOf('#')
  const fragment = hashIndex >= 0 ? href.slice(hashIndex + 1) : ''
  if (hashIndex === 0) {
    // Fragment-only link: an anchor within the same document.
    if (fragment) scrollToFragment(fragment)
    return
  }
  const target = resolveInternalPath(href)
  if (!target) return
  if (isSupportedFile(target)) {
    await openDocument(target)
    if (fragment) {
      // Wait for the swapped-in document to render before scrolling.
      requestAnimationFrame(() => requestAnimationFrame(() => scrollToFragment(fragment)))
    }
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
    afterSave(path)
  } catch (error) {
    reportError(`Failed to save ${path}`, error)
  }
}

/** The document is on disk under `path` and clean: everything that follows. */
function afterSave(path: string): void {
  setActivePath(path)
  setActiveDirty(false)
  updateTitle()
  updateStatus()
  syncDirty()
  syncMenuState()
  void rememberRecent(path)
}

/**
 * Rename the document in place: the same folder, a new name, and the old file
 * gone. The write and the delete are one backend call, so the document is never
 * left on disk under both names or under neither — a rename is not a Save As
 * plus a delete the page can fail between.
 */
async function renameFile(): Promise<void> {
  const oldPath = getActive()?.path
  if (!oldPath) return
  const currentName = oldPath.split('/').pop() ?? oldPath
  const name = await promptForRename(currentName)
  if (name === null) return
  const newPath = oldPath.includes('/') ? `${dirname(oldPath)}/${name}` : name
  if (!isSupportedFile(newPath)) {
    await confirmAction(`"${name}" does not have a supported extension.\n\nContinue anyway?`)
  }
  try {
    const md = blockEditor?.getMarkdown() ?? ''
    await renameTextFile(oldPath, newPath, md)
    afterSave(newPath)
    flashStatus(`Renamed to ${name}`)
  } catch (error) {
    reportError(`Failed to rename ${oldPath}`, error)
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

/** Copy the path of the document in view; a no-op for an unsaved one. */
function copyFilePath(): void {
  const path = getActive()?.path
  if (path) void copyText(path)
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
    } else if (key === '=' || key === '+') {
      event.preventDefault()
      setZoom(zoomIn(documentZoom))
    } else if (key === '-' || key === '_') {
      event.preventDefault()
      setZoom(zoomOut(documentZoom))
    } else if (key === '0') {
      event.preventDefault()
      setZoom(DEFAULT_ZOOM)
    } else if (key === 'c' && event.shiftKey && event.altKey) {
      event.preventDefault()
      copyFilePath()
    } else if (key === 'c' && event.shiftKey) {
      event.preventDefault()
      copyAsMarkdown()
    } else if (key === 'a' && !event.defaultPrevented) {
      // Focus the editor and select all. When the editor already had focus,
      // ProseMirror's own Mod-a keymap handles it (and preventDefault), so
      // this only kicks in when focus is elsewhere (e.g. the toolbar)
      // where the browser would otherwise select the whole window.
      if (!(document.activeElement instanceof HTMLInputElement) &&
          !(document.activeElement instanceof HTMLTextAreaElement)) {
        event.preventDefault()
        editSelectAll()
      }
    } else if (key === 'f') {
      event.preventDefault()
      openSearch()
    } else if (key === 'h') {
      event.preventDefault()
      openSearch(true)
    } else if (key === 'v' && event.shiftKey) {
      // While a dialog or a CodeMirror source editor owns focus, its own paste
      // belongs there — never steal it.
      const active = document.activeElement
      const inforeign =
        active instanceof HTMLElement &&
        !!active.closest('.edi-dialog-overlay, .cm-editor, input, textarea')
      if (!inforeign) {
        event.preventDefault()
        void pasteAsMarkdownCommand()
      }
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

function toggleToolbar(): void {
  toolbar?.toggle()
  syncMenuState()
}

function openSearch(replace = false): void {
  if (getState().sessions.length === 0) return
  searchPanel?.open({ replace })
}

// Menu-triggered undo/redo must not scroll: the transaction is dispatched with
// scrollIntoView=false so the viewport stays put (undoNoScroll/redoNoScroll).
// Reaching for the menu (or a context menu) means the pointer is away from the
// content, so yanking the viewport to the restored selection is disorienting;
// keyboard undo keeps its scroll-to-change behavior via the editor keymap.
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

function copyAsMarkdown(): void {
  const editor = blockEditor
  const view = editor?.getView()
  if (!editor || !view || view.state.selection.empty) return
  view.focus()
  void copyText(editor.getSelectionMarkdown())
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

async function pasteAsMarkdownCommand(): Promise<void> {
  const view = blockEditor?.getView()
  if (!view) return
  view.focus()
  const text = await readText()
  if (!pasteAsMarkdown(view, text)) await editPaste()
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
 * Build the right-click menu for a point in the document. Spreadsheet text
 * inputs get editing commands scoped to the cell; other spreadsheet targets
 * (a selected cell, the chrome) get only the spreadsheet actions, since the
 * generic document commands would silently act on the whole table block.
 * Everything else gets the standard editing commands plus any block-specific
 * actions for the element under the pointer.
 */
function buildContextMenu(event: MouseEvent): ContextMenuEntry[] {
  const target = event.target instanceof Element ? event.target : null
  const input = target?.closest<HTMLInputElement | HTMLTextAreaElement>('.ss-edit-input, .ss-fx-input, .masked-field-input, .mermaid-edit-input') ?? null
  let entries: ContextMenuEntry[]
  if (input) {
    entries = buildInputMenu(input)
  } else if (target?.closest('.cm-editor')) {
    entries = buildSourceEditorMenu(target)
  } else if (target?.closest('.spreadsheet, .ss-plain')) {
    // The node view owns the grid's editing commands; the plain/read-only
    // view has none, so it falls through to the block actions alone.
    entries = spreadsheetMenuEntries(target) ?? []
  } else {
    entries = buildDocumentMenu(target)
  }
  if (target) {
    const blockEntries = buildBlockMenuItems(target)
    if (blockEntries.length > 0) {
      if (entries.length > 0) entries.push({ type: 'separator' })
      entries.push(...blockEntries)
    }
  }
  return entries
}

/** Standard editing commands scoped to the focused spreadsheet input. */
function buildInputMenu(input: HTMLInputElement | HTMLTextAreaElement): ContextMenuEntry[] {
  const hasSelection = input.selectionStart !== input.selectionEnd
  const canUndo = typeof document.execCommand === 'function'
  return [
    {
      type: 'item',
      label: 'Undo',
      disabled: !canUndo,
      onSelect: () => runInputHistory(input, 'undo'),
    },
    {
      type: 'item',
      label: 'Redo',
      disabled: !canUndo,
      onSelect: () => runInputHistory(input, 'redo'),
    },
    { type: 'separator' },
    {
      type: 'item',
      label: 'Cut',
      disabled: !hasSelection,
      onSelect: () => cutInput(input),
    },
    {
      type: 'item',
      label: 'Copy',
      disabled: !hasSelection,
      onSelect: () => copyInput(input),
    },
    { type: 'item', label: 'Paste', onSelect: () => void pasteIntoInput(input) },
    { type: 'item', label: 'Select all', onSelect: () => input.select() },
  ]
}

function inputSelection(input: HTMLInputElement | HTMLTextAreaElement): { text: string; start: number; end: number } {
  const start = input.selectionStart ?? 0
  const end = input.selectionEnd ?? start
  return { text: input.value.slice(start, end), start, end }
}

function runInputHistory(input: HTMLInputElement | HTMLTextAreaElement, command: 'undo' | 'redo'): void {
  input.focus()
  if (typeof document.execCommand === 'function') document.execCommand(command)
}

function copyInput(input: HTMLInputElement | HTMLTextAreaElement): void {
  const { text } = inputSelection(input)
  if (text) void copyText(text)
}

function cutInput(input: HTMLInputElement | HTMLTextAreaElement): void {
  const { text, start, end } = inputSelection(input)
  if (!text) return
  void copyText(text)
  input.setRangeText('', start, end, 'start')
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.focus()
}

/** Standard editing commands scoped to the right-clicked CodeMirror source editor. */
function buildSourceEditorMenu(target: Element): ContextMenuEntry[] {
  const el = target.closest<HTMLElement>('.cm-editor')
  const cmView = el ? EditorView.findFromDOM(el) : null
  const sel = cmView?.state.selection.main
  const hasSelection = !!sel && !sel.empty
  return [
    { type: 'item', label: 'Undo', onSelect: () => { if (cmView) cmUndo(cmView) } },
    { type: 'item', label: 'Redo', onSelect: () => { if (cmView) cmRedo(cmView) } },
    { type: 'separator' },
    {
      type: 'item',
      label: 'Cut',
      disabled: !hasSelection,
      onSelect: () => {
        if (!cmView || !sel || sel.empty) return
        void copyText(cmView.state.sliceDoc(sel.from, sel.to))
        cmView.dispatch({ changes: { from: sel.from, to: sel.to, insert: '' } })
        cmView.focus()
      },
    },
    {
      type: 'item',
      label: 'Copy',
      disabled: !hasSelection,
      onSelect: () => {
        if (!cmView || !sel || sel.empty) return
        void copyText(cmView.state.sliceDoc(sel.from, sel.to))
        cmView.focus()
      },
    },
    {
      type: 'item',
      label: 'Paste',
      onSelect: () => {
        if (!cmView) return
        void readText().then((text) => {
          if (text === null) return
          const range = cmView.state.selection.main
          cmView.dispatch({ changes: { from: range.from, to: range.to, insert: text } })
          cmView.focus()
        })
      },
    },
    { type: 'item', label: 'Select all', onSelect: () => cmView?.dispatch({ selection: EditorSelection.single(0, cmView.state.doc.length) }) },
  ]
}

async function pasteIntoInput(input: HTMLInputElement | HTMLTextAreaElement): Promise<void> {
  const text = await readText()
  if (text === null || text === '') return
  const { start, end } = inputSelection(input)
  input.setRangeText(text, start, end, 'end')
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.focus()
}

function buildDocumentMenu(target: Element | null = null): ContextMenuEntry[] {
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
    {
      type: 'item',
      label: 'Copy as Markdown',
      disabled: !hasEditorSelection(),
      onSelect: () => copyAsMarkdown(),
    },
    { type: 'item', label: 'Paste', onSelect: () => void editPaste() },
    { type: 'item', label: 'Paste as Markdown', onSelect: () => void pasteAsMarkdownCommand() },
    { type: 'item', label: 'Select all', onSelect: () => editSelectAll() },
  ]
  // A right-click on a link is how it is edited: a left-click opens it, and
  // the click plugin ignores every other button (see `createBlockEditor`), so
  // the context menu is the only place left to change one.
  const link = linkRangeForTarget(target)
  if (link) {
    entries.push(
      { type: 'item', label: 'Copy link', onSelect: () => void copyLink(link) },
      { type: 'separator' },
      { type: 'item', label: 'Edit link…', onSelect: () => editLink(link) },
    )
  }
  return entries
}

/** The link the right-click landed on, as its document range. */
function linkRangeForTarget(target: Element | null): LinkRange | null {
  const view = blockEditor?.getView()
  const anchor = target?.closest('a[href]')
  if (!view || !anchor || !view.dom.contains(anchor)) return null
  // The <a> ProseMirror drew *is* the mark's range, so the position at its
  // first child is a position inside the link -- which is all `linkRangeAt`
  // needs to walk out to the rest of the linked text, however many text nodes
  // emphasis in the label split it into.
  return linkRangeAt(view.state.doc, view.posAtDOM(anchor, 0))
}

/**
 * Copy the link covering `link`, the context menu's "Copy link".
 *
 * The href is the one in the document (a relative markdown target stays
 * relative), so what lands on the clipboard is what the source says, not a
 * URL resolved against the app. The range is read at menu-build time for the
 * same reason `editLink` does: that is the only moment the right-click's
 * target is around, and copying cannot move it anyway.
 */
async function copyLink(link: LinkRange): Promise<void> {
  if (await copyText(link.href)) flashStatus(`Copied ${link.href}`)
}

/**
 * Edit the link covering `link`, the context menu's "Edit link…".
 *
 * The range is resolved when the menu is built, because that is the only
 * moment the right-click's target element is around. The dialog's overlay
 * covers the editor, so nothing can move the link while it is up; it is
 * re-checked against the document once the dialog settles regardless, so a
 * range that no longer holds a link marks nothing at all.
 */
function editLink(link: LinkRange): void {
  const view = blockEditor?.getView()
  if (!view) return
  void promptForLink(link.text, link.href, { editing: true }).then((entered) => {
    if (entered === null) return
    const current = linkRangeAt(view.state.doc, link.from)
    if (!current) return
    // `applyLink` writes over the selection, so the range is selected first.
    // It also leaves the linked text selected, which is where the toolbar's
    // Link button picks the same link up from.
    view.dispatch(
      view.state.tr.setSelection(TextSelection.create(view.state.doc, current.from, current.to)),
    )
    view.focus()
    applyLink(view, entered.url, entered.text)
  })
}

/**
 * The block items of the context menu, generated from the block's own descriptor
 * rather than from a chain on its wrapper class names.
 *
 * Three names existed for source mode and two each for a diagram's edit mode and
 * a table's rendered form, all of them spelled per call site; and the block was
 * identified by a `data-block-pos` written into its dot grid when that grid was
 * built. Both problems have the same fix: ask `blockModeFor` what the block
 * supports, and ask the DOM for where the block is now. A right-click inside a
 * list item or a blockquote reaches this too, and works precisely because it no
 * longer needs a handle to identify the block it is in (§6.7).
 */
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

  const pos = blockPosForElement(view, target)
  if (pos < 0) return entries
  const node = view.state.doc.nodeAt(pos)
  if (node === null) return entries
  // The wrapper is still needed for two things that are about the *rendering*,
  // not the mode: a diagram's image to copy, and a runnable block's own controls.
  const wrapper = blockWrapperFor(view, target)

  const img = wrapper?.querySelector<HTMLImageElement>('.mermaid-img') ?? null
  const svg = wrapper?.querySelector<SVGSVGElement>('.mermaid svg[id]') ?? null
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

  const runnable = wrapper?.closest('.runnable-block') ?? null
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
  }

  const descriptor = blockModeFor(node)

  // A table's rendered form, labelled from the descriptor's own form list.
  if (descriptor.forms) {
    const other = descriptor.forms.find((form) => form.id !== tableFormOf(node))
    if (other) addItem(other.label, () => setTableForm(view, pos, other.id))
  }

  if (descriptor.interaction === 'toggle') {
    const editing = modeFor(view.state, pos)?.interaction === 'editing'
    addItem(editing ? 'Done' : 'Edit', () => {
      toggleBlockMode(view, pos, 'interaction')
    })
  }
  if (descriptor.representation) {
    const source = modeFor(view.state, pos)?.representation === 'source'
    addItem(source ? 'Visual' : 'Source', () => {
      toggleBlockMode(view, pos, 'representation')
    })
  }
  if (node.type.name !== 'encrypted_block') {
    addItem('Encrypt block…', () => { void encryptBlockAt(view, pos) })
  }
  return entries
}

/** The top-level block's own wrapper element, for the items about its rendering. */
function blockWrapperFor(view: ProseEditorView, target: Element): HTMLElement | null {
  let el: Element | null = target
  while (el && el !== view.dom && el.parentElement !== view.dom) {
    el = el.parentElement
  }
  return el instanceof HTMLElement && el !== view.dom ? el : null
}

function encryptBlockCommand(): void {
  const view = blockEditor?.getView()
  if (!view) return
  const selPos = view.state.selection.from
  let blockPos = -1
  view.state.doc.forEach((node, offset) => {
    if (blockPos >= 0) return
    if (selPos >= offset && selPos <= offset + node.nodeSize) blockPos = offset
  })
  if (blockPos < 0) return
  void encryptBlockAt(view, blockPos)
}

async function encryptBlockAt(view: ReturnType<BlockEditor['getView']>, pos: number): Promise<void> {
  const node = view.state.doc.nodeAt(pos)
  if (!node) return
  const labelResult = await promptForEncryptedBlockLabel(node.type.name)
  if (labelResult === null) return
  const label = labelResult.label
  const lockImmediately = labelResult.lockImmediately
  const password = await promptForNewPassword(label || node.type.name, { okText: 'Encrypt', title: 'Set password' })
  if (password === null) return
  const markdown = serializeBlock(node, formulaEnvFor(view.state))
  const envelope = await encryptFieldVerified(markdown, password)
  const encrypted = view.state.schema.nodes.encrypted_block.create({ type: node.type.name, label, content: envelope })
  view.dispatch(view.state.tr.replaceWith(pos, pos + node.nodeSize, encrypted))
  view.focus()
  // Unless "Lock immediately" was chosen, freshly encrypted blocks arrive
  // unlocked (no second lock).
  if (!lockImmediately) {
    primeEncryptedBlockShow(password)
    const nodeDom = view.nodeDOM(pos) ?? view.dom.querySelector('.encrypted-block')
    const toggle = nodeDom instanceof HTMLElement ? nodeDom.querySelector<HTMLButtonElement>('.encrypted-block-toggle') : null
    toggle?.click()
  }
}

function init(): void {
  // Document zoom is global and applied before the first paint of the editor.
  documentZoom = loadZoom()
  applyZoom(documentZoom)
  updateZoomIndicator()
  setEncryptedBlockImageResolver(resolveImageFileUrl)
  blockEditor = createBlockEditor(editorContainer, '', {
    onOpenLink: openLink,
    onChange: () => setActiveDirty(true),
    onModeChange: renderModeChip,
    resolveImageSrc: resolveImageFileUrl,
  })
  toolbar = new Toolbar(toolbarEl, { getView: () => getActiveEncryptedBlockView() ?? blockEditor!.getView() }, [
    { label: 'New', title: 'New (Ctrl+N)', markup: NEW_ICON, action: openNewTab },
    { label: 'Open', title: 'Open… (Ctrl+O)', markup: OPEN_ICON, action: () => void openFile() },
    { label: 'Save', title: 'Save (Ctrl+S)', markup: SAVE_ICON, action: () => void saveFile() },
    { label: 'Save As', title: 'Save As… (Ctrl+Shift+S)', markup: SAVE_AS_ICON, action: () => void saveFileAs() },
  ])
  homeScreen = buildHomeScreen()
  searchPanel = new SearchPanel({ getView: () => blockEditor?.getView() ?? null })
  registerShortcuts()
  // On `window`, not `#editor-container`: the start screen has no editor and
  // must zoom too, and a wheel that reached neither would fall through to
  // Chromium's whole-page zoom (which scales the status bar with it).
  window.addEventListener('wheel', onZoomWheel, { passive: false })
  statusZoom.addEventListener('click', () => setZoom(DEFAULT_ZOOM))
  // Right-click opens a custom menu (the browser's native one is suppressed by
  // the desktop shell). On the home screen there is no document to act on.
  editorContainer.addEventListener('contextmenu', (event) => {
    if (getState().sessions.length === 0) return
    event.preventDefault()
    const entries = buildContextMenu(event)
    if (entries.length === 0) return
    const target = event.target instanceof Element ? event.target : null
    const preserveFocus =
      target !== null && target.closest('.ss-edit-input, .ss-fx-input') !== null
    contextMenu ??= new ContextMenu()
    contextMenu.show(entries, event.clientX, event.clientY, { preserveFocus })
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
    rename: () => void renameFile(),
    revert: () => void revertFile(),
    importTable: () => void importTable(),
    importText: () => void importTextFile(),
    insertImage: () => void insertImage(),
    insertTableDefault: () => void insertTableDefault(),
    insertKanban: () => void insertKanban(),
    export: () => void exportHtml(),
    toggleToolbar: () => toggleToolbar(),
    zoomIn: () => setZoom(zoomIn(documentZoom)),
    zoomOut: () => setZoom(zoomOut(documentZoom)),
    zoomReset: () => setZoom(DEFAULT_ZOOM),
    zoomTo: (level) => zoomTo(level),
    formulaReference: () => openFunctionReference(),
    helpGuide: () => openHelpGuide(),
    undo: () => editUndoNoScroll(),
    redo: () => editRedoNoScroll(),
    cut: () => editCut(),
    copy: () => editCopy(),
    copyAsMarkdown: () => copyAsMarkdown(),
    paste: () => void editPaste(),
    pasteAsMarkdown: () => void pasteAsMarkdownCommand(),
    selectAll: () => editSelectAll(),
    encryptBlock: () => void encryptBlockCommand(),
    find: () => openSearch(),
    replace: () => openSearch(true),
    openRecent: (path) => {
      if (path) void openDocument(path)
    },
    copyFilePath: () => copyFilePath(),
  })
  startThemeWatcher()
  subscribe(() => {
    updateView()
    updateTitle()
    updateStatus()
    syncDirty()
    syncMenuState()
    // Re-base an open search on the newly activated/swapped document.
    searchPanel?.refresh()
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
  // Open any document Edi was launched with (silently ignored when there is
  // no native shell, e.g. plain `vite dev` in a browser).
  void openPendingFiles()
  // The subscribe() below only runs on state transitions; boot has none, so
  // render the initial view (home) explicitly.
  updateView()
  syncDirty()
  afterActivate()
}

init()
