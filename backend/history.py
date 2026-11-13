"""Per-document version history: one small git repository per document.

Every save of a document commits the bytes that reached disk into a bare git
repository kept in Edi's app-data folder — never beside the document — so the
history is ordinary git (``git --git-dir=<repo> log`` reads it) without Edi
needing a git install: the repositories are written with dulwich.

A repository is found by its document's path: its folder is named after a hash
of the path, and an ``edi-path`` file inside records the path itself. Edi's own
renames move the repository with the file (``move``). A document renamed or
moved *outside* Edi is found again when its history is asked for: the one
repository whose latest version is exactly the file's current bytes, and whose
recorded path no longer exists, is taken to be the same document (``_reattach``).

History is a convenience on top of saving, never a condition of it: ``record``
and ``move`` log their failures instead of raising them, so a save that reached
disk is reported as saved whatever happens here. See ``docs/history.md``.
"""

from __future__ import annotations

import hashlib
import logging
import os
import re
import shutil
import threading
import time
from pathlib import Path

from dulwich.objects import Blob, Commit, Tree
from dulwich.refs import Ref
from dulwich.repo import Repo

from . import githistory

log = logging.getLogger(__name__)

# Overrides the store's location; the test suite points it at a throwaway folder.
ROOT_ENV = "EDI_HISTORY_DIR"
PATH_FILE = "edi-path"
BRANCH = Ref(b"refs/heads/main")
IDENTITY = b"Edi <edi@localhost>"
_FILE_MODE = 0o100644
_COMMIT_ID = re.compile(r"^[0-9a-f]{40}$")

# Saves arrive on bridge worker threads. One lock for the whole store keeps two
# saves (or a save and a rename) from interleaving their ref updates and folder
# moves; history writes are tiny, so there is nothing to gain from finer locks.
_lock = threading.RLock()


def root() -> Path:
    override = os.environ.get(ROOT_ENV)
    if override:
        return Path(override)
    from PySide6.QtCore import QStandardPaths

    base = QStandardPaths.writableLocation(QStandardPaths.StandardLocation.AppDataLocation)
    return Path(base) / "history"


def _normalized(path: str) -> str:
    return os.path.normcase(os.path.realpath(path))


def repo_dir(path: str) -> Path:
    digest = hashlib.sha256(_normalized(path).encode("utf-8", "surrogateescape")).hexdigest()
    return root() / digest[:32]


def _open(path: str) -> Repo | None:
    folder = repo_dir(path)
    return Repo(str(folder)) if (folder / "HEAD").is_file() else None


def _create(path: str) -> Repo:
    repo = _open(path)
    if repo is not None:
        return repo
    folder = repo_dir(path)
    folder.mkdir(parents=True, exist_ok=True)
    repo = Repo.init_bare(str(folder), default_branch=b"main")
    _write_path(folder, path)
    return repo


def _write_path(folder: Path, path: str) -> None:
    (folder / PATH_FILE).write_text(os.path.realpath(path), encoding="utf-8")


def _head(repo: Repo) -> Commit | None:
    try:
        commit = repo[repo.refs[BRANCH]]
    except KeyError:
        return None
    return commit if isinstance(commit, Commit) else None


def _blob_of(repo: Repo, commit: Commit) -> Blob:
    """The one file a commit's tree holds."""
    tree = repo[commit.tree]
    if not isinstance(tree, Tree):
        raise ValueError(f"Version {commit.id.decode()} has no tree")
    for entry in tree.items():
        blob = repo[entry.sha]
        if isinstance(blob, Blob):
            return blob
    raise ValueError(f"Version {commit.id.decode()} holds no document")


def _commit(repo: Repo, path: str, data: bytes, message: str) -> bool:
    """Commit ``data`` as the document's next version; ``False`` if it is unchanged."""
    head = _head(repo)
    blob = Blob.from_string(data)
    if head is not None and _blob_of(repo, head).id == blob.id:
        return False
    tree = Tree()
    tree.add(os.fsencode(os.path.basename(path)) or b"document", _FILE_MODE, blob.id)
    now = int(time.time())
    offset = time.localtime(now).tm_gmtoff
    commit = Commit()
    commit.tree = tree.id
    commit.parents = [head.id] if head is not None else []
    commit.author = commit.committer = IDENTITY
    commit.author_time = commit.commit_time = now
    commit.author_timezone = commit.commit_timezone = offset
    commit.encoding = b"UTF-8"
    commit.message = message.encode("utf-8")
    store = repo.object_store
    store.add_object(blob)
    store.add_object(tree)
    store.add_object(commit)
    repo.refs[BRANCH] = commit.id
    return True


def record(path: str, message: str = "Saved") -> None:
    """Commit the document as it now is on disk. Never raises."""
    try:
        data = Path(os.path.realpath(path)).read_bytes()
        with _lock:
            with _create(path) as repo:
                _commit(repo, path, data, message)
    except Exception:  # noqa: BLE001 — history never fails a save
        log.exception("Could not record a version of %s", path)


