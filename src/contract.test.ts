import contract from '../shared/edi-contract.json'
import { describe, expect, expectTypeOf, it } from 'vitest'

import { type BridgeMethod, type IsExactlyString, type MenuCommand, type PreferenceName } from './contract'
import { type MenuCommands } from './menus'
import { type Preferences, DEFAULT_PREFERENCES } from './preferences'

/**
 * Two kinds of gate in this file, and both of them are `npm run check`.
 *
 * The runtime half reads the manifest itself — what it says, and that the
 * page ships the defaults it declares. The type half is the one that matters
 * for renames: it asserts the derived unions are *literal*, because a union
 * that has widened to `string` guards nothing (that is what a JSON array
 * would give, and why the manifest's name sections are objects). These are
 * `expectTypeOf` assertions, so `tsc --noEmit` fails on them whether or not
 * vitest is the thing that is running.
 */
describe('the contract manifest', () => {
  it('keeps both name sections sorted, so a rename diffs as one line', () => {
    for (const section of ['menuCommands', 'bridgeMethods'] as const) {
      const names = Object.keys(contract[section])
      expect(names).toEqual([...names].sort())
      expect(names.length).toBeGreaterThan(0)
    }
  })

  it('ships the preference defaults it declares', () => {
    expect(DEFAULT_PREFERENCES).toEqual(contract.preferences)
  })
})

describe('the types derived from the manifest', () => {
  it('are literal unions, not `string`', () => {
    // Each slot below is `false` only while the union is still made of
    // literals: `IsExactlyString<T>` flips to `true` the moment TS widens it,
    // and `true` does not assign to a `false`. The assignment is the gate —
    // it fails `tsc --noEmit`, which is what `npm run check` runs.
    const widened: [
      IsExactlyString<MenuCommand>,
      IsExactlyString<BridgeMethod>,
      IsExactlyString<PreferenceName>,
    ] = [false, false, false]
    expect(widened).toEqual([false, false, false])
  })

  it('are the keys of the surfaces that use them', () => {
    // Widening `MenuCommands` back to an interface or `Record<string, …>`
    // would silently un-pin the page from the manifest; this is what notices.
    expectTypeOf<keyof MenuCommands>().toEqualTypeOf<MenuCommand>()
    expectTypeOf<keyof Preferences>().toEqualTypeOf<PreferenceName>()
  })
})
