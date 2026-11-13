import { invoke } from './bridge'

export const SUPPORTED_EXTENSIONS = ['md', 'markdown', 'txt', 'mermaid'] as const

export const UNTITLED = 'Untitled'

export function fileExtension(path: string): string {
  const base = path.split('/').pop() ?? path
  const dot = base.lastIndexOf('.')
  return dot >= 0 ? base.slice(dot + 1).toLowerCase() : ''
}

export function fileName(path: string): string {
  const base = path.split('/').pop() ?? path
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(0, dot) : base
}

export function isSupportedFile(path: string): boolean {
  const ext = fileExtension(path)
  return (SUPPORTED_EXTENSIONS as readonly string[]).includes(ext)
}

export function isAbsolutePath(path: string): boolean {
  return path.startsWith('/')
}

export function dirname(path: string): string {
  const index = path.lastIndexOf('/')
  return index > 0 ? path.slice(0, index) : '/'
}

export function imageReference(docPath: string | null, imagePath: string): string {
  if (!docPath) {
    return imagePath
  }
  const docDir = dirname(docPath)
  if (imagePath.startsWith(`${docDir}/`)) {
    return imagePath.slice(docDir.length + 1)
  }
  return imagePath
}

export async function readTextFile(path: string): Promise<string> {
  return invoke<string>('readTextFile', { path })
}

export async function getPendingFiles(): Promise<string[]> {
  return invoke<string[]>('getPendingFiles', {})
}

export async function readAnyTextFile(path: string): Promise<string> {
  return invoke<string>('readAnyTextFile', { path })
}

/**
 * Write `content` to `path`. `history` asks the backend to record the written
 * file as a version of the document (`backend/history.py`): a document save
 * does, an export of some other format does not. `makeFolders` makes the
 * document's folder again if it is gone, and is sent only after the reader
 * agreed to it (a write without it is refused with `folderMissing`).
 */
export async function writeTextFile(
  path: string,
  content: string,
  options: { history?: boolean; makeFolders?: boolean } = {},
): Promise<void> {
  await invoke('writeTextFile', {
    path,
    content,
    history: options.history ?? false,
    ...(options.makeFolders ? { makeFolders: true } : {}),
  })
}

/**
 * Where an Edi version falls among a git-tracked document's commits:
 * `uncommitted` after the newest, `between` two of them, `beforeGit` before the
 * file's first commit. Absent when the document has no git history.
 */
export type HistorySection = 'uncommitted' | 'between' | 'beforeGit'

/** One version of a document, as `listHistory` reports it. */
export interface HistoryVersion {
  id: string
  /** Seconds since the epoch. */
  time: number
  message: string
  /** Edi's own snapshot, or a commit in the git repository the document is in. */
  source?: 'edi' | 'git'
  /** A commit's author. */
  author?: string
  /** A commit's short id. */
  short?: string
  section?: HistorySection
  /** For a `between` version, the id of the commit it follows (`''` when that is beyond the walk). */
  group?: string
}

/** What the walk of a document's git history found, when it has one. */
export interface GitWalk {
  /** The walk reached the file's first commit. */
  complete: boolean
  /** How many commits it looked at. */
  walked: number
}

export interface HistoryList {
  versions: HistoryVersion[]
  git: GitWalk | null
}

/**
 * A document's versions, newest first. With `git`, a document tracked by git
 * also lists the commits that changed it (`backend/githistory.py`).
 */
export async function listHistory(path: string, options: { git?: boolean } = {}): Promise<HistoryList> {
  return invoke<HistoryList>('listHistory', { path, git: options.git ?? false })
}

/** Forget a document's saved versions; its current file becomes the first version. */
export async function clearHistory(path: string): Promise<void> {
  await invoke('clearHistory', { path })
}

/** The markdown of one saved version. */
export async function readHistoryVersion(
  path: string,
  id: string,
  source: 'edi' | 'git' = 'edi',
): Promise<string> {
  return invoke<string>('readHistoryVersion', { path, id, source })
}

/**
 * Save `content` at `newPath` and delete `oldPath` in the backend's single
 * call, so the document ends up under exactly one name: the write and the
 * delete are never two steps the page can fail between.
 */
export async function renameTextFile(
  oldPath: string,
  newPath: string,
  content: string,
): Promise<void> {
  await invoke('renameTextFile', { oldPath, newPath, content })
}

export async function writeBinaryFile(path: string, data: string): Promise<void> {
  await invoke('writeBinaryFile', { path, data })
}

export async function pickOpenPath(): Promise<string[] | null> {
  return invoke<string[] | null>('pickOpenPath', {})
}

/**
 * Ask the shell for a typed file path. The shell resolves `~`, `$VARS`, quotes
 * and relative paths (against `baseDir`, or home when it is `null`), and only
 * answers with a supported file that exists; `null` is a cancel.
 */
export async function pickTypedOpenPath(baseDir: string | null): Promise<string | null> {
  return invoke<string | null>('pickTypedOpenPath', { baseDir })
}

/**
 * Ask the shell where the document at `path` should be renamed or moved to.
 * The shell's prompt takes a new name, a path relative to the document's
 * folder, `~` or an absolute path (a folder keeps the name), and only answers
 * with a destination in a folder that exists and holds no file of that name;
 * `null` is a cancel. The answer is granted for the rename that follows.
 */
export async function pickRenamePath(path: string): Promise<string | null> {
  return invoke<string | null>('pickRenamePath', { path })
}

/**
 * Ask the user, in the shell's own prompt, whether Edi may save the document
 * at `path`: one it opened by following a link, which was never handed to it
 * to write. `true` grants the path for the save that follows.
 */
export async function confirmWritePath(path: string): Promise<boolean> {
  return invoke<boolean>('confirmWritePath', { path })
}

export async function pickSavePath(defaultName: string): Promise<string | null> {
  return invoke<string | null>('pickSavePath', { defaultName })
}

export async function pickExportPath(defaultName: string): Promise<string | null> {
  return invoke<string | null>('pickExportPath', { defaultName })
}

export async function pickImageSavePath(defaultName: string): Promise<string | null> {
  return invoke<string | null>('pickImageSavePath', { defaultName })
}

/**
 * Print a standalone HTML page through the native print dialog. Relative
 * images resolve against ``documentPath``'s folder. Resolves ``false`` when
 * the dialog is cancelled.
 */
export async function printHtml(html: string, documentPath: string | null): Promise<boolean> {
  return invoke<boolean>('printHtml', { html, documentPath })
}

export async function pickImportPath(): Promise<string | null> {
  return invoke<string | null>('pickImportPath', {})
}

export async function pickTextImportPath(): Promise<string | null> {
  return invoke<string | null>('pickTextImportPath', {})
}

export async function pickImageImportPath(): Promise<string | null> {
  return invoke<string | null>('pickImageImportPath', {})
}

export async function openUrl(url: string): Promise<void> {
  await invoke('openUrl', { url })
}