def record_opened(path: str) -> None:
    """Edi has just read the document: record it if it is new to the history, or
    changed since the last version, which can only be another writer's change.
    So a file an agent wrote has a version from the first time Edi opens it.

    A document with no history is first offered its history from before a rename
    outside Edi (``_reattach``); a fresh repository made first would hide it."""
    try:
        with _lock:
            if not (repo_dir(path) / "HEAD").is_file():
                _reattach(path)
            known = (repo_dir(path) / "HEAD").is_file()
    except Exception:  # noqa: BLE001 — history never fails an open
        log.exception("Could not look up the history of %s", path)
        return
    record(path, "Changed outside Edi" if known else "Opened in Edi")


def move(old_path: str, new_path: str) -> None:
    """Carry a renamed document's history to its new name, then record it. Never raises."""
    try:
        with _lock:
            source = repo_dir(old_path)
            target = repo_dir(new_path)
            if source != target and (source / "HEAD").is_file():
                if target.exists():
                    # A stale history already sits at the new name (a document
                    # once saved there). Keep it, out of the way, rather than
                    # deleting someone's versions.
                    target.rename(target.with_name(f"{target.name}-replaced-{int(time.time())}"))
                source.rename(target)
                _write_path(target, new_path)
        old_name = os.path.basename(old_path)
        record(new_path, f"Renamed from {old_name}")
    except Exception:  # noqa: BLE001 — history never fails a rename
        log.exception("Could not move the history of %s to %s", old_path, new_path)


def clear(path: str) -> None:
    """Forget every saved version of a document, keeping the file as it is now
    as the first version of a fresh history (if the file still exists), so the
    next change can still be compared with something."""
    with _lock:
        _remove(repo_dir(path))
    if os.path.isfile(path):
        record(path, "History cleared")


def stored_documents() -> list[dict]:
    """Every document the store holds a history for: ``{path, exists}``."""
    store = root()
    if not store.is_dir():
        return []
    documents = []
    with _lock:
        for folder in sorted(store.iterdir()):
            if not (folder / "HEAD").is_file():
                continue
            try:
                recorded = (folder / PATH_FILE).read_text(encoding="utf-8").strip()
            except OSError:
                recorded = ""
            documents.append({"path": recorded, "exists": bool(recorded) and os.path.exists(recorded)})
    return documents


def remove_missing() -> int:
    """Remove the history of every document whose file is no longer on disk.

    That includes a file renamed or moved outside Edi whose history would
    otherwise be reattached when it is next opened (``_reattach``).
    Returns how many histories were removed."""
    removed = 0
    store = root()
    if not store.is_dir():
        return 0
    with _lock:
        for folder in list(store.iterdir()):
            if not folder.is_dir():
                continue
            try:
                recorded = (folder / PATH_FILE).read_text(encoding="utf-8").strip()
            except OSError:
                recorded = ""
            if not recorded or not os.path.exists(recorded):
                _remove(folder)
                removed += 1
    return removed


def clear_all(keep: list[str] | None = None) -> int:
    """Remove every history. The documents in ``keep`` (those open in Edi) get
    their current file back as a first version, as ``clear`` does for one.
    Returns how many histories were removed."""
    store = root()
    removed = 0
    with _lock:
        if store.is_dir():
            for folder in list(store.iterdir()):
                if folder.is_dir():
                    _remove(folder)
                    removed += 1
    for path in keep or []:
        if os.path.isfile(path):
            record(path, "History cleared")
    return removed


def _remove(folder: Path) -> None:
    """Delete a repository folder; it must be inside the store."""
    store = root().resolve()
    target = folder.resolve()
    if target.parent != store:
        raise ValueError(f"Not a history folder: {folder}")
    shutil.rmtree(target, ignore_errors=True)


def _reattach(path: str) -> None:
    """Adopt the history of this document from before it was renamed outside Edi.

    A repository is this document's only if its latest version is the file's
    current bytes *and* the path it recorded no longer exists — and only when
    exactly one repository qualifies, since two copies of one file are two
    documents and neither should silently take the other's history.
    """
    try:
        data = Path(os.path.realpath(path)).read_bytes()
    except OSError:
        return
    wanted = Blob.from_string(data).id
    own = repo_dir(path)
    store = root()
    if not store.is_dir():
        return
    matches: list[Path] = []
    for folder in store.iterdir():
        if folder == own or not (folder / "HEAD").is_file():
            continue
        try:
            recorded = (folder / PATH_FILE).read_text(encoding="utf-8").strip()
        except OSError:
            continue
        if not recorded or os.path.exists(recorded):
            continue
        try:
            with Repo(str(folder)) as repo:
                head = _head(repo)
                if head is not None and _blob_of(repo, head).id == wanted:
                    matches.append(folder)
        except Exception:  # noqa: BLE001 — one damaged repository is no reason to stop
            log.exception("Could not read the history in %s", folder)
    if len(matches) == 1:
        matches[0].rename(own)
        _write_path(own, path)


def list_versions(path: str) -> list[dict]:
    """The document's versions, newest first: ``{id, time, message}``."""
    return [version for version, _data in _edi_versions(path)]


