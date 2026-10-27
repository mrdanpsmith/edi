# Preferences

The app's preferences live in `QSettings` (`backend/preferences.py`), beside
the recent-files list, in `~/.config/Edi/Edi.conf`.

There are three:

- `zoomFactor`;
- `toolbarVisible`;
- `hoverBand`.

The shipped defaults are 100%, on and on. They are declared in both `DEFAULTS`
and `src/preferences.ts`'s `DEFAULT_PREFERENCES`, and both are checked against
`shared/edi-contract.json`'s `preferences` section by `tests/test_contract.py`
and `src/contract.test.ts`. That manifest is where the three values are written
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

The script is a static string, so `set_preference` rewrites its source on every
write. Otherwise a document created later in the same run would replay the
answers this window booted with.

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
