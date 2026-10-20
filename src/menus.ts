import { isMenuCommand, type MenuCommand } from './contract'

/**
 * What the page binds for every command the shell can dispatch.
 *
 * The keys are `shared/edi-contract.json`'s (via `MenuCommand`), so a command
 * renamed, added or removed in the manifest fails `npm run check` right here:
 * the object literal `src/main.ts` passes must match it exactly — a key the
 * manifest does not have is an excess-property error, and one it does have
 * that this object lacks is a missing-property error. Before this type, the
 * interface was a hand-written 33-key list that nothing compared to the
 * commands `backend/window.py` actually dispatches.
 */
export type MenuCommands = Record<MenuCommand, (argument?: string) => void>

type MenuHandler = (argument?: string) => void

export function bindMenuCommands(handlers: MenuCommands): void {
  window.ediMenuCommand = (command: string, argument?: string) => {
    const handler: MenuHandler | undefined = isMenuCommand(command)
      ? handlers[command]
      : undefined
    if (typeof handler !== 'function') {
      // Loud, and logged rather than thrown.
      //
      // Python calls this through `runJavaScript` and ignores the result, so
      // a throw here would not reach the shell — it would land in the page's
      // console exactly where this does, while taking the dispatch down with
      // it and saying nothing the log does not. What the log must say is the
      // name that went nowhere and where it has to be declared: an unknown
      // command is a contract break, and the old `handler?.()` turned it into
      // a menu item that did nothing, silently, for as long as nobody clicked
      // it and noticed.
      console.error(
        `Edi: menu command ${JSON.stringify(command)} has no handler — ` +
          'it is either missing from shared/edi-contract.json (the contract ' +
          'both sides are checked against) or this page never bound it.',
      )
      return
    }
    handler(argument)
  }
}
