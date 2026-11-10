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
| `listHistory({path})` | `[{id, time, message}]`, newest first. `time` is in epoch seconds. |
| `readHistoryVersion({path, id})` | The version's text, decoded the way `readTextFile` decodes a file (`utf-8-sig`, `\n` line endings). |

Both methods require `grants.check_read(path)`. A document's past versions may
hold text that has since been deleted, so they are no more readable than the
document itself (see `PathGrants` in `backend/bridge.py`). `id` must be a
40-hex commit id, and is looked up only in that document's repository.

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
- `tests/test_bridge.py` covers the bridge wiring and grants.
- `src/historyDialog.test.ts` and `src/editor-replacemarkdown.test.ts` cover
  the page.

## Not yet

These are not implemented yet:

- pruning or deleting history;
- version messages the reader writes;
- remotes;
- history for documents outside the grants.
