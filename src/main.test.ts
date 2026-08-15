import { beforeEach, describe, expect, it, vi } from 'vitest'

import { EditorView } from '@codemirror/view'

const mainState = vi.hoisted(() => ({
  hasBridge: vi.fn(() => false),
  invoke: vi.fn().mockResolvedValue(undefined),
  confirmAction: vi.fn().mockResolvedValue(true),
  pickOpenPath: vi.fn(),
  readTextFile: vi.fn(),
  pickSavePath: vi.fn(),
  writeTextFile: vi.fn(),
  pickExportPath: vi.fn(),
  pickImageImportPath: vi.fn(),
  pickImportPath: vi.fn(),
  pickTextImportPath: vi.fn(),
  readAnyTextFile: vi.fn(),
}))

vi.mock('./bridge', () => ({
  hasBridge: () => mainState.hasBridge(),
  invoke: mainState.invoke,
  confirmAction: mainState.confirmAction,
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

vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn().mockResolvedValue({ svg: '<svg></svg>' }),
  },
}))

const DOM_TEMPLATE = `
  <nav id="tabbar" role="tablist" aria-label="Documents"></nav>
  <main id="workspace">
    <section id="editor-pane" aria-label="Editor">
      <div id="formatbar" role="toolbar" aria-label="Formatting"></div>
      <div id="editor-container"></div>
    </section>
    <div id="divider" role="separator" aria-orientation="vertical" aria-label="Resize preview"></div>
    <section id="preview-pane" aria-label="Preview">
      <div id="preview-container"></div>
    </section>
  </main>
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

function editorView(): EditorView {
  const cm = editorContainer().querySelector<HTMLElement>('.cm-editor')!
  return EditorView.findFromDOM(cm)!
}

function editorContainer(): HTMLElement {
  return document.querySelector<HTMLElement>('#editor-container')!
}

function docText(): string {
  return editorView().state.doc.toString()
}

function typeText(text: string): void {
  editorView().dispatch({ changes: { from: 0, insert: text } })
}

function tabbar(): HTMLElement {
  return document.querySelector<HTMLElement>('#tabbar')!
}

function previewContainer(): HTMLElement {
  return document.querySelector<HTMLElement>('#preview-container')!
}

function previewPane(): HTMLElement {
  return document.querySelector<HTMLElement>('#preview-pane')!
}

function editorPane(): HTMLElement {
  return document.querySelector<HTMLElement>('#editor-pane')!
}

function statusLeft(): HTMLElement {
  return document.querySelector<HTMLElement>('#status-left')!
}

function statusRight(): HTMLElement {
  return document.querySelector<HTMLElement>('#status-right')!
}

function activeTabTitle(): string | null {
  return tabbar().querySelector('.tab.active .tab-title')?.textContent ?? null
}

function formatBar(): HTMLElement {
  return document.querySelector<HTMLElement>('#formatbar')!
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
    expect(docText()).toContain('# Welcome to Edi')
    expect(document.title).toBe('Untitled — Edi')
    expect(statusLeft().textContent).toBe('Untitled')
    expect(statusRight().textContent).toContain('words')
    expect(tabbar().querySelectorAll('.tab')).toHaveLength(1)
    expect(previewContainer().querySelector('h1')?.textContent).toContain('Welcome to Edi')
    expect(previewContainer().querySelector('.mermaid[data-state="done"]')).not.toBeNull()
  })

  it('marks the active tab dirty and updates the status when typing', async () => {
    await loadMain()
    typeText('hello world')
    expect(tabbar().querySelector('.tab-title')?.textContent).toBe('* Untitled')
    expect(statusRight().textContent).toContain('2 words')
  })

  it('debounces preview re-renders while typing', async () => {
    await loadMain()
    typeText('first')
    typeText('second')
    expect(previewContainer().textContent).toContain('Welcome to Edi')
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
    menu('togglePreview')
    await flushAsync()
    expect(previewPane().hidden).toBe(true)
  })
})

describe('keyboard shortcuts', () => {
  it('binds all application shortcuts', async () => {
    mainState.pickOpenPath.mockResolvedValue(null)
    mainState.pickSavePath.mockResolvedValue(null)
    mainState.pickExportPath.mockResolvedValue(null)
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
    press('p', { shiftKey: true })
    press('e', { shiftKey: true })
    press('q')
    await flushAsync()

    expect(close).toHaveBeenCalled()
    expect(previewPane().hidden).toBe(true)
  })
})

describe('tabs', () => {
  it('opens a new tab with Ctrl+N', async () => {
    await loadMain()
    press('n')
    const state = await stateModule()
    expect(state.getState().sessions).toHaveLength(2)
    expect(tabbar().querySelectorAll('.tab')).toHaveLength(2)
    expect(docText()).toBe('')
  })

  it('closes the active tab with Ctrl+W', async () => {
    await loadMain()
    press('n')
    press('w')
    await flushAsync()
    const state = await stateModule()
    expect(state.getState().sessions).toHaveLength(1)
    expect(docText()).toContain('# Welcome to Edi')
  })

  it('keeps the tab when closing a dirty document is cancelled', async () => {
    await loadMain()
    typeText('unsaved')
    mainState.confirmAction.mockResolvedValue(false)
    press('w')
    await flushAsync()
    const state = await stateModule()
    expect(state.getState().sessions).toHaveLength(1)
    expect(docText()).toContain('unsaved')
    expect(mainState.confirmAction).toHaveBeenCalledWith(
      'Discard unsaved changes and close this document?',
    )
  })

  it('closes a dirty document after confirming', async () => {
    await loadMain()
    typeText('unsaved')
    press('w')
    await flushAsync()
    const state = await stateModule()
    expect(state.getState().sessions).toHaveLength(1)
    expect(docText()).toBe('')
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
    expect(docText()).toBe('hello file')
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
    expect(docText()).toBe('content b')
  })

  it('reports a failed open', async () => {
    mainState.pickOpenPath.mockResolvedValue(['/tmp/bad.md'])
    mainState.readTextFile.mockRejectedValue(new Error('no such file'))
    await loadMain()
    menu('open')
    await flushAsync()
    expect(mainState.confirmAction).toHaveBeenCalledWith(
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
      expect.stringContaining('# Welcome to Edi'),
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
    expect(mainState.confirmAction).toHaveBeenCalledWith(
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
    typeText('edited')
    mainState.readTextFile.mockResolvedValue('reverted content')
    menu('revert')
    await flushAsync()
    expect(docText()).toBe('reverted content')
    expect(activeTabTitle()).toBe('notes.md')
  })

  it('does not revert when the user cancels', async () => {
    mainState.pickOpenPath.mockResolvedValue(['/tmp/notes.md'])
    mainState.readTextFile.mockResolvedValue('hello file')
    await loadMain()
    menu('open')
    await flushAsync()
    typeText('edited')
    mainState.confirmAction.mockResolvedValue(false)
    menu('revert')
    await flushAsync()
    expect(docText()).toBe('editedhello file')
  })

  it('ignores revert when no path is set', async () => {
    await loadMain()
    menu('revert')
    await flushAsync()
    expect(mainState.confirmAction).not.toHaveBeenCalled()
  })

  it('reverts a clean document without asking', async () => {
    mainState.pickOpenPath.mockResolvedValue(['/tmp/notes.md'])
    mainState.readTextFile.mockResolvedValue('hello file')
    await loadMain()
    menu('open')
    await flushAsync()
    menu('save')
    await flushAsync()
    mainState.readTextFile.mockResolvedValue('v2')
    menu('revert')
    await flushAsync()
    expect(mainState.confirmAction).not.toHaveBeenCalled()
    expect(docText()).toBe('v2')
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
    expect(mainState.confirmAction).toHaveBeenCalledWith(
      expect.stringContaining('Failed to revert /tmp/notes.md'),
    )
  })
})

describe('export', () => {
  it('exports the preview to HTML', async () => {
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
    expect(mainState.confirmAction).toHaveBeenCalledWith(
      expect.stringContaining('Failed to export /tmp/out.html'),
    )
  })
})

describe('view toggles', () => {
  it('toggles the preview', async () => {
    await loadMain()
    expect(previewPane().hidden).toBe(false)
    menu('togglePreview')
    expect(previewPane().hidden).toBe(true)
    expect(mainState.invoke).toHaveBeenCalledWith(
      'setMenuState',
      expect.objectContaining({ previewVisible: false }),
    )
    menu('togglePreview')
    expect(previewPane().hidden).toBe(false)
  })

  it('toggles the editor', async () => {
    await loadMain()
    expect(editorPane().hidden).toBe(false)
    menu('toggleEditor')
    expect(editorPane().hidden).toBe(true)
    expect(mainState.invoke).toHaveBeenCalledWith(
      'setMenuState',
      expect.objectContaining({ editorVisible: false }),
    )
    menu('toggleEditor')
    expect(editorPane().hidden).toBe(false)
  })

  it('toggles the formatting toolbar', async () => {
    await loadMain()
    expect(formatBar().hidden).toBe(false)
    menu('toggleFormatting')
    expect(formatBar().hidden).toBe(true)
    expect(mainState.invoke).toHaveBeenCalledWith(
      'setMenuState',
      expect.objectContaining({ formattingVisible: false }),
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
    expect(docText()).toContain('| A | B |')
    expect(statusLeft().textContent).toBe('Imported data.csv')
  })

  it('reports a failed table import', async () => {
    mainState.pickImportPath.mockResolvedValue('/tmp/data.csv')
    mainState.invoke.mockRejectedValue(new Error('parse failed'))
    await loadMain()
    menu('importTable')
    await flushAsync()
    expect(mainState.confirmAction).toHaveBeenCalledWith(
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
    expect(docText()).toContain('# Welcome to Edi')
    expect(mainState.confirmAction).not.toHaveBeenCalled()
  })

  it('imports a text file', async () => {
    mainState.pickTextImportPath.mockResolvedValue('/tmp/data.txt')
    mainState.readAnyTextFile.mockResolvedValue('inserted text')
    await loadMain()
    menu('importText')
    await flushAsync()
    expect(docText()).toContain('inserted text')
    expect(statusLeft().textContent).toBe('Inserted data')
  })

  it('reports a failed text import', async () => {
    mainState.pickTextImportPath.mockResolvedValue('/tmp/data.txt')
    mainState.readAnyTextFile.mockRejectedValue(new Error('nope'))
    await loadMain()
    menu('importText')
    await flushAsync()
    expect(mainState.confirmAction).toHaveBeenCalledWith(
      expect.stringContaining('Failed to insert /tmp/data.txt'),
    )
  })

  it('inserts an image reference', async () => {
    mainState.pickImageImportPath.mockResolvedValue('/tmp/pic.png')
    await loadMain()
    menu('insertImage')
    await flushAsync()
    expect(docText()).toContain('![pic](/tmp/pic.png)')
    expect(statusLeft().textContent).toBe('Inserted pic')
  })

  it('angle-brackets image paths that contain spaces', async () => {
    mainState.pickImageImportPath.mockResolvedValue('/tmp/my pic.png')
    await loadMain()
    menu('insertImage')
    await flushAsync()
    expect(docText()).toContain('![my pic](</tmp/my pic.png>)')
  })
})

describe('links', () => {
  it('opens external links in a new window', async () => {
    await loadMain()
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    previewContainer().innerHTML = '<a href="https://example.com">x</a>'
    previewContainer()
      .querySelector('a')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(open).toHaveBeenCalledWith('https://example.com', '_blank', 'noopener')
  })

  it('routes external links through the native shell when available', async () => {
    mainState.hasBridge.mockReturnValue(true)
    await loadMain()
    previewContainer().innerHTML = '<a href="https://example.com">x</a>'
    previewContainer()
      .querySelector('a')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await flushAsync()
    expect(mainState.invoke).toHaveBeenCalledWith('openUrl', { url: 'https://example.com' })
  })

  it('opens local markdown links as documents', async () => {
    mainState.pickOpenPath.mockResolvedValue(['/tmp/docs/a.md'])
    mainState.readTextFile.mockResolvedValue('doc a')
    await loadMain()
    menu('open')
    await flushAsync()

    mainState.readTextFile.mockResolvedValue('doc b')
    previewContainer().innerHTML = '<a href="b.md">x</a>'
    previewContainer()
      .querySelector('a')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await flushAsync()

    expect(mainState.readTextFile).toHaveBeenCalledWith('/tmp/docs/b.md')
    expect(docText()).toBe('doc b')
  })

  it('opens non-markdown local links as file URLs', async () => {
    mainState.pickOpenPath.mockResolvedValue(['/tmp/docs/a.md'])
    mainState.readTextFile.mockResolvedValue('doc a')
    await loadMain()
    menu('open')
    await flushAsync()

    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    previewContainer().innerHTML = '<a href="data.csv">x</a>'
    previewContainer()
      .querySelector('a')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(open).toHaveBeenCalledWith('file:///tmp/docs/data.csv', '_blank', 'noopener')
  })

  it('ignores anchor fragment links', async () => {
    await loadMain()
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    previewContainer().innerHTML = '<a href="#section">x</a>'
    previewContainer()
      .querySelector('a')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(open).not.toHaveBeenCalled()
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
