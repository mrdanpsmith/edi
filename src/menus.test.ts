import { afterEach, describe, expect, it, vi } from 'vitest'

import contract from '../shared/edi-contract.json'
import { type MenuCommand, isMenuCommand } from './contract'
import { type MenuCommands, bindMenuCommands } from './menus'

/**
 * The commands are read from the manifest rather than listed here: a second
 * list would be a second thing to keep in step, which is the drift this whole
 * file exists to catch. `bindMenuCommands` type-checks `makeHandlers()`'s
 * result against `MenuCommands`, so a key the manifest lacks (or one it has
 * that this misses) is a compile error in `npm run check`.
 */
const COMMANDS = Object.keys(contract.menuCommands) as MenuCommand[]

function makeHandlers(): MenuCommands {
  // Built as the mapped type rather than cast from `Object.fromEntries`,
  // which returns a plain index signature TS refuses to cast this far. The
  // return type is `MenuCommands`, so this only compiles while every manifest
  // key is filled in — the gate lives in `bindMenuCommands`'s signature.
  const handlers = {} as { [K in MenuCommand]: ReturnType<typeof vi.fn<(argument?: string) => void>> }
  for (const command of COMMANDS) handlers[command] = vi.fn<(argument?: string) => void>()
  return handlers
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('bindMenuCommands', () => {
  it('registers a global command dispatcher', () => {
    const handlers = makeHandlers()
    bindMenuCommands(handlers)
    expect(window.ediMenuCommand).toBeTypeOf('function')
    window.ediMenuCommand?.('open')
    expect(handlers.open).toHaveBeenCalledTimes(1)
    expect(handlers.save).not.toHaveBeenCalled()
  })

  it('dispatches every command in the manifest to its handler', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const handlers = makeHandlers()
    bindMenuCommands(handlers)
    for (const command of COMMANDS) {
      window.ediMenuCommand?.(command)
    }
    for (const command of COMMANDS) {
      expect(handlers[command]).toHaveBeenCalledTimes(1)
    }
    expect(error).not.toHaveBeenCalled()
  })

  it('reports an unknown command instead of dropping it', () => {
    // The old code was `handler?.()`: a command nobody typed by hand simply
    // did nothing, with no trace anywhere. A menu item that silently does
    // nothing is the failure this contract exists to prevent, so it is now
    // loud — and the message names the manifest, because that is where the
    // missing name has to go.
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const handlers = makeHandlers()
    bindMenuCommands(handlers)
    expect(() => window.ediMenuCommand?.('nope')).not.toThrow()
    expect(handlers.open).not.toHaveBeenCalled()
    expect(error).toHaveBeenCalledTimes(1)
    const message = String(error.mock.calls[0]?.[0])
    expect(message).toContain('"nope"')
    expect(message).toContain('edi-contract.json')
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

describe('isMenuCommand', () => {
  it('accepts every name the manifest declares', () => {
    for (const command of COMMANDS) {
      expect(isMenuCommand(command)).toBe(true)
    }
  })

  it('refuses names the manifest does not, including the prototype’s', () => {
    expect(isMenuCommand('nope')).toBe(false)
    expect(isMenuCommand('')).toBe(false)
    // `in` would say yes to these: the contract is the object's own keys.
    expect(isMenuCommand('toString')).toBe(false)
    expect(isMenuCommand('constructor')).toBe(false)
  })
})
