import type { DiagramSession, RenderScope } from './mermaid-session'
import { effectiveZoom } from './zoom'
import {
  ADD_SLOT_CLASS,
  COLUMN_SLOT_CLASS,
  EDITABLE_CLASS,
  KANBAN_BIN_SLOT_CLASS,
  KANBAN_BUTTON_CLASS,
  KANBAN_BUTTON_EDGE,
  KANBAN_BUTTON_HALF,
  KANBAN_CHROME_CLASS,
  MENU_BUTTON_CLASS,
  MENU_ITEM_CLASS,
  MENU_ITEM_DANGER_CLASS,
  MENU_ITEM_KIND_CLASS,
  MENU_LIST_CLASS,
  MENU_WIDTH,
  confirmThen,
  drawnElementAt,
  sectionRect,
  indexOfLabel,
  labelElementIn,
  contains,
  editCardTitle,
  editColumnName,
} from './mermaid-edit'
import type { ChromeBox } from './mermaid-edit'
import {
  findKanbanItem,
  isKanbanCardSlot,
  kanbanColumnCount,
  kanbanItemKey,
  removeKanbanColumn,
} from './kanban-model'
import type { KanbanDoc } from './kanban-model'
import { bandHeaderIn } from './mermaid-dom'

// moved verbatim from mermaid-edit.ts
export function attachKanbanChrome(session: DiagramSession, scope: RenderScope): () => void {
  const { cards, sections, slots } = scope
  const doc = scope.model as KanbanDoc
  // A model that does not line up with the DOM would put a control on a card the
  // user did not press, or offer to delete a neighbour of the one they pressed,
  // and there is no rendering to compare against.
  if (doc.columns.length === 0 || doc.columns.length !== sections.length || doc.cards.length !== cards.length) {
    return () => undefined
  }
  const container = session.preview
  const slotColumn = slots?.column ?? -1

  const columnName = (column: number): string => doc.lines[doc.columns[column]]?.label ?? 'this column'
  /** How many *cards* a column holds: a drawn slot is a place, not one of them. */
  const cardsIn = (column: number): number =>
    doc.cards.filter((card) => card.column === column && !isKanbanCardSlot(card, doc)).length
  /** Where the header of a column is, as an index into the render's labels. */
  const headerOf = (band: Element): number => indexOfLabel(scope, labelElementIn(bandHeaderIn(band) ?? band))

  const layer = document.createElement('div')
  layer.className = KANBAN_CHROME_CLASS
  container.appendChild(layer)
  const unplaced: Array<() => void> = []

  /**
   * One board control, with the event guards every one of them needs: a press
   * must not reach ProseMirror (it would start a node selection), the drag (it
   * hit-tests cards by coordinate and would arm over a card a control sits on) or
   * the click that opens a label's editor.
   */
  const control = (
    kind: string,
    text: string,
    label: string,
    box: () => ChromeBox,
    onClick: () => void,
  ): HTMLButtonElement => {
    const element = document.createElement('button')
    element.type = 'button'
    element.className = `${KANBAN_BUTTON_CLASS} ${kind}`
    element.textContent = text
    element.title = label
    element.setAttribute('aria-label', label)
    element.addEventListener('click', (event) => {
      event.stopPropagation()
      onClick()
    })
    element.addEventListener('mousedown', (event) => {
      event.preventDefault()
      event.stopPropagation()
    })
    element.addEventListener('pointerdown', (event) => event.stopPropagation())
    layer.appendChild(element)
    unplaced.push(session.overlay(element, box))
    return element
  }

  // ── the ⋯ menu ──
  //
  // One at a time, and one per diagram: a board is not a toolbar, and two open
  // menus over it say nothing about either. The list is a positioned sibling of
  // the svg like every other control, so it is chrome too — the double click
  // that ends an edit session must not land inside it.
  let closeMenu: (() => void) | null = null
  // Which `⋯` the open menu belongs to, so pressing *that* one is the toggle and
  // pressing any other is a move: without it, a second `⋯` could only ever close
  // the first menu, and opening a second one took two presses.
  let openMenuFor: HTMLButtonElement | null = null
  const dismissMenu = (): void => {
    closeMenu?.()
    closeMenu = null
    openMenuFor = null
  }

  const menuItem = (text: string, kind: string, danger: boolean, run: () => void | Promise<void>): HTMLButtonElement => {
    const item = document.createElement('button')
    item.type = 'button'
    item.className = `${MENU_ITEM_CLASS} ${MENU_ITEM_KIND_CLASS}${kind}${danger ? ` ${MENU_ITEM_DANGER_CLASS}` : ''}`
    item.setAttribute('role', 'menuitem')
    item.textContent = text
    item.addEventListener('mousedown', (event) => {
      event.preventDefault()
      event.stopPropagation()
    })
    item.addEventListener('pointerdown', (event) => event.stopPropagation())
    item.addEventListener('click', (event) => {
      event.stopPropagation()
      // The menu goes first: an item that opens a composer must not leave its
      // own list on screen over the field that replaced the button.
      dismissMenu()
      void run()
    })
    return item
  }

  /**
   * The list answers for itself, not just for its items: it has padding and 1px
   * gaps between them, and every one of those belongs to the popover. Only the
   * items act on a press, so a press anywhere else in the list is held by it
   * rather than reaching the board.
   */
  const menuList = (label: string): HTMLDivElement => {
    const list = document.createElement('div')
    list.className = MENU_LIST_CLASS
    list.setAttribute('role', 'menu')
    list.setAttribute('aria-label', label)
    for (const type of ['pointerdown', 'mousedown'] as const) {
      list.addEventListener(type, (event) => event.stopPropagation())
    }
    return list
  }

  // The board is drawn with its slots, and this is what says which of the things
  // the DOM walk found are those slots: everything below is built for content.
  for (const el of slots?.cards ?? []) el.classList.add(ADD_SLOT_CLASS)
  if (slotColumn >= 0) sections[slotColumn]!.classList.add(COLUMN_SLOT_CLASS)
  // The card slot in the drawn column is the bin, and at rest it must be nothing.
  // It is the one place on the board that invites a card into a column that does
  // not exist yet, and the press it invites is a press the editor answers with a
  // *column*, so a card drawn there at rest is a caption over the wrong answer.
  // The space stays (mermaid sized the band with it, and the band is what the bin
  // is read against); `kanbanTrash` takes the class off when a card is in the air.
  if (slots?.columnCard) slots.columnCard.classList.add(KANBAN_BIN_SLOT_CLASS)
  session.onRender(() => {
    for (const el of slots?.cards ?? []) el.classList.remove(ADD_SLOT_CLASS)
    if (slotColumn >= 0) sections[slotColumn]?.classList.remove(COLUMN_SLOT_CLASS)
    slots?.columnCard?.classList.remove(KANBAN_BIN_SLOT_CLASS)
  })

  sections.forEach((section, column) => {
    // The new column at the end of the board has no menu: it is a place to type a
    // name, and it is not yet a column to add to, rename or delete.
    if (column === slotColumn) return
    const name = columnName(column)
    const menuBox = (): DOMRect => {
      const rect = sectionRect(section)
      // The control is this size in *document* pixels (it is styled in the same
      // space as the text around it), and every rect here is in viewport pixels.
      // A placement converts back, so what is built here has to be in the space it
      // is measured in or the inset shrinks by the zoom factor.
      const zoom = effectiveZoom(container)
      const size = KANBAN_BUTTON_HALF * 2 * zoom
      const edge = KANBAN_BUTTON_EDGE * zoom
      // Centred on the column's own name, which is what it belongs to and what
      // the eye lines it up with. The band's top edge is not the header's: the
      // band is padded and the name is drawn inside that padding, so an inset
      // from the band puts the mark below the text it is the menu of. The name's
      // own box is the only thing that knows where the header really is, and a
      // band is the fallback for a name with none: one that is not offered (a
      // repeated name, which has no single target) or one that has not been laid
      // out, which measures as no height at all.
      const shown = labelElementIn(bandHeaderIn(section))?.getBoundingClientRect()
      const top =
        shown === undefined || shown.height <= 0 ? rect.top + edge : shown.top + shown.height / 2 - size / 2
      return new DOMRect(rect.right - edge - size, top, size, size)
    }

    // Two items, and both are generic: the menu belongs to the column whose `⋯`
    // it hangs off, so "Rename column" is already "rename *this* column", and
    // nothing it says has to fit inside a name that can be any length. Adding a
    // column is not here at all — the board is drawn with a column slot at its
    // end, which is a place to name rather than an item in a list, so a way to
    // add one that is *only* here would be a way to add one a board has not got.
    const actions: Array<{ text: string; kind: string; danger: boolean; run: () => void | Promise<void> }> = [
      {
        text: 'Rename column',
        kind: 'rename',
        danger: false,
        // The very edit a click on the header makes, found by position rather than
        // by name: two columns may share a name, and the one that renames is the
        // one whose menu was opened.
        run: () => {
          const index = headerOf(section)
          if (index >= 0) editColumnName(session, index, section)
        },
      },
    ]
    // A board keeps at least one column, so a board of one is not offered the
    // delete that would leave nothing behind: what cannot be done is not on the
    // board. `removeKanbanColumn` refuses it as well, and the slot column the
    // board is drawn with is not one of them.
    if (kanbanColumnCount(session.source) > 1) {
      const taken = cardsIn(column)
      const columnKey = kanbanItemKey(doc, 'column', column)
      actions.push({
        // The name is the *dialog's* to say, not the item's: the prompt is where a
        // delete is confirmed, so that is where "which one" has to be answered,
        // and a list that says it twice is a list twice as wide as it needs to be.
        text: 'Delete column',
        kind: 'delete',
        danger: true,
        run: () =>
          confirmThen(
            session,
            `the ${name} column`,
            taken === 0
              ? 'The column is removed from the board.'
              : `Its ${taken} card${taken === 1 ? '' : 's'} go with it.`,
            // Found again by key in the source the answer lands on: an undo
            // under the prompt can have moved the columns.
            (source) => {
              const now = findKanbanItem(source, columnKey)
              return now < 0 ? null : removeKanbanColumn(source, now)
            },
          ),
      })
    }

    const menu = control(MENU_BUTTON_CLASS, '⋯', `${name} column actions`, menuBox, () => {
      if (openMenuFor === menu) {
        dismissMenu()
        return
      }
      // Another column's menu, if one is open, is not this one's business.
      dismissMenu()
      // Claimed *before* anything of this menu is built, because claiming a phase
      // finishes the interaction holding it — which is the menu that was open —
      // and a claim made after would finish this one instead.
      //
      // A menu is the one interaction that does not displace a field: pressing a
      // column's `⋯` mid-rename should not throw the rename away.
      const claimed = session.start('menu', () => dismissMenu())
      const list = menuList(`${name} column actions`)
      for (const action of actions) list.appendChild(menuItem(action.text, action.kind, action.danger, action.run))
      layer.appendChild(list)
      // Placed here rather than on the next resize: the list is built long after
      // the layer's own placement ran, so without this it would sit wherever the
      // markup put it — the top-left of the board, over the first column.
      const unplace = session.overlay(list, () => {
        // Attached to the `⋯`: the list starts exactly where its own button ends,
        // and hangs inside the column because it is right-aligned to it. Its width
        // is a document-space constant like the button's, so it is widened to the
        // viewport space this box is built in and the placement converts it back.
        const at = menuBox()
        const width = MENU_WIDTH * effectiveZoom(container)
        return { left: at.left + at.width - width, top: at.top + at.height, width }
      })
      unplaced.push(unplace)
      closeMenu = () => {
        list.remove()
        const at = unplaced.indexOf(unplace)
        if (at >= 0) unplaced.splice(at, 1)
        unplace()
        claimed()
      }
      openMenuFor = menu
      ;(list.firstElementChild as HTMLElement | null)?.focus()
    })
    menu.addEventListener('keydown', (event) => {
      const key = (event as KeyboardEvent).key
      if (key !== 'Escape' && key !== 'ArrowDown' && key !== 'ArrowUp') return
      event.preventDefault()
      event.stopPropagation()
      if (key === 'Escape') {
        dismissMenu()
        return
      }
      const items = [...layer.querySelectorAll<HTMLElement>(`.${MENU_ITEM_CLASS}`)]
      const at = items.indexOf(document.activeElement as HTMLElement)
      const step = key === 'ArrowDown' ? 1 : -1
      items[(at + step + items.length) % items.length]?.focus()
    })
  })

  // ── the two drawn slots ──
  //
  // A board's shape is obvious while you are looking at it and not at all once it
  // is a paragraph of source, so both places a card or a column can be added are
  // *drawn*: a card slot in every column, in the next card's own place, and a
  // column at the end of the board, as wide and as tall as the real ones. Mermaid
  // lays both out as the things they are about to become, so nothing is positioned
  // by hand, nothing can be laid over a card, and the board is exactly the board
  // plus the room it needs to grow.
  //
  // They are resolved from the click rather than pressed as controls: a slot is
  // part of the drawing, so a click in one is a click on the board. A card slot
  // asks for a title in the composer that fills it, and the new column is named
  // with the editor its own header is edited by, so a name is keyed into the band
  // exactly as it is edited once it exists.
  const slotOf = new Map<SVGElement, number>()
  for (const el of slots?.cards ?? []) slotOf.set(el, doc.cards[cards.indexOf(el)]!.column)
  const band = slotColumn < 0 ? null : (sections[slotColumn] ?? null)
  const onSlotClick = ((event: MouseEvent) => {
    if (event.button !== 0) return
    const slot = drawnElementAt(event, `.${ADD_SLOT_CLASS}, .${COLUMN_SLOT_CLASS}`, [
      ...slotOf.keys(),
      ...(band === null ? [] : [band]),
    ])
    if (slot === null) return
    // A click on a label is the label's own business, which is how a card's title
    // and a band's name are edited.
    if (event.target instanceof Element && event.target.closest(`.${EDITABLE_CLASS}`) !== null) return
    const column = slotOf.get(slot)
    // A card slot in a column that exists asks for a card's title. The one in the
    // drawn column cannot: that column is a place rather than a list, so it has
    // nothing to put a card in, and the whole press falls through to naming it.
    if (column !== undefined && column !== slotColumn) {
      event.preventDefault()
      editCardTitle(session, cards.indexOf(slot), true)
      return
    }
    // The new column is named through its own header, which the label editor
    // already owns: a click anywhere in the empty band is that header's click. The
    // field it opens is a *new* one, though — empty, one line tall, standing in the
    // band rather than over the text on it, because the band is card-tall and its
    // label is a placeholder that is not a name to retype.
    if (band === null || !contains(band.getBoundingClientRect(), event.clientX, event.clientY)) return
    const index = headerOf(band)
    if (index < 0) return
    event.preventDefault()
    editColumnName(session, index, band)
  }) as EventListener
  session.listen(container, 'click', onSlotClick)

  // ── what is under the pointer ──
  //
  // Only the menu answers to it now. A card is not covered by a control and is
  // not deleted by one: it is *picked up* and dragged onto the column the board
  // is drawn with, which is a bin for the length of that drag.
  /** The list, or the `⋯` it belongs to: the menu hangs off both, so the pointer
   *  may travel from either to the other. */
  const isOnMenu = (target: Element): boolean =>
    target.closest(`.${MENU_LIST_CLASS}`) !== null ||
    target.closest(`.${MENU_BUTTON_CLASS}`) === openMenuFor
  // A press anywhere that is not the menu's own list dismisses it. The `⋯` and
  // the items stop the press reaching here, so the `⋯`'s own click is the toggle.
  session.listen(container, 'pointerdown', (() => dismissMenu()) as EventListener)
  session.listen(container, 'keydown', ((event: Event) => {
    if ((event as KeyboardEvent).key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    dismissMenu()
  }) as EventListener)
  // Moving the pointer off it takes it away, because a board is not a dialog and
  // nothing else on it is reachable while one is open. What is *on* it does not:
  // the list, and the `⋯` it hangs off, which the walk up from an item to the mark
  // that opened it crosses on every single pass. A *different* column's `⋯` is a
  // move rather than a return, so it does still take it away.
  session.listen(container, 'pointerover', ((event: Event) => {
    if (closeMenu === null) return
    if (event.target instanceof Element && isOnMenu(event.target)) return
    dismissMenu()
  }) as EventListener)

  return () => {
    for (const unplace of unplaced.splice(0)) unplace()
    layer.remove()
  }
}
