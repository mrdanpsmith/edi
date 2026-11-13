"""A document's history in the git repository it already lives in, read-only.

A document tracked by git has a history of its own: the commits that changed it.
Version History shows those beside Edi's own snapshots (``backend/history.py``),
which still record every save, because an agent may write a file many times
between two commits and git sees none of those.

Everything here *reads*. Edi never commits, stages or writes into the user's
repository. The repository is read with dulwich, never the ``git`` program: a
repository is content from anywhere, and its config can make ``git`` run
programs (``core.fsmonitor``, textconv, external diff) where dulwich only reads
objects. See ``docs/history.md``.

**Tracked** means the document is in the tree of the repository's ``HEAD``. A
file that is untracked, ignored, staged but never committed, stored in git LFS,
or in a repository that cannot be read has no git history here, and Version
History shows Edi's snapshots alone, as for any other file.

**The walk** is ``git log -- <path>``'s: newest first, following the parent a
merge took the file from (history simplification), and stopping on each line
of history where the file does not yet exist. So a file deleted and later added
again is followed back only to that last add. The walk stops after ``LIMIT``
commits that changed the file, or ``BUDGET_S`` seconds, whichever comes first.
"""

from __future__ import annotations

import heapq
import logging
import os
import re
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass
from pathlib import Path

from dulwich.objects import Blob, Commit, ObjectID, Tree
from dulwich.repo import Repo

log = logging.getLogger(__name__)

#: The most commits that changed the file to list.
LIMIT = 100
#: The longest a walk may take, in seconds. Measured on a 108k-commit
#: repository, a file from its first years took 0.8 s with the pack files in the
#: disk cache and 1.2 s without; the walk runs on a bridge worker behind the
#: dialog's "Loading…", so the limit leaves room for a slower disk.
BUDGET_S = 3.0
#: How many documents' walks to remember.
CACHE_SIZE = 64

_COMMIT_ID = re.compile(r"^[0-9a-f]{40}$")
_LFS_POINTER = b"version https://git-lfs.github.com/spec/"


@dataclass(frozen=True)
class GitVersion:
    id: str
    #: When the commit entered the history (``commit_time``): what it is ordered by.
    committed: int
    #: When it was written (``author_time``): what ``git log`` shows.
    authored: int
    message: str
    author: str
    blob: ObjectID


@dataclass(frozen=True)
class GitHistory:
    versions: list[GitVersion]
    #: ``True`` when the walk reached the file's first commit.
    complete: bool
    #: How many commits the walk looked at.
    walked: int


_cache: OrderedDict[tuple[str, str], tuple[ObjectID, GitHistory]] = OrderedDict()
_cache_lock = threading.Lock()


def _locate(path: str) -> tuple[Path, list[bytes]] | None:
    """The work tree holding ``path`` and the path inside it, by the nearest
    ``.git`` (a folder, or a ``gitdir:`` file for a worktree or submodule)."""
    target = Path(os.path.realpath(path))
    for folder in target.parents:
        if (folder / ".git").exists():
            relative = target.relative_to(folder)
            return folder, [os.fsencode(part) for part in relative.parts]
    return None


class _Reader:
    """One open repository and the document's path in it, with the lookups a
    walk repeats cached: most commits share most of their trees."""

    def __init__(self, repo: Repo, parts: list[bytes]) -> None:
        self.repo = repo
        self.store = repo.object_store
        self.parts = parts
        self._entries: dict[tuple[ObjectID, bytes], ObjectID | None] = {}
        self._commits: dict[ObjectID, Commit] = {}

    def commit(self, commit_id: ObjectID) -> Commit:
        found = self._commits.get(commit_id)
        if found is None:
            obj = self.store[commit_id]
            if not isinstance(obj, Commit):
                raise ValueError(f"Not a commit: {commit_id.decode('ascii', 'replace')}")
            found = obj
            self._commits[commit_id] = found
        return found

    def blob_id(self, commit: Commit) -> ObjectID | None:
        """The id of the document's blob in ``commit``, one tree per folder."""
        current: ObjectID = commit.tree
        for part in self.parts:
            key = (current, part)
            if key in self._entries:
                sha = self._entries[key]
            else:
                tree = self.store[current]
                sha = None
                if isinstance(tree, Tree):
                    try:
                        _mode, sha = tree[part]
                    except KeyError:
                        sha = None
                self._entries[key] = sha
            if sha is None:
                return None
            current = sha
        return current

    def data(self, blob_id: ObjectID) -> bytes:
        blob = self.store[blob_id]
        if not isinstance(blob, Blob):
            raise ValueError("Not a file")
        return blob.data


