export interface MenuCommands {
  new: () => void
  open: () => void
  save: () => void
  saveAs: () => void
  revert: () => void
  importTable: () => void
  importText: () => void
  insertImage: () => void
  insertTableDefault: () => void
  export: () => void
  toggleFormatting: () => void
  undo: () => void
  redo: () => void
  cut: () => void
  copy: () => void
  paste: () => void
  selectAll: () => void
}

export function bindMenuCommands(handlers: MenuCommands): void {
  window.ediMenuCommand = (command: string) => {
    const handler = handlers[command as keyof MenuCommands]
    handler?.()
  }
}
