# Documents changed on disk

Edi is often the reader of files that an agent or another tool writes, and those
files change while Edi has them open. Edi notices such a change, keeps it out
of reach of an accidental save, and lets the reader choose what to keep. The
backend is `backend/watcher.py`; the page is `src/diskChanges.ts`.

## What Edi knows about a file

For every document it has read or written, the bridge tells the `DiskWatcher`
the bytes involved (`seen`):

- `readTextFile` tells it after a read;
- `writeTextFile` (a document save, `history: true`) and `renameTextFile` tell
  it after a write.

Those bytes are the file's **known state**. Anything else found on disk later
is somebody else's change.

The page keeps the matching **base text**: the markdown it last read or wrote
for each path (`noteDiskText`). The Compare dialog measures both sides against
it.

## Watching

`QFileSystemWatcher` watches each document and its folder:

- **Atomic replaces.** Agents and editors save by renaming a temporary file over
  the target, and the watcher drops a file that is replaced. So every check
  re-adds the file.
- **Brief gaps.** The folder watch catches a file that is briefly gone and then
  back.
- **Bursts.** A document is checked once its file has been quiet for
  `SETTLE_MS` (300 ms).

A check compares the file's bytes on disk with the known state:

| On disk | What happens |
| --- | --- |
| The known state | Nothing. This is Edi's own save, or a touch that changed nothing. |
| Something else | The page gets `{"type": "diskChanged", "path": …}` on the bridge's `notify` signal, and the new text is recorded as a version, "Changed outside Edi" ([history.md](history.md)). Each new state is reported once. |
| Missing | The page gets `{"type": "diskDeleted", "path": …}`. When the file comes back, `diskChanged` is reported even if its content is unchanged, because that event is what clears the deleted state. |

Paths are matched exactly as the page spells them, which is how they reached
the bridge.

## Saves never overwrite an unseen change

`writeTextFile` with `history: true`, and `renameTextFile`, refuse to write when
the file on disk differs from its known state. They reply with the error code
**`changedOnDisk`** (`errorCodes` in the contract). The page treats that as
"show the bar", not as an error dialog.

This guard does not depend on the watcher having fired. It reads the file at
save time, so it works even if a notification was missed.

**Reading the file is acknowledgement.** Every button in the UI reads the disk
text before acting, and a read makes those bytes the known state. So a choice
the reader made never needs a separate "overwrite anyway" flag, and the guard
only protects a version the reader has never been shown. An HTML export sends
no `history` flag and is not guarded.

## What the reader sees

| The tab | On `diskChanged` |
| --- | --- |
| **No unsaved edits** | It takes the new text as one undoable edit (`replaceMarkdown`), stays clean, and the status bar says "Reloaded … changed on disk". Only the changed range is replaced, so the caret and scroll position survive an agent editing further down. |
| **Unsaved edits** | A bar above the document offers three choices. |

The three choices on the bar:

- **Compare…** reads the disk text and shows two diffs, each from the base:
  *Their changes* (base → disk) and *Your unsaved changes* (base → editor). The
  dialog then offers Keep mine or Take theirs. Without a base, which happens
  only for a document Edi never read itself, it shows a single diff from yours
  to the disk.
- **Take theirs** replaces the editor's text with the disk's as an undoable
  edit, and marks the tab clean. Undo brings your edits back.
- **Keep mine** leaves the editor alone and moves the base to the disk text.
  The next save replaces the disk version, which history has already recorded.

On `diskDeleted`, the bar says the file was deleted or moved and that saving
will write it again, with a Dismiss button.

**Tabs out of view.** An event for a tab that is not in view is held until the
tab is shown: `afterActivate` calls `disk.refresh()`. A refused save raises the
same bar and flashes "Not saved: … changed on disk".

## The marker

A reload is easy to miss, and a reload in a tab out of view happens later, so
every change on disk also leaves a **marker**. It only informs and asks
nothing; the bar is where decisions are made.

- **Where it shows.** A `↻` badge on the tab (`⊘` once the file has been
  deleted), and a note in the status bar while that tab is in view: "Changed on
  disk at 14:32", or "… (3 changes)" when several arrived before it was
  dismissed.
- **Where it lives.** It's `SessionMeta.diskNote` in `src/state.ts`, so the
  tab strip draws it on its own.
- **When it clears.** The reader is evidently done with it when any of these
  happens, so a document that's only read, never edited, doesn't keep a stale
  marker:
  - an edit;
  - a save, open or revert (`noteDiskText`);
  - opening Version History;
  - any choice on the bar or in Compare;
  - a click on the badge or the status note;
  - closing the tab.

The reload Edi makes itself is not an edit by the reader. The controller sets
`applying` while it rewrites the document, so the `onChange` that rewrite fires
does not clear the marker it has just earned.

## Not yet

These are not implemented yet:

- **Merge both:** a three-way merge of their changes onto yours.
- Word-level highlighting inside changed lines.
- Unwatching a document when its tab closes. A closed document keeps being
  watched, and recorded in history, until Edi quits. The page ignores its
  events.
