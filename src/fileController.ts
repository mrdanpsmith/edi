import type { Node as ProseNode } from 'prosemirror-model'
import { confirmAction, isChangedOnDisk, isNotPermitted } from './bridge'
import {
  clearHistory,
  confirmWritePath,
  dirname,
  fileName,
  getPendingFiles,
  imageReference,
  isSupportedFile,
  listHistory,
  pickExportPath,
  pickImageImportPath,
  pickImportPath,
  pickOpenPath,
  pickRenamePath,
  pickSavePath,
  pickTextImportPath,
  pickTypedOpenPath,
  printHtml,
  readAnyTextFile,
  readHistoryVersion,
  readTextFile,
  renameTextFile,
  UNTITLED,
  writeTextFile,
} from './files'
import { buildExportHtml, serializeDocToHtml } from './export'
import { parseTableFile, toMarkdownTable } from './import'
import { copyText } from './clipboard'
import { mermaidPngSnapshots } from './mermaid-export'
import { formulaEnvFor } from './formulaDefs'
import { addRecentFile, getRecentFiles } from './recents'
import {
  findSessionByPath,
  getActive,
  markSaved,
  setActiveDirty,
} from './state'
import { openHistoryDialog } from './historyDialog'
import type { AppContext } from './appContext'

export interface FileController {
  openFile(): Promise<void>
  openTypedPath(): Promise<void>
  openPendingFiles(): Promise<void>
  openPaths(paths: string[]): Promise<void>
  openDocument(path: string): Promise<void>
  onNativeEvent(payload: string): void
  saveFile(): Promise<void>
  saveFileAs(): Promise<void>
  renameFile(): Promise<void>
  revertFile(): Promise<void>
  showHistory(): Promise<void>
  copyFilePath(): void
  rememberRecent(path: string): Promise<void>
  refreshRecents(): void
  importTable(): Promise<void>
  importTextFile(): Promise<void>
  insertImage(): Promise<void>
  exportHtml(): Promise<void>
  printDocument(): Promise<void>
}

interface NativeEvent {
  type?: unknown
  paths?: unknown
  path?: unknown
  message?: unknown
}

/** What a save writes, and which tab, edit and document it was read from. */
interface SaveSnapshot {
  id: string
  revision: number
  markdown: string
  doc: ProseNode | null
}

/**
 * The file lifecycle: open, save, rename and revert, plus the import/export
 * commands that read and write the same files through the same dialogs.
 *
 * The context is the only state this module touches; `openingPaths` is per
 * instance, so two booted pages (or two tests) cannot share an in-flight open.
 */
