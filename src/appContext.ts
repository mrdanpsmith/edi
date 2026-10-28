import type { Node as ProseNode } from 'prosemirror-model'

import { invoke, showError } from './bridge'
import { blockModeFor, interactionLabels, type BlockMode } from './block-modes'
import { UNTITLED } from './files'
import { isHoverBandEnabled } from './hoverBand'
import { getActive, getState, isAnyDirty } from './state'
import { canZoomIn, canZoomOut, DEFAULT_ZOOM } from './zoom'
import type { BlockEditor } from './editor'
import type { ContextMenu } from './contextmenu'
import type { HomeScreen } from './home'
import type { SearchPanel } from './searchPanel'
import type { Tabs } from './tabs'
import type { Toolbar } from './toolbar'

/** The elements the page entry point hands to `init`. */
export interface AppRoots {
  editorContainer: HTMLElement
  toolbar: HTMLElement
  statusLeft: HTMLElement
  statusMode: HTMLElement
  statusRight: HTMLElement
  statusZoom: HTMLButtonElement
  tabbar: HTMLElement
  homeScreen: HTMLElement
}

/**
 * The one mutable application context.
 *
 * The controllers receive this rather than importing module-level `{ value }`
 * boxes: importing any module is now free of page state, and everything that
 * describes the running page lives here. `tabs` is assigned by `init` once the
 * editor callbacks it needs exist.
 */
export interface AppContext {
  readonly roots: AppRoots
  readonly selftest: boolean
  blockEditor: BlockEditor | null
  toolbar: Toolbar | null
  homeScreen: HomeScreen | null
  contextMenu: ContextMenu | null
  searchPanel: SearchPanel | null
  tabs: Tabs
  documentZoom: number
  lastNativeTitle: string
  updateView(): void
  updateTitle(): void
  updateStatus(): void
  renderModeChip(mode: BlockMode | null): void
  afterActivate(): void
  syncDirty(): void
  syncMenuState(): void
  flashStatus(message: string): void
  reportError(message: string, error: unknown): void
}

function required<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector)
  if (!element) throw new Error(`Missing app root ${selector}`)
  return element
}

/** Resolve the root elements from the document, or fail loudly during boot. */
export function rootsFromDocument(): AppRoots {
  return {
    editorContainer: required('#editor-container'),
    toolbar: required('#toolbar'),
    statusLeft: required('#status-left'),
    statusMode: required('#status-mode'),
    statusRight: required('#status-right'),
    statusZoom: required('#status-zoom'),
    tabbar: required('#tabbar'),
    homeScreen: required('#home-screen'),
  }
}

function updateView(): void {
  const app = document.querySelector<HTMLElement>('#app')
  if (!app) return
  app.dataset.view = getState().sessions.length === 0 ? 'home' : 'editor'
}

function updateTitle(ctx: AppContext): void {
  const active = getActive()
  if (!active) {
    document.title = 'Edi'
    if (document.title !== ctx.lastNativeTitle) {
      ctx.lastNativeTitle = document.title
      void invoke('setTitle', { title: 'Edi' }).catch(() => undefined)
    }
    return
  }
  const name = active.path ? active.path.split('/').pop()! : UNTITLED
  const title = `${active.dirty ? '* ' : ''}${name} — Edi`
  document.title = title
  if (document.title !== ctx.lastNativeTitle) {
    ctx.lastNativeTitle = document.title
    void invoke('setTitle', { title }).catch(() => undefined)
  }
}

function updateStatus(ctx: AppContext): void {
  const active = getActive()
  if (!active) {
    ctx.roots.statusLeft.textContent = ''
    ctx.roots.statusRight.textContent = ''
    return
  }
  ctx.roots.statusLeft.textContent = active.path ?? UNTITLED
  const text = ctx.blockEditor?.getMarkdown() ?? ''
  const words = text.trim() ? text.trim().split(/\s+/).length : 0
  ctx.roots.statusRight.textContent = `${words.toLocaleString()} words · ${text.length.toLocaleString()} characters`
}

/**
 * The status chip: which block is in a mode, and what that mode is called.
 *
 * It needs an element of its own because `#status-left` is the transient flash
 * slot — `flashStatus` overwrites it and `updateStatus` clears it after three
 * seconds — so a chip living there would flash away. It is written only from the
 * plugin's own state changes (`onModeChange`), never from a flash, and it says
 * *what* is in a mode; the accent rule on the block itself is the in-document
 * half that says *where* (§7.2).
 */
