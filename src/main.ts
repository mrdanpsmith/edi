import { confirmAction, hasBridge, invoke, onBridgeReady } from './bridge'
import { startThemeWatcher } from './theme'

import { dirname, isAbsolutePath, isSupportedFile, openUrl } from './files'
import { headingSlug } from './schema'
import { insertTable as insertSpreadsheetTable } from './node/table'
import { insertKanbanBoard } from './node/mermaid'
import { setEncryptedBlockImageResolver } from './node/encryptedblock'
import { createBlockEditor } from './editor'
import { encryptSelection } from './encrypt'
import { NEW_ICON, OPEN_ICON, PRINT_ICON, SAVE_AS_ICON, SAVE_ICON, Toolbar } from './toolbar'
import { bindMenuCommands } from './menus'
import { applyZoom, clampZoom, DEFAULT_ZOOM, zoomIn, zoomOut } from './zoom'
import { currentPreferences } from './preferences'
import { applyHoverBand, isHoverBandEnabled, setHoverBand } from './hoverBand'
import { documentFunctionsFor } from './formulaDefs'
import { buildFunctionReferenceMarkdown } from './formulaReference'
import { buildHelpGuideMarkdown } from './helpGuide'
import { buildWelcomeMarkdown } from './welcomeDoc'
import { SearchPanel } from './searchPanel'
import { getActive, getState, setActiveDirty, subscribe } from './state'
import { HomeScreen } from './home'
import { Tabs } from './tabs'
import { isMisleadingLink, launchConfirmation } from './linkSecurity'
import { ContextMenu } from './contextmenu'
import { createAppContext, type AppContext, type AppRoots } from './appContext'
import { createContextMenuController } from './contextMenuController'
import { createEditController, type EditController } from './editController'
import { createFileController, type FileController } from './fileController'
import { createZoomController, type ZoomController } from './zoomController'

function openNewTab(ctx: AppContext): void {
  ctx.tabs.addSession()
}

function openWelcome(ctx: AppContext): void {
  ctx.tabs.addSession(buildWelcomeMarkdown())
}

function openFunctionReference(ctx: AppContext): void {
  const state = ctx.blockEditor?.getState()
  ctx.tabs.addSession(buildFunctionReferenceMarkdown(state ? documentFunctionsFor(state) : []))
}

function openHelpGuide(ctx: AppContext): void {
  ctx.tabs.addSession(buildHelpGuideMarkdown())
}

function buildHomeScreen(ctx: AppContext, files: FileController): HomeScreen {
  return new HomeScreen(ctx.roots.homeScreen, {
    onNew: () => openNewTab(ctx),
    onOpen: () => void files.openFile(),
    onOpenWelcome: () => openWelcome(ctx),
    onExit: () => requestQuit(),
    onOpenRecent: (path) => void files.openDocument(path),
  })
}

