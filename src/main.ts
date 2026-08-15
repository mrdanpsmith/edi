import './styles.css'

import { confirmAction, hasBridge, invoke } from './bridge'

import { createEditor } from './editor'
import { initExecBlocks } from './exec'
import { buildExportHtml } from './export'
import {
  dirname,
  fileName,
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
  UNTITLED,
  writeTextFile,
} from './files'
import { FormatToolbar } from './formatToolbar'
import { parseTableFile, toMarkdownTable } from './import'
import { SplitLayout } from './layout'
import { bindMenuCommands } from './menus'
import { renderPendingMermaid } from './mermaid'
import { renderPreview, resolveLinkHref, type LinkTarget } from './preview'
import { computeSpreadsheet } from './spreadsheet'
import { findSessionByPath, getActive, getState, isAnyDirty, setActiveDirty, setActivePath, subscribe } from './state'
import { Tabs } from './tabs'
import { attachTableCopyControls, previewExportBody } from './tablecopy'

const RENDER_DEBOUNCE_MS = 300

const WELCOME_DOCUMENT = `# Welcome to Edi

Edi is a fast markdown editor with a live preview, Mermaid diagrams, in-line spreadsheets, executable code blocks, and more.

## Getting started

- Type on the left, see the result on the right.
- Use the **File** and **View** menus for document actions and the preview.
- Format text with the toolbar above the editor (\`Ctrl+B\` bold, \`Ctrl+I\` italic), or hide it via \`View → Formatting Toolbar\`.
- Open several documents side by side in tabs (\`Ctrl+N\` for a new tab, \`Ctrl+W\` to close one).
- Insert a spreadsheet, text file, or image with \`Insert → …\`.
- Hover a table in the preview and press **Copy** to paste it into Word, email, or Excel.

## Mermaid diagrams

\`\`\`mermaid
graph TD
    A[Start] --> B{Preview on?}
    B -->|Yes| C[Render diagram]
    B -->|No| D[Show source]
    C --> E[Looks great!]
    D --> E
\`\`\`

## Spreadsheet tables

Start a cell with \`=\` to compute it from other cells:

| Item | Q1 | Q2 | Total |
| --- | --- | --- | --- |
| Widget | 120 | 180 | =SUM(B2:C2) |
| Gadget | 90 | 110 | =B3+C3 |
| **Total** | =SUM(B2:B3) | =SUM(C2:C3) | =SUM(D2:D3) |

Supports \`SUM\`, \`AVERAGE\`, \`MIN\`, \`MAX\`, \`COUNT\`, \`PRODUCT\`, \`ROUND\`, cell references like \`B2\`, and ranges like \`B2:C4\`.

## Executable code blocks

Add a shebang line like a shell script to make a code block runnable:

\`\`\`
#!/usr/bin/env python3
print("Hello from Python!")
\`\`\`

## Tasks

- [x] Fast editing
- [x] Spreadsheet tables
- [x] Executable code blocks
- [x] HTML export
- [x] Multiple tabs
- [x] Spreadsheet import
- [x] Text-file import
- [x] Image insertion
- [x] Formatting toolbar
- [x] Copy tables to the clipboard
`

const editorContainer = document.querySelector<HTMLElement>('#editor-container')!
const previewContainer = document.querySelector<HTMLElement>('#preview-container')!
const workspace = document.querySelector<HTMLElement>('#workspace')!
const editorPane = document.querySelector<HTMLElement>('#editor-pane')!
const previewPane = document.querySelector<HTMLElement>('#preview-pane')!
const divider = document.querySelector<HTMLElement>('#divider')!
const formatBar = document.querySelector<HTMLElement>('#formatbar')!
const statusLeft = document.querySelector<HTMLElement>('#status-left')!
const statusRight = document.querySelector<HTMLElement>('#status-right')!
const tabbar = document.querySelector<HTMLElement>('#tabbar')!

let renderTimer: number | undefined

const editor = createEditor(editorContainer, () => {
  setActiveDirty(true)
  updateStatus()
  schedulePreview()
})

const formatToolbar = new FormatToolbar(formatBar, editor.view)

const layout = new SplitLayout(workspace, editorPane, previewPane, divider)

const tabs = new Tabs(tabbar, editor.view, {
  onNewTab: () => openNewTab(),
  onCloseTab: (id) => void closeTab(id),
  onActivate: () => afterActivate(),
})

function updateTitle(): void {
  const active = getActive()
  const name = active?.path ? active.path.split('/').pop()! : UNTITLED
  document.title = `${active?.dirty ? '* ' : ''}${name} — Edi`
}

