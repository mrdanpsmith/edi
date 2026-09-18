/**
 * Editor plugin that compiles document-local formula definitions.
 *
 * Any `code_block` whose language is `edi-formula` contributes function
 * definitions (see `formulaDsl.ts`). The plugin keeps a compiled `FormulaEnv`
 * in its state so the spreadsheet table node view, the formula reference, and
 * autocomplete all see the same set of functions, and it decorates definition
 * blocks that failed validation with an inline error class.
 */
import { Plugin, PluginKey, type EditorState } from 'prosemirror-state'
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view'
import type { Node as ProseNode } from 'prosemirror-model'
import { BUILTIN_ENV, buildFunctionMap, type FormulaEnv, type FormulaFunction } from './formulas'
import { buildDocumentFunctions, type FormulaDefIssue } from './formulaDsl'

export const FORMULA_DEF_LANGUAGE = 'edi-formula'

export interface FormulaDefsState {
  env: FormulaEnv
  functions: readonly FormulaFunction[]
  issues: readonly FormulaDefIssue[]
}

export const formulaDefsKey = new PluginKey<FormulaDefsState>('EDI_FORMULA_DEFS')

const EMPTY_STATE: FormulaDefsState = {
  env: BUILTIN_ENV,
  functions: [],
  issues: [],
}

interface SourceBlock {
  from: number
  to: number
  source: string
}

export function collectFormulaBlocks(doc: ProseNode): SourceBlock[] {
  const blocks: SourceBlock[] = []
  doc.descendants((node, pos) => {
    if (node.type.name === 'code_block' && node.attrs['language'] === FORMULA_DEF_LANGUAGE) {
      blocks.push({ from: pos, to: pos + node.nodeSize, source: node.textContent })
    }
    return true
  })
  return blocks
}

export function buildFormulaDefsState(doc: ProseNode): FormulaDefsState {
  const blocks = collectFormulaBlocks(doc)
  if (blocks.length === 0) return EMPTY_STATE
  const { functions, issues } = buildDocumentFunctions(blocks.map((block) => block.source))
  return { env: { functions: buildFunctionMap(functions) }, functions, issues }
}

function buildDecorations(doc: ProseNode, state: FormulaDefsState): DecorationSet | null {
  if (state.issues.length === 0) return null
  const bySource = new Map<number, string[]>()
  for (const issue of state.issues) {
    const messages = bySource.get(issue.sourceIndex) ?? []
    messages.push(`line ${issue.line}: ${issue.message}`)
    bySource.set(issue.sourceIndex, messages)
  }
  const blocks = collectFormulaBlocks(doc)
  const decorations: Decoration[] = []
  for (const [sourceIndex, messages] of bySource) {
    const block = blocks[sourceIndex]
    if (!block) continue
    decorations.push(
      Decoration.node(block.from, block.to, {
        class: 'edi-formula-invalid',
        title: `Invalid formula definition — ${messages.join('; ')}`,
      }),
    )
  }
  return DecorationSet.create(doc, decorations)
}

const envListeners = new WeakMap<EditorView, Set<() => void>>()

export const formulaDefsPlugin = new Plugin<FormulaDefsState>({
  key: formulaDefsKey,
  state: {
    init: (_config, state) => buildFormulaDefsState(state.doc),
    apply: (tr, value) => (tr.docChanged ? buildFormulaDefsState(tr.doc) : value),
  },
  props: {
    decorations(state) {
      const value = formulaDefsKey.getState(state)
      return value ? buildDecorations(state.doc, value) : null
    },
  },
  view() {
    return {
      update(view, prevState) {
        if (formulaDefsKey.getState(view.state) === formulaDefsKey.getState(prevState)) return
        const listeners = envListeners.get(view)
        if (!listeners) return
        for (const listener of [...listeners]) listener()
      },
    }
  },
})

/** Subscribe to document-function changes for one editor view. The returned
 * function unsubscribes. Node views that render formula values use this to
 * recompute when an `edi-formula` block is edited. */
export function subscribeFormulaEnv(view: EditorView, listener: () => void): () => void {
  let listeners = envListeners.get(view)
  if (!listeners) {
    listeners = new Set()
    envListeners.set(view, listeners)
  }
  listeners.add(listener)
  return () => {
    listeners!.delete(listener)
    if (listeners!.size === 0) envListeners.delete(view)
  }
}

/** Compiled environment for the document in `state`, builtins included. */
export function formulaEnvFor(state: EditorState): FormulaEnv {
  return formulaDefsKey.getState(state)?.env ?? BUILTIN_ENV
}

/** Document-local functions (excluding builtins) defined in `state`. */
export function documentFunctionsFor(state: EditorState): readonly FormulaFunction[] {
  return formulaDefsKey.getState(state)?.functions ?? []
}
