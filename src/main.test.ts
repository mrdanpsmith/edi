import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EditorState, TextSelection } from 'prosemirror-state'
import { Plugin } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { history, undo } from 'prosemirror-history'
import { schema } from './schema'
import { EditorView as CMEditorView } from '@codemirror/view'
import { EditorState as CMEditorState } from '@codemirror/state'
import { markdownToProse, proseToMarkdown } from './markdown'
import { type ContextMenuEntry } from './contextmenu'
import type { BlockMode } from './block-modes'


const zeroRect = {
  top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0,
  toJSON: () => ({}),
} as DOMRect

function stubLayout() {
  // jsdom lacks layout support; ProseMirror's scrollToSelection calls
  // coordsAtPos → singleRect → getClientRects/getBoundingClientRect.
  // Stub these on Element and Range so pasteHTML doesn't blow up in tests.
  const fakeRectList = Object.assign([zeroRect], {
    item: () => zeroRect,
  }) as unknown as DOMRectList
  Element.prototype.getClientRects = () => fakeRectList
  Element.prototype.getBoundingClientRect = () => zeroRect
  Range.prototype.getClientRects = () => fakeRectList
  Range.prototype.getBoundingClientRect = () => zeroRect
}

const mainState = vi.hoisted(() => {
  const editorView = {
    state: {
      doc: { textContent: 'Welcome' },
      tr: { insertText: vi.fn().mockReturnThis(), replaceWith: vi.fn().mockReturnThis() },
    },
    dispatch: vi.fn(),
    focus: vi.fn(),
  }

  return {
    // Kept so every test can start from the stub view: a test that mounts a
    // real one (the mermaid and link menus) would otherwise leak its
    // selection into the next test's Cut/Copy enabled state.
    defaultEditorView: editorView,
    hasBridge: vi.fn(() => false),
    invoke: vi.fn().mockResolvedValue(undefined),
    confirmAction: vi.fn().mockResolvedValue(true),
    showError: vi.fn().mockResolvedValue(undefined),
    pickOpenPath: vi.fn(),
    getPendingFiles: vi.fn().mockResolvedValue([]),
    readTextFile: vi.fn(),
    pickSavePath: vi.fn(),
    writeTextFile: vi.fn(),
    renameTextFile: vi.fn(),
    promptForRename: vi.fn(),
    promptForLink: vi.fn(),
    pickExportPath: vi.fn(),
    pickImageImportPath: vi.fn(),
    pickImportPath: vi.fn(),
    pickTextImportPath: vi.fn(),
    readAnyTextFile: vi.fn(),
    getRecentFiles: vi.fn().mockResolvedValue([]),
    addRecentFile: vi.fn().mockResolvedValue(undefined),
    copyText: vi.fn().mockResolvedValue(true),
    readText: vi.fn().mockResolvedValue('PASTED'),
    spreadsheetMenuEntries: vi.fn<(target: EventTarget | null) => ContextMenuEntry[] | null>(
      () => null,
    ),
    markdown: 'Welcome',
    selectionMarkdown: 'Welcome',
    editorView,
    editorOptions: undefined as
      | {
          onChange?: () => void
          onModeChange?: (mode: BlockMode | null) => void
        }
      | undefined,
  }
})

vi.mock('./bridge', () => ({
  hasBridge: () => mainState.hasBridge(),
  invoke: mainState.invoke,
  confirmAction: mainState.confirmAction,
  showError: mainState.showError,
  onBridgeReady: (callback: (bridge: unknown) => void) => {
    callback(undefined)
    return Promise.resolve()
  },
}))

vi.mock('./files', async () => {
  const actual = await vi.importActual('./files')
  return {
    ...actual,
    pickOpenPath: mainState.pickOpenPath,
    getPendingFiles: mainState.getPendingFiles,
    readTextFile: mainState.readTextFile,
    pickSavePath: mainState.pickSavePath,
    writeTextFile: mainState.writeTextFile,
    renameTextFile: mainState.renameTextFile,
    pickExportPath: mainState.pickExportPath,
    pickImageImportPath: mainState.pickImageImportPath,
    pickImportPath: mainState.pickImportPath,
    pickTextImportPath: mainState.pickTextImportPath,
    readAnyTextFile: mainState.readAnyTextFile,
  }
})

vi.mock('./editor', async (importOriginal) => ({
  // Only the editor itself is stubbed; `linkRangeAt` is a pure function over a
  // document, and the context menu calls it for real.
  linkRangeAt: (await importOriginal<typeof import('./editor')>()).linkRangeAt,
  createBlockEditor: vi.fn((
    _parent: HTMLElement,
    markdown: string,
    options?: {
      onChange?: () => void
      onModeChange?: (mode: BlockMode | null) => void
    },
  ) => {
    mainState.editorOptions = options
    mainState.markdown = markdown
    return {
      getView: () => mainState.editorView,
      getMarkdown: () => mainState.markdown,
      getSelectionMarkdown: () => mainState.selectionMarkdown,
      setMarkdown: (value: string) => { mainState.markdown = value },
      insertMarkdown: (value: string) => {
        mainState.markdown += value
        options?.onChange?.()
      },
      commitSource: vi.fn(),
      createState: (markdown: string) => ({ _md: markdown }),
      getState: () => ({ _md: mainState.markdown }),
      applyState: (state: { _md: string }) => { mainState.markdown = state._md },
      resolveImages: vi.fn(),
      focus: vi.fn(),
      destroy: vi.fn(),
    }
  }),
}))

vi.mock('prosemirror-commands', async () => {
  const actual = await vi.importActual<typeof import('prosemirror-commands')>('prosemirror-commands')
  return {
    ...actual,
    selectAll: vi.fn().mockReturnValue(true),
  }
})

vi.mock('./mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn().mockResolvedValue({ svg: '<svg></svg>' }),
  },
  // `rethemeMermaid` walks the rendered diagrams when the theme changes; with
  // no `reinitializeMermaidTheme` behind it, it would load the real mermaid.
  reinitializeMermaidTheme: vi.fn().mockResolvedValue(undefined),
  loadMermaid: vi.fn(async () => ({ render: vi.fn().mockResolvedValue({ svg: '<svg></svg>', diagramType: 'base' }) })),
  errorBlock: (message: string) => {
    const block = document.createElement('div')
    block.className = 'mermaid-error'
    block.textContent = message
    return block
  },
  responsifySvg: vi.fn(() => 800),
  adaptDiagramColors: vi.fn(),
  pinSvgTextColors: vi.fn(),
  attachMermaidToolbar: vi.fn(),
  mermaidZoomButtons: vi.fn(() => []),
  bakeDiagram: vi.fn(),
}))

// `./node/mermaid` is deliberately *not* mocked. It registers how a diagram's
// interaction axis is entered and left into the mode registry, and a
// `vi.mock(..., importOriginal)` factory is cached across `resetModules` — so a
// mocked copy would register into the registry of an earlier evaluation than the
// one `main` resolves, and every interaction item in the context menu would be
// silently inert. The real module is cheap here: `rethemeMermaid` only walks the
// (empty) set of rendered diagrams when the theme changes.

// The grid's editing commands come from the live node view; the menu itself
// stays owned by main so the block actions can be appended below them.
vi.mock('./node/table', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./node/table')>()
  return {
    ...actual,
    spreadsheetMenuEntries: mainState.spreadsheetMenuEntries,
  }
})

vi.mock('./export', async () => {
  const actual = await vi.importActual('./export')
  return {
    ...actual,
    serializeDocToHtml: (_doc: unknown) => `<p>${(_doc as { textContent?: string }).textContent ?? ''}</p>`,
  }
})

vi.mock('./recents', () => ({
  getRecentFiles: mainState.getRecentFiles,
  addRecentFile: mainState.addRecentFile,
}))

vi.mock('./urlDialog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./urlDialog')>()
  return {
    ...actual,
    promptForRename: mainState.promptForRename,
    promptForLink: mainState.promptForLink,
  }
})

vi.mock('./clipboard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./clipboard')>()
  return {
    ...actual,
    copyText: mainState.copyText,
    readText: mainState.readText,
  }
})

const DOM_TEMPLATE = `
  <div id="app">
    <nav id="tabbar"></nav>
    <main id="workspace">
      <div id="toolbar" role="toolbar" aria-label="Toolbar"></div>
      <section id="editor-container" aria-label="Editor"></section>
      <section id="home-screen" aria-label="Home">
        <h1>Edi</h1>
        <p class="home-subtitle">Markdown editor with Mermaid, spreadsheets, and more</p>
        <div class="home-action-row">
          <button type="button" class="home-btn home-primary" id="home-new">New</button>
          <button type="button" class="home-btn home-primary" id="home-open">Open…</button>
        </div>
        <div class="home-recent-box">
          <button type="button" class="home-btn" id="home-recent-toggle">Recent documents</button>
          <ul id="home-recent-list" hidden></ul>
        </div>
        <div class="home-action-row">
          <button type="button" class="home-btn" id="home-welcome">Open Welcome</button>
          <button type="button" class="home-btn" id="home-exit">Exit</button>
        </div>
        <p class="home-hint">Ctrl+N new · Ctrl+O open</p>
      </section>
    </main>
    <footer id="statusbar">
      <span id="status-left"></span>
      <span id="status-mode" hidden></span>
      <button type="button" id="status-zoom" hidden></button>
      <span id="status-right"></span>
    </footer>
  </div>
`

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

async function flushAsync(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await tick()
  }
}

async function loadMain(): Promise<void> {
  vi.resetModules()
  // `vi.resetModules()` starts a new module generation, and the node views below
  // are only usable alongside the `blockModePlugin` of *their own* generation —
  // a mode is identified by its `PluginKey`, so a `BLOCK_MODE_KEY` from an older
  // one writes a meta no state in this generation is listening for. Caching them
  // across a reset is what made a sheet silently fail to open. Clearing it here
  // makes the invariant true by construction rather than at four call sites that
  // each had to remember.
  nodeViews = null
  await import('./main')
  await flushAsync()
}

