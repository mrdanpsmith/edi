import { describe, expect, it, vi } from 'vitest'

import { bindMenuCommands } from './menus'

function makeHandlers() {
  return {
    new: vi.fn(),
    open: vi.fn(),
    save: vi.fn(),
    saveAs: vi.fn(),
    revert: vi.fn(),
    importTable: vi.fn(),
    importText: vi.fn(),
    insertImage: vi.fn(),
    export: vi.fn(),
    toggleFormatting: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
    cut: vi.fn(),
    copy: vi.fn(),
    paste: vi.fn(),
    selectAll: vi.fn(),
  }
}

const COMMANDS = [
  'new',
  'open',
  'save',
  'saveAs',
  'revert',
  'importTable',
  'importText',
  'insertImage',
  'export',
  'toggleFormatting',
  'undo',
  'redo',
  'cut',
  'copy',
  'paste',
  'selectAll',
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
})
