export function escapeHtml(value: string): string {
  return value.replace(/[<>&]/g, (char) => {
    switch (char) {
      case '<':
        return '&lt;'
      case '>':
        return '&gt;'
      default:
        return '&amp;'
    }
  })
}

let fieldIds = 0

/**
 * Point `label` at `control` (`for`/`id`), so the control takes the label's
 * text as its accessible name and a click on the label focuses it. A dialog's
 * label sits beside its field rather than around it, so the association has to
 * be spelled out; the id is page-unique and only assigned when there is none.
 */
export function labelControl(label: HTMLLabelElement, control: HTMLElement): void {
  if (!control.id) {
    fieldIds += 1
    control.id = `edi-field-${fieldIds}`
  }
  label.htmlFor = control.id
}
