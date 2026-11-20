# Preferences

The app's preferences live in `QSettings` (`backend/preferences.py`), beside
the recent-files list, in `~/.config/Edi/Edi.conf`.

There are four:

- `zoomFactor`;
- `toolbarVisible`;
- `hoverBand`;
- `gitHistory`: Version History lists a git-tracked document's commits
  ([history.md](history.md)).

The shipped defaults are 100%, on, on and on. They are declared in both `DEFAULTS`
and `src/preferences.ts`'s `DEFAULT_PREFERENCES`, and both are checked against
`shared/edi-contract.json`'s `preferences` section by `tests/test_contract.py`
and `src/contract.test.ts`. That manifest is where the four values are written
down once.

## Why not localStorage

Preferences used to be `localStorage`, and that could not work.

`MainWindow` never creates a `QWebEngineProfile`, so the page runs on
`QWebEngineProfile.defaultProfile()`. That profile is **off-the-record**
(`isOffTheRecord()` is `True`) and discards every byte of web storage when the
process exits.

Zoom, the toolbar row and the hover band therefore came back at their defaults
on every launch. A packaged build showed it most plainly because
`build-pyzip.sh` extracts to a fresh temp directory per run; even a persistent
web profile would have keyed the app's origin by a path that no longer exists.

Nothing was migration-worthy: those keys had never reached a disk. Do not
reintroduce web storage for state that must outlive the process.

## The read is injected, not requested

The read has to be synchronous: zoom is applied in `init()` before the editor's
first paint, and a `QWebChannel` round trip cannot be awaited there.

`backend/window.py` adds a second document-creation `QWebEngineScript`
(`edi-preferences`, `MainWorld`) that assigns `window.ediPreferences` before
the bundle runs. `src/preferences.ts` reads that global **at module load**.

The script is a static string, so `set_preference` rebuilds it on every write
and replaces the page's copy by name (`scripts().find` / `remove` / `insert`).
`insert` stores a copy, so editing the window's own script object afterwards
changes nothing a reload would run. Otherwise a document created later in the
same run would replay the answers this window booted with.

Writes go back as `setPreference` over the bridge. `getPreferences` exists so
the store stays reachable and testable without going through the injection.

## The page's own record

`preferences.ts` keeps `current` as the page's own record, seeded from the
injection. `syncMenuState` publishes the menu checkmarks from it; a re-read of
the injection would answer with this launch's answers.

A stored zoom level is clamped by `clampZoom` on the way into the editor, not
by the store. The ladder belongs to the frontend. `Edi.conf` is a file a person
can edit, so `_as_bool`/`_as_float` in the store exist to read a hand-edited
file, not to second-guess the ladder.

## Allowed image sites

The sites the reader chose **Always load from these sites** for are kept under
`allowedImageHosts`, a list of host names (`backend/remote.py`). They are not a
preference: the page may add to them, on the reader's click, but cannot read
them back as settings or remove them, and View › Forget Allowed Image Sites…
clears them behind the shell's own prompt. Sites allowed with **Load images**
live only until Edi quits. See [architecture.md](architecture.md), "What a
document can make the machine do".

## The last session

The documents open in the window are kept too, under `session/paths` (in tab
order) and `session/active`, so a launch reopens them. This matters most for
upgrades: `install.sh` quits the running Edi before it swaps in the new one,
then starts the new one ([macos-installer.md](macos-installer.md)).

- **Kept as they change.** `src/session.ts`'s `trackOpenFiles` sends
  `setOpenFiles` whenever the open documents or the tab in view change, and
  `backend/session.py` writes it at once. A crash keeps them as well as a quit.
  Tracking starts only after the restore has finished, so a half-done restore
  is never stored over the session it is restoring.
- **Reopened at launch.** `openPendingFiles` asks `getSession` first and opens
  those documents in order, without moving them up the recent list. Then it
  opens any files Edi was launched with, and the last of those is in view.
  Without any, the tab that was in view last time is.
- **Only documents with a path and a grant.** An untitled tab is not kept, nor
  are unsaved edits; the quit prompt still guards those. `setOpenFiles` drops
  any path without a write grant, as the recent list does, so the page cannot
  grant itself a path by storing it. A file that is gone by the next launch is
  left out.
- **App only.** `MainWindow(restore_session=True)` comes from `backend/main.py`,
  outside the packaged smoke test. A window built anywhere else, as every test
  does, reopens nothing: the tests share one settings file, and a window must
  not reopen another test's tabs.
