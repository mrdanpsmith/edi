import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EditorState, TextSelection } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { history, undo } from 'prosemirror-history'
import { schema } from './schema'
import { markdownToProse, proseToMarkdown } from './markdown'
import { type ContextMenuEntry } from './contextmenu'

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
    editorView,
    editorOptions: undefined as { onChange?: () => void } | undefined,
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
    options?: { onChange?: () => void },
  ) => {
    mainState.editorOptions = options
    mainState.markdown = markdown
    return {
      getView: () => mainState.editorView,
      getMarkdown: () => mainState.markdown,
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
}))

vi.mock('./node/mermaid', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./node/mermaid')>()
  return {
    ...actual,
    rethemeMermaid: vi.fn(),
  }
})

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
  await import('./main')
  await flushAsync()
}

async function stateModule(): Promise<typeof import('./state')> {
  return import('./state')
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

  it('is bound to Ctrl+Shift+C', async () => {
    await openNotes()
    mainState.copyText.mockClear()
    press('c', { shiftKey: true })
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
  function attachView(markdown: string): EditorView {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const view = new EditorView(host, {
      state: EditorState.create({
        doc: markdownToProse(markdown, schema),
        plugins: [history()],
      }),
    })
    mainState.editorView = view as unknown as typeof mainState.editorView
    return view
  }

  function columnField(): HTMLTextAreaElement {
    return document.querySelector<HTMLTextAreaElement>('.edi-dialog-input')!
  }

  function addBoard(): void {
    document.querySelector<HTMLButtonElement>('.toolbar-primary')!.click()
  }

  it('inserts a board built from the dialog and opens it in edit mode', async () => {
    await loadMain()
    const view = attachView('Hello')
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
    expect(board?.attrs._edit).toBe(true)
    expect(proseToMarkdown(view.state.doc)).toContain('```mermaid\nkanban\n  col1[Backlog]\n  col2[Doing]\n```')

    undo(view.state, view.dispatch)
    expect(view.state.doc.childCount).toBe(1)
    expect(view.state.doc.child(0)?.type.name).toBe('paragraph')
  })

  it('replaces an empty paragraph with the board', async () => {
    await loadMain()
    const view = attachView('')
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
    const view = attachView('Hello')
    menu('insertKanban')
    await flushAsync()
    columnField().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushAsync()
    expect(view.state.doc.childCount).toBe(1)
    expect(mainState.showError).not.toHaveBeenCalled()
  })

  it('reports names the kanban grammar cannot carry and inserts nothing', async () => {
    await loadMain()
    const view = attachView('Hello')
    menu('insertKanban')
    await flushAsync()
    // A double quote is the one name no quoting can carry: it would close the
    // label its own quote opened.
    columnField().value = '"'
    addBoard()
    await flushAsync()
    expect(view.state.doc.childCount).toBe(1)
    expect(mainState.showError).toHaveBeenCalledWith(
      expect.stringContaining('kanban column'),
    )
  })

  it('inserts a column whose name holds a delimiter, quoted in the source', async () => {
    await loadMain()
    mainState.showError.mockClear()
    const view = attachView('Hello')
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
   * A real EditorView holding `markdown`, mounted where the context menu looks
   * for it: `buildContextMenu` reads the view off the app's block editor, and
   * that is a stub in this suite (a fake doc cannot answer `posAtDOM`).
   */
  async function mountLinkDoc(markdown: string): Promise<{ view: EditorView }> {
    await loadMain()
    // A session has to exist: with no document open the app answers no
    // right-click at all, before the menu is even built.
    window.ediSetContent?.('Hello')
    await flushAsync()
    const host = document.createElement('div')
    document.body.appendChild(host)
    const view = new EditorView(host, {
      state: EditorState.create({
        doc: markdownToProse(markdown, schema),
        plugins: [history()],
      }),
    })
    mainState.editorView = view as unknown as typeof mainState.editorView
    document.querySelector<HTMLElement>('#editor-container')!.appendChild(view.dom)
    await flushAsync()
    return { view }
  }

  it('opens the clipboard menu on right-click inside the editor', async () => {
    await loadMain()
    window.ediSetContent?.('Hello')
    await flushAsync()

    const editor = document.querySelector<HTMLElement>('#editor-container')!
    editor.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 20, clientY: 20 }))
    const labels = Array.from(document.querySelectorAll('.edi-menu-item'))
      .map((button) => (button as HTMLButtonElement).textContent ?? '')
    expect(labels).toEqual([
      'Undo', 'Redo', 'Cut', 'Copy', 'Paste', 'Select all', 'Find…', 'Replace…',
    ])
    // Repeated right-clicks replace the open menu instead of stacking menus.
    editor.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 30, clientY: 30 }))
    expect(document.querySelectorAll('.edi-context-menu')).toHaveLength(1)
  })

  /** Right-click `target` and press the menu's "Edit link…". */
  function editLinkFrom(target: Element): void {
    target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 20, clientY: 20 }))
    const item = Array.from(document.querySelectorAll<HTMLButtonElement>('.edi-menu-item'))
      .find((button) => button.textContent === 'Edit link…')
    expect(item, 'menu item Edit link…').toBeDefined()
    item!.click()
  }

  it('offers Edit link… on a right-click over a link, and nowhere else', async () => {
    const { view } = await mountLinkDoc('See [notes](other.md) here')
    const labels = (): string[] =>
      Array.from(document.querySelectorAll('.edi-menu-item'))
        .map((button) => (button as HTMLButtonElement).textContent ?? '')

    document
      .querySelector<HTMLElement>('#editor-container a[href]')!
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 20, clientY: 20 }))
    expect(labels()).toContain('Edit link…')

    // Plain text keeps the menu it always had: the item is about the link the
    // right-click landed on, not about links existing somewhere in the doc.
    document
      .querySelector<HTMLElement>('#editor-container p')!
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 20, clientY: 20 }))
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
    await loadMain()
    window.ediSetContent?.('Hello')
    await flushAsync()
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
    await loadMain()
    window.ediSetContent?.('Hello')
    await flushAsync()
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
    await loadMain()
    window.ediSetContent?.('Hello')
    await flushAsync()
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
    await loadMain()
    document.querySelector<HTMLElement>('#editor-container')!
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 0, clientY: 0 }))
    expect(document.querySelector('.edi-context-menu')).toBeNull()
  })

  it('offers Run and Copy source on a runnable block, Stop while running', async () => {
    await loadMain()
    window.ediSetContent?.('Hello')
    await flushAsync()

    const runnable = document.createElement('div')
    runnable.className = 'runnable-block'
    runnable.innerHTML = [
      '<pre class="runnable-source">#!/usr/bin/env python3',
      'print("hi")</pre>',
      '<button type="button" class="exec-run">Run</button>',
    ].join('\n')
    document.querySelector<HTMLElement>('#editor-container')!.appendChild(runnable)
    const source = runnable.querySelector<HTMLElement>('.runnable-source')!

    source.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 5, clientY: 5 }))
    let labels = Array.from(document.querySelectorAll<HTMLButtonElement>('.edi-menu-item'))
      .map((button) => button.textContent ?? '')
    expect(labels).toContain('Run')
    expect(labels).toContain('Copy source')
    expect(labels).not.toContain('Stop')

    runnable.querySelector<HTMLElement>('.exec-run')!.classList.add('exec-stop')
    source.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 5, clientY: 5 }))
    labels = Array.from(document.querySelectorAll<HTMLButtonElement>('.edi-menu-item'))
      .map((button) => button.textContent ?? '')
    expect(labels).toContain('Stop')
    expect(labels).not.toContain('Run')
    runnable.remove()
  })

  it('offers Visual mode when right-clicking source-mode blocks', async () => {
    await loadMain()
    window.ediSetContent?.('Hello')
    await flushAsync()
    const sourceMode = document.createElement('div')
    sourceMode.className = 'block-source-mode'
    document.querySelector<HTMLElement>('#editor-container')!.appendChild(sourceMode)

    sourceMode.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 5, clientY: 5 }))
    const labels = Array.from(document.querySelectorAll<HTMLButtonElement>('.edi-menu-item'))
      .map((button) => button.textContent ?? '')
    expect(labels).toContain('Visual mode')
    expect(labels).not.toContain('Edit source')
    sourceMode.remove()
  })

  it('enters source mode from Edit source on a mermaid block', async () => {
    await loadMain()
    window.ediSetContent?.('Hello')
    await flushAsync()
    const host = document.createElement('div')
    document.body.appendChild(host)
    const realView = new EditorView(host, {
      state: EditorState.create({ doc: markdownToProse('# Hello', schema) }),
    })
    mainState.editorView = realView as unknown as typeof mainState.editorView

    const mermaid = document.createElement('div')
    mermaid.className = 'mermaid'
    mermaid.innerHTML = '<div class="block-handle" data-block-pos="1"></div><div class="mermaid-preview"></div>'
    document.querySelector<HTMLElement>('#editor-container')!.appendChild(mermaid)

    mermaid.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 5, clientY: 5 }))
    const editSource = Array.from(document.querySelectorAll<HTMLButtonElement>('.edi-menu-item'))
      .find((button) => button.textContent === 'Edit source')!
    expect(editSource).toBeDefined()
    editSource.click()
    expect(realView.state.doc.child(0)?.attrs._source).toBe(true)

    realView.destroy()
    host.remove()
    mermaid.remove()
  })

  it('enters and leaves mermaid edit mode from the block menu', async () => {
    await loadMain()
    window.ediSetContent?.('Hello')
    await flushAsync()
    const host = document.createElement('div')
    document.body.appendChild(host)
    const realView = new EditorView(host, {
      state: EditorState.create({
        doc: markdownToProse('```mermaid\ngraph TD\n  A[Alpha]\n```', schema),
      }),
    })
    mainState.editorView = realView as unknown as typeof mainState.editorView

    const visual = document.createElement('div')
    visual.className = 'mermaid'
    visual.innerHTML = '<div class="block-handle" data-block-pos="0"></div><div class="mermaid-preview"></div>'
    document.querySelector<HTMLElement>('#editor-container')!.appendChild(visual)

    const openMenu = (): HTMLButtonElement[] => {
      visual.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 5, clientY: 5 }))
      return Array.from(document.querySelectorAll<HTMLButtonElement>('.edi-menu-item'))
    }
    const item = (buttons: HTMLButtonElement[], label: string): HTMLButtonElement => {
      const found = buttons.find((button) => button.textContent === label)
      expect(found, `menu item ${label}`).toBeDefined()
      return found!
    }

    item(openMenu(), 'Edit diagram').click()
    expect(realView.state.doc.child(0)?.attrs._edit).toBe(true)
    visual.classList.add('mermaid-editing')

    item(openMenu(), 'Done editing').click()
    expect(realView.state.doc.child(0)?.attrs._edit).not.toBe(true)

    realView.destroy()
    host.remove()
    visual.remove()
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

  /** A `.spreadsheet` block (block handle included, so the block actions
   *  resolve) with a live view behind it, plus its teardown. */
  const fakeSheet = (): { sheet: HTMLElement; teardown: () => void } => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const view = new EditorView(host, {
      state: EditorState.create({ doc: markdownToProse('# Hello', schema) }),
    })
    mainState.editorView = view as unknown as typeof mainState.editorView
    const sheet = document.createElement('div')
    sheet.className = 'spreadsheet'
    sheet.innerHTML = '<div class="block-handle" data-block-pos="1"></div>'
    document.querySelector<HTMLElement>('#editor-container')!.appendChild(sheet)
    return {
      sheet,
      teardown: () => {
        view.destroy()
        host.remove()
        sheet.remove()
      },
    }
  }

  it('scopes the menu to a spreadsheet cell editor', async () => {
    await loadMain()
    window.ediSetContent?.('Hello')
    await flushAsync()
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
    await loadMain()
    window.ediSetContent?.('Hello')
    await flushAsync()
    const input = sheetInput('=1', [2, 2])

    openCellMenu(input)
    expect(findMenuItem('Cut').disabled).toBe(true)
    expect(findMenuItem('Copy').disabled).toBe(true)
  })

  it('selects and pastes into the cell editor', async () => {
    await loadMain()
    window.ediSetContent?.('Hello')
    await flushAsync()
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
    await loadMain()
    window.ediSetContent?.('Hello')
    await flushAsync()
    const execCommand = vi.fn()
    Object.defineProperty(document, 'execCommand', { configurable: true, value: execCommand })
    const input = sheetInput('=1', [2, 2])

    openCellMenu(input)
    findMenuItem('Undo').click()
    expect(execCommand).toHaveBeenCalledWith('undo')
  })

  it('keeps focus in a spreadsheet input when its menu opens', async () => {
    await loadMain()
    window.ediSetContent?.('Hello')
    await flushAsync()
    const input = sheetInput('=1', [2, 2])
    const blurred = vi.fn()
    input.addEventListener('blur', blurred)

    openCellMenu(input)
    expect(document.activeElement).toBe(input)
    expect(blurred).not.toHaveBeenCalled()
  })

  it('keeps the spreadsheet actions alongside the cell menu', async () => {
    await loadMain()
    window.ediSetContent?.('Hello')
    await flushAsync()
    const { sheet, teardown } = fakeSheet()
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
      'Table view',
      'Edit source',
    ])

    teardown()
  })

  it('offers only block actions on a cell with no live spreadsheet view', async () => {
    await loadMain()
    window.ediSetContent?.('Hello')
    await flushAsync()
    const { sheet, teardown } = fakeSheet()
    sheet.insertAdjacentHTML(
      'beforeend',
      '<table><tbody><tr><td class="ss-cell">1</td></tr></tbody></table>',
    )
    const cell = sheet.querySelector<HTMLElement>('.ss-cell')!

    cell.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 5, clientY: 5 }))
    expect(menuLabels()).toEqual(['Table view', 'Edit source'])

    teardown()
  })

  it('keeps the grid editing commands above the block actions on a cell', async () => {
    await loadMain()
    window.ediSetContent?.('Hello')
    await flushAsync()
    const { sheet, teardown } = fakeSheet()
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
    expect(menuLabels()).toEqual(['Cut', 'Copy', 'Table view', 'Edit source'])

    findMenuItem('Cut').click()
    expect(cut).toHaveBeenCalledTimes(1)

    teardown()
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
