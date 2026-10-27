# The cross-language contract

`shared/edi-contract.json` is the single source of truth for names that cross
the Python ↔ TypeScript boundary as bare strings:

- **menu commands** — `window.ediMenuCommand("…")` from `backend/window.py`
  into `MenuCommands` in `src/menus.ts`;
- **bridge methods** — the `invoke('…')`/`invokeStream('…')` names against
  `Bridge._handlers` in `backend/bridge.py`;
- **the three preference defaults**.

All three used to drift silently: a rename on one side left a menu item that
did nothing, a call that answered `Unknown method`, or a store disagreeing with
the page.

Each side checks itself against the manifest:

- `tests/test_contract.py` checks Python's `_handlers`, the **built menubar**
  and `DEFAULTS`/`NAMES`;
- `src/contract.ts` and `src/contract.test.ts` check the page at typecheck
  time.

Payload *schemas* are deliberately not in the manifest. It is names only.

## Objects, not arrays

The two name sections are objects keyed by the name, not arrays of names, and
that shape is load-bearing.

TypeScript widens a JSON array to `string[]`. `typeof
contract.menuCommands[number]` would then be plain `string`, and every derived
type would guard nothing (measured with this repo's tsc 5.9.3).

An object's **keys** survive JSON import as an exact literal union:

```ts
type MenuCommand = keyof typeof contract.menuCommands
```

That is what makes a manifest rename fail `npm run check` rather than the
running application. `contract.test.ts` re-asserts that the unions are still
literal (`IsExactlyString<T> = false` assignments), because a reshape that
widened them again would pass everything else.

Both sections are kept sorted, so a rename diffs as one line.

## The menu command lives on the QAction

`MainWindow._link_command(action, command, argument="")` is the one place a
command enters the menubar. It calls `setData(command)` on the action and wires
`triggered` to `_menu_command`.

`tests/test_contract.py` walks the menus of a window built by `_build_menus`:

- `_MenusOnly(MainWindow)` calls `QMainWindow.__init__` to skip the webview;
- it needs the `qapp` fixture, because a widget with no `QApplication` under
  the offscreen platform segfaults rather than raising.

The gate is therefore the menu **as built**, not a regex over the source. Quit
and About carry no name because they are not commands the page implements.

An unknown command reaching the page is a `console.error` naming the manifest,
never a silent drop. `runJavaScript` ignores its result, so a `throw` would
land in the same console without any more reach.