function updateStatus(): void {
  const active = getActive()
  statusLeft.textContent = active?.path ?? UNTITLED
  const text = editor.getValue()
  const words = text.trim() ? text.trim().split(/\s+/).length : 0
  statusRight.textContent = `${words.toLocaleString()} words · ${text.length.toLocaleString()} characters`
}

function afterActivate(): void {
  updateTitle()
  updateStatus()
  syncDirty()
  syncMenuState()
  void renderPreviewNow()
  editor.focus()
}

function syncDirty(): void {
  void invoke('setDirty', { dirty: isAnyDirty() }).catch(() => undefined)
}

function syncMenuState(): void {
  const active = getActive()
  void invoke('setMenuState', {
    canRevert: Boolean(active?.path),
    previewVisible: layout.isPreviewVisible(),
    editorVisible: layout.isEditorVisible(),
    formattingVisible: formatToolbar.isVisible(),
  }).catch(() => undefined)
}

function insertText(text: string): void {
  editor.view.dispatch(editor.view.state.replaceSelection(text))
  editor.view.focus()
}

function insertTable(markdown: string): void {
  insertText(`\n${markdown}\n`)
}

function flashStatus(message: string): void {
  statusLeft.textContent = message
  window.setTimeout(() => updateStatus(), 3000)
}

function togglePreview(): void {
  layout.togglePreview()
  syncMenuState()
}

function toggleEditor(): void {
  layout.toggleEditor()
  syncMenuState()
}

function toggleFormatting(): void {
  formatToolbar.toggle()
  syncMenuState()
}

async function exportHtml(): Promise<void> {
  await renderPreviewNow()
  const active = getActive()
  const base = active?.path ? fileName(active.path) : UNTITLED
  const path = await pickExportPath(base)
  if (!path) {
    return
  }
  try {
    await writeTextFile(path, buildExportHtml(fileName(path), previewExportBody(previewContainer)))
    flashStatus(`Exported ${path}`)
  } catch (error) {
    reportError(`Failed to export ${path}`, error)
  }
}

function schedulePreview(): void {
  if (renderTimer !== undefined) {
    window.clearTimeout(renderTimer)
  }
  renderTimer = window.setTimeout(() => void renderPreviewNow(), RENDER_DEBOUNCE_MS)
}

async function renderPreviewNow(): Promise<void> {
  const scrollTop = previewContainer.scrollTop
  const active = getActive()
  previewContainer.innerHTML = renderPreview(editor.getValue(), {
    docDir: active?.path ? dirname(active.path) : undefined,
  })
  previewContainer.scrollTop = Math.min(scrollTop, previewContainer.scrollHeight)
  computeSpreadsheet(previewContainer)
  attachTableCopyControls(previewContainer, { onCopied: () => flashStatus('Table copied to clipboard') })
  initExecBlocks(previewContainer)
  await renderPendingMermaid(previewContainer)
}

function openNewTab(): void {
  tabs.addSession()
}

async function closeTab(id: string): Promise<void> {
  const session = getState().sessions.find((entry) => entry.id === id)
  if (
    session?.dirty &&
    !(await confirmAction('Discard unsaved changes and close this document?'))
  ) {
    return
  }
  tabs.close(id)
}

async function openFile(): Promise<void> {
  const paths = await pickOpenPath()
  if (!paths || paths.length === 0) {
    return
  }
  for (const path of paths) {
    await openDocument(path)
  }
}

async function openDocument(path: string): Promise<void> {
  const existing = findSessionByPath(path)
  if (existing) {
    tabs.activate(existing.id)
    afterActivate()
    return
  }
  try {
    const content = await readTextFile(path)
    tabs.addSession(content)
    setActivePath(path)
    afterActivate()
  } catch (error) {
    reportError(`Failed to open ${path}`, error)
  }
}

function openLink(target: LinkTarget): void {
  if (target.kind === 'fragment') {
    const element = previewContainer.querySelector<HTMLElement>(`#${target.id}`)
    element?.scrollIntoView({ block: 'start' })
    return
  }
  if (target.kind === 'external') {
    void openExternalUrl(target.url)
    return
  }
  if (isSupportedFile(target.path)) {
    void openDocument(target.path)
    return
  }
  void openExternalUrl(`file://${target.path}`)
}

function openExternalUrl(url: string): void {
  if (hasBridge()) {
    void invoke('openUrl', { url }).catch(() => undefined)
    return
  }
  window.open(url, '_blank', 'noopener')
}

function bindPreviewLinks(): void {
  previewContainer.addEventListener('click', (event) => {
    const anchor = (event.target as Element | null)?.closest?.('a[href]')
    if (!anchor) {
      return
    }
    const href = anchor.getAttribute('href')
    if (!href) {
      return
    }
    const active = getActive()
    const target = resolveLinkHref(href, active?.path ? dirname(active.path) : undefined)
    event.preventDefault()
    openLink(target)
  })
}

