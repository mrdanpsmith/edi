# Version history

Every save of a document records a version of it. **File › Version History…**
lists them, shows what changed between a version and the document as it is now,
and restores one. The store is `backend/history.py`; the dialog is
`src/historyDialog.ts`.

## One git repository per document, kept away from it

Each document has its own bare git repository in Edi's app-data folder, under
`history/` (`QStandardPaths.AppDataLocation`; on macOS that is
`~/Library/Application Support/Edi/Edi/history/`). Nothing is written beside
the document. [architecture.md](architecture.md) explains why: the file is the
document, and a folder of notes should not pick up sidecars.

- **Finding a document's repository.** The repository's folder is named after
  the first 32 hex digits of the SHA-256 of the document's
  `normcase(realpath(path))`. An `edi-path` file inside the repository records
  the path itself.
- **What a commit holds.** Each commit's tree has a single entry: the
  document's file name, holding the **exact bytes on disk**, line endings and
  byte-order mark included. Commits go on `refs/heads/main`, with author `Edi
  <edi@localhost>` and the message `Saved` or `Renamed from <old name>`.
- **No git install needed.** The repositories are written with **dulwich**, a
  pure-Python git implementation, so Edi doesn't need git installed. They are
  ordinary git, though, and any git can read one:

  ```sh
  git --git-dir="$HOME/Library/Application Support/Edi/Edi/history/<hash>" log -p
  ```

- **Unchanged saves.** A save whose bytes match the newest version records
  nothing.
- **Untitled documents** have no history until their first save.
- **The store is local to the machine.** Copying or syncing a document doesn't
  take its history with it.

## What records a version, and what doesn't

A save asks for a version explicitly: `writeTextFile` takes `history: true`.
Only `fileController.saveTo` (Save and Save As) sends it. Export HTML writes
through the same bridge method but sends no flag, so an export is never
recorded as a version of anything.

Changes Edi didn't make are recorded too, because the documents Edi opens are
often written by agents:

| Event | What happens |
| --- | --- |
| **Opening a document** | `Bridge._read_text_file` calls `history.record_opened`. A document new to the history is recorded as "Opened in Edi". One that differs from its newest version is recorded as "Changed outside Edi", since only another writer could have changed it. Reattach is tried first, so opening a file renamed outside Edi adopts its history instead of starting a new one. |
| **A change on disk while Edi has the document** | `backend/watcher.py` records it as "Changed outside Edi" ([disk-changes.md](disk-changes.md)). |
| **Rename in Edi** | `Bridge._rename_text_file` calls `history.move` after the rename succeeds. The repository folder is re-keyed to the new path and a `Renamed from …` commit is recorded if the text changed. If a stale repository already sits at the new name, it is renamed aside with a `-replaced-<time>` suffix rather than deleted. |
| **Rename or move outside Edi** | The history is found again the first time it is listed (`_reattach`). A repository is adopted only if its newest version is byte-for-byte the file's current content **and** the path it recorded no longer exists. It is only adopted when exactly one repository qualifies: a copy of a document is a second document, and must not take the original's history. A file edited after it was moved outside Edi isn't matched. |

**History never fails a save.** `record` and `move` log their errors instead of
raising them. Once the file is on disk, the save is reported as successful even
if the history write fails.

Saves run on bridge worker threads. One store-wide lock serializes commits,
ref updates and folder moves.

## Reading history from the page

| Bridge method | Returns |
| --- | --- |
| `listHistory({path, git})` | `{versions, git}`. `versions` is newest first, each `{id, time, message, source}`; `time` is in epoch seconds and `source` is `"edi"` or `"git"`. With `git: true`, a tracked document's commits are included (see below) and `git` is `{complete, walked}`; otherwise `git` is `null`. |
| `readHistoryVersion({path, id, source})` | The version's text, decoded the way `readTextFile` decodes a file (`utf-8-sig`, `\n` line endings). `source` says which history `id` is from; it defaults to `"edi"`. |

Both methods require `grants.check_read(path)`. A document's past versions may
hold text that has since been deleted, so they are no more readable than the
document itself (see `PathGrants` in `backend/bridge.py`). `id` must be a
40-hex commit id, and is looked up only in that document's repository: Edi's
own, or for `source: "git"` the repository the document is in.

## Documents tracked by git

A document in a git repository already has a history: the commits that changed
it. When **File › Include Git Commits in History** is on (the `gitHistory`
preference, on by default), Version History lists those commits beside Edi's
own versions. The reader is `backend/githistory.py`; the merge is
`history.list_combined`.

Edi keeps recording its own versions of a tracked document exactly as before.
Git only sees commits, and an agent may write a file many times between two of
them, so Edi's versions are the only record of those states.

### What counts as tracked

A document is tracked when it is in the tree of the `HEAD` commit of the
nearest repository above it (a `.git` folder, or a `.git` file for a worktree
or a submodule). These have no git history here, and Version History lists
Edi's versions alone:

- untracked or ignored files, and a file staged but never committed;
- a repository with no commits yet, or one dulwich can't read;
- a file stored in git LFS: the commits hold only a pointer to it.

### Reading the repository

**Read-only.** Edi never commits, stages or writes into the repository.

**dulwich, not `git`.** The repository is read with dulwich. A repository is
content from anywhere, and its config can make `git` run programs
(`core.fsmonitor`, textconv, an external diff), while dulwich only reads
objects. dulwich doesn't read the commit-graph index, so it is 10–20× slower
than `git log`, which is why the walk has limits.

