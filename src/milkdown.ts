import { Editor, editorViewCtx, parserCtx, rootCtx } from '@milkdown/core'
import type { Ctx } from '@milkdown/ctx'
import { listener, listenerCtx } from '@milkdown/plugin-listener'
import { commonmark } from '@milkdown/preset-commonmark'
import { gfm } from '@milkdown/preset-gfm'

export type Mode = 'visual' | 'text'

export interface EdiEditor {
  mount(container: HTMLElement): Promise<void>
  unmount(): Promise<void>
  getMarkdown(): string
  setMarkdown(markdown: string): Promise<void>
  getView(): import('@milkdown/prose/view').EditorView | null
  isMounted(): boolean
  onChange(callback: (markdown: string) => void): void
  onMounted(callback: () => void): void
}

export function createEdiEditor(): EdiEditor {
  let editor: Editor | null = null
  let mounted = false
  let changeCallback: ((markdown: string) => void) | null = null
  let mountedCallback: (() => void) | null = null
  let suppressUpdates = false
  let latestMarkdown = ''
  let rootElement: HTMLElement | null = null

  async function mount(container: HTMLElement): Promise<void> {
    if (mounted) return
    rootElement = container

    editor = Editor.make()
      .config((ctx: Ctx) => {
        ctx.set(rootCtx, container)
      })
      .config((ctx: Ctx) => {
        const mgr = ctx.get(listenerCtx)
        mgr.markdownUpdated((_ctx: Ctx, markdown: string) => {
          latestMarkdown = markdown
          if (!suppressUpdates) {
            changeCallback?.(markdown)
          }
        })
      })
      .use(commonmark)
      .use(gfm)
      .use(listener)

    await editor.create()
    mounted = true
    mountedCallback?.()
  }

  async function unmount(): Promise<void> {
    if (!editor || !mounted) return
    await editor.destroy()
    editor = null
    mounted = false
  }

  function getMarkdown(): string {
    return latestMarkdown
  }

  async function setMarkdown(markdown: string): Promise<void> {
    latestMarkdown = markdown
    if (!editor || !mounted || !rootElement) return

    suppressUpdates = true
    try {
      editor.action((ctx: Ctx) => {
        const view = ctx.get(editorViewCtx)
        const parse = ctx.get(parserCtx)
        const doc = parse(markdown)
        view.dispatch(view.state.tr.replaceWith(0, view.state.doc.content.size, doc.content))
      })
    } finally {
      suppressUpdates = false
    }
  }

  function getView(): import('@milkdown/prose/view').EditorView | null {
    if (!editor || !mounted) return null
    try {
      return editor.action((ctx: Ctx) => ctx.get(editorViewCtx))
    } catch {
      return null
    }
  }

  function isMounted(): boolean {
    return mounted
  }

  function onChange(callback: (markdown: string) => void): void {
    changeCallback = callback
  }

  function onMounted(callback: () => void): void {
    mountedCallback = callback
  }

  return {
    mount,
    unmount,
    getMarkdown,
    setMarkdown,
    getView,
    isMounted,
    onChange,
    onMounted,
  }
}
