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

## Allowed image sites

The sites the reader chose **Always load from these sites** for are kept under
`allowedImageHosts`, a list of host names (`backend/remote.py`). They are not a
preference: the page may add to them, on the reader's click, but cannot read
them back as settings or remove them, and View › Forget Allowed Image Sites…
clears them behind the shell's own prompt. Sites allowed with **Load images**
live only until Edi quits. See [architecture.md](architecture.md), "What a
document can make the machine do".

## Update check

`updates/automatic` (off unless the reader turns on Help › Check for Updates
Automatically) and `updates/lastCheck` (seconds since the epoch of the last
check that got an answer) belong to `backend/updates.py`. Like the allowed image
sites they are the shell's, not preferences: only the shell reads them, and the
page cannot turn the request on. An automatic check runs at launch when it is
on and the last check is a day old.

## Approved code

The code blocks the reader agreed to run are kept under `approvedCode`: SHA-256
digests of each block's shebang and source, newest first, at most 1000
(`backend/approvals.py`). The page never sees or sets them; the bridge adds one
when the reader answers Run in the shell's prompt, and View › Forget Approved
Code… clears them. A document trusted "until Edi quits" is never stored.

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
`backend/window.py`. The submenu reads it each time it opens. The launcher
reads it each time the home screen or a launcher tab comes into view, and on a
`recentsChanged` event from the shell. A document trashed in Edi or deleted
outside it is gone from the list the next time either is shown.
`backend/recents.py` keeps it under `recentDocuments`, as JSON: each document
with its open count, its last open and its score as of that open.

- **Ranked by frecency.** Every open counts toward a document's score, and an
  open's weight halves every week (`HALF_LIFE_DAYS`). A document opened daily
  stays near the top through a week of one-off files. Ranked by last open
  alone, it would fall off after eight other files.
- **A running score.** The score is not worked out from a list of opens. At
  any moment it is the stored score decayed by the time since the last open,
  and an open decays it to now and adds 1. That equals the sum of every open's
  decayed weight, so nothing has to be capped: the open count is the real one,
  however large it grows.
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
  it to the Trash is a deletion like any other: the document is left off the
  list but keeps its history, so Manage Recent Documents can recover it.
  Only that dialog's Remove and Clear drop a history outright.
- **Grants.** `addRecentFile` takes only paths that already have a write grant,
  and reopening a path on the shown list grants it again
  ([architecture.md](architecture.md)). The page cannot grant itself a path by
  adding it.
- **Managed in the shell.** File › Open Recent › Manage Recent Documents…
  (`backend/recentsmanager.py`) lists every remembered document with its score
  as a bar, its opens and its last open, best first. Every column sorts. Each
  row says whether the document is on the list, ranked below it, or not on
  disk, and why (missing, folder missing, drive not connected). The dialog
  opens, removes or clears them all. Clear Recent Documents… is the same Clear
  All prompt straight from the menu. Both are the shell's own, like Manage
  Version History: the page can add a granted path and read the shown list,
  but cannot list or wipe the history. After a change the shell sends
  `recentsChanged`, and the launcher redraws.
- **Recover.** A deleted document can be put back from its version history,
  which holds a copy of every document opened in Edi. Recover… is the same
  flow as Manage Version History's (`backend/recovery.py`,
  [history.md](history.md)), and the document keeps its rank, at its new place
  if it went to another folder. A missing document with no saved copy says so
  and can only be removed.

Two older shapes are read and replaced on the next write: entries holding a
list of open times, which become a count and a score, and the `recentFiles`
list (last opened first), read as one open each a minute apart so its order
holds.