function renderModeChip(ctx: AppContext, mode: BlockMode | null): void {
  const statusMode = ctx.roots.statusMode
  if (!statusMode) return
  const view = mode !== null ? ctx.blockEditor?.getView() : undefined
  const node = mode !== null && view !== undefined ? view.state.doc.nodeAt(mode.pos) : null
  if (mode === null || node === null || node === undefined) {
    statusMode.textContent = ''
    statusMode.hidden = true
    return
  }
  const source = mode.representation === 'source'
  const words = modeChipWords(node)
  statusMode.hidden = false
  // The record's *name*, in the record's own vocabulary (§5.1). Which of the three
  // it is has to be asked rather than assumed, because a table held open as a
  // sheet is `visual` and `viewing` — the two axes alone would call it "Edit",
  // which is a different block's mode entirely. The label comes from the
  // descriptor so the chip, the cluster button and the context menu cannot drift
  // into three spellings of the same word.
  //
  // **A block's own axis says which state that is.** A diagram's engaged state is
  // `Edit`, which is why one word served both jobs; an encrypted block's is
  // `Unlocked`, and the word on its button is `Lock` — so the chip reads the
  // `engaged` word rather than either control's, and `Edit` here would be the
  // diagram's vocabulary again.
  const form = mode.form === undefined
    ? undefined
    : blockModeFor(node).forms?.find((entry) => entry.id === mode.form)?.label
  const name = source ? 'Source' : form ?? interactionLabels(node.type.name).engaged
  statusMode.textContent = words === ''
    ? name
    : `${name} — “${words}”${source ? ' · Esc for visual' : ''}`
}

/** A few words of the block itself, so the chip names *which* block it is about. */
function modeChipWords(node: ProseNode): string {
  const text = node.type.name === 'mermaid_block'
    ? String(node.attrs.value ?? '').split('\n', 1)[0] ?? ''
    : node.textContent
  const trimmed = text.replace(/\s+/g, ' ').trim()
  if (trimmed === '') return ''
  return trimmed.length > 40 ? `${trimmed.slice(0, 39)}…` : trimmed
}

function syncDirty(): void {
  void invoke('setDirty', { dirty: isAnyDirty() }).catch(() => undefined)
}

function syncMenuState(ctx: AppContext): void {
  const active = getActive()
  void invoke('setMenuState', {
    canRevert: Boolean(active?.path),
    canCopyPath: Boolean(active?.path),
    canRename: Boolean(active?.path),
    toolbarVisible: ctx.toolbar?.isVisible() ?? true,
    hoverBand: isHoverBandEnabled(),
    zoomFactor: ctx.documentZoom,
    canZoomIn: canZoomIn(ctx.documentZoom),
    canZoomOut: canZoomOut(ctx.documentZoom),
  }).catch(() => undefined)
}

function afterActivate(ctx: AppContext): void {
  updateTitle(ctx)
  updateStatus(ctx)
  syncDirty()
  syncMenuState(ctx)
}

function flashStatus(ctx: AppContext, message: string): void {
  ctx.roots.statusLeft.textContent = message
  window.setTimeout(() => updateStatus(ctx), 3000)
}

function reportError(message: string, error: unknown): void {
  const detail = error instanceof Error ? `\n\n${error.message}` : ''
  void showError(`${message}${detail}`)
}

export function createAppContext(roots: AppRoots, selftest: boolean): AppContext {
  const ctx: AppContext = {
    roots,
    selftest,
    blockEditor: null,
    toolbar: null,
    homeScreen: null,
    contextMenu: null,
    searchPanel: null,
    // Assigned by `init` before any controller can be used.
    tabs: undefined as unknown as Tabs,
    documentZoom: DEFAULT_ZOOM,
    lastNativeTitle: '',
    updateView,
    updateTitle: () => updateTitle(ctx),
    updateStatus: () => updateStatus(ctx),
    renderModeChip: (mode) => renderModeChip(ctx, mode),
    afterActivate: () => afterActivate(ctx),
    syncDirty,
    syncMenuState: () => syncMenuState(ctx),
    flashStatus: (message) => flashStatus(ctx, message),
    reportError,
  }
  return ctx
}
