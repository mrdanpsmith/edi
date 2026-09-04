import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EditorState } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { schema } from './schema'
import { markdownToProse, proseToMarkdown } from './markdown'

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
    markdown: 'Welcome',
    editorView,
  }
})

vi.mock('./bridge', () => ({
  hasBridge: () => mainState.hasBridge(),
  invoke: mainState.invoke,
  confirmAction: mainState.confirmAction,
  showError: mainState.showError,
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
  createBlockEditor: vi.fn((_parent: HTMLElement, markdown: string) => {
    mainState.markdown = markdown
    return {
      getView: () => mainState.editorView,
      getMarkdown: () => mainState.markdown,
      setMarkdown: (value: string) => { mainState.markdown = value },
      insertMarkdown: (value: string) => { mainState.markdown += value },
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

vi.mock('./export', async () => {
  const actual = await vi.importActual('./export')
  return {
    ...actual,
    serializeDocToHtml: (_doc: unknown) => `<p>${(_doc as { textContent?: string }).textContent ?? ''}</p>`,
  }
})

const DOM_TEMPLATE = `
  <nav id="tabbar" role="tablist" aria-label="Documents"></nav>
  <main id="workspace">
    <section id="editor-container" aria-label="Editor"></section>
  </main>
  <div id="formatbar" role="toolbar" aria-label="Formatting"></div>
  <footer id="statusbar">
    <span id="status-left"></span>
    <span id="status-right"></span>
  </footer>
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
  localStorage.clear()
  window.matchMedia = matchMediaStub()
  mainState.hasBridge.mockReturnValue(false)
  mainState.invoke.mockReset().mockResolvedValue(undefined)
  mainState.confirmAction.mockReset().mockResolvedValue(true)
  mainState.markdown = 'Welcome'
  for (const mock of FILE_MOCKS) {
    mock.mockReset()
  }
  vi.restoreAllMocks()
})

describe('init', () => {
  it('boots the welcome document', async () => {
    await loadMain()
    const state = await stateModule()
    expect(state.getState().sessions).toHaveLength(1)
    expect(document.title).toBe('Untitled — Edi')
    expect(statusLeft().textContent).toBe('Untitled')
    expect(statusRight().textContent).toContain('words')
    expect(tabbarEl().querySelectorAll('.tab')).toHaveLength(1)
  })

  it('ignores keydowns without a modifier', async () => {
    await loadMain()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n' }))
    const state = await stateModule()
    expect(state.getState().sessions).toHaveLength(1)
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
    expect(state.getState().sessions).toHaveLength(2)

    press('w')
    await flushAsync()
    expect(state.getState().sessions).toHaveLength(1)

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

  it('pastes plain text via the text path even when HTML is present', async () => {
    await loadMain()
    mainState.hasBridge.mockReturnValue(true)
    mainState.invoke.mockResolvedValue({
      text: 'line1\nline2',
      html: '<div>ignored html</div>',
    })

    const host = document.createElement('div')
    document.body.appendChild(host)
    const realView = new EditorView(host, {
      state: EditorState.create({ doc: markdownToProse('abc', schema) }),
    })
    mainState.editorView = realView as unknown as typeof mainState.editorView

    menu('paste')
    await flushAsync()

    // Plain text is preferred, so the paste becomes two clean paragraphs
    // (not the HTML branch, and no literal newline inside one paragraph).
    expect(proseToMarkdown(realView.state.doc)).toContain('line1\n\nline2')
    expect(proseToMarkdown(realView.state.doc)).not.toContain('ignored html')
    realView.destroy()
    host.remove()
  })
})

describe('tabs', () => {
  it('opens a new tab with Ctrl+N', async () => {
    await loadMain()
    press('n')
    const state = await stateModule()
    expect(state.getState().sessions).toHaveLength(2)
    expect(tabbarEl().querySelectorAll('.tab')).toHaveLength(2)
  })

  it('closes the active tab with Ctrl+W', async () => {
    await loadMain()
    press('n')
    press('w')
    await flushAsync()
    const state = await stateModule()
    expect(state.getState().sessions).toHaveLength(1)
  })

  it('keeps the tab when closing a dirty document is cancelled', async () => {
    await loadMain()
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
    mainState.markdown = 'unsaved content'
    const { setActiveDirty } = await import('./state')
    setActiveDirty(true)
    await flushAsync()
    press('w')
    await flushAsync()
    const state = await stateModule()
    expect(state.getState().sessions).toHaveLength(1)
    expect(mainState.confirmAction).toHaveBeenCalled()
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
    expect(state.getState().sessions).toHaveLength(2)
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
    expect(state.getState().sessions).toHaveLength(2)
    expect(mainState.readTextFile).toHaveBeenCalledTimes(1)
  })

  it('does nothing when the open dialog is cancelled', async () => {
    mainState.pickOpenPath.mockResolvedValue(null)
    await loadMain()
    menu('open')
    await flushAsync()
    const state = await stateModule()
    expect(state.getState().sessions).toHaveLength(1)
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
    expect(state.getState().sessions).toHaveLength(3)
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
    menu('save')
    await flushAsync()
    expect(mainState.pickSavePath).toHaveBeenCalledWith('Untitled')
    expect(mainState.writeTextFile).toHaveBeenCalledWith(
      '/tmp/new.md',
      expect.stringContaining('Welcome'),
    )
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
    menu('save')
    await flushAsync()
    expect(mainState.confirmAction).toHaveBeenCalledWith(expect.stringContaining('/tmp/out.csv'))
    expect(mainState.writeTextFile).toHaveBeenCalledWith('/tmp/out.csv', expect.any(String))
  })

  it('reports a failed save', async () => {
    mainState.pickSavePath.mockResolvedValue('/tmp/new.md')
    mainState.writeTextFile.mockRejectedValue(new Error('disk full'))
    await loadMain()
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
    menu('export')
    await flushAsync()
    expect(mainState.writeTextFile).not.toHaveBeenCalled()
  })

  it('reports a failed export', async () => {
    mainState.pickExportPath.mockResolvedValue('/tmp/out.html')
    mainState.writeTextFile.mockRejectedValue(new Error('boom'))
    await loadMain()
    menu('export')
    await flushAsync()
    expect(mainState.showError).toHaveBeenCalledWith(
      expect.stringContaining('Failed to export /tmp/out.html'),
    )
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