export function createFileController(ctx: AppContext): FileController {
  const openingPaths = new Set<string>()

  async function openFile(): Promise<void> {
    const paths = await pickOpenPath()
    if (!paths || paths.length === 0) {
      return
    }
    for (const path of paths) {
      await openDocument(path)
    }
  }

  /**
   * Open a document by a path the user types (File → Open Path…). A relative
   * path resolves against the active document's folder; an untitled document
   * has none, so the shell falls back to the home directory.
   */
  async function openTypedPath(): Promise<void> {
    const activePath = getActive()?.path
    const path = await pickTypedOpenPath(activePath ? dirname(activePath) : null)
    if (path) await openDocument(path)
  }

  /**
   * Open files Edi was launched with (e.g. a .md double-clicked in the file
   * manager, delivered as command-line arguments and surfaced via the bridge).
   * Runs after the bridge is up; unsupported extensions are ignored so a stray
   * argument never pops an error dialog on an otherwise clean launch.
   */
  async function openPendingFiles(): Promise<void> {
    const paths = await getPendingFiles().catch(() => undefined)
    if (!paths || paths.length === 0) return
    await openPaths(paths)
  }

  /** Open the supported paths in `paths`, in order, as tabs. */
  async function openPaths(paths: string[]): Promise<void> {
    for (const path of paths) {
      if (isSupportedFile(path)) {
        await openDocument(path)
      }
    }
  }

  /**
   * Events the native shell pushes outside a request/response pair.
   *
   * macOS delivers a double-clicked file to a *running* app as an open-document
   * Apple Event, not as an argument to a new process (`QFileOpenEvent` in
   * `backend/main.py`). The shell forwards it here so the file opens as a tab in
   * this window instead of launching a second Edi.
   */
  function onNativeEvent(payload: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(payload)
    } catch {
      return
    }
    if (typeof parsed !== 'object' || parsed === null) return
    const event = parsed as NativeEvent
    // A document changed or vanished on disk (`backend/watcher.py`).
    if ((event.type === 'diskChanged' || event.type === 'diskDeleted') && typeof event.path === 'string') {
      ctx.disk?.onEvent(event.type, event.path)
      return
    }
    // The shell reporting the outcome of one of its own dialogs.
    if (event.type === 'flashStatus' && typeof event.message === 'string') {
      ctx.flashStatus(event.message)
      return
    }
    if (event.type !== 'openFiles' || !Array.isArray(event.paths)) return
    const paths = event.paths.filter((path): path is string => typeof path === 'string')
    void openPaths(paths)
  }

  async function openDocument(path: string): Promise<void> {
    const existing = findSessionByPath(path)
    if (existing) {
      // Already-open *and* already-active is not a swap, so there is no settle
      // to be called from — the one case the caller speaks for itself.
      if (existing.id === ctx.tabs.activeId) ctx.afterActivate()
      else ctx.tabs.activate(existing.id)
      return
    }
    // A path can be asked for twice before its read finishes: a cold-launch
    // event is in the pending list and a warm one arrives while that list is
    // still being opened. One document is the answer to both.
    if (openingPaths.has(path)) return
    openingPaths.add(path)
    try {
      const content = await readTextFile(path)
      ctx.disk?.noteDiskText(path, content)
      // The path is set before the content is rendered so that relative image
      // references in opened documents resolve against the document's directory.
      ctx.tabs.addSession(content, path)
      void rememberRecent(path)
    } catch (error) {
      ctx.reportError(`Failed to open ${path}`, error)
    } finally {
      openingPaths.delete(path)
    }
  }

  async function saveFile(): Promise<void> {
    if (!getActive()) return
    const active = getActive()!
    let path = active.path ?? null
    if (!path) {
      path = await pickSavePath(UNTITLED)
      if (!path) {
        return
      }
    }
    await saveTo(path)
  }

  async function saveFileAs(): Promise<void> {
    if (!getActive()) return
    const defaultName = getActive()!.path?.split('/').pop() ?? UNTITLED
    const path = await pickSavePath(defaultName)
    if (!path) {
      return
    }
    await saveTo(path)
  }

  async function saveTo(path: string, confirmed = false): Promise<void> {
    if (
      !isSupportedFile(path) &&
      !(await confirmAction(`"${path}" does not have a supported extension.\n\nContinue anyway?`))
    ) {
      return
    }
    try {
      const snapshot = await snapshotForSave()
      if (snapshot === null) return
      await writeTextFile(path, snapshot.markdown, { history: true })
      afterSave(path, snapshot)
    } catch (error) {
      if (isChangedOnDisk(error)) {
        // Something else wrote the file since Edi read it. Not overwritten:
        // the bar this raises offers Compare, Take theirs and Keep mine.
        ctx.disk?.saveRefused(path)
        return
      }
      if (isNotPermitted(error) && !confirmed) {
        // The shell only writes files the user named outside the page (see
        // `PathGrants` in backend/bridge.py) — a document opened by following
        // a link was not. The shell asks about that one file in its own
        // prompt, once; a yes grants it and the save goes ahead.
        let allowed: boolean
        try {
          allowed = await confirmWritePath(path)
        } catch (confirmError) {
          ctx.reportError(`Failed to save ${path}`, confirmError)
          return
        }
        if (allowed) await saveTo(path, true)
        return
      }
      ctx.reportError(`Failed to save ${path}`, error)
    }
  }

  /**
   * The active document as it is to be written, and which tab and edit it is.
   *
   * An open encrypted block's last keystrokes are only written into the
   * document after a debounce, so they are flushed first or the save writes the
   * text from before them and marks the tab clean. The tab is read *after* that
   * await, together with the markdown, so the two always describe one document.
   */
  async function snapshotForSave(): Promise<SaveSnapshot | null> {
    await ctx.blockEditor?.flushReveals()
    const session = getActive()
    if (!session) return null
    return {
      id: session.id,
      revision: session.revision,
      markdown: ctx.blockEditor?.getMarkdown() ?? '',
      doc: ctx.blockEditor?.getView().state.doc ?? null,
    }
  }

  /** The document is on disk under `path`: everything that follows. */
  function afterSave(path: string, snapshot: SaveSnapshot): void {
    ctx.disk?.noteDiskText(path, snapshot.markdown)
    markSaved(snapshot.id, path, snapshot.revision)
    // The editor's saved point is the document the save read. Only for the tab
    // in view: another tab's state is stored away, and is not this editor's.
    if (snapshot.doc && getActive()?.id === snapshot.id) ctx.blockEditor?.markSavedPoint(snapshot.doc)
    ctx.updateTitle()
    ctx.updateStatus()
    ctx.syncDirty()
    ctx.syncMenuState()
    void rememberRecent(path)
  }

  /**
   * Rename or move the document: a new name, a new folder or both, and the old
   * file gone. The write and the delete are one backend call, so the document is
   * never left on disk under both names or under neither — a rename is not a
   * Save As plus a delete the page can fail between.
   *
   * The new path is typed into the shell's own prompt (`pickRenamePath`), which
   * is what lets it name another folder: the shell trusts a path the user typed
   * there, not one the page sends. Relative images and links are rebased so they
   * still name the same files from the new folder; the editor takes that rewrite
   * only once the file is on disk, so a refused move changes nothing.
   */
  async function renameFile(): Promise<void> {
    const oldPath = getActive()?.path
    if (!oldPath) return
    const newPath = await pickRenamePath(oldPath)
    if (!newPath) return
    const name = newPath.split('/').pop() ?? newPath
    if (
      !isSupportedFile(newPath) &&
      !(await confirmAction(`"${name}" does not have a supported extension.\n\nContinue anyway?`))
    ) {
      return
    }
    try {
      let snapshot = await snapshotForSave()
      if (snapshot === null) return
      const rebased = ctx.blockEditor?.rebaseLinks(oldPath, newPath) ?? null
      const markdown = rebased?.markdown ?? snapshot.markdown
      await renameTextFile(oldPath, newPath, markdown)
      ctx.disk?.renamed(oldPath, newPath)
      if (rebased) {
        // Only the editor in view can take the rewrite. A tab switched away
        // from mid-move keeps its stored state's old links (the file on disk
        // has the new ones), so it is left dirty rather than marked saved.
        if (getActive()?.id === snapshot.id && rebased.apply()) {
          // Nothing was typed during the move: the editor holds exactly what
          // was written, including the revision the rebase itself made.
          snapshot = { ...snapshot, markdown, doc: rebased.doc, revision: getActive()!.revision }
        } else {
          snapshot = { ...snapshot, markdown, doc: rebased.doc, revision: -1 }
        }
      }
      afterSave(newPath, snapshot)
      ctx.flashStatus(dirname(newPath) === dirname(oldPath) ? `Renamed to ${name}` : `Moved to ${newPath}`)
    } catch (error) {
      if (isChangedOnDisk(error)) {
        ctx.disk?.saveRefused(oldPath)
        return
      }
      ctx.reportError(`Failed to rename ${oldPath}`, error)
    }
  }

  async function revertFile(): Promise<void> {
    if (!getActive()) return
    const active = getActive()!
    const path = active.path ?? null
    if (!path) {
      return
    }
    if (
      active?.dirty &&
      !(await confirmAction('Discard unsaved changes and revert to the saved version?'))
    ) {
      return
    }
    try {
      const content = await readTextFile(path)
      ctx.disk?.noteDiskText(path, content)
      ctx.tabs.setActiveContent(content)
      setActiveDirty(false)
      ctx.tabs.snapshotActive()
    } catch (error) {
      ctx.reportError(`Failed to revert ${path}`, error)
    }
  }

  /**
   * File › Version History: browse the document's saved versions and restore one.
   *
   * A restore replaces the document as an ordinary edit — undoable, and leaving
   * the tab dirty — rather than as a revert, so nothing is lost until the reader
   * saves, and that save records the restored text as the newest version.
   */
  async function showHistory(): Promise<void> {
    const session = getActive()
    const path = session?.path
    if (!session || !path) return
    // Looking at the history is looking at what changed: the marker has done its job.
    ctx.disk?.dismiss(path)
    await ctx.blockEditor?.flushReveals()
    const name = path.split('/').pop() ?? path
    const restored = await openHistoryDialog({
      name,
      current: ctx.blockEditor?.getMarkdown() ?? '',
      list: () => listHistory(path),
      read: (id) => readHistoryVersion(path, id),
      clear: async () => {
        const confirmed = await confirmAction(
          `Delete every saved version of ${name}?\n\nThe document as it is on disk is kept as the first version of a new history. This cannot be undone.`,
        )
        if (!confirmed) return false
        try {
          await clearHistory(path)
        } catch (error) {
          ctx.reportError(`Failed to clear the history of ${name}`, error)
          return false
        }
        ctx.flashStatus(`Cleared the history of ${name}`)
        return true
      },
    })
    if (restored === null || getActive()?.id !== session.id) return
    await ctx.blockEditor?.flushReveals()
    ctx.blockEditor?.replaceMarkdown(restored)
    ctx.blockEditor?.focus()
    ctx.flashStatus('Restored a saved version')
  }

  /** Copy the path of the document in view; a no-op for an unsaved one. */
  function copyFilePath(): void {
    const path = getActive()?.path
    if (path) void copyText(path)
  }

  async function importTable(): Promise<void> {
    const path = await pickImportPath()
    if (!path) {
      return
    }
    try {
      const table = await parseTableFile(path)
      insertTable(toMarkdownTable(table.rows))
      ctx.flashStatus(`Imported ${table.name}`)
    } catch (error) {
      ctx.reportError(`Failed to import ${path}`, error)
    }
  }

  async function importTextFile(): Promise<void> {
    const path = await pickTextImportPath()
    if (!path) {
      return
    }
    try {
      const content = await readAnyTextFile(path)
      insertMarkdown(`\n${content}\n`)
      ctx.flashStatus(`Inserted ${fileName(path)}`)
    } catch (error) {
      ctx.reportError(`Failed to insert ${path}`, error)
    }
  }

  async function insertImage(): Promise<void> {
    const path = await pickImageImportPath()
    if (!path) {
      return
    }
    const reference = imageReference(getActive()?.path ?? null, path)
    const destination = /[ ()]/u.test(reference) ? `<${reference}>` : reference
    insertMarkdown(`\n![${fileName(path)}](${destination})\n`)
    ctx.flashStatus(`Inserted ${fileName(path)}`)
  }

  /** The active document as a standalone page: what export writes and print prints. */
  async function documentHtml(title: string): Promise<string | null> {
    const state = ctx.blockEditor?.getView().state
    if (!state) {
      return null
    }
    const snapshots = await mermaidPngSnapshots(state.doc)
    const bodyHtml = serializeDocToHtml(state.doc, formulaEnvFor(state), snapshots)
    return buildExportHtml(title, bodyHtml)
  }

  async function exportHtml(): Promise<void> {
    if (!getActive()) return
    const base = getActive()!.path ? fileName(getActive()!.path!) : UNTITLED
    const path = await pickExportPath(base)
    if (!path) {
      return
    }
    try {
      const html = await documentHtml(fileName(path))
      if (html === null) {
        return
      }
      await writeTextFile(path, html)
      ctx.flashStatus(`Exported ${path}`)
    } catch (error) {
      ctx.reportError(`Failed to export ${path}`, error)
    }
  }

  async function printDocument(): Promise<void> {
    const active = getActive()
    if (!active) return
    const title = active.path ? fileName(active.path) : UNTITLED
    try {
      const html = await documentHtml(title)
      if (html === null) {
        return
      }
      if (await printHtml(html, active.path ?? null)) {
        ctx.flashStatus(`Printed ${title}`)
      }
    } catch (error) {
      ctx.reportError(`Failed to print ${title}`, error)
    }
  }

  function insertMarkdown(markdown: string): void {
    ctx.blockEditor?.insertMarkdown(markdown)
  }

  function insertTable(markdown: string): void {
    insertMarkdown(`\n${markdown}\n`)
  }

  function refreshRecents(): void {
    getRecentFiles()
      .then((paths) => ctx.homeScreen?.setRecents(paths))
      .catch(() => undefined)
  }

  async function rememberRecent(path: string): Promise<void> {
    try {
      await addRecentFile(path)
    } catch {
      // Recent-files persistence is best-effort (e.g. no native bridge).
    }
    refreshRecents()
  }

  return {
    openFile,
    openTypedPath,
    openPendingFiles,
    openPaths,
    openDocument,
    onNativeEvent,
    saveFile,
    saveFileAs,
    renameFile,
    revertFile,
    showHistory,
    copyFilePath,
    rememberRecent,
    refreshRecents,
    importTable,
    importTextFile,
    insertImage,
    exportHtml,
    printDocument,
  }
}
