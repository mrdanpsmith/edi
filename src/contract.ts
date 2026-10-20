/**
 * The cross-language contract: `shared/edi-contract.json`, read once.
 *
 * Three surfaces cross the Python ↔ TypeScript boundary as bare strings, and
 * each of them used to drift silently — a rename on one side left the other
 * side with a menu item that did nothing, a bridge call that answered
 * `Unknown method`, or a preference default that disagreed between the store
 * and the page. The manifest is the single source of truth for the *names* on
 * all three; `tests/test_contract.py` checks Python against it and this
 * module's types check the page against it at `npm run check` time.
 *
 * **The two name sections are objects keyed by the name, not arrays of
 * names**, and that shape is load-bearing: TypeScript widens a JSON array to
 * `string[]`, so `typeof contract.menuCommands[number]` would be plain
 * `string` and every type derived from it would guard nothing (measured with
 * this repo's own tsc 5.9.3). An object's *keys* survive JSON import as an
 * exact literal union, so `keyof` is what makes the gate real.
 */
import contract from '../shared/edi-contract.json'

/** Every command the shell's menu bar can ask the page to run. */
export type MenuCommand = keyof typeof contract.menuCommands

/** Every method the page may `invoke(...)` on the native bridge. */
export type BridgeMethod = keyof typeof contract.bridgeMethods

/** Every persisted preference name the store will accept. */
export type PreferenceName = keyof typeof contract.preferences

/**
 * `true` only when `T` is exactly `string` — a compile-time probe that the
 * unions above kept their literals. `IsExactlyString<`replace` | `copy`>` is
 * `false`, `IsExactlyString<string>` is `true`, so a union widened by a
 * reshape of the manifest fails to assign to a `false` literal. The obvious
 * spelling (`expectTypeOf<T>().not.toBeString()`) only *reports* a widening
 * through a matcher that is not even callable when the condition holds.
 */
export type IsExactlyString<T> = [T] extends [string] ? ([string] extends [T] ? true : false) : false

/**
 * Is `name` a command the manifest declares? An own-property test, not `in`:
 * a command called `toString` is not this app's `constructor`, and the
 * prototype's methods are not the contract.
 */
export function isMenuCommand(name: string): name is MenuCommand {
  return Object.hasOwn(contract.menuCommands, name)
}
