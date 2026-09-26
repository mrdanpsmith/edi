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
  toggleToolbar: () => void
  formulaReference: () => void
  helpGuide: () => void
  undo: () => void
  redo: () => void
  cut: () => void
  copy: () => void
  paste: () => void
  selectAll: () => void
  find: () => void
  replace: () => void
}

export function bindMenuCommands(handlers: MenuCommands): void {
  window.ediMenuCommand = (command: string) => {
    const handler = handlers[command as keyof MenuCommands]
    handler?.()
  }
}
