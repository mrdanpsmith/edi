import { Editor, commandsCtx, editorViewCtx, parserCtx, rootCtx } from '@milkdown/core'
import type { Ctx } from '@milkdown/ctx'
import { listener, listenerCtx } from '@milkdown/plugin-listener'
import { commonmark } from '@milkdown/preset-commonmark'
import {
  schema as gfmSchema,
  inputRules as gfmInputRules,
  pasteRules as gfmPasteRules,
  markInputRules as gfmMarkInputRules,
  keymap as gfmKeymap,
  commands as gfmCommands,
  keepTableAlignPlugin,
  autoInsertSpanPlugin,
  tableEditingPlugin,
} from '@milkdown/preset-gfm'
import { $prose, $remark } from '@milkdown/utils'
import remarkGFM from 'remark-gfm'
import { highlight } from './remark/highlight'
import { subscript } from './remark/sub'
import { superscript } from './remark/sup'
import {
  remarkDeflistPlugin,
  descriptionListSchema,
  descriptionTermSchema,
  descriptionDetailsSchema,
} from './remark/deflist'
import { mermaidRemark, mermaidSchema, mermaidNodeView } from './node/mermaid'
import { execRemark, execSchema, execNodeView } from './node/execblock'
import { spreadsheetPlugin } from './node/spreadsheet'
import { Plugin, PluginKey } from '@milkdown/prose/state'
import type { EditorView } from '@milkdown/prose/view'

const taskTogglePlugin = $prose(() => {
  return new Plugin({
    key: new PluginKey('MILKDOWN_TASK_TOGGLE'),
    props: {
      handleClick(view: EditorView, pos: number, event: MouseEvent) {
        const target = event.target as HTMLElement
        const li = target.closest('li[data-item-type="task"]')
        if (!li) return false

        const $pos = view.state.doc.resolve(pos)
        let depth = $pos.depth
        while (depth > 0 && $pos.node(depth).type.name !== 'list_item') {
          depth--
        }
        if (depth === 0) return false
        const node = $pos.node(depth)
        if (node.type.name !== 'list_item') return false

        const tr = view.state.tr.setNodeAttribute(
          $pos.before(depth),
          'checked',
          !(node.attrs.checked as boolean),
        )
        view.dispatch(tr)

        const newChecked = !(node.attrs.checked as boolean)
        li.setAttribute('data-checked', String(newChecked))
        return true
      },
    },
  })
})

export interface EdiEditor {
  mount(container: HTMLElement): Promise<void>
  unmount(): Promise<void>
  getMarkdown(): string
  getHtml(): string
  setMarkdown(markdown: string): Promise<void>
  getView(): import('@milkdown/prose/view').EditorView | null
  isMounted(): boolean
  runCommand(name: string, payload?: unknown): boolean
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
      .use([
        gfmSchema,
        gfmInputRules,
        gfmPasteRules,
        gfmMarkInputRules,
        gfmKeymap,
        gfmCommands,
        keepTableAlignPlugin,
        autoInsertSpanPlugin,
        tableEditingPlugin,
      ].flat())
      .use($remark('remarkGfmNoSingleTilde', () => remarkGFM as never, { singleTilde: false }))
      .use(highlight.remark)
      .use(subscript.remark)
      .use(superscript.remark)
      .use(remarkDeflistPlugin)
      .use(mermaidRemark)
      .use(execRemark)
      .use(highlight.schema)
      .use(subscript.schema)
      .use(superscript.schema)
      .use(descriptionListSchema)
      .use(descriptionTermSchema)
      .use(descriptionDetailsSchema)
      .use(mermaidSchema)
      .use(execSchema)
      .use(highlight.command)
      .use(subscript.command)
      .use(superscript.command)
      .use(highlight.inputRule)
      .use(subscript.inputRule)
      .use(superscript.inputRule)
      .use(mermaidNodeView)
      .use(execNodeView)
      .use(spreadsheetPlugin)
      .use(taskTogglePlugin)
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

  function getHtml(): string {
    if (!rootElement) return ''
    const editor = rootElement.querySelector<HTMLElement>('.editor')
    return editor?.innerHTML ?? ''
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

  function runCommand(name: string, payload?: unknown): boolean {
    if (!editor || !mounted) return false
    try {
      return editor.action((ctx: Ctx) => ctx.get(commandsCtx).call(name, payload))
    } catch {
      return false
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
    getHtml,
    setMarkdown,
    getView,
    isMounted,
    runCommand,
    onChange,
    onMounted,
  }
}
