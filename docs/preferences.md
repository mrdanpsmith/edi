# Preferences

The app's preferences live in `QSettings` (`backend/preferences.py`), beside
the recent documents and the last session, in `~/.config/Edi/Edi.conf`.

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
  those documents in order, without counting them as opens on the recent list. Then it
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

## Recent documents

File › Open Recent and the launcher show the same list, `recent_files()` in
`backend/window.py`, read again each time either is shown. `backend/recents.py`
keeps it under `recentDocuments`, as JSON: each document with the times it was
last opened.

- **Ranked by frecency.** Every open counts toward a document's score, and an
  open's weight halves every week (`HALF_LIFE_DAYS`). A document opened daily
  stays near the top through a week of one-off files. Ranked by last open
  alone, it would fall off after eight other files.
- **The latest opens are always shown.** The list is the 8 best-scored
  documents (`SHOWN`), but the 3 opened most recently (`ALWAYS_SHOWN`) are on
  it whatever their score. Otherwise a file opened a minute ago could be
  missing from the list because it has no history yet.
- **Only opens count.** `addRecentFile` comes from opening a document, or from
  saving one under a new name. Saving the same file again does not count, or a
  document would rank by how often it was saved. Reopening the last session
  does not count either.
- **A missing file is hidden, not forgotten.** A file that no longer exists is
  left off the list but keeps its history. A git branch switch, an unmounted
  drive or a sync tool can bring it back, with its rank. A history ages out
  once 50 documents (`TRACKED`) outscore it.
- **Rename and trash.** Renaming or moving a document in Edi carries its
  history to the new path (`move_recent_file`), so it keeps its place. Moving
  it to the Trash drops it and its history (`forget_recent_file`).
- **Grants.** `addRecentFile` takes only paths that already have a write grant,
  and reopening a path on the shown list grants it again
  ([architecture.md](architecture.md)). The page cannot grant itself a path by
  adding it.

The older `recentFiles` list (last opened first) is read once, as one open
each a minute apart so its order holds, and then removed.
