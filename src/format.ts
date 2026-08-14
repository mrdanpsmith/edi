import type { EditorView } from '@codemirror/view'

export interface FormatEdit {
  from: number
  to: number
  insert: string
  selectionFrom: number
  selectionTo: number
}

export type FormatFn = (doc: string, from: number, to: number) => FormatEdit

export function applyFormatEdit(view: EditorView, edit: FormatEdit): void {
  view.dispatch({
    changes: { from: edit.from, to: edit.to, insert: edit.insert },
    selection: { anchor: edit.selectionFrom, head: edit.selectionTo },
  })
}

export function runFormat(view: EditorView, fn: FormatFn): boolean {
  const { from, to } = view.state.selection.main
  applyFormatEdit(view, fn(view.state.doc.toString(), from, to))
  return true
}

function lineStart(doc: string, pos: number): number {
  if (pos > 0 && doc.charCodeAt(pos - 1) === 10) {
    return pos
  }
  return doc.lastIndexOf('\n', pos - 1) + 1
}

function lineEnd(doc: string, pos: number): number {
  const nl = doc.indexOf('\n', pos)
  return nl === -1 ? doc.length : nl
}

function blockRange(doc: string, from: number, to: number): { start: number; end: number } {
  const start = lineStart(doc, from)
  const contentEnd = to > 0 && doc.charCodeAt(to - 1) === 10 ? to - 1 : to
  return { start, end: lineEnd(doc, Math.max(start, contentEnd)) }
}

function trimSelection(doc: string, from: number, to: number): { start: number; end: number } {
  let start = from
  while (start < to && doc.charCodeAt(start) === 10) {
    start++
  }
  let end = to
  while (end > start && doc.charCodeAt(end - 1) === 10) {
    end--
  }
  return { start, end }
}

export function toggleInline(doc: string, from: number, to: number, marker: string): FormatEdit {
  const { start, end } = trimSelection(doc, from, to)
  if (start === end) {
    return {
      from,
      to,
      insert: marker + marker,
      selectionFrom: from + marker.length,
      selectionTo: from + marker.length,
    }
  }
  const selected = doc.slice(start, end)
  if (selected.startsWith(marker) && selected.endsWith(marker) && selected.length >= marker.length * 2) {
    const inner = selected.slice(marker.length, selected.length - marker.length)
    return { from: start, to: end, insert: inner, selectionFrom: start, selectionTo: start + inner.length }
  }
  return {
    from: start,
    to: end,
    insert: marker + selected + marker,
    selectionFrom: start + marker.length,
    selectionTo: end + marker.length,
  }
}

export function toggleBold(doc: string, from: number, to: number): FormatEdit {
  return toggleInline(doc, from, to, '**')
}

export function toggleItalic(doc: string, from: number, to: number): FormatEdit {
  return toggleInline(doc, from, to, '*')
}

export function toggleStrikethrough(doc: string, from: number, to: number): FormatEdit {
  return toggleInline(doc, from, to, '~~')
}

function fencedInner(selected: string): string | null {
  const fence = '```'
  if (!selected.startsWith(fence)) {
    return null
  }
  const firstNl = selected.indexOf('\n', fence.length)
  if (firstNl === -1) {
    return null
  }
  const open = selected.slice(0, firstNl + 1)
  const close = `\n${fence}`
  if (!selected.endsWith(close) || selected.length <= open.length + close.length) {
    return null
  }
  return selected.slice(open.length, selected.length - close.length)
}

export function toggleCode(doc: string, from: number, to: number): FormatEdit {
  const { start, end } = trimSelection(doc, from, to)
  if (start === end) {
    return { from, to, insert: '``', selectionFrom: from + 1, selectionTo: from + 1 }
  }
  const selected = doc.slice(start, end)
  if (!selected.includes('\n')) {
    if (selected.startsWith('`') && selected.endsWith('`') && selected.length >= 2) {
      const inner = selected.slice(1, selected.length - 1)
      return { from: start, to: end, insert: inner, selectionFrom: start, selectionTo: start + inner.length }
    }
    return {
      from: start,
      to: end,
      insert: `\`${selected}\``,
      selectionFrom: start + 1,
      selectionTo: end + 1,
    }
  }
  const inner = fencedInner(selected)
  if (inner !== null) {
    return { from: start, to: end, insert: inner, selectionFrom: start, selectionTo: start + inner.length }
  }
  const fence = '```'
  const open = `${fence}\n`
  const close = `\n${fence}`
  return {
    from: start,
    to: end,
    insert: `${open}${selected}${close}`,
    selectionFrom: start + open.length,
    selectionTo: end + open.length,
  }
}

