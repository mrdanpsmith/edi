import { confirmAction } from './bridge'
import {
  dirname,
  fileName,
  getPendingFiles,
  imageReference,
  isSupportedFile,
  pickExportPath,
  pickImageImportPath,
  pickImportPath,
  pickOpenPath,
  pickSavePath,
  pickTextImportPath,
  readAnyTextFile,
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
  setActiveDirty,
  setActivePath,
} from './state'
import { promptForRename } from './urlDialog'
import type { AppContext } from './appContext'

export interface FileController {
  openFile(): Promise<void>
  openPendingFiles(): Promise<void>
  openPaths(paths: string[]): Promise<void>
  openDocument(path: string): Promise<void>
  onNativeEvent(payload: string): void
  saveFile(): Promise<void>
  saveFileAs(): Promise<void>
  renameFile(): Promise<void>
  revertFile(): Promise<void>
  copyFilePath(): void
  rememberRecent(path: string): Promise<void>
  refreshRecents(): void
  importTable(): Promise<void>
  importTextFile(): Promise<void>
  insertImage(): Promise<void>
  exportHtml(): Promise<void>
}

interface NativeEvent {
  type?: unknown
  paths?: unknown
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

  async function saveTo(path: string): Promise<void> {
    if (
      !isSupportedFile(path) &&
      !(await confirmAction(`"${path}" does not have a supported extension.\n\nContinue anyway?`))
    ) {
      return
    }
    try {
      const md = ctx.blockEditor?.getMarkdown() ?? ''
      await writeTextFile(path, md)
      afterSave(path)
    } catch (error) {
      ctx.reportError(`Failed to save ${path}`, error)
    }
  }

  /** The document is on disk under `path` and clean: everything that follows. */
  function afterSave(path: string): void {
    setActivePath(path)
    setActiveDirty(false)
    ctx.updateTitle()
    ctx.updateStatus()
    ctx.syncDirty()
    ctx.syncMenuState()
    void rememberRecent(path)
  }

  /**
   * Rename the document in place: the same folder, a new name, and the old file
   * gone. The write and the delete are one backend call, so the document is never
   * left on disk under both names or under neither — a rename is not a Save As
   * plus a delete the page can fail between.
   */
  async function renameFile(): Promise<void> {
    const oldPath = getActive()?.path
    if (!oldPath) return
    const currentName = oldPath.split('/').pop() ?? oldPath
    const name = await promptForRename(currentName)
    if (name === null) return
    const newPath = oldPath.includes('/') ? `${dirname(oldPath)}/${name}` : name
    if (
      !isSupportedFile(newPath) &&
      !(await confirmAction(`"${name}" does not have a supported extension.\n\nContinue anyway?`))
    ) {
      return
    }
    try {
      const md = ctx.blockEditor?.getMarkdown() ?? ''
      await renameTextFile(oldPath, newPath, md)
      afterSave(newPath)
      ctx.flashStatus(`Renamed to ${name}`)
    } catch (error) {
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
      ctx.tabs.setActiveContent(content)
      setActiveDirty(false)
      ctx.tabs.snapshotActive()
    } catch (error) {
      ctx.reportError(`Failed to revert ${path}`, error)
    }
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

  async function exportHtml(): Promise<void> {
    if (!getActive()) return
    const base = getActive()!.path ? fileName(getActive()!.path!) : UNTITLED
    const path = await pickExportPath(base)
    if (!path) {
      return
    }
    try {
      const state = ctx.blockEditor?.getView().state
      if (!state) {
        return
      }
      const snapshots = await mermaidPngSnapshots(state.doc)
      const bodyHtml = serializeDocToHtml(state.doc, formulaEnvFor(state), snapshots)
      await writeTextFile(path, buildExportHtml(fileName(path), bodyHtml))
      ctx.flashStatus(`Exported ${path}`)
    } catch (error) {
      ctx.reportError(`Failed to export ${path}`, error)
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
    openPendingFiles,
    openPaths,
    openDocument,
    onNativeEvent,
    saveFile,
    saveFileAs,
    renameFile,
    revertFile,
    copyFilePath,
    rememberRecent,
    refreshRecents,
    importTable,
    importTextFile,
    insertImage,
    exportHtml,
  }
}
