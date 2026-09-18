import { describe, expect, it } from 'vitest'
import { EditorState } from 'prosemirror-state'
import type { DecorationSet } from 'prosemirror-view'

import { schema } from './schema'
import { markdownToProse, proseToMarkdown } from './markdown'
import { applyFunction, num } from './formulas'
import {
  buildFormulaDefsState,
  collectFormulaBlocks,
  documentFunctionsFor,
  formulaDefsKey,
  formulaDefsPlugin,
  formulaEnvFor,
} from './formulaDefs'

function stateFrom(markdown: string): EditorState {
  return EditorState.create({
    doc: markdownToProse(markdown, schema),
    plugins: [formulaDefsPlugin],
  })
}

function decorationsOf(state: EditorState): DecorationSet | null {
  const source = formulaDefsPlugin.props.decorations as (
    state: EditorState,
  ) => DecorationSet | null
  return source(state)
}

describe('formulaDefsPlugin', () => {
  it('compiles an edi-formula block into the document environment', () => {
    const state = stateFrom('```edi-formula\nMYAVG(a, b) = (a + b) / 2\n```')
    expect(formulaEnvFor(state).functions.get('MYAVG')).toBeDefined()
    expect(applyFunction('MYAVG', [num(1), num(3)], formulaEnvFor(state))).toEqual(num(2))
  })

  it('keeps builtins available alongside document functions', () => {
    const state = stateFrom('```edi-formula\nDOUBLE(x) = x * 2\n```')
    expect(formulaEnvFor(state).functions.get('SUM')).toBeDefined()
    expect(documentFunctionsFor(state).map((f) => f.name)).toEqual(['DOUBLE'])
  })

  it('ignores code blocks tagged with other languages', () => {
    const state = stateFrom('```js\nSUM(x) = x\n```')
    expect(formulaEnvFor(state).functions.get('SUM')).toBeDefined()
    expect(documentFunctionsFor(state)).toEqual([])
    expect(formulaDefsKey.getState(state)!.issues).toEqual([])
  })

  it('collects every edi-formula block in the document', () => {
    const doc = markdownToProse(
      '```edi-formula\nA(x) = x\n```\n\n```edi-formula\nB(x) = x\n```',
      schema,
    )
    expect(collectFormulaBlocks(doc).map((b) => b.source)).toEqual(['A(x) = x', 'B(x) = x'])
  })

  it('decorates a block whose definitions are rejected', () => {
    const state = stateFrom('```edi-formula\nSUM(x) = x\n```')
    const value = formulaDefsKey.getState(state)!
    expect(value.issues).toHaveLength(1)

    const decorations = decorationsOf(state)
    expect(decorations).not.toBeNull()
    const classes = decorations!
      .find()
      .map((d) => (d as unknown as { type: { attrs: Record<string, string> } }).type.attrs['class'])
    expect(classes).toContain('edi-formula-invalid')
  })

  it('adds no decorations when every definition is valid', () => {
    const state = stateFrom('```edi-formula\nDOUBLE(x) = x * 2\n```')
    expect(decorationsOf(state)).toBeNull()
  })

  it('recomputes the environment when the document changes', () => {
    const first = stateFrom('```edi-formula\nA(x) = x\n```')
    expect(formulaEnvFor(first).functions.get('B')).toBeUndefined()
    const doc = markdownToProse('```edi-formula\nB(x) = x\n```', schema)
    const next = first.apply(first.tr.replaceWith(0, first.doc.content.size, doc.content))
    expect(formulaEnvFor(next).functions.get('B')).toBeDefined()
    expect(formulaEnvFor(next).functions.get('A')).toBeUndefined()
  })
})

describe('document functions in resolved tables', () => {
  it('serializes computed values using document definitions', () => {
    const markdown = [
      '```edi-formula',
      'DOUBLE(x) = x * 2',
      '```',
      '',
      '| A | B |',
      '| --- | --- |',
      '| 5 | =DOUBLE(A2) |',
    ].join('\n')
    const doc = markdownToProse(markdown, schema)
    const env = buildFormulaDefsState(doc).env

    const children: import('prosemirror-model').Node[] = []
    doc.forEach((child) => children.push(child))
    const resolved = children.map((child) =>
      child.type.name === 'table'
        ? schema.node('table', { value: child.attrs.value, _resolved: true })
        : child,
    )
    const out = proseToMarkdown(schema.node('doc', {}, resolved), env)
    expect(out).toContain('| 5 | 10 |')
  })
})