async function stateModule(): Promise<typeof import('./state')> {
  return import('./state')
}

/**
 * The `block-modes` module *as `main` itself resolved it*.
 *
 * `loadMain` calls `vi.resetModules()` and then imports `./main`, which
 * re-evaluates `main` and its non-mocked dependencies — `./block-modes` among
 * them, since it is not in this file's mock list. A view built from the copy
 * imported at the top of this file therefore holds a different `blockModePlugin`
 * from the one `main`'s own `toggleSourceMode` writes to, and the two can never
 * meet: the meta lands on a key nothing is listening for. Importing after
 * `loadMain` picks up the instance in `main`'s registry instead.
 *
 * Only `main`'s own entry points need this. The `./node/mermaid` mock is cached
 * across `resetModules`, so anything routed through the diagram module still
 * shares the statically imported copy, and a view built from *that* works for
 * the menu items that call it.
 */
async function mainSideBlockModes(): Promise<typeof import('./block-modes')> {
  return import('./block-modes')
}

/**
 * A real EditorView on the app's block editor, with a real node view for every
 * block type.
 *
 * The context menu and the block-mode gestures both ask the *DOM* which block the
 * pointer is over (§6.4), and the node views ask the mode record which form they
 * are drawing — so neither a fake document nor a hand-made `<div class="spreadsheet">`
 * can stand in for one any more.
 *
 * The mode plugin and the node views come from one batch of dynamic imports,
 * after `loadMain` has re-evaluated every non-mocked module. A mode is
 * identified by its `PluginKey`, so a node view from a different evaluation than
 * the plugin would ask a record no view carries.
 */
type MainSideNodeViews = {
  modes: typeof import('./block-modes')
  table: typeof import('./node/table')
  plugins: Plugin[]
}

let nodeViews: MainSideNodeViews | null = null

async function mainSideNodeViews(): Promise<MainSideNodeViews> {
  if (nodeViews !== null) return nodeViews
  // `importActual` for the two node-view modules the mock list covers: a
  // `vi.mock(..., importOriginal)` factory is cached across `resetModules`, so the
  // mocked copy is built from a module evaluated in an *earlier* generation — and
  // its node views ask the mode record through the `BLOCK_MODE_KEY` of that
  // generation, which is a different key from the `blockModePlugin` in the view
  // below. A form therefore never reached the DOM. This wants the real node views
  // anyway (see above), and `main` keeps seeing the mock, which is all the mock is
  // for.
  const [modes, blockview, mermaid, table, execblock] = await Promise.all([
    mainSideBlockModes(),
    vi.importActual<typeof import('./blockview')>('./blockview'),
    import('./node/mermaid'),
    vi.importActual<typeof import('./node/table')>('./node/table'),
    vi.importActual<typeof import('./node/execblock')>('./node/execblock'),
  ])
  nodeViews = {
    modes,
    table,
    plugins: [
      history(),
      modes.blockModePlugin,
      // Before the plain block view, as in the editor: a code block with a
      // shebang is a runnable block, and ProseMirror takes the first node view
      // that claims a type.
      execblock.codeBlockNodeViewPlugin,
      new Plugin({
        props: {
          nodeViews: Object.fromEntries(
            [...blockview.BLOCK_NODE_TYPES, 'source_block'].map((name) => [name, blockview.blockNodeView]),
          ),
        },
      }),
      mermaid.mermaidNodeViewPlugin,
      table.tableNodeViewPlugin,
    ],
  }
  return nodeViews
}

async function mountDoc(markdown: string): Promise<EditorView> {
  const views = await mainSideNodeViews()
  const host = document.createElement('div')
  document.body.appendChild(host)
  const view = new EditorView(host, {
    state: EditorState.create({
      doc: markdownToProse(markdown, schema),
      plugins: [...views.plugins],
    }),
  })
  mainState.editorView = view as unknown as typeof mainState.editorView
  document.querySelector<HTMLElement>('#editor-container')?.appendChild(view.dom)
  return view
}

function press(key: string, extra: KeyboardEventInit = {}): void {
  window.dispatchEvent(new KeyboardEvent('keydown', { key, ctrlKey: true, ...extra }))
}

function tabbarEl(): HTMLElement {
  return document.querySelector<HTMLElement>('#tabbar')!
}

function appEl(): HTMLElement {
  return document.querySelector<HTMLElement>('#app')!
}

function statusLeft(): HTMLElement {
  return document.querySelector<HTMLElement>('#status-left')!
}

function statusRight(): HTMLElement {
  return document.querySelector<HTMLElement>('#status-right')!
}

function activeTabTitle(): string | null {
  return tabbarEl().querySelector('.tab.active .tab-title')?.textContent ?? null
}

function menu(command: string, argument?: string): void {
  window.ediMenuCommand?.(command, argument)
}

function matchMediaStub(): typeof window.matchMedia {
  return ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}

const FILE_MOCKS = [
  mainState.pickOpenPath,
  mainState.readTextFile,
  mainState.pickSavePath,
  mainState.writeTextFile,
  mainState.renameTextFile,
  mainState.promptForRename,
  mainState.promptForLink,
  mainState.pickExportPath,
  mainState.pickImageImportPath,
  mainState.pickImportPath,
  mainState.pickTextImportPath,
  mainState.readAnyTextFile,
]

beforeEach(() => {
  document.body.innerHTML = DOM_TEMPLATE
  window.history.replaceState(null, '', '/')
  localStorage.clear()
  window.matchMedia = matchMediaStub()
  mainState.hasBridge.mockReturnValue(false)
  mainState.invoke.mockReset().mockResolvedValue(undefined)
  mainState.confirmAction.mockReset().mockResolvedValue(true)
  mainState.getRecentFiles.mockReset().mockResolvedValue([])
  mainState.getPendingFiles.mockReset().mockResolvedValue([])
  mainState.addRecentFile.mockReset().mockResolvedValue(undefined)
  mainState.copyText.mockReset().mockResolvedValue(true)
  mainState.readText.mockReset().mockResolvedValue('PASTED')
  mainState.spreadsheetMenuEntries.mockReset().mockReturnValue(null)
  mainState.markdown = 'Welcome'
  mainState.selectionMarkdown = 'Welcome'
  mainState.editorView = mainState.defaultEditorView
  mainState.editorOptions = undefined
  for (const mock of FILE_MOCKS) {
    mock.mockReset()
  }
  vi.restoreAllMocks()
})

describe('init', () => {
  it('boots the home screen', async () => {
    await loadMain()
    const state = await stateModule()
    expect(state.getState().sessions).toHaveLength(0)
    expect(document.title).toBe('Edi')
    expect(appEl().dataset.view).toBe('home')
    expect(tabbarEl().querySelectorAll('.tab')).toHaveLength(0)
    expect(statusLeft().textContent).toBe('')
    expect(statusRight().textContent).toBe('')
  })

  it('boots the welcome doc in selftest mode', async () => {
    window.history.replaceState(null, '', '?selftest=1')
    await loadMain()
    const state = await stateModule()
    expect(state.getState().sessions).toHaveLength(1)
    expect(document.title).toBe('Untitled — Edi')
    expect(appEl().dataset.view).toBe('editor')
    expect(tabbarEl().querySelectorAll('.tab')).toHaveLength(1)
  })

  it('ignores keydowns without a modifier', async () => {
    await loadMain()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n' }))
    const state = await stateModule()
    expect(state.getState().sessions).toHaveLength(0)
  })

  it('ignores bridge errors while syncing state', async () => {
    mainState.invoke.mockImplementation((method: string) =>
      method === 'setDirty' || method === 'setMenuState'
        ? Promise.reject(new Error('bridge down'))
        : Promise.resolve(undefined),
    )
    await loadMain()
    await flushAsync()
  })
})

describe('keyboard shortcuts', () => {
  it('binds all application shortcuts', async () => {
    mainState.pickOpenPath.mockResolvedValue(null)
    mainState.pickSavePath.mockResolvedValue(null)
    const close = vi.spyOn(window, 'close').mockImplementation(() => undefined)
    await loadMain()

    press('n')
    const state = await stateModule()
    expect(state.getState().sessions).toHaveLength(1)

    press('w')
    await flushAsync()
    expect(state.getState().sessions).toHaveLength(0)

    press('o')
    press('s', { shiftKey: true })
    press('s')
    press('q')
    await flushAsync()

    expect(close).toHaveBeenCalled()
  })

  it('selects all in the editor with Ctrl+A even when focus is elsewhere', async () => {
    await loadMain()
    const { selectAll } = await import('prosemirror-commands')
    vi.mocked(selectAll).mockClear()
    press('a')
    expect(mainState.editorView.focus).toHaveBeenCalled()
    expect(selectAll).toHaveBeenCalled()
  })

  it('preserves scroll position when selecting all', async () => {
    await loadMain()
    const container = document.querySelector<HTMLElement>('#editor-container')!
    container.scrollTop = 123
    press('a')
    await flushAsync()
    expect(container.scrollTop).toBe(123)
  })

  it('pastes rich HTML with formatting preserved (inner copy round-trip)', async () => {
    await loadMain()
    stubLayout()
    mainState.hasBridge.mockReturnValue(true)
    mainState.invoke.mockResolvedValue({
      text: 'line1\nline2',
      html: '<strong>bold</strong> and <a href="https://example.com">link</a> text',
    })

    const host = document.createElement('div')
    document.body.appendChild(host)
    const realView = new EditorView(host, {
      state: EditorState.create({ doc: markdownToProse('abc', schema) }),
    })
    mainState.editorView = realView as unknown as typeof mainState.editorView

    menu('paste')
    await flushAsync()

    // When HTML is present it is preferred so formatting is kept.
    const md = proseToMarkdown(realView.state.doc)
    expect(md).toContain('**bold**')
    expect(md).toContain('[link](https://example.com)')
    realView.destroy()
    host.remove()
  })

  it('pastes plain text via the text path when no HTML is present', async () => {
    await loadMain()
    mainState.hasBridge.mockReturnValue(true)
    mainState.invoke.mockResolvedValue({ text: 'line1\nline2', html: '' })

    const host = document.createElement('div')
    document.body.appendChild(host)
    const realView = new EditorView(host, {
      state: EditorState.create({ doc: markdownToProse('abc', schema) }),
    })
    mainState.editorView = realView as unknown as typeof mainState.editorView

    menu('paste')
    await flushAsync()

    // No HTML, so plain text is parsed into two clean paragraphs.
    expect(proseToMarkdown(realView.state.doc)).toContain('line1\n\nline2')
    realView.destroy()
    host.remove()
  })

  it('cut writes serialized rich content and deletes the selection', async () => {
    await loadMain()
    mainState.hasBridge.mockReturnValue(true)
    mainState.invoke.mockResolvedValue(undefined)

    const host = document.createElement('div')
    document.body.appendChild(host)
    const cutDoc = markdownToProse('a **bold** tail', schema)
    const realView = new EditorView(host, {
      state: EditorState.create({
        doc: cutDoc,
        selection: TextSelection.create(cutDoc, 1, cutDoc.content.size - 1),
      }),
    })
    mainState.editorView = realView as unknown as typeof mainState.editorView

    menu('cut')
    await flushAsync()

    const sent = mainState.invoke.mock.calls.find(
      (call) => call[0] === 'copyContent',
    ) as [string, { html: string; text: string }] | undefined
    expect(sent).toBeDefined()
    expect(sent![1].html).toContain('<strong>')
    expect(sent![1].text).toContain('bold')
    expect(proseToMarkdown(realView.state.doc)).not.toContain('bold')
    realView.destroy()
    host.remove()
  })
})