async function saveFile(): Promise<void> {
  const active = getActive()
  let path = active?.path ?? null
  if (!path) {
    path = await pickSavePath(UNTITLED)
    if (!path) {
      return
    }
  }
  await saveTo(path)
}

async function saveFileAs(): Promise<void> {
  const current = getActive()?.path ?? null
  const defaultName = current ? current.split('/').pop()! : UNTITLED
  const path = await pickSavePath(defaultName)
  if (!path) {
    return
  }
  await saveTo(path)
}

async function saveTo(path: string): Promise<void> {
  if (!isSupportedFile(path)) {
    await confirmAction(`"${path}" does not have a supported extension.\n\nContinue anyway?`)
  }
  try {
    await writeTextFile(path, editor.getValue())
    setActivePath(path)
    setActiveDirty(false)
    updateTitle()
    updateStatus()
    syncDirty()
    syncMenuState()
  } catch (error) {
    reportError(`Failed to save ${path}`, error)
  }
}

async function revertFile(): Promise<void> {
  const active = getActive()
  const path = active?.path ?? null
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
    editor.setValue(content)
    setActiveDirty(false)
    tabs.snapshotActive()
    afterActivate()
  } catch (error) {
    reportError(`Failed to revert ${path}`, error)
  }
}

async function importTable(): Promise<void> {
  const path = await pickImportPath()
  if (!path) {
    return
  }
  try {
    const table = await parseTableFile(path)
    insertTable(toMarkdownTable(table.rows))
    flashStatus(`Imported ${table.name}`)
  } catch (error) {
    reportError(`Failed to import ${path}`, error)
  }
}

async function importTextFile(): Promise<void> {
  const path = await pickTextImportPath()
  if (!path) {
    return
  }
  try {
    const content = await readAnyTextFile(path)
    insertText(`\n${content}\n`)
    flashStatus(`Inserted ${fileName(path)}`)
  } catch (error) {
    reportError(`Failed to insert ${path}`, error)
  }
}

async function insertImage(): Promise<void> {
  const path = await pickImageImportPath()
  if (!path) {
    return
  }
  const reference = imageReference(getActive()?.path ?? null, path)
  const destination = /[ ()]/u.test(reference) ? `<${reference}>` : reference
  insertText(`\n![${fileName(path)}](${destination})\n`)
  flashStatus(`Inserted ${fileName(path)}`)
}

function reportError(message: string, error: unknown): void {
  const detail = error instanceof Error ? `\n\n${error.message}` : ''
  void confirmAction(`${message}${detail}`)
}

function registerShortcuts(): void {
  window.addEventListener('keydown', (event) => {
    if (!(event.ctrlKey || event.metaKey)) {
      return
    }
    const key = event.key.toLowerCase()
    if (key === 'n') {
      event.preventDefault()
      openNewTab()
    } else if (key === 'w') {
      event.preventDefault()
      void closeTab(tabs.activeId)
    } else if (key === 'o') {
      event.preventDefault()
      void openFile()
    } else if (key === 's' && event.shiftKey) {
      event.preventDefault()
      void saveFileAs()
    } else if (key === 's') {
      event.preventDefault()
      void saveFile()
    } else if (key === 'p' && event.shiftKey) {
      event.preventDefault()
      togglePreview()
    } else if (key === 'e' && event.shiftKey) {
      event.preventDefault()
      void exportHtml()
    } else if (key === 'q') {
      event.preventDefault()
      void requestQuit()
    }
  })
}

interface CloseRequestEvent {
  preventDefault: () => void
}

function requestQuit(event?: CloseRequestEvent): void {
  // The native shell owns the dirty check: its closeEvent prompts when any
  // document is unsaved. Ask it to close and let it decide.
  if (hasBridge()) {
    void invoke('quit')
    return
  }
  event?.preventDefault()
  window.close()
}

function init(): void {
  editor.setValue(WELCOME_DOCUMENT)
  tabs.snapshotActive()
  registerShortcuts()
  bindPreviewLinks()
  bindMenuCommands({
    new: () => openNewTab(),
    open: () => void openFile(),
    save: () => void saveFile(),
    saveAs: () => void saveFileAs(),
    revert: () => void revertFile(),
    importTable: () => void importTable(),
    importText: () => void importTextFile(),
    insertImage: () => void insertImage(),
    export: () => void exportHtml(),
    togglePreview: () => togglePreview(),
    toggleEditor: () => toggleEditor(),
    toggleFormatting: () => toggleFormatting(),
  })
  subscribe(() => syncDirty())
  syncDirty()
  afterActivate()
}

init()
