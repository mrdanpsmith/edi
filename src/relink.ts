import type { EditorState, Transaction } from 'prosemirror-state'
import type { Mark, Node as ProseNode } from 'prosemirror-model'
import { dirname } from './files'

/**
 * Keeping a moved document's relative references pointing where they did.
 *
 * A relative image or link resolves against the document's folder, so a
 * document moved to another folder would otherwise point at nothing (or at the
 * wrong file). A rename or move rewrites every relative reference the editor
 * models — an image's `src`, a link's `href` (and the reference it was read
 * from), and the link/image definitions kept as source blocks — so it names the
 * same file from the new folder. A reference to the document itself follows it
 * to its new name.
 *
 * Not rewritten: URLs (anything with a scheme), absolute paths, `#fragment`
 * links, and references inside what the editor keeps as opaque text — inline
 * HTML, tables' pipe source, code, diagrams and encrypted blocks.
 */

const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/

/** `/a/./b/../c` → `/a/c`; `null` for a path that climbs above the root. */
function normalize(path: string): string | null {
  const out: string[] = []
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (out.length === 0) return null
      out.pop()
    } else {
      out.push(segment)
    }
  }
  return `/${out.join('/')}`
}

/** The relative path from folder `from` to `to`; both absolute and normalized. */
function relativePath(from: string, to: string): string {
  const fromParts = from.split('/').filter(Boolean)
  const toParts = to.split('/').filter(Boolean)
  let common = 0
  while (common < fromParts.length && common < toParts.length && fromParts[common] === toParts[common]) common++
  const up = fromParts.slice(common).map(() => '..')
  return [...up, ...toParts.slice(common)].join('/') || '.'
}

/**
 * `ref` as written in the document at `fromPath`, rewritten to name the same
 * target from `toPath`. Anything that is not a relative path comes back as it
 * was, as does a reference whose target the move does not change.
 */
export function rebaseReference(ref: string, fromPath: string, toPath: string): string {
  if (!ref || ref.startsWith('/') || ref.startsWith('#') || ref.startsWith('?') || SCHEME.test(ref)) return ref
  const cut = ref.search(/[?#]/)
  const pathPart = cut >= 0 ? ref.slice(0, cut) : ref
  const suffix = cut >= 0 ? ref.slice(cut) : ''
  if (!pathPart) return ref
  let target = normalize(`${dirname(fromPath)}/${pathPart}`)
  if (target === null) return ref
  // A link to the document itself names it by its old name; it follows the move.
  if (target === normalize(fromPath)) target = normalize(toPath) ?? target
  let rebased = relativePath(normalize(dirname(toPath)) ?? '/', target)
  if (pathPart.endsWith('/') && !rebased.endsWith('/')) rebased += '/'
  // Keep a leading `./` the author wrote, where the new path still starts here.
  if (pathPart.startsWith('./') && !rebased.startsWith('.')) rebased = `./${rebased}`
  // Only the folder changed nothing about this one: keep the author's spelling.
  if (normalize(`${dirname(toPath)}/${rebased}`) === normalize(`${dirname(toPath)}/${pathPart}`)) return ref
  return rebased + suffix
}

/**
 * A link or image definition line: `[label]: destination "title"`. Footnote
 * definitions (`[^1]: …`) have text, not a destination, and are left alone.
 */
const DEFINITION = /^( {0,3}\[(?!\^)(?:[^\]\\]|\\.)+\]:[ \t]*)(<(?:[^>\\\n]|\\.)*>|[^\s<]\S*)/gm

/** A source block's markdown with each definition's destination rebased. */
export function rebaseDefinitions(markdown: string, fromPath: string, toPath: string): string {
  return markdown.replace(DEFINITION, (_whole, lead: string, destination: string) => {
    const bracketed = destination.startsWith('<')
    const inner = bracketed ? destination.slice(1, -1) : destination
    const rebased = rebaseReference(inner, fromPath, toPath)
    if (rebased === inner) return lead + destination
    return lead + (bracketed || /\s/.test(rebased) ? `<${rebased}>` : rebased)
  })
}

function rebasedLink(mark: Mark, fromPath: string, toPath: string): Mark | null {
  const href = (mark.attrs.href as string) ?? ''
  const reference = mark.attrs.reference as { type: string; label: string; url: string } | null
  const nextHref = rebaseReference(href, fromPath, toPath)
  const nextUrl = reference ? rebaseReference(reference.url, fromPath, toPath) : null
  if (nextHref === href && (!reference || nextUrl === reference.url)) return null
  return mark.type.create({
    ...mark.attrs,
    href: nextHref,
    reference: reference ? { ...reference, url: nextUrl } : null,
  })
}

/**
 * The transaction that rebases every relative reference in `state`'s document
 * from `fromPath` to `toPath`, or `null` when there is nothing to rewrite. It is
 * kept out of the undo history: undoing past it would only break the links again.
 */
export function rebaseLinksTransaction(state: EditorState, fromPath: string, toPath: string): Transaction | null {
  if (fromPath === toPath) return null
  const tr = state.tr
  let changed = false
  state.doc.descendants((node: ProseNode, pos: number) => {
    if (node.isInline) {
      for (const mark of node.marks) {
        if (mark.type.name !== 'link') continue
        const next = rebasedLink(mark, fromPath, toPath)
        if (!next) continue
        tr.removeMark(pos, pos + node.nodeSize, mark).addMark(pos, pos + node.nodeSize, next)
        changed = true
      }
    }
    if (node.type.name === 'image') {
      const src = (node.attrs.src as string) ?? ''
      const next = rebaseReference(src, fromPath, toPath)
      if (next !== src) {
        // Read the node back from `tr`: its marks may just have been rewritten.
        const current = tr.doc.nodeAt(pos)!
        const reference = current.attrs.reference as { url: string } | null
        tr.setNodeMarkup(
          pos,
          undefined,
          {
            ...current.attrs,
            src: next,
            // Its definition moves with it, so it stays a reference.
            reference: reference ? { ...reference, url: rebaseReference(reference.url, fromPath, toPath) } : null,
          },
          current.marks,
        )
        changed = true
      }
    } else if (node.type.name === 'source_block') {
      const markdown = (node.attrs.markdown as string) ?? ''
      const next = rebaseDefinitions(markdown, fromPath, toPath)
      if (next !== markdown) {
        tr.setNodeMarkup(pos, undefined, { ...node.attrs, markdown: next })
        changed = true
      }
    }
    return true
  })
  return changed ? tr.setMeta('addToHistory', false) : null
}