describe('tabs', () => {
  it('opens a new tab with Ctrl+N', async () => {
    await loadMain()
    press('n')
    const state = await stateModule()
    expect(state.getState().sessions).toHaveLength(1)
    expect(tabbarEl().querySelectorAll('.tab')).toHaveLength(1)
  })

  it('closes the active tab with Ctrl+W and returns to home', async () => {
    await loadMain()
    press('n')
    press('w')
    await flushAsync()
    const state = await stateModule()
    expect(state.getState().sessions).toHaveLength(0)
    expect(document.title).toBe('Edi')
    expect(appEl().dataset.view).toBe('home')
  })

  it('keeps the tab when closing a dirty document is cancelled', async () => {
    await loadMain()
    press('n')
    mainState.markdown = 'unsaved content'
    const state = await stateModule()
    const { setActiveDirty } = await import('./state')
    setActiveDirty(true)
    await flushAsync()
    mainState.confirmAction.mockResolvedValue(false)
    press('w')
    await flushAsync()
    expect(state.getState().sessions).toHaveLength(1)
    expect(mainState.confirmAction).toHaveBeenCalledWith(
      'Discard unsaved changes and close this document?',
    )
  })

  it('closes a dirty document after confirming', async () => {
    await loadMain()
    press('n')
    mainState.markdown = 'unsaved content'
    const { setActiveDirty } = await import('./state')
    setActiveDirty(true)
    await flushAsync()
    press('w')
    await flushAsync()
    const state = await stateModule()
    expect(state.getState().sessions).toHaveLength(0)
    expect(mainState.confirmAction).toHaveBeenCalled()
  })

  it('marks the active tab dirty when the document is edited', async () => {
    await loadMain()
    press('n')
    expect(activeTabTitle()).toBe('Untitled')
    expect(document.title).toBe('Untitled — Edi')
    mainState.editorOptions!.onChange!()
    await flushAsync()
    const state = await stateModule()
    expect(state.getActive()!.dirty).toBe(true)
    expect(activeTabTitle()).toBe('* Untitled')
    expect(document.title).toBe('* Untitled — Edi')
  })

  it('tracks a dirty document by filename in the tab and window title', async () => {
    mainState.pickSavePath.mockResolvedValue('/tmp/notes.md')
    mainState.writeTextFile.mockResolvedValue(undefined)
    await loadMain()
    press('n')
    menu('save')
    await flushAsync()
    expect(activeTabTitle()).toBe('notes.md')
    mainState.editorOptions!.onChange!()
    await flushAsync()
    expect(activeTabTitle()).toBe('* notes.md')
    expect(document.title).toBe('* notes.md — Edi')
    expect(mainState.invoke).toHaveBeenCalledWith(
      'setTitle',
      { title: '* notes.md — Edi' },
    )
  })

  it('opens the Edi Guide as an untitled tab from the Help menu', async () => {
    await loadMain()
    menu('helpGuide')
    await flushAsync()
    const state = await stateModule()
    expect(state.getState().sessions).toHaveLength(1)
    expect(activeTabTitle()).toBe('Untitled')
    expect(mainState.markdown).toContain('# Edi Guide')
    expect(mainState.markdown).toContain('## Masked fields')
  })
})

describe('open and save', () => {
  it('opens a file', async () => {
    mainState.pickOpenPath.mockResolvedValue(['/tmp/notes.md'])
    mainState.readTextFile.mockResolvedValue('hello file')
    await loadMain()
    menu('open')
    await flushAsync()
    const state = await stateModule()
    expect(state.getState().sessions).toHaveLength(1)
    expect(document.title).toBe('notes.md — Edi')
    expect(statusLeft().textContent).toBe('/tmp/notes.md')
  })

  it('focuses an already-open file instead of reopening it', async () => {
    mainState.pickOpenPath.mockResolvedValue(['/tmp/notes.md'])
    mainState.readTextFile.mockResolvedValue('hello file')
    await loadMain()
    menu('open')
    await flushAsync()
    menu('open')
    await flushAsync()
    const state = await stateModule()
    expect(state.getState().sessions).toHaveLength(1)
    expect(mainState.readTextFile).toHaveBeenCalledTimes(1)
  })

  it('does nothing when the open dialog is cancelled', async () => {
    mainState.pickOpenPath.mockResolvedValue(null)
    await loadMain()
    menu('open')
    await flushAsync()
    const state = await stateModule()
    expect(state.getState().sessions).toHaveLength(0)
    expect(mainState.readTextFile).not.toHaveBeenCalled()
  })

  it('opens every file selected in one dialog', async () => {
    mainState.pickOpenPath.mockResolvedValue(['/tmp/a.md', '/tmp/b.md'])
    mainState.readTextFile
      .mockResolvedValueOnce('content a')
      .mockResolvedValueOnce('content b')
    await loadMain()
    menu('open')
    await flushAsync()
    const state = await stateModule()
    expect(state.getState().sessions).toHaveLength(2)
    expect(mainState.readTextFile).toHaveBeenNthCalledWith(1, '/tmp/a.md')
    expect(mainState.readTextFile).toHaveBeenNthCalledWith(2, '/tmp/b.md')
  })

  it('opens files Edi was launched with', async () => {
    mainState.getPendingFiles.mockResolvedValue(['/tmp/notes.md', '/tmp/other.txt'])
    mainState.readTextFile
      .mockResolvedValueOnce('content a')
      .mockResolvedValueOnce('content b')
    await loadMain()
    await flushAsync()
    const state = await stateModule()
    expect(state.getState().sessions).toHaveLength(2)
    expect(mainState.readTextFile).toHaveBeenNthCalledWith(1, '/tmp/notes.md')
    expect(mainState.readTextFile).toHaveBeenNthCalledWith(2, '/tmp/other.txt')
    expect(document.title).toBe('other.txt — Edi')
  })

  it('ignores unsupported pending files and a missing bridge', async () => {
    mainState.getPendingFiles.mockResolvedValue(['/tmp/a.md', '/tmp/b.bin'])
    mainState.readTextFile.mockResolvedValue('content')
    await loadMain()
    await flushAsync()
    const state = await stateModule()
    expect(state.getState().sessions).toHaveLength(1)
    expect(mainState.readTextFile).toHaveBeenCalledTimes(1)

    mainState.getPendingFiles.mockRejectedValue(new Error('no bridge'))
    mainState.readTextFile.mockClear()
    await loadMain()
    await flushAsync()
    expect(mainState.readTextFile).not.toHaveBeenCalled()
  })

  it('reports a failed open', async () => {
    mainState.pickOpenPath.mockResolvedValue(['/tmp/bad.md'])
    mainState.readTextFile.mockRejectedValue(new Error('no such file'))
    await loadMain()
    menu('open')
    await flushAsync()
    expect(mainState.showError).toHaveBeenCalledWith(
      expect.stringContaining('Failed to open /tmp/bad.md'),
    )
  })

  it('saves the active document', async () => {
    mainState.pickOpenPath.mockResolvedValue(['/tmp/notes.md'])
    mainState.readTextFile.mockResolvedValue('hello file')
    await loadMain()
    menu('open')
    await flushAsync()
    menu('save')
    await flushAsync()
    expect(mainState.writeTextFile).toHaveBeenCalledWith('/tmp/notes.md', 'hello file')
    expect(activeTabTitle()).toBe('notes.md')
  })

  it('does nothing when the save dialog is cancelled', async () => {
    mainState.pickSavePath.mockResolvedValue(null)
    await loadMain()
    menu('save')
    await flushAsync()
    expect(mainState.writeTextFile).not.toHaveBeenCalled()
  })

  it('does nothing when save-as is cancelled', async () => {
    mainState.pickSavePath.mockResolvedValue(null)
    await loadMain()
    menu('saveAs')
    await flushAsync()
    expect(mainState.writeTextFile).not.toHaveBeenCalled()
  })

  it('prompts for a path when saving an unsaved document', async () => {
    mainState.pickSavePath.mockResolvedValue('/tmp/new.md')
    await loadMain()
    window.ediSetContent?.('Welcome to Edi')
    await flushAsync()
    menu('save')
    await flushAsync()
    expect(mainState.pickSavePath).toHaveBeenCalledWith('Untitled')
    expect(mainState.writeTextFile).toHaveBeenCalledWith('/tmp/new.md', 'Welcome to Edi')
    expect(document.title).toBe('new.md — Edi')
  })

  it('saves under a new name', async () => {
    mainState.pickOpenPath.mockResolvedValue(['/tmp/notes.md'])
    mainState.readTextFile.mockResolvedValue('hello file')
    await loadMain()
    menu('open')
    await flushAsync()
    mainState.pickSavePath.mockResolvedValue('/tmp/copy.md')
    menu('saveAs')
    await flushAsync()
    expect(mainState.writeTextFile).toHaveBeenCalledWith('/tmp/copy.md', 'hello file')
    expect(document.title).toBe('copy.md — Edi')
  })

  it('asks before saving to an unsupported extension', async () => {
    mainState.pickSavePath.mockResolvedValue('/tmp/out.csv')
    await loadMain()
    press('n')
    menu('save')
    await flushAsync()
    expect(mainState.confirmAction).toHaveBeenCalledWith(expect.stringContaining('/tmp/out.csv'))
    expect(mainState.writeTextFile).toHaveBeenCalledWith('/tmp/out.csv', expect.any(String))
  })

  it('reports a failed save', async () => {
    mainState.pickSavePath.mockResolvedValue('/tmp/new.md')
    mainState.writeTextFile.mockRejectedValue(new Error('disk full'))
    await loadMain()
    press('n')
    menu('save')
    await flushAsync()
    expect(mainState.showError).toHaveBeenCalledWith(
      expect.stringContaining('Failed to save /tmp/new.md'),
    )
  })
})