def _open(path: str) -> tuple[_Reader, Path] | None:
    located = _locate(path)
    if located is None:
        return None
    work_tree, parts = located
    if not parts:
        return None
    try:
        repo = Repo(str(work_tree))
    except Exception:  # noqa: BLE001 — an unreadable repository is no git history
        log.debug("Could not open the repository at %s", work_tree, exc_info=True)
        return None
    return _Reader(repo, parts), work_tree


def _author_name(commit: Commit) -> str:
    """The author's name, without the address."""
    author = commit.author.decode("utf-8", "replace")
    return author.split("<", 1)[0].strip() or author


def _walk(reader: _Reader, head: Commit, limit: int, budget: float) -> GitHistory:
    started = time.monotonic()
    heap: list[tuple[int, ObjectID]] = [(-head.commit_time, head.id)]
    seen = {head.id}
    found: list[GitVersion] = []
    walked = 0
    complete = True
    while heap:
        if len(found) >= limit or time.monotonic() - started > budget:
            complete = False
            break
        _, commit_id = heapq.heappop(heap)
        commit = reader.commit(commit_id)
        walked += 1
        mine = reader.blob_id(commit)
        if mine is None:
            # The file is not here yet on this line of history.
            continue
        parents = commit.parents
        same = [parent for parent in parents if reader.blob_id(reader.commit(parent)) == mine]
        if same:
            follow = same[:1]
        else:
            message = commit.message.decode("utf-8", "replace").strip().splitlines()
            found.append(
                GitVersion(
                    id=commit.id.decode("ascii"),
                    committed=commit.commit_time,
                    authored=commit.author_time,
                    message=message[0] if message else "",
                    author=_author_name(commit),
                    blob=mine,
                )
            )
            follow = parents
        for parent in follow:
            if parent not in seen:
                seen.add(parent)
                heapq.heappush(heap, (-reader.commit(parent).commit_time, parent))
    return GitHistory(found, complete, walked)


def history(path: str) -> GitHistory | None:
    """The commits that changed the document, newest first, or ``None`` when it
    has no git history (see the module docstring). Never raises."""
    try:
        opened = _open(path)
        if opened is None:
            return None
        reader, work_tree = opened
        with reader.repo:
            try:
                head_id = reader.repo.head()
            except KeyError:
                return None  # a repository with no commits yet
            head = reader.commit(head_id)
            blob_id = reader.blob_id(head)
            if blob_id is None:
                return None  # untracked, ignored, or only staged
            if reader.data(blob_id).startswith(_LFS_POINTER):
                return None  # the file's content is not in git
            key = (str(work_tree), "/".join(os.fsdecode(part) for part in reader.parts))
            with _cache_lock:
                cached = _cache.get(key)
                if cached is not None and cached[0] == head_id:
                    _cache.move_to_end(key)
                    return cached[1]
            result = _walk(reader, head, LIMIT, BUDGET_S)
            with _cache_lock:
                _cache[key] = (head_id, result)
                _cache.move_to_end(key)
                while len(_cache) > CACHE_SIZE:
                    _cache.popitem(last=False)
            return result
    except Exception:  # noqa: BLE001 — git history is a view, never a failure
        log.exception("Could not read the git history of %s", path)
        return None


def read(path: str, commit_id: str) -> bytes:
    """The document's bytes as one commit holds them."""
    if not _COMMIT_ID.match(commit_id):
        raise ValueError(f"Not a version id: {commit_id!r}")
    opened = _open(path)
    if opened is None:
        raise FileNotFoundError(f"{path} is not in a git repository")
    reader, _work_tree = opened
    with reader.repo:
        try:
            commit = reader.commit(ObjectID(commit_id.encode("ascii")))
        except KeyError:
            raise FileNotFoundError(f"No such commit: {commit_id}") from None
        blob_id = reader.blob_id(commit)
        if blob_id is None:
            raise FileNotFoundError(f"Commit {commit_id[:7]} does not hold this document")
        return reader.data(blob_id)


def clear_cache() -> None:
    with _cache_lock:
        _cache.clear()
