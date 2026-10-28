import { cellKey, type CellRef, type FillRect } from './tableShared'

/**
 * The sheet's selection: an anchor, the active cell it was dragged to, and any
 * ctrl-clicked cells outside that rectangle. Pure data and range queries — it
 * knows nothing about the DOM, the document or which cells exist beyond the
 * dimensions it is handed.
 */
export class TableSelection {
  anchor: CellRef | null = null
  active: CellRef | null = null
  extra = new Set<string>()

  set(anchor: CellRef, active: CellRef): void {
    this.anchor = anchor
    this.active = active
  }

  collapse(ref: CellRef): void {
    this.anchor = { ...ref }
    this.active = { ...ref }
    this.extra.clear()
  }

  /** Keep the current anchor and move the active end, as Shift+click does. */
  extendTo(ref: CellRef): void {
    if (this.anchor === null) this.anchor = { ...ref }
    this.active = { ...ref }
    this.extra.clear()
  }

  /** Move the whole selection to one cell, or extend it from the anchor. */
  moveTo(ref: CellRef, extend: boolean): void {
    if (extend) {
      this.extendTo(ref)
      return
    }
    this.collapse(ref)
  }

  /** Add or remove a ctrl-clicked cell, keeping the rectangle selection. */
  toggleExtra(ref: CellRef): void {
    const key = cellKey(ref.row, ref.col)
    if (this.extra.has(key)) this.extra.delete(key)
    else this.extra.add(key)
  }

  contains(row: number, col: number): boolean {
    if (this.extra.has(cellKey(row, col))) return true
    const { anchor, active } = this
    if (anchor === null || active === null) return false
    return (
      row >= Math.min(anchor.row, active.row) &&
      row <= Math.max(anchor.row, active.row) &&
      col >= Math.min(anchor.col, active.col) &&
      col <= Math.max(anchor.col, active.col)
    )
  }

  collect(rows: number, cols: number): CellRef[] {
    const out: CellRef[] = []
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (this.contains(r, c)) out.push({ row: r, col: c })
      }
    }
    return out
  }

  selectedCols(rows: number, cols: number): Set<number> {
    const out = new Set<number>()
    for (let c = 0; c < cols; c++) {
      let full = true
      for (let r = 0; r < rows; r++) {
        if (!this.contains(r, c)) {
          full = false
          break
        }
      }
      if (full) out.add(c)
    }
    return out
  }

  selectedRows(rows: number, cols: number): Set<number> {
    const out = new Set<number>()
    for (let r = 0; r < rows; r++) {
      let full = true
      for (let c = 0; c < cols; c++) {
        if (!this.contains(r, c)) {
          full = false
          break
        }
      }
      if (full) out.add(r)
    }
    return out
  }

  /** The un-extended rectangle between anchor and active, if both exist. */
  rect(): FillRect | null {
    const { anchor, active } = this
    if (anchor === null || active === null) return null
    return {
      sr1: Math.min(anchor.row, active.row),
      sc1: Math.min(anchor.col, active.col),
      sr2: Math.max(anchor.row, active.row),
      sc2: Math.max(anchor.col, active.col),
      r1: Math.min(anchor.row, active.row),
      c1: Math.min(anchor.col, active.col),
      r2: Math.max(anchor.row, active.row),
      c2: Math.max(anchor.col, active.col),
    }
  }

  /** The bounding box of every selected cell, extras included. */
  bounds(): { r1: number; c1: number; r2: number; c2: number } | null {
    let r1 = Infinity
    let c1 = Infinity
    let r2 = -Infinity
    let c2 = -Infinity
    if (this.anchor !== null && this.active !== null) {
      r1 = Math.min(this.anchor.row, this.active.row)
      c1 = Math.min(this.anchor.col, this.active.col)
      r2 = Math.max(this.anchor.row, this.active.row)
      c2 = Math.max(this.anchor.col, this.active.col)
    }
    for (const key of this.extra) {
      const [row, col] = key.split(':').map(Number)
      r1 = Math.min(r1, row!)
      c1 = Math.min(c1, col!)
      r2 = Math.max(r2, row!)
      c2 = Math.max(c2, col!)
    }
    if (!Number.isFinite(r1)) return null
    return { r1, c1, r2, c2 }
  }

  selectAll(rows: number, cols: number): void {
    this.anchor = { row: 0, col: 0 }
    this.active = { row: Math.max(0, rows - 1), col: Math.max(0, cols - 1) }
    this.extra.clear()
  }

  /** Clamp the selection to a grid that just changed size. */
  clamp(rows: number, cols: number): void {
    if (this.anchor !== null) {
      this.anchor = {
        row: Math.min(this.anchor.row, rows - 1),
        col: Math.max(0, Math.min(this.anchor.col, cols - 1)),
      }
    }
    if (this.active !== null) {
      this.active = {
        row: Math.min(this.active.row, rows - 1),
        col: Math.max(0, Math.min(this.active.col, cols - 1)),
      }
    }
    this.extra.clear()
  }
}