describe('rename', () => {
  async function openNotes(): Promise<void> {
    mainState.pickOpenPath.mockResolvedValue(['/tmp/notes.md'])
    mainState.readTextFile.mockResolvedValue('hello file')
    await loadMain()
    menu('open')
    await flushAsync()
  }

  it('renames in place through a single call, and the document follows', async () => {
    await openNotes()
    mainState.promptForRename.mockResolvedValue('ideas.md')
    menu('rename')
    await flushAsync()
    // One call, carrying the old name, the new one and the body: the old file
    // never survives a rename as a second copy of the document.
    expect(mainState.renameTextFile).toHaveBeenCalledTimes(1)
    expect(mainState.renameTextFile).toHaveBeenCalledWith('/tmp/notes.md', '/tmp/ideas.md', 'hello file')
    expect(mainState.writeTextFile).not.toHaveBeenCalled()
    expect(document.title).toBe('ideas.md — Edi')
    expect(activeTabTitle()).toBe('ideas.md')
    expect(statusLeft().textContent).toContain('Renamed to ideas.md')
  })

  it('offers the current name and remembers the new one', async () => {
    await openNotes()
    mainState.promptForRename.mockResolvedValue('ideas.md')
    menu('rename')
    await flushAsync()
    expect(mainState.promptForRename).toHaveBeenCalledWith('notes.md')
    expect(mainState.addRecentFile).toHaveBeenCalledWith('/tmp/ideas.md')
  })

  it('clears the dirty flag: the bytes are on disk under the new name', async () => {
    await openNotes()
    mainState.markdown = 'edited'
    mainState.editorOptions?.onChange?.()
    mainState.promptForRename.mockResolvedValue('ideas.md')
    menu('rename')
    await flushAsync()
    const state = await stateModule()
    expect(state.isAnyDirty()).toBe(false)
  })

  it('keeps the document where it was when the prompt is cancelled', async () => {
    await openNotes()
    mainState.promptForRename.mockResolvedValue(null)
    menu('rename')
    await flushAsync()
    expect(mainState.renameTextFile).not.toHaveBeenCalled()
    expect(document.title).toBe('notes.md — Edi')
  })

  it('does nothing for a document that has no path yet', async () => {
    await loadMain()
    press('n')
    mainState.promptForRename.mockResolvedValue('ideas.md')
    menu('rename')
    await flushAsync()
    expect(mainState.promptForRename).not.toHaveBeenCalled()
    expect(mainState.renameTextFile).not.toHaveBeenCalled()
  })

  it('asks before renaming to an unsupported extension', async () => {
    await openNotes()
    mainState.promptForRename.mockResolvedValue('out.csv')
    menu('rename')
    await flushAsync()
    expect(mainState.confirmAction).toHaveBeenCalledWith(expect.stringContaining('out.csv'))
    expect(mainState.renameTextFile).toHaveBeenCalledWith('/tmp/notes.md', '/tmp/out.csv', 'hello file')
  })

  it('reports a failed rename, leaving the document on its old name', async () => {
    await openNotes()
    mainState.promptForRename.mockResolvedValue('ideas.md')
    mainState.renameTextFile.mockRejectedValue(new Error('permission denied'))
    menu('rename')
    await flushAsync()
    expect(mainState.showError).toHaveBeenCalledWith(
      expect.stringContaining('Failed to rename /tmp/notes.md'),
    )
    expect(document.title).toBe('notes.md — Edi')
  })

  it('reports the renameable document in the menu state', async () => {
    function lastMenuState(): { canRename?: boolean } {
      const calls = mainState.invoke.mock.calls.filter((call) => call[0] === 'setMenuState')
      return calls[calls.length - 1]?.[1] as { canRename?: boolean }
    }

    await loadMain()
    expect(lastMenuState().canRename).toBe(false)
    await openNotes()
    expect(lastMenuState().canRename).toBe(true)
  })
})

describe('revert', () => {
  it('reverts a dirty document after confirming', async () => {
    mainState.pickOpenPath.mockResolvedValue(['/tmp/notes.md'])
    mainState.readTextFile.mockResolvedValue('hello file')
    await loadMain()
    menu('open')
    await flushAsync()
    mainState.markdown = 'edited content'
    const { setActiveDirty } = await import('./state')
    setActiveDirty(true)
    await flushAsync()
    mainState.readTextFile.mockResolvedValue('reverted content')
    menu('revert')
    await flushAsync()
    expect(activeTabTitle()).toBe('notes.md')
  })

  it('does not revert when the user cancels', async () => {
    mainState.pickOpenPath.mockResolvedValue(['/tmp/notes.md'])
    mainState.readTextFile.mockResolvedValue('hello file')
    await loadMain()
    menu('open')
    await flushAsync()
    mainState.confirmAction.mockResolvedValue(false)
    menu('revert')
    await flushAsync()
    expect(mainState.markdown).toBe('hello file')
  })

  it('ignores revert when no path is set', async () => {
    await loadMain()
    menu('revert')
    await flushAsync()
    expect(mainState.confirmAction).not.toHaveBeenCalled()
  })

  it('reports a failed revert', async () => {
    mainState.pickOpenPath.mockResolvedValue(['/tmp/notes.md'])
    mainState.readTextFile.mockResolvedValue('hello file')
    await loadMain()
    menu('open')
    await flushAsync()
    mainState.readTextFile.mockRejectedValue(new Error('gone'))
    menu('revert')
    await flushAsync()
    expect(mainState.showError).toHaveBeenCalledWith(
      expect.stringContaining('Failed to revert /tmp/notes.md'),
    )
  })
})

describe('copy file path', () => {
  async function openNotes(): Promise<void> {
    mainState.pickOpenPath.mockResolvedValue(['/tmp/notes.md'])
    mainState.readTextFile.mockResolvedValue('hello file')
    await loadMain()
    menu('open')
    await flushAsync()
  }

  it('copies the path of the document in view', async () => {
    await openNotes()
    menu('copyFilePath')
    await flushAsync()
    expect(mainState.copyText).toHaveBeenCalledWith('/tmp/notes.md')
  })

  it('copies the new path after a save as', async () => {
    await openNotes()
    mainState.pickSavePath.mockResolvedValue('/tmp/copy.md')
    menu('saveAs')
    await flushAsync()
    mainState.copyText.mockClear()
    menu('copyFilePath')
    await flushAsync()
    expect(mainState.copyText).toHaveBeenCalledWith('/tmp/copy.md')
  })

  it('copies nothing for an unsaved document', async () => {
    await loadMain()
    menu('copyFilePath')
    await flushAsync()
    expect(mainState.copyText).not.toHaveBeenCalled()
  })

  it('is bound to Ctrl+Alt+Shift+C', async () => {
    await openNotes()
    mainState.copyText.mockClear()
    press('c', { shiftKey: true, altKey: true })
    await flushAsync()
    expect(mainState.copyText).toHaveBeenCalledWith('/tmp/notes.md')
  })

  it('reports the copyable path in the menu state', async () => {
    function lastMenuState(): { canCopyPath?: boolean } {
      const calls = mainState.invoke.mock.calls.filter((call) => call[0] === 'setMenuState')
      return calls[calls.length - 1]?.[1] as { canCopyPath?: boolean }
    }

    mainState.pickOpenPath.mockResolvedValue(['/tmp/notes.md'])
    mainState.readTextFile.mockResolvedValue('hello file')
    await loadMain()
    expect(lastMenuState().canCopyPath).toBe(false)

    menu('open')
    await flushAsync()
    expect(lastMenuState().canCopyPath).toBe(true)
  })
})

describe('export', () => {
  it('exports to HTML', async () => {
    mainState.pickExportPath.mockResolvedValue('/tmp/out.html')
    await loadMain()
    press('n')
    menu('export')
    await flushAsync()
    expect(mainState.pickExportPath).toHaveBeenCalledWith('Untitled')
    expect(mainState.writeTextFile).toHaveBeenCalledWith(
      '/tmp/out.html',
      expect.stringContaining('<html'),
    )
    expect(statusLeft().textContent).toBe('Exported /tmp/out.html')
  })

  it('does nothing when the export dialog is cancelled', async () => {
    mainState.pickExportPath.mockResolvedValue(null)
    await loadMain()
    press('n')
    menu('export')
    await flushAsync()
    expect(mainState.writeTextFile).not.toHaveBeenCalled()
  })

  it('reports a failed export', async () => {
    mainState.pickExportPath.mockResolvedValue('/tmp/out.html')
    mainState.writeTextFile.mockRejectedValue(new Error('boom'))
    await loadMain()
    press('n')
    menu('export')
    await flushAsync()
    expect(mainState.showError).toHaveBeenCalledWith(
      expect.stringContaining('Failed to export /tmp/out.html'),
    )
  })
})