**The walk** follows `git log -- <path>`:

- newest first, from `HEAD`, so only the current branch's history;
- at a merge, it follows the parent the file came from (history
  simplification);
- each lookup goes one tree per folder of the path rather than diffing whole
  trees;
- it stops on each line of history where the file doesn't exist yet. A file
  deleted and later added again is followed back only to that last add.

It stops after `LIMIT` (100) commits that changed the file, or after
`BUDGET_S` (3) seconds. The dialog then says how many commits it searched.

**Speed, measured** on a 108k-commit, 2.3 GB repository: 200–550 ms for files
that changed recently, 0.8 s for a file from the repository's first years with
the pack files in the disk cache, 1.2 s without. Merge simplification is why it
is that fast: such a walk visits about 10k of the 108k commits.

**Cache.** A walk's result is kept per document until the repository's `HEAD`
moves, for up to 64 documents. Reopening the dialog takes a few milliseconds.
Opening a document does no git work at all.

### One timeline

The list is newest first, by when each version entered its history (a commit's
commit time; it shows the author time, as `git log` does). A commit row shows
its message's first line, its short id and its author. Each of Edi's versions
falls into a section by where it lies among the commits:

| Section | Where it lies | Shown |
| --- | --- | --- |
| `uncommitted` | after the newest commit | under "Not committed" |
| `between` | between two commits | folded into one "N Edi snapshots" row, which opens them |
| `beforeGit` | before the file's first commit, which git knows nothing of | under "Before git" |

A version older than the oldest commit an unfinished walk reached is
`between`, with `group: ""`: there may be commits before it that the walk
didn't get to.

**Folding.** One of Edi's versions whose text is the commit just before it, or
the commit just after it, *is* that commit (opened right after a commit, or
saved and then committed), and is left out of the list. The comparison ignores
a byte-order mark and `\r\n` line endings, which git's `core.autocrlf` can
introduce. Nothing is removed from the store: the folding is only what the
dialog shows.

**A document moved into a repository.** Its Edi history goes with it: Edi's
rename moves it, and a move outside Edi is reattached as usual. Once it is
committed, its earlier versions are `beforeGit` and stay in view. They exist
nowhere else.

## Restore is an edit, not a revert

Restoring calls `BlockEditor.replaceMarkdown`, which replaces the whole
document in one ordinary transaction. Unlike Revert, which builds a fresh
`EditorState` with `setMarkdown`, a restore:

- can be undone;
- leaves the tab dirty;
- doesn't touch the file until the reader saves. That save records the
  restored text as the newest version, so restoring never rewrites history.

Open encrypted blocks are flushed before the comparison and before the restore,
as they are before a save.

## The diff

The dialog diffs **from** the editor's current markdown **to** the selected
version. The view is about that version: green lines are in it, red lines are
in the document now but not in the version, and the diff is exactly the change
Restore would make. (The first version of this dialog diffed the other way, and
a heading the old version lacked read as "added" while that version was
selected.) It uses `diffLines` from the `diff` package,
imported statically because the bundle must stay a single file (see
[distribution.md](distribution.md)). Unchanged runs are folded to three lines of
context either side of each change. Restore is disabled when the selected
version is the document as it is now.

**Encrypted blocks** are stored the way they are saved, as sealed envelopes. A
diff therefore shows a changed encrypted block as changed ciphertext lines,
never its plaintext.

## Tests

- `tests/conftest.py` points `EDI_HISTORY_DIR` at a throwaway folder, so the
  suite never writes into the developer's real history store. Tests that need
  their own store set it with `monkeypatch`.
- `tests/test_history.py` covers the store.
- `tests/test_githistory.py` covers reading a tracked document's commits and
  the one timeline, against throwaway repositories made with dulwich in
  `tmp_path`.
- `tests/test_bridge.py` covers the bridge wiring and grants.
- `src/historyDialog.test.ts` and `src/editor-replacemarkdown.test.ts` cover
  the page.

## Clearing history

There are two ways to clear history:

- **One document.** **Clear History…** in the Version History dialog asks for
  confirmation, then calls `clearHistory({path})`, which checks
  `grants.check_read` like the other history methods. `history.clear` deletes
  the document's repository and records the file as it is on disk now as a
  fresh first version, "History cleared", so the next change can still be
  compared with something. A document whose file is gone keeps nothing.
- **The whole store.** **File › Clear Version History…** is a native dialog
  (`MainWindow._clear_all_history`) that says how many documents have history
  and how many of those are no longer on disk. It offers two actions:
  - **Remove Deleted Documents' History** (`history.remove_missing`) removes
    every history whose recorded path no longer exists. That includes
    documents renamed or moved outside Edi, which would otherwise be
    reattached the next time they're opened, and the dialog says so.
  - **Clear All History** (`history.clear_all`) removes everything. The
    documents Edi has open (the watcher's `watched()`) get a fresh "History
    cleared" first version, as `clear` gives a single document.

  The outcome is reported in the status bar through a `flashStatus` native
  event.

The store-wide actions run in the shell's own dialog and have no page command
or bridge method, so nothing running in the page can wipe every history. Every
deletion goes through `history._remove`, which refuses a folder that isn't
directly inside the store.

## Not yet

These are not implemented yet:

- automatic pruning (by age or by count);
- version messages the reader writes;
- remotes;
- history for documents outside the grants;
- following a file across a rename in git (`git log --follow`), and loading
  commits beyond the walk's limits.