export function toggleCodeBlock(doc: string, from: number, to: number): FormatEdit {
  const { start, end } = trimSelection(doc, from, to)
  if (start === end) {
    const fence = '```'
    const open = `${fence}\n`
    const placeholder = 'code'
    const padBefore = start > 0 && doc.charCodeAt(start - 1) !== 10 ? '\n' : ''
    const padAfter = end < doc.length && doc.charCodeAt(end) !== 10 ? '\n' : ''
    const insert = `${padBefore}${open}${placeholder}\n${fence}${padAfter}`
    const contentStart = start + padBefore.length + open.length
    return {
      from: start,
      to: end,
      insert,
      selectionFrom: contentStart,
      selectionTo: contentStart + placeholder.length,
    }
  }
  const inner = fencedInner(doc.slice(start, end))
  if (inner !== null) {
    return { from: start, to: end, insert: inner, selectionFrom: start, selectionTo: start + inner.length }
  }
  const selected = doc.slice(start, end)
  const fence = '```'
  const open = `${fence}\n`
  const close = `\n${fence}`
  return {
    from: start,
    to: end,
    insert: `${open}${selected}${close}`,
    selectionFrom: start + open.length,
    selectionTo: end + open.length,
  }
}

export function toggleLinePrefixes(
  doc: string,
  from: number,
  to: number,
  prefix: (index: number) => string,
  placeholder?: string,
): FormatEdit {
  const { start, end } = blockRange(doc, from, to)
  if (from === to && placeholder !== undefined && doc.slice(start, end).trim() === '') {
    const marker = prefix(0)
    const insert = `${marker}${placeholder}`
    return {
      from: start,
      to: end,
      insert,
      selectionFrom: start + marker.length,
      selectionTo: start + insert.length,
    }
  }
  const lines = doc.slice(start, end).split('\n')
  const prefixes = lines.map((line, index) => (line.length === 0 ? '' : prefix(index)))
  const allPrefixed = lines.every((line, index) => (line.length === 0 ? true : line.startsWith(prefixes[index])))
  const insert = allPrefixed
    ? lines.map((line, index) => (line.length === 0 ? line : line.slice(prefixes[index].length))).join('\n')
    : lines.map((line, index) => (line.length === 0 ? line : prefixes[index] + line)).join('\n')
  return { from: start, to: end, insert, selectionFrom: start, selectionTo: start + insert.length }
}

export function toggleHeading(doc: string, from: number, to: number, level: number): FormatEdit {
  const prefix = `${'#'.repeat(level)} `
  return toggleLinePrefixes(doc, from, to, () => prefix, level === 1 ? 'Heading 1' : 'Heading 2')
}

export function toggleBlockquote(doc: string, from: number, to: number): FormatEdit {
  return toggleLinePrefixes(doc, from, to, () => '> ', 'quote')
}

export function toggleUnorderedList(doc: string, from: number, to: number): FormatEdit {
  return toggleLinePrefixes(doc, from, to, () => '- ', 'item')
}

export function toggleOrderedList(doc: string, from: number, to: number): FormatEdit {
  return toggleLinePrefixes(doc, from, to, (index) => `${index + 1}. `, 'item')
}

export function toggleTaskList(doc: string, from: number, to: number): FormatEdit {
  return toggleLinePrefixes(doc, from, to, () => '- [ ] ', 'task')
}

export function insertLink(doc: string, from: number, to: number): FormatEdit {
  const { start, end } = trimSelection(doc, from, to)
  const label = doc.slice(start, end) || 'text'
  const placeholder = 'https://'
  const urlStart = start + label.length + 3
  return {
    from: start,
    to: end,
    insert: `[${label}](${placeholder})`,
    selectionFrom: urlStart,
    selectionTo: urlStart + placeholder.length,
  }
}

export function insertHorizontalRule(doc: string, from: number, to: number): FormatEdit {
  const padBefore = from > 0 && doc.charCodeAt(from - 1) !== 10 ? '\n' : ''
  const padAfter = to < doc.length && doc.charCodeAt(to) !== 10 ? '\n' : ''
  const insert = `${padBefore}---${padAfter}`
  const selectionFrom = from + padBefore.length + 3
  return {
    from,
    to,
    insert,
    selectionFrom,
    selectionTo: selectionFrom,
  }
}