describe('recent files', () => {
  it('renders recent files on the home screen', async () => {
    mainState.getRecentFiles.mockResolvedValue(['/x/a.md', '/x/b.md'])
    await loadMain()
    const items = document.querySelectorAll<HTMLElement>('#home-recent-list li')
    expect(items).toHaveLength(2)
    expect(items[0]?.textContent).toBe('a.md')
    expect(items[1]?.dataset.path).toBe('/x/b.md')
  })

  it('records an opened file as recent', async () => {
    mainState.pickOpenPath.mockResolvedValue(['/tmp/notes.md'])
    mainState.readTextFile.mockResolvedValue('hello file')
    await loadMain()
    menu('open')
    await flushAsync()
    expect(mainState.addRecentFile).toHaveBeenCalledWith('/tmp/notes.md')
  })

  it('records a saved file as recent', async () => {
    mainState.pickSavePath.mockResolvedValue('/tmp/new.md')
    await loadMain()
    window.ediSetContent?.('content')
    await flushAsync()
    menu('save')
    await flushAsync()
    expect(mainState.addRecentFile).toHaveBeenCalledWith('/tmp/new.md')
  })

  it('opens a document from the Open Recent menu command', async () => {
    mainState.readTextFile.mockResolvedValue('hello file')
    await loadMain()
    menu('openRecent', '/tmp/notes.md')
    await flushAsync()
    const state = await stateModule()
    expect(state.getState().sessions).toHaveLength(1)
    expect(document.title).toBe('notes.md — Edi')
  })

  it('ignores Open Recent without a path', async () => {
    await loadMain()
    menu('openRecent')
    await flushAsync()
    const state = await stateModule()
    expect(state.getState().sessions).toHaveLength(0)
    expect(mainState.readTextFile).not.toHaveBeenCalled()
  })
})

describe('import', () => {
  it('imports a spreadsheet table', async () => {
    mainState.pickImportPath.mockResolvedValue('/tmp/data.csv')
    mainState.invoke.mockImplementation((method: string) => {
      if (method === 'parseTableFile') {
        return Promise.resolve({ name: 'data.csv', rows: [['A', 'B'], ['1', '2']] })
      }
      return Promise.resolve(undefined)
    })
    await loadMain()
    menu('importTable')
    await flushAsync()
    expect(statusLeft().textContent).toBe('Imported data.csv')
  })

  it('reports a failed table import', async () => {
    mainState.pickImportPath.mockResolvedValue('/tmp/data.csv')
    mainState.invoke.mockRejectedValue(new Error('parse failed'))
    await loadMain()
    menu('importTable')
    await flushAsync()
    expect(mainState.showError).toHaveBeenCalledWith(
      expect.stringContaining('Failed to import /tmp/data.csv'),
    )
  })

  it('does nothing when the import dialogs are cancelled', async () => {
    mainState.pickImportPath.mockResolvedValue(null)
    mainState.pickTextImportPath.mockResolvedValue(null)
    mainState.pickImageImportPath.mockResolvedValue(null)
    await loadMain()
    menu('importTable')
    menu('importText')
    menu('insertImage')
    await flushAsync()
    expect(mainState.confirmAction).not.toHaveBeenCalled()
  })

  it('imports a text file', async () => {
    mainState.pickTextImportPath.mockResolvedValue('/tmp/data.txt')
    mainState.readAnyTextFile.mockResolvedValue('inserted text')
    await loadMain()
    menu('importText')
    await flushAsync()
    expect(statusLeft().textContent).toBe('Inserted data')
  })

  it('reports a failed text import', async () => {
    mainState.pickTextImportPath.mockResolvedValue('/tmp/data.txt')
    mainState.readAnyTextFile.mockRejectedValue(new Error('nope'))
    await loadMain()
    menu('importText')
    await flushAsync()
    expect(mainState.showError).toHaveBeenCalledWith(
      expect.stringContaining('Failed to insert /tmp/data.txt'),
    )
  })

  it('inserts an image reference', async () => {
    mainState.pickImageImportPath.mockResolvedValue('/tmp/pic.png')
    await loadMain()
    menu('insertImage')
    await flushAsync()
    expect(statusLeft().textContent).toBe('Inserted pic')
  })

  it('angle-brackets image paths that contain spaces', async () => {
    mainState.pickImageImportPath.mockResolvedValue('/tmp/my pic.png')
    await loadMain()
    menu('insertImage')
    await flushAsync()
  })
})

describe('kanban board insertion', () => {
  /**
   * A view with the same node views and mode plugin the insert writes through.
   *
   * The record is then read back the only way that cannot disagree about which
   * evaluation of the mode module wrote it: the board's own drawing, which is
   * what "open in edit mode" means to a reader.
   */
  async function attachView(markdown: string): Promise<EditorView> {
    await loadMain()
    return mountDoc(markdown)
  }

  function columnField(): HTMLTextAreaElement {
    return document.querySelector<HTMLTextAreaElement>('.edi-dialog-input')!
  }

  function addBoard(): void {
    document.querySelector<HTMLButtonElement>('.toolbar-primary')!.click()
  }

  it('inserts a board built from the dialog and opens it in edit mode', async () => {
    await loadMain()
    const view = await attachView('Hello')
    menu('insertKanban')
    await flushAsync()
    expect(document.querySelector('.edi-dialog-title')?.textContent).toBe('New kanban board')
    expect(columnField().value.split('\n')).toEqual(['Todo', 'In Progress', 'Review', 'Done'])

    columnField().value = 'Backlog\nDoing'
    addBoard()
    await flushAsync()

    // Inserted after the paragraph the caret was in, as one transaction, so a
    // single undo takes the whole board away.
    const board = view.state.doc.child(1)
    expect(board?.type.name).toBe('mermaid_block')
    expect(board?.attrs.value).toBe('kanban\n  col1[Backlog]\n  col2[Doing]')
    expect(proseToMarkdown(view.state.doc)).toContain('```mermaid\nkanban\n  col1[Backlog]\n  col2[Doing]\n```')
    // The insert carries the record with it, so the board comes up drawn for
    // editing — one undo takes the whole thing away, record and all. The drawing
    // is the assertion that cannot go wrong about *which* evaluation of the mode
    // module wrote it: it is the node view's own answer.
    await flushAsync()
    expect(view.dom.querySelector('.mermaid')?.classList.contains('mermaid-editing')).toBe(true)

    undo(view.state, view.dispatch)
    expect(view.state.doc.childCount).toBe(1)
    expect(view.state.doc.child(0)?.type.name).toBe('paragraph')
  })

  it('replaces an empty paragraph with the board', async () => {
    const view = await attachView('')
    menu('insertKanban')
    await flushAsync()
    columnField().value = 'Todo'
    addBoard()
    await flushAsync()
    expect(view.state.doc.childCount).toBe(1)
    expect(view.state.doc.child(0)?.type.name).toBe('mermaid_block')
  })

  it('inserts nothing when the dialog is cancelled', async () => {
    await loadMain()
    mainState.showError.mockClear()
    const view = await attachView('Hello')
    menu('insertKanban')
    await flushAsync()
    columnField().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushAsync()
    expect(view.state.doc.childCount).toBe(1)
    expect(mainState.showError).not.toHaveBeenCalled()
  })

  it('inserts nothing when every name the dialog collects is blank', async () => {
    await loadMain()
    const view = await attachView('Hello')
    menu('insertKanban')
    await flushAsync()
    // Emptiness is the only thing left to refuse, and the dialog refuses it
    // itself -- it says so in place and never settles, so the add never runs.
    // A double quote is *not* such a name any more: it is carried as `&quot;`
    // (see mermaid-kanban-escaping.test.ts), which is what left
    // `insertKanbanBoard`'s error branch unreachable from here.
    columnField().value = '   '
    addBoard()
    await flushAsync()
    expect(view.state.doc.childCount).toBe(1)
    expect(mainState.showError).not.toHaveBeenCalled()
    const error = document.querySelector<HTMLElement>('.edi-dialog-error')!
    expect(error.hidden).toBe(false)
    expect(error.textContent).toContain('at least one column')
  })

  it('builds a column whose name is a double quote, carried as an entity', async () => {
    await loadMain()
    mainState.showError.mockClear()
    const view = await attachView('Hello')
    menu('insertKanban')
    await flushAsync()
    // A raw quote would close the label its own quote opened, so the source
    // holds the entity and the board draws the quote.
    columnField().value = 'Q3 "final"'
    addBoard()
    await flushAsync()
    expect(mainState.showError).not.toHaveBeenCalled()
    expect(view.state.doc.childCount).toBe(2)
    expect(view.state.doc.child(1)?.attrs.value).toBe('kanban\n  col1["Q3 &quot;final&quot;"]')
  })

  it('inserts a column whose name holds a delimiter, quoted in the source', async () => {
    await loadMain()
    mainState.showError.mockClear()
    const view = await attachView('Hello')
    menu('insertKanban')
    await flushAsync()
    // `]]` is a perfectly good column name; mermaid just cannot read it bare.
    columnField().value = 'Q3 (launch)\n]]'
    addBoard()
    await flushAsync()
    expect(mainState.showError).not.toHaveBeenCalled()
    expect(view.state.doc.child(1)?.attrs.value).toBe('kanban\n  col1["Q3 (launch)"]\n  col2["]]"]')
  })
})

