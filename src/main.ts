import './styles.css'

import { hasBridge, invoke } from './bridge'

import { createEditor } from './editor'
import { initExecBlocks } from './exec'
import { buildExportHtml } from './export'
import {
  fileName,
  isSupportedFile,
  pickExportPath,
  pickOpenPath,
  pickSavePath,
  readTextFile,
  UNTITLED,
  writeTextFile,
} from './files'
import { bindFragmentDialog, listFragments, saveFragment } from './fragments'
import { SplitLayout } from './layout'
import { renderPendingMermaid } from './mermaid'
import { renderPreview } from './preview'
import { computeSpreadsheet } from './spreadsheet'
import { getDocState, setDirty, setPath, subscribe } from './state'

const RENDER_DEBOUNCE_MS = 300

const WELCOME_DOCUMENT = `# Welcome to Edi

Edi is a fast markdown editor with a live preview, Mermaid diagrams, in-line spreadsheets, executable code blocks, and more.

## Getting started

- Type on the left, see the result on the right.
- Press \`Ctrl+Shift+P\` to toggle the preview, or drag the divider to resize it.
- Open and save files with \`Ctrl+O\`, \`Ctrl+S\`, and \`Ctrl+Shift+S\`.
- Export the rendered document as a self-contained HTML file with \`Ctrl+Shift+E\`.

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

## Fragments

Select any text and press \`Ctrl+Shift+F\` (or \`Ctrl+Shift+K\`) to save it as a named fragment, then re-insert it anywhere.

## Tasks

- [x] Fast editing
- [x] Spreadsheet tables
- [x] Executable code blocks
- [x] Copy/paste fragments
- [x] HTML export
`

const editorContainer = document.querySelector<HTMLElement>('#editor-container')!
const previewContainer = document.querySelector<HTMLElement>('#preview-container')!
const workspace = document.querySelector<HTMLElement>('#workspace')!
const previewPane = document.querySelector<HTMLElement>('#preview-pane')!
const divider = document.querySelector<HTMLElement>('#divider')!
const docTitle = document.querySelector<HTMLElement>('#doc-title')!
const dirtyIndicator = document.querySelector<HTMLElement>('#dirty-indicator')!
const statusLeft = document.querySelector<HTMLElement>('#status-left')!
const statusRight = document.querySelector<HTMLElement>('#status-right')!
const previewBtn = document.querySelector<HTMLButtonElement>('#preview-btn')!
const fragmentsBtn = document.querySelector<HTMLButtonElement>('#fragments-btn')!
const fragmentsDialog = document.querySelector<HTMLDialogElement>('#fragments-dialog')!
const exportBtn = document.querySelector<HTMLButtonElement>('#export-btn')!

let renderTimer: number | undefined

function confirmAction(message: string): Promise<boolean> {
  if (hasBridge()) {
    return invoke<boolean>('confirm', { message })
  }
  return Promise.resolve(window.confirm(message))
}

function updateTitle(): void {
  const { path, dirty } = getDocState()
  const name = path ? path.split('/').pop()! : UNTITLED
  docTitle.textContent = name
  docTitle.title = path ?? ''
  dirtyIndicator.hidden = !dirty
  document.title = `${dirty ? '* ' : ''}${name} — Edi`
}

function updateStatus(): void {
  const { path } = getDocState()
  statusLeft.textContent = path ?? UNTITLED
  const text = editor.getValue()
  const words = text.trim() ? text.trim().split(/\s+/).length : 0
  statusRight.textContent = `${words.toLocaleString()} words · ${text.length.toLocaleString()} characters`
}

function selectionOrLine(): string {
  const { from, to } = editor.view.state.selection.main
  if (from !== to) {
    return editor.view.state.sliceDoc(from, to)
  }
  return editor.view.state.doc.lineAt(from).text
}

function insertText(text: string): void {
  editor.view.dispatch(editor.view.state.replaceSelection(text))
  editor.view.focus()
}