async function closeTab(ctx: AppContext, id: string): Promise<void> {
  const session = getState().sessions.find((entry) => entry.id === id)
  if (
    session?.dirty &&
    !(await confirmAction('Discard unsaved changes and close this document?'))
  ) {
    return
  }
  ctx.tabs.close(id)
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

async function openLink(
  files: FileController,
  href: string,
  text: string,
): Promise<void> {
  // One question per click: a destination the user has already been shown and
  // accepted is not asked about a second time.
  let confirmed = false
  if (isMisleadingLink(href, text)) {
    const go = await confirmAction(
      `The link text "${text}" does not match its destination (${href}). Open it anyway?`,
    )
    if (!go) return
    confirmed = true
  }
  const launch = async (target: string, isLocalFile: boolean): Promise<void> => {
    const question = confirmed ? null : launchConfirmation(target, isLocalFile)
    if (question !== null && !(await confirmAction(question))) return
    void openUrl(target)
  }
  if (isExternalUrl(href)) {
    await launch(href, false)
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
    await files.openDocument(target)
    if (fragment) {
      // Wait for the swapped-in document to render before scrolling.
      requestAnimationFrame(() => requestAnimationFrame(() => scrollToFragment(fragment)))
    }
  } else {
    await launch(target, true)
  }
}

function insertTableDefault(ctx: AppContext): void {
  const view = ctx.blockEditor?.getView()
  if (!view) return
  insertSpreadsheetTable(view, 3, 3)
  setActiveDirty(true)
}

async function insertKanban(ctx: AppContext): Promise<void> {
  const view = ctx.blockEditor?.getView()
  if (!view) return
  if (await insertKanbanBoard(view)) setActiveDirty(true)
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

function toggleToolbar(ctx: AppContext): void {
  ctx.toolbar?.toggle()
  ctx.syncMenuState()
}

function toggleHoverBand(ctx: AppContext): void {
  setHoverBand(!isHoverBandEnabled())
  ctx.syncMenuState()
}

function openSearch(ctx: AppContext, replace = false): void {
  if (getState().sessions.length === 0) return
  // Resolve **now**, while the caret still says which document the reader is in:
  // opening the bar takes the focus away from it, and the panel holds it from then
  // on. See `SearchPanel.open`.
  ctx.searchPanel?.open({ replace })
}

function registerShortcuts(
  ctx: AppContext,
  edit: EditController,
  files: FileController,
  zoom: ZoomController,
): () => void {
  const onKeyDown = (event: KeyboardEvent): void => {
    if (!(event.ctrlKey || event.metaKey)) {
      return
    }
    const key = event.key.toLowerCase()
    if (key === 'n') {
      event.preventDefault()
      openNewTab(ctx)
    } else if (key === 'w') {
      event.preventDefault()
      void closeTab(ctx, ctx.tabs.activeId)
    } else if (key === 'o') {
      event.preventDefault()
      void files.openFile()
    } else if (key === 's' && event.shiftKey) {
      event.preventDefault()
      void files.saveFileAs()
    } else if (key === 's') {
      event.preventDefault()
      void files.saveFile()
    } else if (key === 'q') {
      event.preventDefault()
      void requestQuit()
    } else if (key === '=' || key === '+') {
      event.preventDefault()
      zoom.set(zoomIn(ctx.documentZoom))
    } else if (key === '-' || key === '_') {
      event.preventDefault()
      zoom.set(zoomOut(ctx.documentZoom))
    } else if (key === '0') {
      event.preventDefault()
      zoom.set(DEFAULT_ZOOM)
    } else if (key === 'c' && event.shiftKey && event.altKey) {
      event.preventDefault()
      files.copyFilePath()
    } else if (key === 'c' && event.shiftKey) {
      event.preventDefault()
      edit.copyAsMarkdown()
    } else if (key === 'f') {
      event.preventDefault()
      openSearch(ctx)
    } else if (key === 'h') {
      event.preventDefault()
      openSearch(ctx, true)
    } else if (key === 'v' && event.shiftKey) {
      if (!edit.focusIsForeign()) {
        event.preventDefault()
        void edit.pasteAsMarkdown()
      }
    } else if (key === 'c' || key === 'x' || key === 'v') {
      /* Cut, Copy and Paste are handled *here* rather than left to the browser, and
       * they have to be: the page has no other route for them.
       *
       * The shell's Edit menu items for these called the same functions, so a click
       * worked and the keyboard did nothing at all — which is not a shortcut that is
       * bound to the wrong thing, it is a shortcut that is bound to *nothing*. Qt
       * never claimed it (a `\t` in a QAction label gives the action no shortcut at
       * all), and ProseMirror has no `Mod-c` binding: it answers a native `copy`
       * DOM event, which a webview whose selection is managed in JavaScript does not
       * reliably produce. Nothing was handling it.
       *
       * So these three route to `edit.cut`/`edit.copy`/`edit.paste`, which is what the
       * menu items call — **including the rich-text payload**. `edit.copy` sends
       * `serializeForClipboard`'s HTML *and* its text through the bridge, so
       * `Ctrl+C` carries the document as rich text the way the menu always has, and
       * `Ctrl+Shift+C` stays plain Markdown, which is the difference between the
       * two keys and the reason both exist.
       */
      if (event.defaultPrevented || edit.focusIsForeign()) return
      event.preventDefault()
      if (key === 'c') edit.copy()
      else if (key === 'x') edit.cut()
      else void edit.paste()
    }
  }
  // `Ctrl+A` is Edit → Select All, so it is taken in the capture phase, before
  // ProseMirror, CodeMirror or a sheet grid can bind it to something else: the
  // key and the menu run the same `edit.selectAll()`. A native text field keeps
  // the browser's own select-all.
  const onSelectAllKey = (event: KeyboardEvent): void => {
    if (!(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey) return
    if (event.key.toLowerCase() !== 'a') return
    const active = document.activeElement
    if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return
    event.preventDefault()
    event.stopPropagation()
    edit.selectAll()
  }
  window.addEventListener('keydown', onSelectAllKey, true)
  window.addEventListener('keydown', onKeyDown)
  return () => {
    window.removeEventListener('keydown', onSelectAllKey, true)
    window.removeEventListener('keydown', onKeyDown)
  }
}

/**
 * Boot the page.
 *
 * Importing this module has no side effects: the roots are passed in, so tests
 * can build the DOM first, dispose one boot and attach another to the same
 * document. The thin `entry.ts` resolves the roots from the page.
 */
export function init(roots: AppRoots): () => void {
  const ctx = createAppContext(
    roots,
    new URLSearchParams(window.location.search).has('selftest'),
  )
  const files = createFileController(ctx)
  const edit = createEditController(ctx)
  const menus = createContextMenuController(ctx, edit)
  const zoom = createZoomController(ctx)
  let disposed = false
  let nativeBridge: typeof window.bridge = undefined

  // Document zoom is global and applied before the first paint of the editor.
  // The saved level comes from the shell, which injected it before this bundle
  // ran — so this read is synchronous, which is the only way an apply-here can
  // be first — and is clamped on the way in, since `Edi.conf` is a file a person
  // can edit. (It is not `localStorage`: the page's web profile is
  // off-the-record, so nothing stored there outlives the process. See
  // `src/preferences.ts`.)
  ctx.documentZoom = clampZoom(currentPreferences().zoomFactor)
  applyZoom(ctx.documentZoom)
  zoom.updateIndicator()
  // The hover band is on by default and read from the same place, before the
  // first paint for the same reason: the answer decides a pseudo-element's
  // existence, and a class added after the first hover would leave the first
  // hover band drawn for a reader who has already turned the band off.
  applyHoverBand(isHoverBandEnabled())
  setEncryptedBlockImageResolver(resolveImageFileUrl)
  ctx.blockEditor = createBlockEditor(roots.editorContainer, '', {
    onOpenLink: (href, text) => openLink(files, href, text),
    // Dirty means "not the document on disk", so undoing back to it is clean.
    onChange: () => setActiveDirty(!(ctx.blockEditor?.isAtSavedPoint() ?? false)),
    onModeChange: (mode) => ctx.renderModeChip(mode),
    resolveImageSrc: resolveImageFileUrl,
  })
  ctx.tabs = new Tabs(roots.tabbar, {
    getMarkdown(): string {
      ctx.blockEditor?.commitSource()
      return ctx.blockEditor?.getMarkdown() ?? ''
    },
    setMarkdown(value: string): void | Promise<void> {
      return ctx.blockEditor?.setMarkdown(value)
    },
    createState(markdown: string): unknown {
      return ctx.blockEditor?.createState(markdown)
    },
    getState(): unknown {
      // Same tab boundary as getMarkdown: commit any in-progress source-mode
      // content into the document before capturing the live editor state.
      ctx.blockEditor?.commitSource()
      return ctx.blockEditor?.getState()
    },
    setState(state: unknown): void | Promise<void> {
      return ctx.blockEditor?.applyState(state as import('prosemirror-state').EditorState)
    },
    // Read at the snapshot boundary, not at the swap: see `TabContent.flush`.
    flush(): void | Promise<void> {
      return ctx.blockEditor?.flushReveals()
    },
    // A document replaced from outside is not a tab being left: see `discardPending`.
    discardPending(): void {
      ctx.blockEditor?.discardPending()
    },
    getScroll(): number {
      return roots.editorContainer.scrollTop
    },
    setScroll(value: number): void {
      roots.editorContainer.scrollTop = value
    },
  }, {
    onNewTab: () => openNewTab(ctx),
    onCloseTab: (id) => void closeTab(ctx, id),
    onActivate: () => ctx.afterActivate(),
  })
  ctx.toolbar = new Toolbar(roots.toolbar, { getView: () => edit.focusedEditor() ?? ctx.blockEditor!.getView() }, [
    { label: 'New', title: 'New (Ctrl+N)', markup: NEW_ICON, action: () => openNewTab(ctx) },
    { label: 'Open', title: 'Open… (Ctrl+O)', markup: OPEN_ICON, action: () => void files.openFile() },
    { label: 'Save', title: 'Save (Ctrl+S)', markup: SAVE_ICON, action: () => void files.saveFile() },
    { label: 'Save As', title: 'Save As… (Ctrl+Shift+S)', markup: SAVE_AS_ICON, action: () => void files.saveFileAs() },
    { label: 'Print', title: 'Print… (Ctrl+P)', markup: PRINT_ICON, action: () => void files.printDocument() },
  ])
  ctx.homeScreen = buildHomeScreen(ctx, files)
  ctx.searchPanel = new SearchPanel({ getView: () => edit.focusedEditor() })
  const removeShortcuts = registerShortcuts(ctx, edit, files, zoom)
  // On `window`, not `#editor-container`: the start screen has no editor and
  // must zoom too, and a wheel that reached neither would fall through to
  // Chromium's whole-page zoom (which scales the status bar with it).
  const onWheel = (event: WheelEvent): void => zoom.onWheel(event)
  window.addEventListener('wheel', onWheel, { passive: false })
  const resetZoom = (): void => zoom.set(DEFAULT_ZOOM)
  roots.statusZoom.addEventListener('click', resetZoom)
  // Right-click opens a custom menu (the browser's native one is suppressed by
  // the desktop shell). On the home screen there is no document to act on.
  const onContextMenu = (event: MouseEvent): void => {
    if (getState().sessions.length === 0) return
    event.preventDefault()
    const entries = menus.buildContextMenu(event)
    if (entries.length === 0) return
    const target = event.target instanceof Element ? event.target : null
    const preserveFocus =
      target !== null && target.closest('.ss-edit-input, .ss-fx-input') !== null
    ctx.contextMenu ??= new ContextMenu()
    ctx.contextMenu.show(entries, event.clientX, event.clientY, { preserveFocus })
  }
  roots.editorContainer.addEventListener('contextmenu', onContextMenu)
  // Drive content from the native shell (QWebChannel): the desktop shell loads
  // documents and the smoke/selftest harness drives headless runs via this hook.
  const setContent = (markdown: string): void => {
    if (getState().sessions.length === 0) {
      // A document arrived on the home screen: create a tab for it.
      ctx.tabs.addSession(markdown)
    } else {
      // Loads the document into the current tab, scrolled to the top. The
      // scroll is `setActiveContent`'s to apply: it settles the scroll on the
      // document that has *arrived*, and a swap that had to wait would
      // otherwise leave the reader at the top of the one being left.
      ctx.tabs.setActiveContent(markdown)
    }
    ctx.tabs.snapshotActive()
  }
  window.ediSetContent = setContent
  bindMenuCommands({
    new: () => openNewTab(ctx),
    open: () => void files.openFile(),
    save: () => void files.saveFile(),
    saveAs: () => void files.saveFileAs(),
    rename: () => void files.renameFile(),
    revert: () => void files.revertFile(),
    importTable: () => void files.importTable(),
    importText: () => void files.importTextFile(),
    insertImage: () => void files.insertImage(),
    insertTableDefault: () => void insertTableDefault(ctx),
    insertKanban: () => void insertKanban(ctx),
    export: () => void files.exportHtml(),
    print: () => void files.printDocument(),
    toggleToolbar: () => toggleToolbar(ctx),
    toggleHoverBand: () => toggleHoverBand(ctx),
    zoomIn: () => zoom.set(zoomIn(ctx.documentZoom)),
    zoomOut: () => zoom.set(zoomOut(ctx.documentZoom)),
    zoomReset: () => zoom.set(DEFAULT_ZOOM),
    zoomTo: (level) => zoom.setFromLevel(level),
    formulaReference: () => openFunctionReference(ctx),
    helpGuide: () => openHelpGuide(ctx),
    undo: () => edit.undo(),
    redo: () => edit.redo(),
    cut: () => edit.cut(),
    copy: () => edit.copy(),
    copyAsMarkdown: () => edit.copyAsMarkdown(),
    paste: () => void edit.paste(),
    pasteAsMarkdown: () => void edit.pasteAsMarkdown(),
    selectAll: () => edit.selectAll(),
    encrypt: () => {
      const view = edit.focusedEditor()
      if (view) void encryptSelection(view)
    },
    find: () => openSearch(ctx),
    replace: () => openSearch(ctx, true),
    openRecent: (path) => {
      if (path) void files.openDocument(path)
    },
    copyFilePath: () => files.copyFilePath(),
  })
  const stopTheme = startThemeWatcher()
  const unsubscribeState = subscribe(() => {
    ctx.updateView()
    ctx.updateTitle()
    ctx.updateStatus()
    ctx.syncDirty()
    ctx.syncMenuState()
    // Re-base an open search on the newly activated/swapped document.
    ctx.searchPanel?.refresh()
  })
  // Re-resolve relative image references when the active document's path
  // changes (e.g. Save As into a different directory) so they keep pointing at
  // the current document's directory.
  let lastImagePath: string | null = getActive()?.path ?? null
  const unsubscribeImages = subscribe(() => {
    const path = getActive()?.path ?? null
    if (path !== lastImagePath) {
      lastImagePath = path
      ctx.blockEditor?.resolveImages()
    }
  })
  if (ctx.selftest) {
    // The packaged smoke test probes the rendered editor + mermaid diagram, so
    // boot the welcome document into a tab instead of the home screen.
    openWelcome(ctx)
  }
  files.refreshRecents()
  // Register the shell-event listener *before* asking for pending files: an
  // open event that arrives during boot is queued by the shell until the first
  // getPendingFiles call marks this page ready, so neither path can lose it.
  onBridgeReady((bridge) => {
    if (disposed) return
    nativeBridge = bridge
    bridge?.notify?.connect(files.onNativeEvent)
  })
  // Open any document Edi was launched with (silently ignored when there is
  // no native shell, e.g. plain `vite dev` in a browser).
  void files.openPendingFiles()
  // The subscribe() below only runs on state transitions; boot has none, so
  // render the initial view (home) explicitly.
  ctx.updateView()
  ctx.syncDirty()
  ctx.afterActivate()

  return () => {
    disposed = true
    removeShortcuts()
    window.removeEventListener('wheel', onWheel)
    roots.statusZoom.removeEventListener('click', resetZoom)
    roots.editorContainer.removeEventListener('contextmenu', onContextMenu)
    unsubscribeState()
    unsubscribeImages()
    nativeBridge?.notify?.disconnect?.(files.onNativeEvent)
    stopTheme()
    ctx.contextMenu?.hide()
    ctx.blockEditor?.destroy()
    ctx.tabs.destroy()
    if (window.ediSetContent === setContent) delete window.ediSetContent
  }
}