describe('context menu', () => {
  /**
   * Boot the app and give every test in here a document to right-click in.
   *
   * This replaces the `loadMain` / `ediSetContent` / `flushAsync` trio each of
   * these tests used to open with. It has to be here rather than inside each
   * test: two `loadMain` calls mean two live copies of `main`, and therefore two
   * `contextmenu` listeners and two menus on the page.
   */
  async function boot(options: { withDocument?: boolean } = {}): Promise<void> {
    await loadMain()
    // `loadMain` re-evaluates every non-mocked module, so the cached node views
    // belong to the registry that just went away. Holding on to them would have
    // the node views ask a record no view carries.
    if (options.withDocument === false) return
    // A session has to exist: with no document open the app answers no
    // right-click at all, before the menu is even built.
    window.ediSetContent?.('Hello')
    await flushAsync()
    await mountDoc('Hello')
    await flushAsync()
  }

  async function mountLinkDoc(markdown: string): Promise<{ view: EditorView }> {
    await boot()
    const view = await mountDoc(markdown)
    await flushAsync()
    return { view }
  }

  it('opens the clipboard menu on right-click inside the editor', async () => {
    await boot()
    const editor = document.querySelector<HTMLElement>('#editor-container')!
    editor.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 20, clientY: 20 }))
    const labels = Array.from(document.querySelectorAll('.edi-menu-item'))
      .map((button) => (button as HTMLButtonElement).textContent ?? '')
    expect(labels).toEqual([
      'Undo', 'Redo', 'Cut', 'Copy', 'Copy as Markdown', 'Paste', 'Paste as Markdown', 'Select all',
    ])
    // Repeated right-clicks replace the open menu instead of stacking menus.
    editor.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 30, clientY: 30 }))
    expect(document.querySelectorAll('.edi-context-menu')).toHaveLength(1)
  })

  /** A real CodeMirror editor mounted where the masked-field input branch looks. */
  async function mountCodeMirror(doc: string): Promise<CMEditorView> {
    await boot()
    const host = document.createElement('div')
    document.querySelector<HTMLElement>('#editor-container')!.appendChild(host)
    const view = new CMEditorView({
      state: CMEditorState.create({ doc }),
      parent: host,
    })
    return view
  }

  function sourceMenuLabels(): string[] {
    return Array.from(document.querySelectorAll('.edi-menu-item'))
      .map((button) => (button as HTMLButtonElement).textContent ?? '')
  }

  function sourceMenuItem(label: string): HTMLButtonElement {
    const item = Array.from(document.querySelectorAll<HTMLButtonElement>('.edi-menu-item'))
      .find((button) => button.textContent === label)
    expect(item, `menu item ${label}`).toBeDefined()
    return item!
  }

  it('offers the input menu (with selection-aware cut/copy) in a source editor', async () => {
    const cm = await mountCodeMirror('Hello world')
    cm.dom.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 5, clientY: 5 }))
    expect(sourceMenuLabels()).toEqual(['Undo', 'Redo', 'Cut', 'Copy', 'Paste', 'Select all'])
    // No selection in the CM editor: cut/copy disabled, not the ProseMirror
    // document menu's stale state.
    expect(sourceMenuItem('Cut').disabled).toBe(true)
    expect(sourceMenuItem('Copy').disabled).toBe(true)

    cm.dispatch({ selection: { anchor: 0, head: 5 } })
    cm.dom.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 5, clientY: 5 }))
    expect(sourceMenuItem('Cut').disabled).toBe(false)
    expect(sourceMenuItem('Copy').disabled).toBe(false)

    mainState.copyText.mockResolvedValue(true)
    sourceMenuItem('Copy').click()
    await flushAsync()
    expect(mainState.copyText).toHaveBeenCalledWith('Hello')
  })

  it('cut in a source editor removes the selected text', async () => {
    const cm = await mountCodeMirror('Hello world')
    cm.dispatch({ selection: { anchor: 0, head: 5 } })
    mainState.copyText.mockResolvedValue(true)
    clickMenuItem(cm.dom, 'Cut')
    await flushAsync()
    expect(mainState.copyText).toHaveBeenCalledWith('Hello')
    expect(cm.state.doc.toString()).toBe(' world')
  })

  it('paste in a source editor inserts at the selection', async () => {
    const cm = await mountCodeMirror('world')
    mainState.readText.mockResolvedValue('Hello ')
    clickMenuItem(cm.dom, 'Paste')
    await flushAsync()
    expect(cm.state.doc.toString()).toBe('Hello world')
  })

  it('gives masked-field inputs the real input menu instead of the document menu', async () => {
    await boot()
    const input = document.createElement('input')
    input.className = 'masked-field-input'
    input.value = 'hunter2'
    input.selectionStart = 0
    input.selectionEnd = 7
    document.querySelector<HTMLElement>('#editor-container')!.appendChild(input)

    input.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 5, clientY: 5 }))
    expect(sourceMenuLabels()).toEqual(['Undo', 'Redo', 'Cut', 'Copy', 'Paste', 'Select all'])
    expect(sourceMenuItem('Cut').disabled).toBe(false)

    mainState.copyText.mockResolvedValue(true)
    sourceMenuItem('Copy').click()
    await flushAsync()
    expect(mainState.copyText).toHaveBeenCalledWith('hunter2')
  })

  it('Paste as Markdown parses clipboard text into real nodes', async () => {
    const { view } = await mountLinkDoc('Hello')
    mainState.readText.mockResolvedValue('# Title\n\n- one\n- two')

    clickMenuItem(view.dom, 'Paste as Markdown')
    await flushAsync()
    expect(view.state.doc.firstChild?.type.name).toBe('heading')
    expect(view.state.doc.firstChild?.textContent).toBe('Title')
    expect(view.state.doc.childCount).toBeGreaterThanOrEqual(3)
    view.destroy()
  })

  it('Mod-Shift-V parses clipboard text as markdown', async () => {
    const { view } = await mountLinkDoc('Hello')
    mainState.readText.mockResolvedValue('## Heading from shortcut')

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'V', code: 'KeyV', ctrlKey: true, shiftKey: true }))
    await flushAsync()
    expect(view.state.doc.firstChild?.type.name).toBe('heading')
    expect(view.state.doc.firstChild?.textContent).toBe('Heading from shortcut')
    view.destroy()
  })

  it('Copy as Markdown puts the selection markdown on the clipboard', async () => {
    const { view } = await mountLinkDoc('Hello **world**')
    mainState.selectionMarkdown = 'Hello **world**'
    view.dispatch(
      view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, view.state.doc.content.size - 1)),
    )
    mainState.copyText.mockClear()
    menu('copyAsMarkdown')
    await flushAsync()
    expect(mainState.copyText).toHaveBeenCalledWith('Hello **world**')
    view.destroy()
  })

  it('Mod-Shift-C copies as markdown', async () => {
    const { view } = await mountLinkDoc('Hello **world**')
    mainState.selectionMarkdown = '# Selected'
    view.dispatch(
      view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, view.state.doc.content.size - 1)),
    )
    mainState.copyText.mockClear()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'C', code: 'KeyC', ctrlKey: true, shiftKey: true }))
    await flushAsync()
    expect(mainState.copyText).toHaveBeenCalledWith('# Selected')
    view.destroy()
  })

  it('Mod-Shift-V does not steal paste from a focused input', async () => {
    const { view } = await mountLinkDoc('Hello')
    mainState.readText.mockResolvedValue('# Should not appear')

    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'V', code: 'KeyV', ctrlKey: true, shiftKey: true }))
    await flushAsync()
    expect(view.state.doc.textContent).toBe('Hello')
    input.remove()
    view.destroy()
  })

  /** Right-click `target` and press the menu's item named `label`. */
  function clickMenuItem(target: Element, label: string): void {
    target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 20, clientY: 20 }))
    const item = Array.from(document.querySelectorAll<HTMLButtonElement>('.edi-menu-item'))
      .find((button) => button.textContent === label)
    expect(item, `menu item ${label}`).toBeDefined()
    item!.click()
  }

  /** Right-click `target` and press the menu's "Edit link…". */
  function editLinkFrom(target: Element): void {
    clickMenuItem(target, 'Edit link…')
  }

  it('copies the href of the right-clicked link, and leaves the others alone', async () => {
    const { view } = await mountLinkDoc('[one](a.md) and [two](b.md)')
    mainState.copyText.mockResolvedValue(true)

    const anchors = document.querySelectorAll<HTMLElement>('#editor-container a[href]')
    expect(anchors).toHaveLength(2)
    clickMenuItem(anchors[1]!, 'Copy link')
    await flushAsync()

    expect(mainState.copyText).toHaveBeenCalledWith('b.md')
    // Copying reads the document; it must not have rewritten anything.
    expect(proseToMarkdown(view.state.doc)).toContain('[two](b.md)')
    view.destroy()
  })

  it('offers Copy link on a right-click over a link, and nowhere else', async () => {
    const { view } = await mountLinkDoc('See [notes](other.md) here')
    const labels = (): string[] =>
      Array.from(document.querySelectorAll('.edi-menu-item'))
        .map((button) => (button as HTMLButtonElement).textContent ?? '')

    document
      .querySelector<HTMLElement>('#editor-container a[href]')!
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 20, clientY: 20 }))
    expect(labels()).toContain('Copy link')
    expect(labels()).toContain('Edit link…')

    // Plain text keeps the menu it always had: the items are about the link
    // the right-click landed on, not about links existing somewhere in the doc.
    document
      .querySelector<HTMLElement>('#editor-container p')!
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 20, clientY: 20 }))
    expect(labels()).not.toContain('Copy link')
    expect(labels()).not.toContain('Edit link…')
    view.destroy()
  })

  it('rewrites the href of the right-clicked link and leaves the others alone', async () => {
    const { view } = await mountLinkDoc('[one](a.md) and [two](b.md)')
    mainState.promptForLink.mockResolvedValue({ text: '', url: 'edited.md' })

    const anchors = document.querySelectorAll<HTMLElement>('#editor-container a[href]')
    expect(anchors).toHaveLength(2)
    // Right-click the *second* link: the first must not be the one edited.
    editLinkFrom(anchors[1]!)
    await flushAsync()

    expect(mainState.promptForLink).toHaveBeenCalledWith('two', 'b.md', { editing: true })
    const markdown = proseToMarkdown(view.state.doc)
    expect(markdown).toContain('[one](a.md)')
    expect(markdown).toContain('[two](edited.md)')
    view.destroy()
  })

  it('leaves the link untouched when the edit dialog is cancelled', async () => {
    const { view } = await mountLinkDoc('[one](a.md)')
    mainState.promptForLink.mockResolvedValue(null)

    editLinkFrom(document.querySelector('#editor-container a[href]')!)
    await flushAsync()

    expect(mainState.promptForLink).toHaveBeenCalledWith('one', 'a.md', { editing: true })
    expect(proseToMarkdown(view.state.doc)).toContain('[one](a.md)')
    view.destroy()
  })

  it('removes the link when the edit dialog is emptied', async () => {
    const { view } = await mountLinkDoc('See [notes](other.md) here')
    mainState.promptForLink.mockResolvedValue({ text: '', url: '' })

    editLinkFrom(document.querySelector('#editor-container a[href]')!)
    await flushAsync()

    // An empty URL is the toolbar Link button's "unlink", and it is one undo
    // away from the link being back.
    expect(proseToMarkdown(view.state.doc).trim()).toBe('See notes here')
    undo(view.state, view.dispatch)
    expect(proseToMarkdown(view.state.doc)).toContain('[notes](other.md)')
    view.destroy()
  })

  it('disables cut and copy without a selection', async () => {
    await boot()
    document.querySelector<HTMLElement>('#editor-container')!
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 0, clientY: 0 }))
    const cut = Array.from(document.querySelectorAll<HTMLButtonElement>('.edi-menu-item'))
      .find((button) => button.textContent === 'Cut')!
    const copy = Array.from(document.querySelectorAll<HTMLButtonElement>('.edi-menu-item'))
      .find((button) => button.textContent === 'Copy')!
    expect(cut.disabled).toBe(true)
    expect(copy.disabled).toBe(true)
    expect(
      Array.from(document.querySelectorAll<HTMLButtonElement>('.edi-menu-item'))
        .find((button) => button.textContent === 'Select all')!.disabled,
    ).toBe(false)
  })

  it('disables undo and redo when there is nothing to undo or redo', async () => {
    await boot()
    // A view of this test's own: whether `ediSetContent` still points at an
    // earlier test's editor (and how much history that one is holding) is not
    // what "nothing to undo" is meant to be about.
    const host = document.createElement('div')
    document.body.appendChild(host)
    const realView = new EditorView(host, {
      state: EditorState.create({
        doc: markdownToProse('one two', schema),
        plugins: [history()],
      }),
    })
    mainState.editorView = realView as unknown as typeof mainState.editorView
    document.querySelector<HTMLElement>('#editor-container')!
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 0, clientY: 0 }))
    const findItem = (label: string): HTMLButtonElement =>
      Array.from(document.querySelectorAll<HTMLButtonElement>('.edi-menu-item'))
        .find((button) => button.textContent === label)!
    expect(findItem('Undo').disabled).toBe(true)
    expect(findItem('Redo').disabled).toBe(true)
  })

  it('enables undo and redo per history depth without scrolling', async () => {
    await boot()
    const host = document.createElement('div')
    document.body.appendChild(host)
    const realView = new EditorView(host, {
      state: EditorState.create({
        doc: markdownToProse('one two', schema),
        plugins: [history()],
      }),
    })
    mainState.editorView = realView as unknown as typeof mainState.editorView
    realView.dispatch(realView.state.tr.insertText('!'))
    const dispatch = vi.spyOn(realView, 'dispatch')

    const openMenu = (): void => {
      document.querySelector<HTMLElement>('#editor-container')!
        .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 5, clientY: 5 }))
    }
    const findItem = (label: string): HTMLButtonElement =>
      Array.from(document.querySelectorAll<HTMLButtonElement>('.edi-menu-item'))
        .find((button) => button.textContent === label)!

    openMenu()
    expect(findItem('Undo').disabled).toBe(false)
    expect(findItem('Redo').disabled).toBe(true)

    findItem('Undo').click()
    expect(realView.state.doc.textContent).toBe('one two')
    expect(dispatch).toHaveBeenCalled()
    // Menu undo must not scroll the editor to the undone selection.
    expect((dispatch.mock.calls[0]![0] as { scrolledIntoView: boolean }).scrolledIntoView).toBe(false)

    openMenu()
    expect(findItem('Undo').disabled).toBe(true)
    expect(findItem('Redo').disabled).toBe(false)
    findItem('Redo').click()
    expect(realView.state.doc.textContent).toBe('!one two')

    realView.destroy()
    host.remove()
  })

  it('opens no context menu on the home screen', async () => {
    await boot({ withDocument: false })
    document.querySelector<HTMLElement>('#editor-container')!
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 0, clientY: 0 }))
    expect(document.querySelector('.edi-context-menu')).toBeNull()
  })

  it('offers Run and Copy source on a runnable block, Stop while running', async () => {
    await boot()
    // A real block in a real view: the menu finds its block by asking the DOM
    // where it is (§6.4), so a hand-made element outside the view names nothing.
    const view = await mountDoc('```\n#!/usr/bin/env some-unknown-tool\nprint("hi")\n```')
    await flushAsync()
    const source = view.dom.querySelector<HTMLElement>('.runnable-block')!

    source.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 5, clientY: 5 }))
    let labels = Array.from(document.querySelectorAll<HTMLButtonElement>('.edi-menu-item'))
      .map((button) => button.textContent ?? '')
    expect(labels).toContain('Run')
    expect(labels).toContain('Copy source')
    expect(labels).not.toContain('Stop')

    view.dom.querySelector<HTMLElement>('.exec-run')!.classList.add('exec-stop')
    source.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 5, clientY: 5 }))
    labels = Array.from(document.querySelectorAll<HTMLButtonElement>('.edi-menu-item'))
      .map((button) => button.textContent ?? '')
    expect(labels).toContain('Stop')
    expect(labels).not.toContain('Run')
  })

  it('offers Visual, and not Source, on a block in its source form', async () => {
    await boot()
    const view = await mountDoc('# Hello')
    const modes = await mainSideBlockModes()
    modes.enterSourceMode(view, 0)
    await flushAsync()
    const sourceMode = view.dom.querySelector<HTMLElement>('.block-source-mode')!
    expect(sourceMode).not.toBeNull()

    sourceMode.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 5, clientY: 5 }))
    const labels = Array.from(document.querySelectorAll<HTMLButtonElement>('.edi-menu-item'))
      .map((button) => button.textContent ?? '')
    // §5.1: two names for the two forms, and the menu offers the way *out*.
    expect(labels).toContain('Visual')
    expect(labels).not.toContain('Source')
  })

  it('enters source mode from the block menu on a diagram', async () => {
    await boot()
    const view = await mountDoc('```mermaid\ngraph TD\n  A[Alpha]\n```')
    const modes = await mainSideBlockModes()
    const block = view.nodeDOM(0) as HTMLElement

    block.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 5, clientY: 5 }))
    const source = Array.from(document.querySelectorAll<HTMLButtonElement>('.edi-menu-item'))
      .find((button) => button.textContent === 'Source')
    expect(source).toBeDefined()
    source!.click()

    expect(modes.modeFor(view.state, 0)?.representation).toBe('source')
  })

  it('enters and leaves the interaction axis from the block menu', async () => {
    await boot()
    const view = await mountDoc('```mermaid\ngraph TD\n  A[Alpha]\n```')
    const modes = await mainSideBlockModes()

    const openMenu = (): HTMLButtonElement[] => {
      const block = view.nodeDOM(0) as HTMLElement
      block.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 5, clientY: 5 }))
      return Array.from(document.querySelectorAll<HTMLButtonElement>('.edi-menu-item'))
    }
    const item = (buttons: HTMLButtonElement[], label: string): HTMLButtonElement => {
      const found = buttons.find((button) => button.textContent === label)
      expect(found, `menu item ${label}`).toBeDefined()
      return found!
    }

    // Both words of §5.1's interaction axis, from the descriptor rather than from
    // a class name on the wrapper.
    item(openMenu(), 'Edit').click()
    expect(modes.modeFor(view.state, 0)?.interaction).toBe('editing')

    item(openMenu(), 'Done').click()
    expect(modes.currentBlockMode(view.state)).toBeNull()
  })

  function sheetInput(value: string, selection?: [number, number]): HTMLInputElement {
    const input = document.createElement('input')
    input.className = 'ss-edit-input'
    input.value = value
    document.querySelector<HTMLElement>('#editor-container')!.appendChild(input)
    input.focus()
    if (selection) input.setSelectionRange(selection[0], selection[1])
    return input
  }

  const menuLabels = (): string[] =>
    Array.from(document.querySelectorAll<HTMLButtonElement>('.edi-menu-item')).map(
      (button) => button.textContent ?? '',
    )

  const findMenuItem = (label: string): HTMLButtonElement =>
    Array.from(document.querySelectorAll<HTMLButtonElement>('.edi-menu-item')).find(
      (button) => button.textContent === label,
    )!

  const openCellMenu = (input: HTMLInputElement): void => {
    input.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 5, clientY: 5 }))
  }

  /**
   * A real spreadsheet in a real view, with a live grid behind it.
   *
   * A sheet is one state of the one record, so the grid node view renders without
   * anything having to ask for it.
   */
  const fakeSheet = async (): Promise<{ sheet: HTMLElement; teardown: () => void }> => {
    const view = await mountDoc('| A |\n| --- |\n| 1 |')
    // A table opens as text; the grid is one click away.
    //
    // Taken through `modes`, not through the mocked `./node/table`: a
    // `vi.mock(..., importOriginal)` factory is cached across `resetModules`, so
    // that copy's `enterSpreadsheetMode` closes over the `BLOCK_MODE_KEY` of an
    // *earlier* module generation than the one whose `blockModePlugin` is in this
    // view — and a mode is identified by its key, so the write goes to a plugin
    // nobody is listening for. This is the same trap §5.2's own note records for
    // `./node/mermaid`, which is why that one is deliberately not mocked; a form
    // only stayed invisible here while it was an attribute, which is immune to it.
    const tr = view.state.tr
    nodeViews!.modes.setBlockModeAt(view.state, tr, 0, { form: 'sheet' })
    view.dispatch(tr)
    const sheet = view.dom.querySelector<HTMLElement>('.spreadsheet')!
    expect(sheet).not.toBeNull()
    return { sheet, teardown: () => view.destroy() }
  }

  it('scopes the menu to a spreadsheet cell editor', async () => {
    await boot()
    const input = sheetInput('=SUM(A1)', [1, 4])

    openCellMenu(input)
    expect(menuLabels()).toEqual(['Undo', 'Redo', 'Cut', 'Copy', 'Paste', 'Select all'])
    expect(findMenuItem('Cut').disabled).toBe(false)

    findMenuItem('Copy').click()
    expect(mainState.copyText).toHaveBeenCalledWith('SUM')

    openCellMenu(input)
    findMenuItem('Cut').click()
    expect(input.value).toBe('=(A1)')
  })

  it('disables cut and copy on a cell editor without a selection', async () => {
    await boot()
    const input = sheetInput('=1', [2, 2])

    openCellMenu(input)
    expect(findMenuItem('Cut').disabled).toBe(true)
    expect(findMenuItem('Copy').disabled).toBe(true)
  })

  it('selects and pastes into the cell editor', async () => {
    await boot()
    const input = sheetInput('=A1', [2, 2])

    openCellMenu(input)
    findMenuItem('Select all').click()
    expect(input.selectionStart).toBe(0)
    expect(input.selectionEnd).toBe(input.value.length)
    expect(document.activeElement).toBe(input)

    mainState.readText.mockResolvedValue('PASTED')
    input.setSelectionRange(2, 2)
    openCellMenu(input)
    findMenuItem('Paste').click()
    await flushAsync()
    expect(input.value).toBe('=APASTED1')
  })

  it('runs undo and redo against the cell editor', async () => {
    await boot()
    const execCommand = vi.fn()
    Object.defineProperty(document, 'execCommand', { configurable: true, value: execCommand })
    const input = sheetInput('=1', [2, 2])

    openCellMenu(input)
    findMenuItem('Undo').click()
    expect(execCommand).toHaveBeenCalledWith('undo')
  })

  it('keeps focus in a spreadsheet input when its menu opens', async () => {
    await boot()
    const input = sheetInput('=1', [2, 2])
    const blurred = vi.fn()
    input.addEventListener('blur', blurred)

    openCellMenu(input)
    expect(document.activeElement).toBe(input)
    expect(blurred).not.toHaveBeenCalled()
  })

  it('keeps the spreadsheet actions alongside the cell menu', async () => {
    await boot()
    const { sheet, teardown } = await fakeSheet()
    const input = document.createElement('input')
    input.className = 'ss-edit-input'
    input.value = '=1'
    sheet.appendChild(input)
    input.focus()

    openCellMenu(input)
    expect(menuLabels()).toEqual([
      'Undo',
      'Redo',
      'Cut',
      'Copy',
      'Paste',
      'Select all',
      'Visual',
      'Source',
      'Encrypt block…',
    ])

    teardown()
  })

  it('offers only block actions on a cell with no live spreadsheet view', async () => {
    await boot()
    const { sheet, teardown } = await fakeSheet()
    sheet.insertAdjacentHTML(
      'beforeend',
      '<table><tbody><tr><td class="ss-cell">1</td></tr></tbody></table>',
    )
    const cell = sheet.querySelector<HTMLElement>('.ss-cell')!

    cell.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 5, clientY: 5 }))
    expect(menuLabels()).toEqual(['Visual', 'Source', 'Encrypt block…'])

    teardown()
  })

  it('keeps the grid editing commands above the block actions on a cell', async () => {
    await boot()
    const { sheet, teardown } = await fakeSheet()
    sheet.insertAdjacentHTML(
      'beforeend',
      '<table><tbody><tr><td class="ss-cell">1</td></tr></tbody></table>',
    )
    const cell = sheet.querySelector<HTMLElement>('.ss-cell')!
    const cut = vi.fn()
    mainState.spreadsheetMenuEntries.mockReturnValue([
      { type: 'item', label: 'Cut', onSelect: cut },
      { type: 'item', label: 'Copy', onSelect: vi.fn() },
    ])

    cell.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 5, clientY: 5 }))
    expect(mainState.spreadsheetMenuEntries).toHaveBeenCalledWith(cell)
    expect(menuLabels()).toEqual(['Cut', 'Copy', 'Visual', 'Source', 'Encrypt block…'])

    findMenuItem('Cut').click()
    expect(cut).toHaveBeenCalledTimes(1)

    teardown()
  })
})

