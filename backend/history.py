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
import threading
import time
from pathlib import Path

from dulwich.objects import Blob, Commit, Tree
from dulwich.refs import Ref
from dulwich.repo import Repo

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
                versions.append(
                    {
                        "id": commit.id.decode("ascii"),
                        "time": commit.commit_time,
                        "message": commit.message.decode("utf-8", "replace").strip(),
                    }
                )
            return versions


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
