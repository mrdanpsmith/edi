import { describe, expect, it, vi } from 'vitest'

import { bindMenuCommands } from './menus'

function makeHandlers() {
  return {
    new: vi.fn(),
    open: vi.fn(),
    save: vi.fn(),
    saveAs: vi.fn(),
    rename: vi.fn(),
    revert: vi.fn(),
    importTable: vi.fn(),
    importText: vi.fn(),
    insertImage: vi.fn(),
    insertTableDefault: vi.fn(),
    insertKanban: vi.fn(),
    export: vi.fn(),
    toggleToolbar: vi.fn(),
    toggleHoverBand: vi.fn(),
    zoomIn: vi.fn(),
    zoomOut: vi.fn(),
    zoomReset: vi.fn(),
    zoomTo: vi.fn(),
    formulaReference: vi.fn(),
    helpGuide: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
    cut: vi.fn(),
    copy: vi.fn(),
    copyAsMarkdown: vi.fn(),
    paste: vi.fn(),
    pasteAsMarkdown: vi.fn(),
    selectAll: vi.fn(),
    encryptBlock: vi.fn(),
    find: vi.fn(),
    replace: vi.fn(),
    openRecent: vi.fn(),
    copyFilePath: vi.fn(),
  }
}

const COMMANDS = [
  'new',
  'open',
  'save',
  'saveAs',
  'rename',
  'revert',
  'importTable',
  'importText',
  'insertImage',
  'insertTableDefault',
  'insertKanban',
  'export',
  'toggleToolbar',
  'toggleHoverBand',
  'zoomIn',
  'zoomOut',
  'zoomReset',
  'zoomTo',
  'formulaReference',
  'helpGuide',
  'undo',
  'redo',
  'cut',
  'copy',
  'copyAsMarkdown',
  'paste',
  'pasteAsMarkdown',
  'selectAll',
  'encryptBlock',
  'find',
  'replace',
  'openRecent',
  'copyFilePath',
]

describe('bindMenuCommands', () => {
  it('registers a global command dispatcher', () => {
    const handlers = makeHandlers()
    bindMenuCommands(handlers)
    expect(window.ediMenuCommand).toBeTypeOf('function')
    window.ediMenuCommand?.('open')
    expect(handlers.open).toHaveBeenCalledTimes(1)
    expect(handlers.save).not.toHaveBeenCalled()
  })

  it('dispatches every command to its handler', () => {
    const handlers = makeHandlers()
    bindMenuCommands(handlers)
    for (const command of COMMANDS) {
      window.ediMenuCommand?.(command)
    }
    for (const command of COMMANDS) {
      expect(handlers[command as keyof typeof handlers]).toHaveBeenCalledTimes(1)
    }
  })

  it('ignores unknown commands', () => {
    const handlers = makeHandlers()
    bindMenuCommands(handlers)
    expect(() => window.ediMenuCommand?.('nope')).not.toThrow()
    expect(handlers.open).not.toHaveBeenCalled()
  })

  it('forwards a command argument to its handler', () => {
    const handlers = makeHandlers()
    bindMenuCommands(handlers)
    window.ediMenuCommand?.('openRecent', '/x/a.md')
    expect(handlers.openRecent).toHaveBeenCalledWith('/x/a.md')
  })

  it('ignores a missing argument', () => {
    const handlers = makeHandlers()
    bindMenuCommands(handlers)
    expect(() => window.ediMenuCommand?.('openRecent')).not.toThrow()
    expect(handlers.openRecent).toHaveBeenCalledWith(undefined)
  })
})