describe('the status chip', () => {
  /**
   * The chip is written from the mode record alone and into an element of its
   * own, because `#status-left` is the transient flash slot: a chip there would
   * be overwritten by the next flash and cleared by `updateStatus` after three
   * seconds.
   */
  function chip(): { text: string; hidden: boolean } {
    const el = document.querySelector<HTMLElement>('#status-mode')!
    return { text: el.textContent ?? '', hidden: el.hidden }
  }

  it('names the mode and the block it is about, and empties when it closes', async () => {
    await loadMain()
    const modes = await mainSideBlockModes()
    expect(chip()).toEqual({ text: '', hidden: true })

    const view = await mountDoc('## The heading text')
    modes.enterSourceMode(view, 0)
    // `createBlockEditor` is stubbed here, so the notification the real
    // `dispatchTransaction` sends on a record change is delivered by hand;
    // `editor.test.ts` is where the notification itself is pinned.
    mainState.editorOptions?.onModeChange?.(modes.currentBlockMode(view.state))
    await flushAsync()
    expect(chip()).toEqual({
      text: 'Source \u2014 \u201cThe heading text\u201d \u00b7 Esc for visual',
      hidden: false,
    })

    modes.exitBlockMode(view)
    mainState.editorOptions?.onModeChange?.(modes.currentBlockMode(view.state))
    await flushAsync()
    expect(chip()).toEqual({ text: '', hidden: true })
  })

  it('names a diagram by its first line, and truncates a long one', async () => {
    await loadMain()
    const modes = await mainSideBlockModes()
    const view = await mountDoc('```mermaid\nflowchart LR\n  A[Alpha]\n```')
    modes.enterBlockMode(view, 0, { interaction: 'editing' })
    mainState.editorOptions?.onModeChange?.(modes.currentBlockMode(view.state))
    await flushAsync()
    expect(chip().text).toBe('Edit \u2014 \u201cflowchart LR\u201d')

    const long = await mountDoc('a paragraph of exactly sixty words is not what a status chip is for at all')
    modes.enterSourceMode(long, 0)
    mainState.editorOptions?.onModeChange?.(modes.currentBlockMode(long.state))
    await flushAsync()
    const text = chip().text
    expect(text.startsWith('Source \u2014 \u201c')).toBe(true)
    expect(text.endsWith('\u2026\u201d \u00b7 Esc for visual')).toBe(true)
    expect(text.length).toBeLessThan(90)
  })
})

