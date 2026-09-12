import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EditorState, TextSelection } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { history } from 'prosemirror-history'
import { schema } from './schema'
import { markdownToProse, proseToMarkdown } from './markdown'

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
    hasBridge: vi.fn(() => false),
    invoke: vi.fn().mockResolvedValue(undefined),
    confirmAction: vi.fn().mockResolvedValue(true),
    showError: vi.fn().mockResolvedValue(undefined),
    pickOpenPath: vi.fn(),
    readTextFile: vi.fn(),
    pickSavePath: vi.fn(),
    writeTextFile: vi.fn(),
    pickExportPath: vi.fn(),
    pickImageImportPath: vi.fn(),
    pickImportPath: vi.fn(),
    pickTextImportPath: vi.fn(),
    readAnyTextFile: vi.fn(),
    getRecentFiles: vi.fn().mockResolvedValue([]),
    addRecentFile: vi.fn().mockResolvedValue(undefined),
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
    readTextFile: mainState.readTextFile,
    pickSavePath: mainState.pickSavePath,
    writeTextFile: mainState.writeTextFile,
    pickExportPath: mainState.pickExportPath,
    pickImageImportPath: mainState.pickImageImportPath,
    pickImportPath: mainState.pickImportPath,
    pickTextImportPath: mainState.pickTextImportPath,
    readAnyTextFile: mainState.readAnyTextFile,
  }
})

vi.mock('./editor', () => ({
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

const DOM_TEMPLATE = `
  <div id="app">
    <nav id="tabbar" role="tablist" aria-label="Documents"></nav>
    <main id="workspace">
      <div id="formatbar" role="toolbar" aria-label="Formatting"></div>
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

function menu(command: string): void {
  window.ediMenuCommand?.(command)
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
  mainState.addRecentFile.mockReset().mockResolvedValue(undefined)
  mainState.markdown = 'Welcome'
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

describe('context menu', () => {
  it('opens the clipboard menu on right-click inside the editor', async () => {
    await loadMain()
    window.ediSetContent?.('Hello')
    await flushAsync()

    const editor = document.querySelector<HTMLElement>('#editor-container')!
    editor.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 20, clientY: 20 }))
    const labels = Array.from(document.querySelectorAll('.edi-menu-item'))
      .map((button) => (button as HTMLButtonElement).textContent ?? '')
    expect(labels).toEqual([
      'Undo', 'Redo', 'Cut', 'Copy', 'Paste', 'Select all',
    ])
    // Repeated right-clicks replace the open menu instead of stacking menus.
    editor.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 30, clientY: 30 }))
    expect(document.querySelectorAll('.edi-context-menu')).toHaveLength(1)
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
