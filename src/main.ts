import 'prosemirror-view/style/prosemirror.css'
import 'prosemirror-tables/style/tables.css'
import 'prosemirror-gapcursor/style/gapcursor.css'
import './styles.css'

import { confirmAction, hasBridge, invoke } from './bridge'

import { buildExportHtml } from './export'
import {
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
import { parseTableFile, toMarkdownTable } from './import'
import { FormatToolbar } from './formatToolbar'
import { bindMenuCommands } from './menus'
import { createBlockEditor, type BlockEditor } from './editor'
import { findSessionByPath, getActive, getState, isAnyDirty, setActiveDirty, setActivePath, subscribe } from './state'
import { Tabs } from './tabs'

const WELCOME_DOCUMENT = `# Welcome to Edi

Edi is a fast markdown editor with Mermaid diagrams, in-line spreadsheets, executable code blocks, and more.

## Getting started

- Click the handle on the left of any block or press \`Ctrl+Shift+E\` to toggle that block's source view.
- Use the **File** and **View** menus for document actions.
- Open several documents side by side in tabs (\`Ctrl+N\` for a new tab, \`Ctrl+W\` to close one).
- Insert a spreadsheet, text file, or image with \`Insert → …\`.

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
`

const editorContainer = document.querySelector<HTMLElement>('#editor-container')!
const formatBar = document.querySelector<HTMLElement>('#formatbar')!
const statusLeft = document.querySelector<HTMLElement>('#status-left')!
const statusRight = document.querySelector<HTMLElement>('#status-right')!
const tabbar = document.querySelector<HTMLElement>('#tabbar')!

let blockEditor: BlockEditor | null = null
let formatToolbar: FormatToolbar | null = null

const tabs = new Tabs(tabbar, {
  getMarkdown(): string {
    return blockEditor?.getMarkdown() ?? ''
  },
  setMarkdown(value: string): void {
    blockEditor?.setMarkdown(value)
  },
}, {
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
  const text = blockEditor?.getMarkdown() ?? ''
  const words = text.trim() ? text.trim().split(/\s+/).length : 0
  statusRight.textContent = `${words.toLocaleString()} words · ${text.length.toLocaleString()} characters`
}

function afterActivate(): void {
  updateTitle()
  updateStatus()
  syncDirty()
  syncMenuState()
}

function syncDirty(): void {
  void invoke('setDirty', { dirty: isAnyDirty() }).catch(() => undefined)
}

function syncMenuState(): void {
  const active = getActive()
  void invoke('setMenuState', {
    canRevert: Boolean(active?.path),
    visualMode: true,
    formattingVisible: formatToolbar?.isVisible() ?? true,
  }).catch(() => undefined)
}

function insertText(text: string): void {
  const view = blockEditor?.getView()
  if (view) {
    view.focus()
    view.dispatch(view.state.tr.insertText(text))
  }
}

function insertTable(markdown: string): void {
  insertText(`\n${markdown}\n`)
}

function flashStatus(message: string): void {
  statusLeft.textContent = message
  window.setTimeout(() => updateStatus(), 3000)
}

async function exportHtml(): Promise<void> {
  const active = getActive()
  const base = active?.path ? fileName(active.path) : UNTITLED
  const path = await pickExportPath(base)
  if (!path) {
    return
  }
  try {
    const md = blockEditor?.getMarkdown() ?? ''
    const div = document.createElement('div')
    div.className = 'md-preview'
    div.textContent = md
    const bodyHtml = div.innerHTML
    await writeTextFile(path, buildExportHtml(fileName(path), bodyHtml))
    flashStatus(`Exported ${path}`)
  } catch (error) {
    reportError(`Failed to export ${path}`, error)
  }
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
    const md = blockEditor?.getMarkdown() ?? ''
    await writeTextFile(path, md)
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
    blockEditor?.setMarkdown(content)
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
  if (hasBridge()) {
    void invoke('quit')
    return
  }
  event?.preventDefault()
  window.close()
}

function getWelcomeDocument(): string {
  return WELCOME_DOCUMENT
}

function toggleFormatting(): void {
  formatToolbar?.toggle()
  syncMenuState()
}

function init(): void {
  const welcome = getWelcomeDocument()
  blockEditor = createBlockEditor(editorContainer, welcome)
  formatToolbar = new FormatToolbar(formatBar, {
    getView: () => blockEditor!.getView(),
  })
  tabs.snapshotActive()
  registerShortcuts()
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
    toggleMode: () => {},
    toggleFormatting: () => toggleFormatting(),
  })
  subscribe(() => syncDirty())
  syncDirty()
  afterActivate()
}

init()