describe('quit', () => {
  it('requests a quit through the native shell when available', async () => {
    mainState.hasBridge.mockReturnValue(true)
    await loadMain()
    press('q')
    await flushAsync()
    expect(mainState.invoke).toHaveBeenCalledWith('quit')
  })

  it('closes the window without a native shell', async () => {
    await loadMain()
    const close = vi.spyOn(window, 'close').mockImplementation(() => undefined)
    press('q')
    await flushAsync()
    expect(close).toHaveBeenCalled()
  })
})

describe('document zoom', () => {
  const applied = (): string => document.documentElement.style.getPropertyValue('--doc-zoom')

  it('applies a saved level at boot', async () => {
    localStorage.setItem('edi.zoom', '1.25')
    await loadMain()
    expect(applied()).toBe('1.25')
  })

  it('zooms from the View commands and the shortcut, and resets', async () => {
    await loadMain()
    expect(applied()).toBe('1')
    menu('zoomIn')
    await flushAsync()
    expect(applied()).toBe('1.1')
    menu('zoomTo', '2')
    await flushAsync()
    expect(applied()).toBe('2')
    menu('zoomOut')
    await flushAsync()
    expect(applied()).toBe('1.75')
    press('=', {})
    await flushAsync()
    expect(applied()).toBe('2')
    menu('zoomReset')
    await flushAsync()
    expect(applied()).toBe('1')
  })

  it('zooms from Ctrl+wheel anywhere, not only over the editor', async () => {
    await loadMain()
    const status = document.querySelector('#statusbar')!
    // Dispatched on the status bar (outside the editor surface): the listener
    // has to be on `window`, or a Ctrl+wheel here would fall through to
    // Chromium's whole-page zoom and scale the chrome.
    status.dispatchEvent(
      new WheelEvent('wheel', { deltaY: -120, ctrlKey: true, bubbles: true, cancelable: true }),
    )
    await flushAsync()
    expect(applied()).toBe('1.1')

    // A plain wheel is left to scroll.
    status.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true }))
    await flushAsync()
    expect(applied()).toBe('1.1')

    // The throttle is time-based; step past it, then zoom back down.
    await new Promise((resolve) => setTimeout(resolve, 120))
    status.dispatchEvent(
      new WheelEvent('wheel', { deltaY: 120, ctrlKey: true, bubbles: true, cancelable: true }),
    )
    await flushAsync()
    expect(applied()).toBe('1')
  })

  it('shows the status indicator only away from 100%', async () => {
    await loadMain()
    const indicator = document.querySelector<HTMLButtonElement>('#status-zoom')!
    expect(indicator.hidden).toBe(true)
    menu('zoomIn')
    await flushAsync()
    expect(indicator.hidden).toBe(false)
    expect(indicator.textContent).toBe('110%')
    menu('zoomReset')
    await flushAsync()
    expect(indicator.hidden).toBe(true)
  })
})