function flashStatus(message: string): void {
  statusLeft.textContent = message
  window.setTimeout(() => updateStatus(), 3000)
}

async function exportHtml(): Promise<void> {
  await renderPreviewNow()
  const base = getDocState().path ? fileName(getDocState().path!) : UNTITLED
  const path = await pickExportPath(base)
  if (!path) {
    return
  }
  try {
    await writeTextFile(path, buildExportHtml(fileName(path), previewContainer.innerHTML))
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
  previewContainer.innerHTML = renderPreview(editor.getValue())
  previewContainer.scrollTop = Math.min(scrollTop, previewContainer.scrollHeight)
  computeSpreadsheet(previewContainer)
  initExecBlocks(previewContainer)
  await renderPendingMermaid(previewContainer)
}

async function openFile(): Promise<void> {
  if (getDocState().dirty && !(await confirmAction('Discard unsaved changes and open a new file?'))) {
    return
  }
  const path = await pickOpenPath()
  if (!path) {
    return
  }
  try {
    const content = await readTextFile(path)
    editor.setValue(content)
    setPath(path)
    setDirty(false)
    updateStatus()
    await renderPreviewNow()
  } catch (error) {
    reportError(`Failed to open ${path}`, error)
  }
}

async function saveFile(): Promise<void> {
  let path = getDocState().path
  if (!path) {
    path = await pickSavePath(UNTITLED)
    if (!path) {
      return
    }
  }
  await saveTo(path)
}

async function saveFileAs(): Promise<void> {
  const current = getDocState().path
  const defaultName = current ? current.split('/').pop()! : UNTITLED
  const path = await pickSavePath(defaultName)
  if (!path) {
    return
  }
  await saveTo(path)
}

async function saveTo(path: string): Promise<void> {
  if (!isSupportedFile(path)) {
    await confirmAction(
      `"${path}" does not have a supported extension.\n\nContinue anyway?`,
    )
  }
  try {
    await writeTextFile(path, editor.getValue())
    setPath(path)
    setDirty(false)
    updateStatus()
  } catch (error) {
    reportError(`Failed to save ${path}`, error)
  }
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
    if (key === 'o') {
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
      layout.togglePreview()
    } else if (key === 'f' && event.shiftKey) {
      event.preventDefault()
      fragments.open()
    } else if (key === 'k' && event.shiftKey) {
      event.preventDefault()
      fragments.open()
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
  // The native shell owns the dirty check: its closeEvent prompts when the
  // document is unsaved. Ask it to close and let it decide.
  if (hasBridge()) {
    void invoke('quit')
    return
  }
  event?.preventDefault()
  window.close()
}

const editor = createEditor(editorContainer, () => {
  setDirty(true)
  updateStatus()
  schedulePreview()
})

const layout = new SplitLayout(workspace, previewPane, divider)

const fragments = bindFragmentDialog(fragmentsDialog, {
  onInsert(name) {
    const fragment = listFragments().find((fragment) => fragment.name === name)
    if (fragment) {
      insertText(fragment.content)
    }
  },
  onSaveSelection(name) {
    saveFragment(name, selectionOrLine())
  },
})

document.querySelector('#open-btn')!.addEventListener('click', () => void openFile())
document.querySelector('#save-btn')!.addEventListener('click', () => void saveFile())
document.querySelector('#save-as-btn')!.addEventListener('click', () => void saveFileAs())
fragmentsBtn.addEventListener('click', () => {
  fragments.open()
})
exportBtn.addEventListener('click', () => void exportHtml())
previewBtn.addEventListener('click', () => {
  layout.togglePreview()
  previewBtn.setAttribute('aria-pressed', String(layout.isPreviewVisible()))
})

function syncDirty(): void {
  void invoke('setDirty', { dirty: getDocState().dirty }).catch(() => undefined)
}

function init(): void {
  editor.setValue(WELCOME_DOCUMENT)
  updateTitle()
  updateStatus()
  registerShortcuts()
  subscribe(syncDirty)
  syncDirty()
  void renderPreviewNow()
}

init()
