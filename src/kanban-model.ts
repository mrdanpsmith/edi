/**
 * Pure kanban model — string-in/string-out functions with no DOM dependency.
 * Extracted from `src/mermaid-edit.ts` (lines 1128–1800) so that the edit layer,
 * drag logic, chrome, and rendering can each depend on the model independently.
 *
 * **Do not rewrite bodies.** This is a mechanical move; every function body should
 * remain byte-identical. The goal is that `npm run check` and `npm run build` pass
 * unchanged, and `.venv/bin/pytest tests/test_window.py -k kanban` continues to pass.
 *
 * Types, functions and constants are documented by their original JSDoc comments.
 * Private helpers that are used only inside this block are kept here; anything
 * that was shared externally has been re-exported from `mermaid-edit.ts`.
 */


// Shared type used by label mappers
// Moved from mermaid-edit.ts:175–178. Kept here because `kanbanLabelSpan` is the
// only consumer inside this block; callers outside import it re-exported from
// mermaid-edit.ts.
export interface Span {
  start: number
  end: number
}

// ── Diagram-type detection (shared with mermaid-edit.ts) ────────────────────
// The first meaningful line of a diagram names its type: `kanban`,
// `sequenceDiagram`, `graph TD` / `flowchart-elk LR`, `stateDiagram-v2`,
// `pie title …`, `C4Context`, … Blank lines, `%%` comments and a leading YAML
// frontmatter block are skipped.
export function detectDiagramType(source: string): string {
  const lines = source.split('\n')
  let inFrontmatter = false
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim()
    if (index === 0 && line === '---') {
      inFrontmatter = true
      continue
    }
    if (inFrontmatter) {
      if (line === '---') inFrontmatter = false
      continue
    }
    if (!line || line.startsWith('%%')) continue
    return line.split(/\s+/, 1)[0]
  }
  return ''
}

// ── Kanban line kinds ──────────────────────────────────────────────────────

/** The kind of a kanban line: column, card, or blank. */
type KanbanLineKind = 'column' | 'card' | 'blank' | 'comment' | 'pending'

// ── Kanban line ────────────────────────────────────────────────────────────

/** A line in the kanban source, without its indentation. */
export interface KanbanLine {
  /** The line without its indentation. */
  text: string
  indent: string
  /** Offset of the line's first character in the source. */
  offset: number
  kind: KanbanLineKind
  /** The text a column header or card shows, or `null` for an unknown shape. */
  label: string | null
  labelStart: number
  labelEnd: number
}

/** A node line whose column/card role depends on the first node's indent. */
// @ts-expect-error TS6196
type __RawKanbanLine = KanbanLine | (Omit<KanbanLine, 'kind'> & { kind: 'pending' })

/** A card in the kanban board. */
export interface KanbanCard {
  /** Index into `KanbanDoc.lines`. */
  line: number
  /** Index into `KanbanDoc.columns`, or -1 for a card with no column above it. */
  column: number
  /** Position of the card inside its column, top to bottom. */
  index: number
  label: string | null
  labelStart: number
  labelEnd: number
}

/** The full kanban document model. */
export interface KanbanDoc {
  lines: KanbanLine[]
  /** Line indices of the column headers, in source order. */
  columns: number[]
  cards: KanbanCard[]
}