def _edi_versions(path: str) -> list[tuple[dict, bytes]]:
    """Edi's versions of the document, newest first, each with its bytes."""
    with _lock:
        if not (repo_dir(path) / "HEAD").is_file():
            _reattach(path)
        repo = _open(path)
        if repo is None:
            return []
        with repo:
            head = _head(repo)
            if head is None:
                return []
            versions = []
            for entry in repo.get_walker(include=[head.id]):
                commit = entry.commit
                version = {
                    "id": commit.id.decode("ascii"),
                    "time": commit.commit_time,
                    "message": commit.message.decode("utf-8", "replace").strip(),
                }
                versions.append((version, _blob_of(repo, commit).data))
            return versions


def _comparable(data: bytes) -> bytes:
    """A file's bytes with the differences git itself may introduce removed: a
    byte-order mark and ``\\r\\n`` line endings (``core.autocrlf``)."""
    if data.startswith(b"\xef\xbb\xbf"):
        data = data[3:]
    return data.replace(b"\r\n", b"\n")


def list_combined(path: str, use_git: bool = True) -> dict:
    """Edi's versions of the document, and its git commits when it is tracked.

    Returns ``{versions, git}``. Each version has ``id``, ``time``, ``message``
    and ``source`` (``"edi"`` or ``"git"``); a git one also has ``author`` and
    ``short``. ``git`` is ``None`` for a document without git history, else
    ``{complete, walked}`` from the walk (``backend/githistory.py``).

    When there are commits, each of Edi's versions gets a ``section``, by where
    it falls among them:

    - ``uncommitted``: after the newest commit;
    - ``between``: between two commits, or older than the commits the walk
      reached (``group`` is the id of the commit it follows, or ``""``);
    - ``beforeGit``: before the file's first commit, the stretch git knows
      nothing of.

    One of Edi's versions whose text is the commit just before it or just after
    it (line endings aside) is that commit, and is left out. Nothing is removed
    from the store: this is only what Version History shows. The list is newest
    first, by when each version entered its history.
    """
    edi = _edi_versions(path)
    found = githistory.history(path) if use_git else None
    if found is None or not found.versions:
        return {
            "versions": [{**version, "source": "edi"} for version, _data in edi],
            "git": None if found is None else {"complete": found.complete, "walked": found.walked},
        }
    commits = found.versions  # newest first
    texts: dict[str, bytes] = {}

    def text_of(index: int) -> bytes:
        commit = commits[index]
        if commit.id not in texts:
            try:
                texts[commit.id] = _comparable(githistory.read(path, commit.id))
            except Exception:  # noqa: BLE001 — an unreadable commit folds nothing
                texts[commit.id] = b""
        return texts[commit.id]

    entries: list[tuple[int, int, dict]] = []
    for order, commit in enumerate(commits):
        entries.append(
            (
                commit.committed,
                -order,
                {
                    "id": commit.id,
                    "time": commit.authored,
                    "message": commit.message,
                    "source": "git",
                    "author": commit.author,
                    "short": commit.id[:7],
                },
            )
        )
    for order, (version, data) in enumerate(edi):
        when = version["time"]
        # The newest commit at or before this version, and the oldest after it.
        base = next((i for i, commit in enumerate(commits) if commit.committed <= when), None)
        after = (base if base is not None else len(commits)) - 1
        mine = _comparable(data)
        if (base is not None and text_of(base) == mine) or (after >= 0 and text_of(after) == mine):
            continue
        entry: dict = {**version, "source": "edi"}
        if after < 0:
            entry["section"] = "uncommitted"
        elif base is None and found.complete:
            entry["section"] = "beforeGit"
        else:
            entry["section"] = "between"
            entry["group"] = commits[base].id if base is not None else ""
        # An Edi version sorts after a commit made in the same second: the
        # commit was made from it.
        entries.append((when, -len(commits) - order, entry))
    entries.sort(key=lambda item: (item[0], item[1]), reverse=True)
    return {
        "versions": [entry for _when, _order, entry in entries],
        "git": {"complete": found.complete, "walked": found.walked},
    }


def read_from(path: str, version_id: str, source: str = "edi") -> str:
    """The text of one version from either history, decoded like a file."""
    if source == "git":
        text = githistory.read(path, version_id).decode("utf-8-sig")
        return text.replace("\r\n", "\n")
    return read_version(path, version_id)


def read_version(path: str, version_id: str) -> str:
    """The text of one version, decoded the way ``files.read_text_file`` reads."""
    if not _COMMIT_ID.match(version_id):
        raise ValueError(f"Not a version id: {version_id!r}")
    with _lock:
        repo = _open(path)
        if repo is None:
            raise FileNotFoundError(f"No history for {path}")
        with repo:
            try:
                commit = repo[version_id.encode("ascii")]
            except KeyError:
                raise FileNotFoundError(f"No such version: {version_id}") from None
            if not isinstance(commit, Commit):
                raise ValueError(f"Not a version id: {version_id!r}")
            data = _blob_of(repo, commit).data
    text = data.decode("utf-8-sig")
    # The page always works in `\n`, as `read_text_file` hands it the file.
    return text.replace("\r\n", "\n")
