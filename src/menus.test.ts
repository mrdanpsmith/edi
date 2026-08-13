import { describe, expect, it, vi } from 'vitest'

import { bindMenuCommands } from './menus'

describe('bindMenuCommands', () => {
  it('registers a global command dispatcher', () => {
    const handlers = {
      new: vi.fn(),
      open: vi.fn(),
      save: vi.fn(),
      saveAs: vi.fn(),
      revert: vi.fn(),
      importTable: vi.fn(),
      export: vi.fn(),
      togglePreview: vi.fn(),
    }
    bindMenuCommands(handlers)
    expect(window.ediMenuCommand).toBeTypeOf('function')
    window.ediMenuCommand?.('open')
    expect(handlers.open).toHaveBeenCalledTimes(1)
    expect(handlers.save).not.toHaveBeenCalled()
  })

  it('dispatches every command to its handler', () => {
    const handlers = {
      new: vi.fn(),
      open: vi.fn(),
      save: vi.fn(),
      saveAs: vi.fn(),
      revert: vi.fn(),
      importTable: vi.fn(),
      export: vi.fn(),
      togglePreview: vi.fn(),
    }
    bindMenuCommands(handlers)
    const commands = [
      'new',
      'open',
      'save',
      'saveAs',
      'revert',
      'importTable',
      'export',
      'togglePreview',
    ]
    for (const command of commands) {
      window.ediMenuCommand?.(command)
    }
    for (const command of commands) {
      expect(handlers[command as keyof typeof handlers]).toHaveBeenCalledTimes(1)
    }
  })

  it('ignores unknown commands', () => {
    const handlers = {
      new: vi.fn(),
      open: vi.fn(),
      save: vi.fn(),
      saveAs: vi.fn(),
      revert: vi.fn(),
      importTable: vi.fn(),
      export: vi.fn(),
      togglePreview: vi.fn(),
    }
    bindMenuCommands(handlers)
    expect(() => window.ediMenuCommand?.('nope')).not.toThrow()
    expect(handlers.open).not.toHaveBeenCalled()
  })
})
